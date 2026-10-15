import type { EditFormat, EditRequestInput, ImageMotion, Transition } from './edit-spec.js';
import { EDIT_LIMITS } from './edit-spec.js';

/**
 * Templates: a reusable "look" (format, pacing, transitions, card and caption style). Applying
 * a template to a set of files produces a complete, editable timeline (an EditRequest) with no
 * AI involved. The AI director (next step) uses the same builder: it only picks the template,
 * the order, the words and the timings.
 *
 * Plain data, so the browser shows them and the API validates against them.
 */
export interface Template {
  id: string;
  name: string;
  description: string;
  format: EditFormat;
  transition: Transition;
  /** Seconds per still image. */
  imageS: number;
  /** Max seconds kept from each recording (the middle part, trimmed). */
  videoMaxS: number;
  /** Stills: 'auto' varies the move per image. */
  motion: ImageMotion | 'auto';
  /** cover = fill the frame (reels), contain = show the whole screenshot (tutorials). */
  fit: 'contain' | 'cover';
  background: string;
  intro: { bg: string; bg2?: string; color: string; durationS: number } | null;
  outro: { title: string; subtitle?: string; bg: string; bg2?: string; color: string; durationS: number } | null;
  caption: { size: 's' | 'm' | 'l' | 'xl'; style: 'box' | 'outline' | 'plain'; y: number; color: string; anim: 'none' | 'fade' | 'slide' };
  /** Per-clip caption when the user gives none: '' = no caption, '{n}' = step number. */
  autoCaption: '' | 'Step {n}';
}

export const TEMPLATES: Template[] = [
  {
    id: 'reel-punchy',
    name: 'Punchy Reel',
    description: 'Fast 9:16 cuts with zoom moves and bold captions. Instagram Reels / Shorts.',
    format: '9:16',
    transition: 'slideleft',
    imageS: 1.6,
    videoMaxS: 3,
    motion: 'auto',
    fit: 'cover',
    background: '#000000',
    intro: { bg: '#7c3aed', bg2: '#db2777', color: '#ffffff', durationS: 1.5 },
    outro: { title: 'Follow for more', bg: '#111111', color: '#ffffff', durationS: 1.5 },
    caption: { size: 'l', style: 'outline', y: 0.78, color: '#ffffff', anim: 'slide' },
    autoCaption: '',
  },
  {
    id: 'travel-story',
    name: 'Travel Story',
    description: 'Calm 9:16 slideshow: slow Ken Burns, soft dissolves, gentle captions.',
    format: '9:16',
    transition: 'dissolve',
    imageS: 2.8,
    videoMaxS: 4,
    motion: 'auto',
    fit: 'cover',
    background: '#000000',
    intro: { bg: '#0ea5e9', bg2: '#14b8a6', color: '#ffffff', durationS: 2 },
    outro: { title: 'Thanks for watching', bg: '#0f172a', bg2: '#1e293b', color: '#ffffff', durationS: 2 },
    caption: { size: 'm', style: 'plain', y: 0.82, color: '#ffffff', anim: 'fade' },
    autoCaption: '',
  },
  {
    id: 'product-demo',
    name: 'Product Demo',
    description: '16:9 demo of an app: title card, full screenshots (no cropping), clean fades.',
    format: '16:9',
    transition: 'fade',
    imageS: 3.5,
    videoMaxS: 8,
    motion: 'zoom-in',
    fit: 'contain',
    background: '#0b0b10',
    intro: { bg: '#111827', bg2: '#312e81', color: '#ffffff', durationS: 2.5 },
    outro: { title: 'Try it today', bg: '#111827', bg2: '#312e81', color: '#ffffff', durationS: 2.5 },
    caption: { size: 'm', style: 'box', y: 0.88, color: '#ffffff', anim: 'fade' },
    autoCaption: '',
  },
  {
    id: 'tutorial-steps',
    name: 'Tutorial Steps',
    description: '16:9 step-by-step guide: every screen gets a "Step N" caption, no motion.',
    format: '16:9',
    transition: 'smoothleft',
    imageS: 4,
    videoMaxS: 10,
    motion: 'none',
    fit: 'contain',
    background: '#0b0b10',
    intro: { bg: '#0f766e', bg2: '#115e59', color: '#ffffff', durationS: 2.5 },
    outro: { title: "That's it!", subtitle: 'Now try it yourself', bg: '#0f766e', bg2: '#115e59', color: '#ffffff', durationS: 2 },
    caption: { size: 'm', style: 'box', y: 0.9, color: '#ffffff', anim: 'slide' },
    autoCaption: 'Step {n}',
  },
  {
    id: 'square-slideshow',
    name: 'Square Slideshow',
    description: '1:1 photo slideshow for feeds: steady pace, fades, no text unless you add it.',
    format: '1:1',
    transition: 'fade',
    imageS: 2.5,
    videoMaxS: 4,
    motion: 'auto',
    fit: 'cover',
    background: '#000000',
    intro: null,
    outro: null,
    caption: { size: 'm', style: 'box', y: 0.85, color: '#ffffff', anim: 'fade' },
    autoCaption: '',
  },
];

export const findTemplate = (id: string) => TEMPLATES.find((t) => t.id === id);

/** One source file, as the builder needs it. */
export interface BuildItem {
  uploadId: string;
  kind: 'image' | 'video';
  durationMs: number | null;
  /** Optional caption for this clip (the AI writes these; users can too). */
  caption?: string;
  /** Optional per-clip length override (seconds). */
  durationS?: number;
}

export interface BuildOptions {
  title?: string;
  subtitle?: string;
  /** Override the outro text. */
  outroTitle?: string;
  outroSubtitle?: string;
  /** Aim for roughly this many seconds (scales still-image time; recordings keep their trims). */
  targetS?: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Template + files (+ optional words) -> a complete EditRequest. Deterministic and pure.
 * The result is a normal timeline: the user can change anything before rendering.
 */
export function buildFromTemplate(t: Template, items: BuildItem[], opts: BuildOptions = {}): EditRequestInput {
  const clips: EditRequestInput['clips'] = [];
  const texts: NonNullable<EditRequestInput['texts']> = [];
  const lengths: number[] = [];

  if (t.intro && opts.title !== '') {
    const title = (opts.title ?? t.name).slice(0, 80);
    clips.push({ card: { title, subtitle: (opts.subtitle ?? '').slice(0, 120), bg: t.intro.bg, bg2: t.intro.bg2, color: t.intro.color }, durationS: t.intro.durationS });
    lengths.push(t.intro.durationS);
  }

  // Scale still-image time towards the target length (within sane bounds).
  let imageS = t.imageS;
  if (opts.targetS) {
    const fixed =
      (t.intro?.durationS ?? 0) +
      (t.outro?.durationS ?? 0) +
      items.filter((i) => i.kind === 'video').reduce((s, i) => s + Math.min(t.videoMaxS, (i.durationMs ?? 0) / 1000), 0);
    const stills = items.filter((i) => i.kind === 'image' && i.durationS === undefined).length;
    if (stills > 0) imageS = Math.min(6, Math.max(1, (opts.targetS - fixed) / stills));
  }

  const firstMedia = clips.length;
  items.forEach((it) => {
    if (it.kind === 'image') {
      const len = r2(Math.min(EDIT_LIMITS.maxImageClipS, Math.max(EDIT_LIMITS.minClipS, it.durationS ?? imageS)));
      clips.push({ uploadId: it.uploadId, durationS: len, fit: t.fit, motion: t.motion });
      lengths.push(len);
    } else {
      // Keep the middle of long recordings: intros/outros of screen recordings are usually dead air.
      const src = (it.durationMs ?? 0) / 1000;
      const want = Math.min(src, it.durationS ?? t.videoMaxS);
      const start = r2(Math.max(0, (src - want) / 2));
      const end = r2(Math.min(src, start + want));
      clips.push({ uploadId: it.uploadId, trimStartS: start, trimEndS: end, fit: t.fit });
      lengths.push(end - start);
    }
  });

  if (t.outro) {
    clips.push({
      card: { title: (opts.outroTitle ?? t.outro.title).slice(0, 80), subtitle: (opts.outroSubtitle ?? t.outro.subtitle ?? '').slice(0, 120), bg: t.outro.bg, bg2: t.outro.bg2, color: t.outro.color },
      durationS: t.outro.durationS,
    });
    lengths.push(t.outro.durationS);
  }

  // Captions sit on each media clip, inside it, clear of the transitions at either end.
  const overlap = t.transition === 'none' || lengths.length < 2 ? 0 : Math.min(0.5, Math.min(...lengths) * 0.4);
  let at = 0;
  lengths.forEach((len, i) => {
    const mi = i - firstMedia;
    if (mi >= 0 && mi < items.length) {
      const it = items[mi]!;
      const text = (it.caption ?? (t.autoCaption ? t.autoCaption.replace('{n}', String(mi + 1)) : '')).trim();
      if (text) {
        texts.push({
          text: text.slice(0, EDIT_LIMITS.textChars),
          startS: r2(at + overlap),
          endS: r2(Math.max(at + overlap + 0.5, at + len - overlap)),
          x: 0.5,
          y: t.caption.y,
          size: t.caption.size,
          color: t.caption.color,
          style: t.caption.style,
          anim: t.caption.anim,
        });
      }
    }
    at += len - (i < lengths.length - 1 ? overlap : 0);
  });

  return { title: opts.title || undefined, format: t.format, background: t.background, transition: t.transition, clips, texts, boxes: [] };
}
