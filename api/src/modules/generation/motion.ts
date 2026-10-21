/**
 * "Motion": turn a still image into a short MP4 with a cinematic camera move.
 *
 * Honest scope: this is a CAMERA move over a still (Ken Burns / 2.5D-free), rendered by ffmpeg
 * in the worker. Nothing inside the picture moves. It costs nothing, needs no GPU and is
 * deterministic, so it is fast to test. A real image-to-video AI provider can plug in behind the
 * same job kind later (see MotionRenderer): the queue, credits, storage and UI don't change.
 */

export interface MotionPreset {
  id: string;
  name: string;
  description: string;
  /** zoompan expressions; `E` is replaced with an eased 0..1 progress. */
  z: string;
  x: string;
  y: string;
}

const CENTER_X = 'iw/2-(iw/zoom/2)';
const CENTER_Y = 'ih/2-(ih/zoom/2)';

export const MOTION_PRESETS: MotionPreset[] = [
  { id: 'push-in', name: 'Push in', description: 'Slow dolly towards the subject', z: '1+0.30*E', x: CENTER_X, y: CENTER_Y },
  { id: 'pull-out', name: 'Pull out', description: 'Reveal: start close, pull back', z: '1.30-0.30*E', x: CENTER_X, y: CENTER_Y },
  { id: 'pan-right', name: 'Pan right', description: 'Lateral track left to right', z: '1.22', x: '(iw-iw/zoom)*E', y: CENTER_Y },
  { id: 'pan-left', name: 'Pan left', description: 'Lateral track right to left', z: '1.22', x: '(iw-iw/zoom)*(1-E)', y: CENTER_Y },
  { id: 'crane-up', name: 'Crane up', description: 'Rise from the bottom of the frame', z: '1.22', x: CENTER_X, y: '(ih-ih/zoom)*(1-E)' },
  {
    id: 'drift',
    name: 'Drift',
    description: 'Dreamy diagonal float with a gentle zoom',
    z: '1.08+0.18*E',
    x: '(iw-iw/zoom)*(0.2+0.6*E)',
    y: '(ih-ih/zoom)*(0.7-0.4*E)',
  },
];

/** Stored in GenerationJob.model for MOTION jobs (metrics/labels group by it). */
export const MOTION_MODEL_ID = 'motion/ffmpeg-camera';

export const MOTION_DURATIONS = [3, 5, 8] as const;
export const MOTION_FPS = 24;
/** Credits per second of video. Cheap (it's CPU only), but not free: it still uses worker time. */
export const MOTION_CREDITS_PER_SECOND = 1;

export const motionCost = (durationS: number) => Math.max(1, Math.round(durationS * MOTION_CREDITS_PER_SECOND));
export const findPreset = (id: string) => MOTION_PRESETS.find((p) => p.id === id);

/** Output size: keep the source aspect ratio, long side 1024, even numbers (H.264 needs them). */
export function outputSize(srcW: number, srcH: number, longSide = 1024): { w: number; h: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return srcW >= srcH ? { w: even(longSide), h: even((longSide * srcH) / srcW) } : { w: even((longSide * srcW) / srcH), h: even(longSide) };
}

/**
 * The ffmpeg filter graph for one preset. Pure function, so it's unit-tested without ffmpeg.
 *
 * - Upscale 4x first: zoompan works on whole pixels, so moving across a 1024px image makes
 *   visible 1px "stair-step" jitter. On a 4x canvas each output pixel moves in quarter steps
 *   (measured: frame-to-frame jitter 0.56 -> 0.23).
 * - Smoothstep easing (3t^2 - 2t^3): starts and ends at rest, like a real camera operator.
 * - yuv420p + tv range: the format every browser/phone plays.
 */
export function motionFilter(preset: MotionPreset, frames: number, out: { w: number; h: number }): string {
  const t = `(on/${frames - 1})`;
  const eased = `(${t}*${t}*(3-2*${t}))`;
  const sub = (e: string) => e.replaceAll('E', eased);
  return [
    `scale=${out.w * 4}:${out.h * 4}:flags=lanczos`,
    `zoompan=z='${sub(preset.z)}':x='${sub(preset.x)}':y='${sub(preset.y)}':d=${frames}:s=${out.w}x${out.h}:fps=${MOTION_FPS}`,
    'scale=out_range=tv',
    'format=yuv420p',
  ].join(',');
}
