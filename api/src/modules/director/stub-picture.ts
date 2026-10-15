import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess } from '../../lib/run-process.js';

/** Offline stand-in picture (tests / no local AI): a purple->pink gradient PNG made by ffmpeg. */
export async function createStubImageBytes(width: number, height: number, ffmpegPath = 'ffmpeg'): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'stubpic-'));
  try {
    const out = path.join(dir, 'p.png');
    await runProcess(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', `gradients=s=${width}x${height}:c0=0x7c3aed:c1=0xdb2777:d=1`, '-frames:v', '1', out],
      { timeoutMs: 30_000 },
    );
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Offline stand-in moving shot: a drifting gradient MP4 (tests / no local AI). */
export async function createStubClipBytes(width: number, height: number, seconds: number, ffmpegPath = 'ffmpeg'): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'stubclip-'));
  try {
    const out = path.join(dir, 'c.mp4');
    await runProcess(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', `gradients=s=${width}x${height}:c0=0x7c3aed:c1=0xdb2777:speed=0.05:r=24:d=${seconds.toFixed(2)}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out],
      { timeoutMs: 60_000 },
    );
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
