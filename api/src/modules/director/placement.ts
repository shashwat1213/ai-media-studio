import { EDIT_FORMATS, TEXT_SIZES } from '../editor/edit-spec.js';

/**
 * Where on-screen text goes so it doesn't cover a face. Pure, unit-tested.
 *
 * Shots are pictures of people, and SD1.5 almost always paints the head in the top third
 * (measured on 12 real scene shots: face top 0.09-0.34 of the height). A title at a fixed
 * y = 0.14 therefore sat right on the face. The gateway's /faces (OpenCV YuNet) gives face boxes
 * per picture; here we pick the first title position whose text band misses every face.
 */

/** A face in a picture, normalised 0..1 (top-left origin). */
export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
  score?: number;
}

export type SceneFormat = keyof typeof EDIT_FORMATS;

/** The default title spot (top of the frame, clear of the karaoke captions at 0.74). */
export const TITLE_Y = 0.14;
/** The default karaoke caption line, and its fallback lower down. */
export const CAPTION_Y = 0.74;
export const CAPTION_Y_LOW = 0.86;
/** Never put a title lower than this: the karaoke captions live below. */
const TITLE_MAX_Y = 0.6;
const TITLE_MIN_Y = 0.07;

/**
 * Face box in the picture -> face box in the output frame. The editor fits the picture with
 * `cover` (scale up, crop the overflow), then Ken Burns zooms up to 15% around the centre,
 * so the box is mapped through the crop and grown by the zoom plus a small safety pad.
 */
export function faceInFrame(f: FaceBox, format: SceneFormat, pic?: { w: number; h: number }): FaceBox {
  const out = EDIT_FORMATS[format];
  const src = pic && pic.w > 0 && pic.h > 0 ? pic : out;
  const k = Math.max(out.w / src.w, out.h / src.h);
  const cropX = (src.w * k - out.w) / 2;
  const cropY = (src.h * k - out.h) / 2;
  const toX = (x: number) => (x * src.w * k - cropX) / out.w;
  const toY = (y: number) => (y * src.h * k - cropY) / out.h;
  const ZOOM = 1.15;
  const PAD = 0.02;
  const grow = (v: number) => 0.5 + (v - 0.5) * ZOOM;
  // Zooming moves edges away from the centre: take the wider of the zoomed / unzoomed extents.
  const x0 = Math.min(toX(f.x), grow(toX(f.x))) - PAD;
  const x1 = Math.max(toX(f.x + f.w), grow(toX(f.x + f.w))) + PAD;
  const y0 = Math.min(toY(f.y), grow(toY(f.y))) - PAD;
  const y1 = Math.max(toY(f.y + f.h), grow(toY(f.y + f.h))) + PAD;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The vertical band a centred title of `text` covers (as a fraction of the frame height), as
 * [top, bottom] around y = 0. Matches the editor's libass box style: size 'l' from the short side,
 * ~0.55 em per character, line height 1.2 em, box padding 0.35 em, plus the 4% 'slide' rise.
 */
export function titleBand(text: string, format: SceneFormat): { up: number; down: number; widthFrac: number } {
  const { w, h } = EDIT_FORMATS[format];
  const size = Math.min(w, h) * TEXT_SIZES.l;
  const margin = Math.min(w, h) * 0.06;
  const usable = w - 2 * margin;
  const perLine = Math.max(1, Math.floor(usable / (size * 0.55)));
  const chars = [...text.trim()].length;
  const lines = Math.max(1, Math.ceil(chars / perLine));
  const half = (lines * size * 1.2 + 2 * size * 0.35) / 2 / h;
  const widthFrac = Math.min(1, (Math.min(chars, perLine) * size * 0.55 + 2 * size * 0.35) / w);
  return { up: half, down: half + 0.04, widthFrac };
}

const overlapY = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** How much of the faces a title at `y` would cover (face-area units; 0 = clear). */
function coverage(y: number, band: ReturnType<typeof titleBand>, faces: FaceBox[]): number {
  const x0 = 0.5 - band.widthFrac / 2;
  const x1 = 0.5 + band.widthFrac / 2;
  return faces.reduce((sum, f) => sum + overlapY(y - band.up, y + band.down, f.y, f.y + f.h) * overlapY(x0, x1, f.x, f.x + f.w), 0);
}

/**
 * The title's y (centre, 0..1) for one shot. Order of preference:
 *  1. the usual top spot (0.14), or a little higher (0.09), if it misses every face;
 *  2. just below the faces (the chest/body area), as long as it stays above the captions;
 *  3. just above the faces, if there's room;
 *  4. otherwise the candidate that covers the least face area.
 * No faces (or detection unavailable) -> 0.14, exactly as before.
 */
export function placeTitle(faces: FaceBox[] | undefined, text: string, format: SceneFormat, pic?: { w: number; h: number }): number {
  if (!faces?.length) return TITLE_Y;
  const band = titleBand(text, format);
  const boxes = faces.map((f) => faceInFrame(f, format, pic));
  const lo = TITLE_MIN_Y + band.up * 0.5;
  const clamp = (y: number) => Math.min(TITLE_MAX_Y, Math.max(lo, y));
  const below = Math.max(...boxes.map((b) => b.y + b.h)) + band.up + 0.01;
  const above = Math.min(...boxes.map((b) => b.y)) - band.down - 0.01;
  const candidates = [TITLE_Y, 0.09, below, above].map(clamp);
  const round = (y: number) => Math.round(y * 1000) / 1000;
  for (const y of candidates) if (coverage(y, band, boxes) === 0) return round(y);
  let best = candidates[0]!;
  for (const y of candidates) if (coverage(y, band, boxes) < coverage(best, band, boxes)) best = y;
  return round(best);
}

/**
 * One y for the karaoke captions of the whole scene (they run across cuts). Keep 0.74 unless faces
 * sit on that line in more shots than they'd sit on the lower line (0.86).
 */
export function placeCaptions(facesPerShot: (FaceBox[] | undefined)[], format: SceneFormat, pic?: { w: number; h: number }): number {
  const { w, h } = EDIT_FORMATS[format];
  const half = (Math.min(w, h) * TEXT_SIZES.l * 1.4) / 2 / h;
  const band = { up: half, down: half, widthFrac: 0.8 };
  const hits = (y: number) => facesPerShot.filter((fs) => fs?.length && coverage(y, band, fs.map((f) => faceInFrame(f, format, pic))) > 0).length;
  return hits(CAPTION_Y) > hits(CAPTION_Y_LOW) ? CAPTION_Y_LOW : CAPTION_Y;
}

/** Validates face boxes from the gateway (never trust a remote shape). */
export function parseFaces(raw: unknown): FaceBox[] {
  if (!Array.isArray(raw)) return [];
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  return raw
    .filter((f): f is FaceBox => !!f && typeof f === 'object' && ok(f.x) && ok(f.y) && ok(f.w) && ok(f.h) && f.w > 0 && f.h > 0)
    .slice(0, 5)
    .map((f) => ({ x: f.x, y: f.y, w: Math.min(f.w, 1 - f.x), h: Math.min(f.h, 1 - f.y), ...(ok(f.score) ? { score: f.score } : {}) }));
}
