import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MOTION_FPS, motionFilter, outputSize, type MotionPreset } from './motion.js';
import { ProviderError } from './providers/types.js';

export interface MotionRequest {
  image: Buffer;
  /** Source size if known (from the Asset row); avoids probing. */
  width?: number | null;
  height?: number | null;
  preset: MotionPreset;
  durationS: number;
  signal?: AbortSignal;
}

export interface RenderedVideo {
  data: Buffer;
  mimeType: 'video/mp4';
  width: number;
  height: number;
  durationMs: number;
}

/** The video boundary, like ImageProvider for images. Today: ffmpeg. Later: an AI image-to-video API. */
export interface MotionRenderer {
  readonly name: string;
  render(req: MotionRequest): Promise<RenderedVideo>;
}

const MAX_STDERR = 4000;

/**
 * Runs ffmpeg as a child process. Safety:
 *  - spawn() with an args ARRAY, never a shell string: nothing from the user reaches a shell.
 *    (The prompt isn't even passed; the filter is built only from our own preset table.)
 *  - Input/output live in a private temp dir that is always removed.
 *  - Hard timeout + AbortSignal -> SIGKILL, so a stuck render can't hold a worker slot forever.
 */
export function createFfmpegRenderer(opts: { ffmpegPath?: string; timeoutMs?: number } = {}): MotionRenderer {
  const bin = opts.ffmpegPath ?? 'ffmpeg';
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return {
    name: 'ffmpeg',
    async render({ image, width, height, preset, durationS, signal }) {
      const out = outputSize(width ?? 1024, height ?? 1024);
      const frames = durationS * MOTION_FPS;
      const dir = await mkdtemp(path.join(tmpdir(), 'motion-'));
      const input = path.join(dir, 'in');
      const output = path.join(dir, 'out.mp4');
      try {
        await writeFile(input, image);
        const args = [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          '-i', input,
          '-filter_complex', motionFilter(preset, frames, out),
          '-frames:v', String(frames),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
          '-pix_fmt', 'yuv420p', '-color_range', 'tv',
          // moov atom at the front: the browser can start playing before the whole file arrives.
          '-movflags', '+faststart',
          '-an',
          output,
        ];
        await run(bin, args, timeoutMs, signal);
        const data = await readFile(output);
        if (data.length === 0) throw new Error('ffmpeg produced an empty file');
        return { data, mimeType: 'video/mp4', width: out.w, height: out.h, durationMs: durationS * 1000 };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

function run(bin: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += d.toString();
    });
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (err) => {
      clearTimeout(timer);
      // ENOENT = ffmpeg not installed: an ops problem, not the user's. Retrying won't help.
      reject(
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? new ProviderError(`ffmpeg not found at "${bin}"`, { retryable: false, userMessage: 'Video rendering is unavailable right now.' })
          : err,
      );
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code ?? sig}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}
