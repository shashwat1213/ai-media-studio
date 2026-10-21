import { useEffect, useMemo, useState } from 'react';
import type { AutoCaptions, EditAudio, EditBox, EditCard, EditFormat, EditRequest, EditText, ImageMotion, Transition, Upload } from '@/lib/api';

/**
 * The editor's local state: the timeline being built. Lives in the browser (and is saved as a
 * draft in localStorage, so a refresh doesn't lose work) until the user hits Render.
 * Timeline maths mirror api/src/modules/editor/edit-spec.ts so the preview matches the render.
 */

interface ClipBase {
  /** Local id (the same upload can be on the timeline twice). */
  key: string;
  /** Images and cards: how long to show it. */
  durationS: number;
}
export interface MediaClip extends ClipBase {
  kind: 'media';
  uploadId: string;
  /** Videos: the part to use. */
  trimStartS: number;
  trimEndS: number;
  fit: 'contain' | 'cover';
  motion: ImageMotion | 'auto';
  /** Videos: their own sound (0 = mute). */
  volume: number;
}
export interface CardClip extends ClipBase {
  kind: 'card';
  card: EditCard;
}
export type Clip = MediaClip | CardClip;

export interface Caption extends EditText {
  key: string;
}
export interface Highlight extends EditBox {
  key: string;
}
export interface AudioTrack extends EditAudio {
  key: string;
}

export interface EditState {
  title: string;
  format: EditFormat;
  transition: Transition;
  background: string;
  clips: Clip[];
  texts: Caption[];
  boxes: Highlight[];
  audio: AudioTrack[];
  autoCaptions: AutoCaptions | null;
}

const DRAFT_KEY = 'ams.editor.draft.v2';
const EMPTY: EditState = { title: '', format: '16:9', transition: 'fade', background: '#0b0b10', clips: [], texts: [], boxes: [], audio: [], autoCaptions: null };
const uid = () => Math.random().toString(36).slice(2, 10);
export const round2 = (n: number) => Math.round(n * 100) / 100;
const ms = (n: number) => Math.round(n * 1000) / 1000;
const AUTO: ImageMotion[] = ['zoom-in', 'pan-right', 'zoom-out', 'pan-left', 'pan-up', 'zoom-in', 'pan-down'];

/** A clip's length on the timeline. */
export function clipLength(c: Clip, u?: Upload): number {
  if (c.kind === 'media' && u?.kind === 'video') return Math.max(0, c.trimEndS - c.trimStartS);
  return c.durationS;
}

/** Same rule as the server: ≤ 0.5 s and ≤ 40% of the shortest clip. */
export function transitionLength(t: Transition, lengths: number[]) {
  if (t === 'none' || lengths.length < 2) return 0;
  return ms(Math.min(0.5, Math.min(...lengths) * 0.4));
}

export interface Span {
  clip: Clip;
  start: number;
  end: number;
  /** Resolved Ken Burns move ('auto' expanded the way the server does). */
  motion: ImageMotion;
}

/** Where each clip starts on the timeline (transitions overlap neighbours), and the total. */
export function layout(clips: Clip[], uploads: Map<string, Upload>, transition: Transition) {
  const lengths = clips.map((c) => clipLength(c, c.kind === 'media' ? uploads.get(c.uploadId) : undefined));
  const overlap = transitionLength(transition, lengths);
  let t = 0;
  let auto = 0;
  const spans: Span[] = clips.map((clip, i) => {
    const len = lengths[i]!;
    const u = clip.kind === 'media' ? uploads.get(clip.uploadId) : undefined;
    const motion: ImageMotion =
      clip.kind === 'media' && u?.kind === 'image' ? (clip.motion === 'auto' ? AUTO[auto++ % AUTO.length]! : clip.motion) : 'none';
    const span = { clip, start: ms(t), end: ms(t + len), motion };
    t += len - (i < clips.length - 1 ? overlap : 0);
    return span;
  });
  return { spans, total: round2(t), overlap };
}

function loadDraft(): EditState {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<EditState>) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** A server-built request (template / AI director) -> editable local state. */
export function fromRequest(r: EditRequest, title = ''): EditState {
  return {
    title: r.title ?? title,
    format: r.format,
    transition: r.transition,
    background: r.background,
    clips: r.clips.map((c): Clip =>
      'card' in c
        ? { kind: 'card', key: uid(), durationS: c.durationS, card: { ...c.card, subtitle: c.card.subtitle ?? '' } }
        : {
            kind: 'media',
            key: uid(),
            uploadId: c.uploadId,
            durationS: c.durationS ?? 3,
            trimStartS: c.trimStartS ?? 0,
            trimEndS: c.trimEndS ?? 0,
            fit: c.fit,
            motion: c.motion ?? 'none',
            volume: c.volume ?? 1,
          },
    ),
    texts: r.texts.map((t) => ({ ...t, anim: t.anim ?? 'none', key: uid() })),
    boxes: r.boxes.map((b) => ({ ...b, key: uid() })),
    audio: (r.audio ?? []).map((a) => ({ ...a, key: uid() })),
    autoCaptions: r.autoCaptions ?? null,
  };
}

/**
 * Hand a server-built draft (Scene Director) to the Editor: written where the editor restores its
 * draft from, so opening /studio?tool=editor shows it. Replaces the current draft.
 */
export function openDraftInEditor(r: EditRequest, title = '') {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(fromRequest(r, title)));
}

export function useEditState(uploads: Upload[] | undefined) {
  const [state, setState] = useState<EditState>(loadDraft);
  const [selected, setSelected] = useState<{ type: 'clip' | 'text' | 'box'; key: string } | null>(null);

  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(state));
  }, [state]);

  const byId = useMemo(() => new Map((uploads ?? []).map((u) => [u.id, u])), [uploads]);
  // Clips whose file was deleted (or the draft is from another account) are dropped from view.
  const clips = uploads ? state.clips.filter((c) => c.kind === 'card' || byId.has(c.uploadId)) : state.clips;
  const audio = uploads ? (state.audio ?? []).filter((a) => byId.has(a.uploadId)) : (state.audio ?? []);
  const autoCaptions = state.autoCaptions && (!uploads || byId.has(state.autoCaptions.uploadId)) ? state.autoCaptions : null;
  const { spans, total, overlap } = layout(clips, byId, state.transition);

  const patch = (p: Partial<EditState>) => setState((s) => ({ ...s, ...p }));
  const update = <K extends 'clips' | 'texts' | 'boxes'>(list: K, key: string, p: object) =>
    setState((s) => ({ ...s, [list]: (s[list] as Array<{ key: string }>).map((x) => (x.key === key ? { ...x, ...p } : x)) }));
  const remove = (list: 'clips' | 'texts' | 'boxes', key: string) => {
    setState((s) => ({ ...s, [list]: (s[list] as Array<{ key: string }>).filter((x) => x.key !== key) }));
    setSelected((sel) => (sel?.key === key ? null : sel));
  };

  return {
    state: { ...state, clips, audio, autoCaptions },
    byId,
    spans,
    total,
    overlap,
    selected,
    select: setSelected,
    patch,
    /** Replace everything (template / AI result). */
    load(next: EditState) {
      setState(next);
      setSelected(null);
    },
    addClip(u: Upload) {
      const dur = (u.durationMs ?? 0) / 1000;
      const clip: MediaClip = { kind: 'media', key: uid(), uploadId: u.id, durationS: 3, trimStartS: 0, trimEndS: round2(dur), fit: 'contain', motion: 'none', volume: 1 };
      setState((s) => ({ ...s, clips: [...s.clips, clip] }));
      setSelected({ type: 'clip', key: clip.key });
    },
    addCard(where: 'start' | 'end') {
      const clip: CardClip = {
        kind: 'card',
        key: uid(),
        durationS: 2,
        card: where === 'start' ? { title: 'Your title', subtitle: '', bg: '#7c3aed', bg2: '#db2777', color: '#ffffff' } : { title: 'Thanks for watching', subtitle: '', bg: '#111111', color: '#ffffff' },
      };
      setState((s) => ({ ...s, clips: where === 'start' ? [clip, ...s.clips] : [...s.clips, clip] }));
      setSelected({ type: 'clip', key: clip.key });
    },
    updateClip: (key: string, p: Partial<MediaClip> | Partial<CardClip>) => update('clips', key, p),
    updateCard: (key: string, p: Partial<EditCard>) =>
      setState((s) => ({ ...s, clips: s.clips.map((c) => (c.key === key && c.kind === 'card' ? { ...c, card: { ...c.card, ...p } } : c)) })),
    moveClip(key: string, dir: -1 | 1) {
      setState((s) => {
        const i = s.clips.findIndex((c) => c.key === key);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= s.clips.length) return s;
        const next = [...s.clips];
        [next[i], next[j]] = [next[j]!, next[i]!];
        return { ...s, clips: next };
      });
    },
    removeClip: (key: string) => remove('clips', key),
    addText(at: number) {
      const end = Math.min(total || 3, at + 3);
      const t: Caption = {
        key: uid(),
        text: 'Your text here',
        startS: round2(at),
        endS: round2(Math.max(end, at + 0.5)),
        x: 0.5,
        y: 0.85,
        size: 'm',
        color: '#ffffff',
        style: 'box',
        anim: 'fade',
      };
      setState((s) => ({ ...s, texts: [...s.texts, t] }));
      setSelected({ type: 'text', key: t.key });
    },
    updateText: (key: string, p: Partial<Caption>) => update('texts', key, p),
    removeText: (key: string) => remove('texts', key),
    addBox(at: number) {
      const b: Highlight = { key: uid(), x: 0.35, y: 0.3, w: 0.3, h: 0.25, startS: round2(at), endS: round2(Math.min(total || 3, at + 2)), color: '#facc15' };
      setState((s) => ({ ...s, boxes: [...s.boxes, b] }));
      setSelected({ type: 'box', key: b.key });
    },
    updateBox: (key: string, p: Partial<Highlight>) => update('boxes', key, p),
    removeBox: (key: string) => remove('boxes', key),
    /** Audio file -> the audio track at the playhead. Voice-overs get auto captions offered. */
    addAudio(u: Upload, at: number, duck = false) {
      const a: AudioTrack = { key: uid(), uploadId: u.id, atS: round2(Math.max(0, Math.min(at, Math.max(0, total - 0.5)))), trimStartS: 0, volume: duck ? 0.6 : 1, duck };
      setState((s) => ({ ...s, audio: [...(s.audio ?? []), a] }));
    },
    updateAudio: (key: string, p: Partial<AudioTrack>) =>
      setState((s) => ({ ...s, audio: (s.audio ?? []).map((x) => (x.key === key ? { ...x, ...p } : x)) })),
    removeAudio: (key: string) => setState((s) => ({ ...s, audio: (s.audio ?? []).filter((x) => x.key !== key) })),
    setAutoCaptions: (ac: AutoCaptions | null) => setState((s) => ({ ...s, autoCaptions: ac })),
    reset() {
      setState(EMPTY);
      setSelected(null);
    },
  };
}

export type Editor = ReturnType<typeof useEditState>;

function omitKey<T extends { key: string }>(o: T): Omit<T, 'key'> {
  const copy: Partial<T> = { ...o };
  delete copy.key;
  return copy as Omit<T, 'key'>;
}

/** The request the API wants. Overlays are clamped into the timeline here so a stale draft can't 400. */
export function toRequest(e: Editor): EditRequest {
  const { state, byId, total } = e;
  const inside = <T extends { startS: number; endS: number }>(o: T) => o.startS < total;
  const clampT = <T extends { startS: number; endS: number }>({ ...o }: T) => ({ ...o, startS: round2(o.startS), endS: round2(Math.min(o.endS, total)) });
  return {
    title: state.title.trim() || undefined,
    format: state.format,
    background: state.background,
    transition: state.transition,
    clips: state.clips.map((c) =>
      c.kind === 'card'
        ? { card: c.card, durationS: c.durationS }
        : byId.get(c.uploadId)?.kind === 'video'
          ? { uploadId: c.uploadId, trimStartS: c.trimStartS, trimEndS: c.trimEndS, fit: c.fit, volume: c.volume ?? 1 }
          : { uploadId: c.uploadId, durationS: c.durationS, fit: c.fit, motion: c.motion },
    ),
    texts: state.texts.filter(inside).map((c) => clampT(omitKey(c))),
    boxes: state.boxes.filter(inside).map((b) => clampT(omitKey(b))),
    audio: state.audio.filter((a) => a.atS < total).map((a) => omitKey(a)),
    autoCaptions: state.autoCaptions,
  };
}

export const formatTime = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
