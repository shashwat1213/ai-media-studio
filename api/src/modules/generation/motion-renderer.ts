import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MOTION_FPS, motionFilter, outputSize, type MotionPreset } from './motion.js';
import { runProcess } from '../../lib/run-process.js';

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
        await runProcess(bin, args, { timeoutMs, signal });
        const data = await readFile(output);
        if (data.length === 0) throw new Error('ffmpeg produced an empty file');
        return { data, mimeType: 'video/mp4', width: out.w, height: out.h, durationMs: durationS * 1000 };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
