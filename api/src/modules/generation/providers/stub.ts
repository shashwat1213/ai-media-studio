import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { ProviderError, type GenerateRequest, type GeneratedImage, type ImageProvider } from './types.js';

/**
 * FREE fake provider (the default). Produces a real, valid PNG — a soft gradient with
 * "bokeh" circles whose colours are derived from the prompt — after a short delay,
 * so the whole pipeline (queue -> worker -> S3 -> UI) runs exactly as it would with real AI.
 *
 * Demo hooks (stub mode only) so you can see the failure paths in the UI:
 *   prompt contains "[fail]"  -> permanent error (no retry, credits refunded)
 *   prompt contains "[flaky]" -> transient error on every attempt (retried, then refunded)
 */
export function createStubProvider(delayMs: number): ImageProvider {
  return {
    name: 'stub',
    async generate({ prompt, aspectRatio, signal }: GenerateRequest): Promise<GeneratedImage> {
      if (delayMs > 0) await sleep(delayMs, undefined, { signal });
      if (prompt.includes('[fail]')) {
        throw new ProviderError('stub: forced permanent failure', {
          retryable: false,
          userMessage: 'The model rejected this prompt.',
        });
      }
      if (prompt.includes('[flaky]')) {
        throw new ProviderError('stub: forced transient failure', {
          retryable: true,
          userMessage: 'The AI provider is temporarily unavailable.',
        });
      }
      const { width, height } = dimensions(aspectRatio, 512);
      return { data: renderPng(prompt, width, height), mimeType: 'image/png', width, height, costUsd: 0 };
    },
  };
}

/** Long side = `long` px, other side from the ratio (e.g. 16:9 -> 512x288). */
export function dimensions(aspectRatio: string, long: number) {
  const [w, h] = aspectRatio.split(':').map(Number) as [number, number];
  return w >= h
    ? { width: long, height: Math.round((long * h) / w) }
    : { width: Math.round((long * w) / h), height: long };
}

function renderPng(prompt: string, width: number, height: number): Buffer {
  const seed = createHash('sha256').update(prompt).digest();
  const hueA = (seed[0]! / 255) * 360;
  const hueB = (hueA + 60 + (seed[1]! / 255) * 120) % 360;
  const c1 = hsl(hueA, 0.65, 0.55);
  const c2 = hsl(hueB, 0.7, 0.35);
  const circles = Array.from({ length: 6 }, (_, i) => ({
    x: (seed[2 + i * 3]! / 255) * width,
    y: (seed[3 + i * 3]! / 255) * height,
    r: (0.08 + (seed[4 + i * 3]! / 255) * 0.25) * Math.min(width, height),
    color: hsl((hueA + i * 47) % 360, 0.8, 0.75),
  }));

  // Raw PNG scanlines: each row starts with a filter byte (0 = none), then RGB triples.
  const row = 1 + width * 3;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      let r = c1[0] + (c2[0] - c1[0]) * t;
      let g = c1[1] + (c2[1] - c1[1]) * t;
      let b = c1[2] + (c2[2] - c1[2]) * t;
      for (const c of circles) {
        const d = Math.hypot(x - c.x, y - c.y) / c.r;
        if (d < 1) {
          const a = 0.35 * (1 - d * d); // soft edge
          r += (c.color[0] - r) * a;
          g += (c.color[1] - g) * a;
          b += (c.color[2] - b) * a;
        }
      }
      const o = y * row + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
