/**
 * Photo editing model + canvas renderer. Pure data -> pixels, no React, so the preview and the
 * saved full-size file come from the SAME function (what you see is what you save).
 *
 * Order of operations (like Lightroom/Snapseed): rotate/flip -> crop (aspect + zoom + pan) ->
 * colour (filter preset + sliders) -> text on top.
 */

export type Aspect = 'original' | '1:1' | '4:5' | '9:16' | '16:9' | '3:2';
export type Rotation = 0 | 90 | 180 | 270;
export type TextPos = 'top' | 'center' | 'bottom';
export type TextStyle = 'box' | 'outline' | 'plain';

export interface Adjust {
  /** -100..100, 0 = unchanged. */
  brightness: number;
  contrast: number;
  saturation: number;
  /** -100 (cool, blue) .. 100 (warm, orange). */
  warmth: number;
  /** 0..100 */
  blur: number;
  /** 0..100: darkens the corners. */
  vignette: number;
}

export interface PhotoText {
  text: string;
  pos: TextPos;
  /** Fraction of the short side, 0.03..0.15. */
  size: number;
  color: string;
  style: TextStyle;
}

export interface PhotoEdit {
  rotation: Rotation;
  flipH: boolean;
  flipV: boolean;
  aspect: Aspect;
  /** 1..3: zoom into the crop. */
  zoom: number;
  /** -1..1: where the crop sits inside the free space (0 = centred). */
  panX: number;
  panY: number;
  filter: FilterId;
  adjust: Adjust;
  text: PhotoText;
}

export const FILTERS = {
  none: { label: 'Original', css: '' },
  vivid: { label: 'Vivid', css: 'saturate(1.35) contrast(1.1)' },
  warm: { label: 'Warm', css: 'sepia(0.25) saturate(1.2) brightness(1.03)' },
  cool: { label: 'Cool', css: 'hue-rotate(-12deg) saturate(1.05) brightness(1.02)' },
  bw: { label: 'B&W', css: 'grayscale(1) contrast(1.15)' },
  vintage: { label: 'Vintage', css: 'sepia(0.45) contrast(0.92) brightness(1.05) saturate(0.85)' },
  fade: { label: 'Fade', css: 'contrast(0.85) brightness(1.08) saturate(0.8)' },
  drama: { label: 'Drama', css: 'contrast(1.35) saturate(1.1) brightness(0.95)' },
} as const;
export type FilterId = keyof typeof FILTERS;

export const ASPECTS: { id: Aspect; label: string; ratio: number | null }[] = [
  { id: 'original', label: 'Original', ratio: null },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
];

export const DEFAULT_EDIT: PhotoEdit = {
  rotation: 0,
  flipH: false,
  flipV: false,
  aspect: 'original',
  zoom: 1,
  panX: 0,
  panY: 0,
  filter: 'none',
  adjust: { brightness: 0, contrast: 0, saturation: 0, warmth: 0, blur: 0, vignette: 0 },
  text: { text: '', pos: 'bottom', size: 0.07, color: '#ffffff', style: 'box' },
};

/** Saved files are capped here (long side): enough for a 1080x1920 reel and print-ish quality. */
export const MAX_OUTPUT = 2560;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Size of the picture after rotation (90/270 swap width and height). */
export function rotatedSize(w: number, h: number, r: Rotation) {
  return r === 90 || r === 270 ? { w: h, h: w } : { w, h };
}

/**
 * The crop rectangle in ROTATED-picture pixels: the largest box of the chosen aspect, shrunk by
 * zoom, placed by pan (-1 = left/top edge, 1 = right/bottom edge).
 */
export function cropRect(w: number, h: number, e: Pick<PhotoEdit, 'rotation' | 'aspect' | 'zoom' | 'panX' | 'panY'>) {
  const s = rotatedSize(w, h, e.rotation);
  const ratio = ASPECTS.find((a) => a.id === e.aspect)?.ratio ?? s.w / s.h;
  let cw = s.w;
  let ch = cw / ratio;
  if (ch > s.h) {
    ch = s.h;
    cw = ch * ratio;
  }
  const z = clamp(e.zoom, 1, 3);
  cw /= z;
  ch /= z;
  const x = ((s.w - cw) / 2) * (1 + clamp(e.panX, -1, 1));
  const y = ((s.h - ch) / 2) * (1 + clamp(e.panY, -1, 1));
  return { x, y, w: cw, h: ch };
}

/** Output pixel size for a crop, long side capped at `max`. */
export function outputSize(crop: { w: number; h: number }, max = MAX_OUTPUT) {
  const k = Math.min(1, max / Math.max(crop.w, crop.h));
  return { w: Math.max(1, Math.round(crop.w * k)), h: Math.max(1, Math.round(crop.h * k)) };
}

/** Preset + sliders -> one CSS/canvas filter string. `scale` keeps blur the same look at any size. */
export function filterString(e: Pick<PhotoEdit, 'filter' | 'adjust'>, scale = 1): string {
  const a = e.adjust;
  const parts: string[] = [];
  if (FILTERS[e.filter]?.css) parts.push(FILTERS[e.filter].css);
  if (a.brightness) parts.push(`brightness(${(1 + a.brightness / 100).toFixed(3)})`);
  if (a.contrast) parts.push(`contrast(${(1 + a.contrast / 100).toFixed(3)})`);
  if (a.saturation) parts.push(`saturate(${(1 + a.saturation / 100).toFixed(3)})`);
  if (a.blur > 0) parts.push(`blur(${((a.blur / 100) * 12 * scale).toFixed(2)}px)`);
  return parts.join(' ') || 'none';
}

/** Text wrapping by measured width (canvas). Pure given `measure`. */
export function wrapText(text: string, maxW: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (line && measure(next) > maxW) {
        out.push(line);
        line = w;
      } else line = next;
    }
    out.push(line);
  }
  while (out.length && !out.at(-1)) out.pop();
  return out.slice(0, 6);
}

export const isEdited = (e: PhotoEdit) => JSON.stringify(e) !== JSON.stringify(DEFAULT_EDIT);

type Canvas2D = CanvasRenderingContext2D;

/**
 * Draw `img` with edit `e` into `canvas`, sized to the crop (long side <= max).
 * Used for the live preview (small max) and for saving (MAX_OUTPUT).
 */
export function renderPhoto(canvas: HTMLCanvasElement, img: CanvasImageSource & { naturalWidth: number; naturalHeight: number }, e: PhotoEdit, max = MAX_OUTPUT) {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const crop = cropRect(W, H, e);
  const out = outputSize(crop, max);
  canvas.width = out.w;
  canvas.height = out.h;
  const ctx = canvas.getContext('2d') as Canvas2D;
  const k = out.w / crop.w; // rotated-picture px -> output px
  const rs = rotatedSize(W, H, e.rotation);

  ctx.save();
  ctx.filter = filterString(e, out.w / 1080);
  // Map: output = (rotated - crop.xy) * k; rotated = rotate/flip(original) around the centre.
  ctx.scale(k, k);
  ctx.translate(-crop.x, -crop.y);
  ctx.translate(rs.w / 2, rs.h / 2);
  ctx.rotate((e.rotation * Math.PI) / 180);
  ctx.scale(e.flipH ? -1 : 1, e.flipV ? -1 : 1);
  ctx.drawImage(img, -W / 2, -H / 2, W, H);
  ctx.restore();

  const a = e.adjust;
  if (a.warmth) {
    // Colour cast with soft-light: warm = orange, cool = blue. Strength from the slider.
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = Math.abs(a.warmth) / 100 * 0.6;
    ctx.fillStyle = a.warmth > 0 ? '#ff9a3c' : '#3c8cff';
    ctx.fillRect(0, 0, out.w, out.h);
    ctx.restore();
  }
  if (a.vignette > 0) {
    const g = ctx.createRadialGradient(out.w / 2, out.h / 2, Math.min(out.w, out.h) * 0.3, out.w / 2, out.h / 2, Math.hypot(out.w, out.h) / 2);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${((a.vignette / 100) * 0.75).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, out.w, out.h);
  }
  drawText(ctx, out.w, out.h, e.text);
}

function drawText(ctx: Canvas2D, w: number, h: number, t: PhotoText) {
  if (!t.text.trim()) return;
  const short = Math.min(w, h);
  const size = Math.round(short * clamp(t.size, 0.03, 0.15));
  const margin = short * 0.06;
  ctx.save();
  ctx.font = `600 ${size}px "Geist Variable", "Noto Sans Devanagari", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrapText(t.text, w - 2 * margin - size, (s) => ctx.measureText(s).width);
  const lh = size * 1.25;
  const blockH = lines.length * lh;
  const cy = t.pos === 'top' ? margin + blockH / 2 + size * 0.4 : t.pos === 'center' ? h / 2 : h - margin - blockH / 2 - size * 0.4;
  lines.forEach((line, i) => {
    const y = cy - blockH / 2 + lh * (i + 0.5);
    if (t.style === 'box') {
      const pad = size * 0.35;
      const tw = ctx.measureText(line).width;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      ctx.roundRect(w / 2 - tw / 2 - pad, y - lh / 2, tw + 2 * pad, lh, size * 0.2);
      ctx.fill();
    } else if (t.style === 'outline') {
      ctx.lineWidth = Math.max(2, size * 0.12);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(line, w / 2, y);
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = size * 0.25;
    }
    ctx.fillStyle = t.color;
    ctx.fillText(line, w / 2, y);
  });
  ctx.restore();
}

/** Canvas -> file blob (JPEG for photos: ~5-10x smaller than PNG). */
export function canvasBlob(canvas: HTMLCanvasElement, type: 'image/jpeg' | 'image/png' = 'image/jpeg'): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the picture'))), type, 0.92));
}

/** "beach.png" -> "beach-edited.jpg" */
export function editedName(name: string, ext = 'jpg') {
  const base = name.replace(/\.[a-z0-9]+$/i, '').replace(/-edited(-\d+)?$/, '');
  return `${base.slice(0, 80)}-edited.${ext}`;
}
