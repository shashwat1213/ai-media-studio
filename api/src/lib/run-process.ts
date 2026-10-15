import { spawn } from 'node:child_process';
import { ProviderError } from '../modules/generation/providers/types.js';

const MAX_OUTPUT = 64 * 1024;

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a media tool (ffmpeg / ffprobe) safely. Shared by Motion, the Editor and upload probing.
 *  - spawn() with an args ARRAY, never a shell string: nothing from the user reaches a shell.
 *  - Hard timeout + AbortSignal -> SIGKILL, so a stuck process can't hold a worker slot forever.
 *  - Output is capped, so a chatty process can't eat memory.
 */
export function runProcess(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal; maxOutput?: number },
): Promise<RunResult> {
  const cap = opts.maxOutput ?? MAX_OUTPUT;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('aborted'));
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < cap) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < cap) stderr += d.toString();
    });
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(kill, opts.timeoutMs);
    opts.signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (err) => {
      clearTimeout(timer);
      // ENOENT = the binary isn't installed: an ops problem, not the user's. Retrying won't help.
      reject(
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? new ProviderError(`${bin} not found`, { retryable: false, userMessage: 'Video rendering is unavailable right now.' })
          : err,
      );
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', kill);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin} exited with ${code ?? sig}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}
