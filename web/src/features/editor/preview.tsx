import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { cn } from 'cn';
import type { EditCard, EditFormat, ImageMotion, Transition, Upload } from '@/lib/api';
import type { Caption, Editor, Highlight, Span } from './edit-state';

/** Same numbers as the server render (api/src/modules/editor/edit-spec.ts), so the preview is honest. */
export const TEXT_SIZES = { s: 0.035, m: 0.05, l: 0.07, xl: 0.1 } as const;
export const FORMAT_RATIO: Record<EditFormat, string> = { '16:9': '16 / 9', '9:16': '9 / 16', '1:1': '1 / 1' };
const ANIM_S = 0.35;
/** The frame's short side in preview pixels (the preview box is sized by its height). */
const shortSide = (f: EditFormat, h: number) => (f === '9:16' ? (h * 9) / 16 : h);
const ease = (t: number) => t * t * (3 - 2 * t);

/** CSS transform for a Ken Burns move at progress p (same moves as the server, approximately). */
function motionTransform(m: ImageMotion, p: number): string {
  const e = ease(Math.min(1, Math.max(0, p)));
  const pan = 6; // % of travel at 1.12x zoom
  switch (m) {
    case 'zoom-in':
      return `scale(${1 + 0.15 * e})`;
    case 'zoom-out':
      return `scale(${1.15 - 0.15 * e})`;
    case 'pan-left':
      return `scale(1.12) translateX(${pan * (2 * e - 1)}%)`;
    case 'pan-right':
      return `scale(1.12) translateX(${pan * (1 - 2 * e)}%)`;
    case 'pan-up':
      return `scale(1.12) translateY(${pan * (2 * e - 1)}%)`;
    case 'pan-down':
      return `scale(1.12) translateY(${pan * (1 - 2 * e)}%)`;
    default:
      return 'none';
  }
}

/** How the incoming clip enters during a transition (progress p 0..1). Approximations of xfade. */
function enterStyle(t: Transition, p: number): React.CSSProperties {
  switch (t) {
    case 'slideleft':
      return { transform: `translateX(${(1 - p) * 100}%)` };
    case 'slideup':
      return { transform: `translateY(${(1 - p) * 100}%)` };
    case 'smoothleft':
    case 'wipeleft':
      return { clipPath: `inset(0 0 0 ${(1 - p) * 100}%)` };
    case 'circleopen':
      return { clipPath: `circle(${p * 75}% at 50% 50%)` };
    case 'zoomin':
      return { opacity: p, transform: `scale(${1.3 - 0.3 * p})` };
    default:
      return { opacity: p };
  }
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const active = (o: { startS: number; endS: number }, t: number) => t >= o.startS && t <= o.endS;

/**
 * Live preview of the timeline at `time`: the current clip (image or video, positioned the way
 * ffmpeg will), plus captions and highlights. Captions and highlights can be dragged into place.
 * Uses the same font (Geist SemiBold) and the same size fractions as the server render.
 */
export function Preview({ editor, time, playing }: { editor: Editor; time: number; playing: boolean }) {
  const { state, spans, byId, total, selected } = editor;
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setHeight(e!.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const t = Math.min(time, Math.max(0, total - 0.001));
  // Every clip on screen at t: normally one; two during a transition (the later one enters on top).
  const visible = spans.filter((sp) => t >= sp.start && t < sp.end);
  if (visible.length === 0 && spans.length) visible.push(spans.at(-1)!);
  const overlapping = visible.length > 1;
  const fadeBlack = state.transition === 'fadeblack';

  const toFrac = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };

  return (
    <div className="flex justify-center rounded-2xl bg-black/60 p-2 ring-1 ring-white/[0.07]">
      <div
        ref={box}
        className="relative h-[min(46vh,520px)] max-w-full overflow-hidden rounded-lg select-none"
        style={{ aspectRatio: FORMAT_RATIO[state.format], background: state.background }}
        onPointerDown={(e) => e.target === e.currentTarget && editor.select(null)}
      >
        {visible.length ? (
          visible.map((sp, i) => {
            const p = overlapping && i === 1 ? (t - sp.start) / editor.overlap : 1;
            // fadeblack: out to black, then in from black (no overlap blend).
            const style = !overlapping ? {} : fadeBlack ? { opacity: i === 0 ? Math.max(0, 1 - 2 * ((t - visible[1]!.start) / editor.overlap)) : Math.max(0, 2 * p - 1) } : i === 1 ? enterStyle(state.transition, p) : {};
            return (
              <div key={sp.clip.key} className="absolute inset-0 overflow-hidden" style={style}>
                <ClipView span={sp} upload={sp.clip.kind === 'media' ? byId.get(sp.clip.uploadId) : undefined} t={t} playing={playing} />
              </div>
            );
          })
        ) : (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-white/50">Pick a template or add files from the panel →</div>
        )}

        {state.audio.map((a) => {
          const u = byId.get(a.uploadId);
          return u?.url ? <TrackAudio key={a.key} src={u.url} offset={time - a.atS + a.trimStartS} active={time >= a.atS} playing={playing} volume={Math.min(1, a.volume * (a.duck ? 0.6 : 1))} /> : null;
        })}
        {state.autoCaptions && <KaraokePreview editor={editor} t={t} height={height} />}

        {state.boxes.map((b) =>
          active(b, t) || selected?.key === b.key ? (
            <BoxOverlay key={b.key} b={b} height={height} dim={!active(b, t)} selected={selected?.key === b.key} editor={editor} toFrac={toFrac} />
          ) : null,
        )}
        {state.texts.map((c) =>
          active(c, t) || selected?.key === c.key ? (
            <CaptionOverlay key={c.key} c={c} t={t} height={height} dim={!active(c, t)} selected={selected?.key === c.key} editor={editor} toFrac={toFrac} />
          ) : null,
        )}
      </div>
    </div>
  );
}

/** One audio track in the preview, kept in step with the timeline clock (like video clips). */
function TrackAudio({ src, offset, active, playing, volume }: { src: string; offset: number; active: boolean; playing: boolean; volume: number }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    a.volume = volume;
    const run = playing && active && offset < (a.duration || Infinity);
    if (!run) {
      if (!a.paused) a.pause();
      if (!playing) a.currentTime = Math.max(0, offset);
      return;
    }
    if (Math.abs(a.currentTime - offset) > 0.3) a.currentTime = Math.max(0, offset);
    if (a.paused) void a.play().catch(() => undefined);
  }, [offset, active, playing, volume]);
  return <audio ref={ref} src={src} preload="auto" />;
}

/** Word-by-word caption preview from the selected transcript (same grouping as the server). */
function KaraokePreview({ editor, t, height }: { editor: Editor; t: number; height: number }) {
  const ac = editor.state.autoCaptions!;
  const u = editor.byId.get(ac.uploadId);
  const words = u?.transcript?.words ?? [];
  // Where is that audio on the timeline? An audio track or a video clip.
  const track = editor.state.audio.find((a) => a.uploadId === ac.uploadId);
  const clip = editor.spans.find((sp) => sp.clip.kind === 'media' && sp.clip.uploadId === ac.uploadId);
  const at = track ? track.atS - track.trimStartS : clip && clip.clip.kind === 'media' ? clip.start - clip.clip.trimStartS : null;
  if (at === null || !words.length) return null;
  const local = t - at;
  // Lines of up to maxWords, broken on sentence ends / pauses (mirror of groupWords on the API).
  const lines: (typeof words)[] = [];
  let cur: typeof words = [];
  for (const w of words) {
    const prev = cur.at(-1);
    if (prev && (cur.length >= ac.maxWords || w.s - prev.e > 0.6 || /[.!?।]$/.test(prev.w))) {
      lines.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) lines.push(cur);
  const line = lines.find((l, i) => local >= l[0]!.s && local < (lines[i + 1]?.[0]?.s ?? l.at(-1)!.e + 0.3));
  if (!line) return null;
  const size = shortSide(editor.state.format, height) * TEXT_SIZES[ac.size];
  return (
    <div className="pointer-events-none absolute inset-x-[6%] flex -translate-y-1/2 justify-center text-center" style={{ top: `${ac.y * 100}%` }}>
      <span
        className="font-sans font-semibold leading-tight"
        style={{
          fontSize: size,
          WebkitTextStroke: ac.style === 'outline' ? `${Math.max(1, size * 0.08)}px #000` : undefined,
          paintOrder: 'stroke fill',
          background: ac.style === 'box' ? 'rgba(0,0,0,.7)' : undefined,
          padding: ac.style === 'box' ? size * 0.35 : 0,
        }}
      >
        {line.map((w, i) => (
          <span key={i} style={{ color: local >= w.s ? ac.highlight : ac.color }}>
            {w.w}
            {i < line.length - 1 ? ' ' : ''}
          </span>
        ))}
      </span>
    </div>
  );
}

function ClipView({ span, upload, t, playing }: { span: Span; upload?: Upload; t: number; playing: boolean }) {
  const c = span.clip;
  if (c.kind === 'card') return <CardView card={c.card} t={t - span.start} />;
  if (!upload) return null;
  const p = (t - span.start) / Math.max(0.001, span.end - span.start);
  return (
    <div className="size-full" style={{ transform: motionTransform(span.motion, p) }}>
      <Media upload={upload} fit={c.fit} offset={c.trimStartS + (t - span.start)} playing={playing} volume={c.volume ?? 1} />
    </div>
  );
}

/** Title/end card: gradient or solid, title + subtitle fading/rising in like the render. */
function CardView({ card, t }: { card: EditCard; t: number }) {
  // Sizes follow the short side of the frame (same rule as the server): container query units.
  const in1 = Math.min(1, Math.max(0, (t - 0.1) / 0.5));
  const in2 = Math.min(1, Math.max(0, (t - 0.35) / 0.5));
  const rise = (p: number) => `translateY(${(1 - p) * 3}%)`;
  return (
    <div
      className="flex size-full flex-col items-center justify-center text-center"
      style={{ background: card.bg2 && card.bg2 !== card.bg ? `linear-gradient(135deg, ${card.bg}, ${card.bg2})` : card.bg, color: card.color, containerType: 'size' }}
    >
      <div className="font-semibold leading-[1.15] whitespace-pre" style={{ fontSize: 'calc(min(100cqw, 100cqh) * 0.09)', opacity: in1, transform: rise(in1) }}>
        {card.title}
      </div>
      {card.subtitle && (
        <div className="mt-[4cqmin] font-semibold whitespace-pre" style={{ fontSize: 'calc(min(100cqw, 100cqh) * 0.045)', opacity: 0.85 * in2, transform: rise(in2) }}>
          {card.subtitle}
        </div>
      )}
    </div>
  );
}

function Media({ upload, fit, offset, playing, volume = 0 }: { upload: Upload; fit: 'contain' | 'cover'; offset: number; playing: boolean; volume?: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.muted = !(upload.hasAudio && volume > 0);
    v.volume = Math.min(1, volume);
  }, [upload.hasAudio, volume]);
  // Keep the <video> in step with the timeline clock: seek when paused or when it drifts.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (!playing || Math.abs(v.currentTime - offset) > 0.25) v.currentTime = offset;
    if (playing && v.paused) void v.play().catch(() => undefined);
    if (!playing && !v.paused) v.pause();
  }, [offset, playing]);

  const cls = cn('size-full', fit === 'cover' ? 'object-cover' : 'object-contain');
  return upload.kind === 'image' ? (
    <img src={upload.url ?? ''} alt="" draggable={false} className={cls} />
  ) : (
    <video ref={ref} src={upload.url ?? ''} muted playsInline preload="auto" className={cls} />
  );
}

type ToFrac = (e: { clientX: number; clientY: number }) => { x: number; y: number };

/** Pointer-drag helper: calls onMove with the pointer position as a frame fraction. */
function useDrag(toFrac: ToFrac, onMove: (p: { x: number; y: number }, start: { x: number; y: number }) => void, onStart?: () => void) {
  return (e: RPointerEvent<HTMLElement>) => {
    e.stopPropagation();
    e.preventDefault();
    onStart?.();
    const start = toFrac(e);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => onMove(toFrac(ev), start);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
}

function CaptionOverlay({ c, t, height, dim, selected, editor, toFrac }: { c: Caption; t: number; height: number; dim: boolean; selected: boolean; editor: Editor; toFrac: ToFrac }) {
  // Short side of the frame, like the server (9:16 text isn't huge).
  const short = shortSide(editor.state.format, height);
  const size = short * TEXT_SIZES[c.size];
  const a = c.anim === 'none' || selected ? 1 : Math.max(0, Math.min(1, (t - c.startS) / ANIM_S, (c.endS - t) / ANIM_S));
  const rise = c.anim === 'slide' && !selected ? Math.max(0, 1 - (t - c.startS) / ANIM_S) * height * 0.04 : 0;
  const pad = size * 0.4;
  const origin = { x: c.x, y: c.y };
  const drag = useDrag(
    toFrac,
    (p, s) => editor.updateText(c.key, { x: Math.round(clamp01(origin.x + p.x - s.x) * 1000) / 1000, y: Math.round(clamp01(origin.y + p.y - s.y) * 1000) / 1000 }),
    () => editor.select({ type: 'text', key: c.key }),
  );
  const style =
    c.style === 'outline'
      ? { WebkitTextStroke: `${Math.max(1, size * 0.08)}px #000`, paintOrder: 'stroke fill' as const }
      : c.style === 'plain'
        ? { textShadow: '2px 2px 0 rgba(0,0,0,.6)' }
        : {};
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Caption: ${c.text}`}
      onPointerDown={drag}
      className={cn('absolute flex cursor-move flex-col items-center whitespace-pre', dim && 'opacity-40', selected && 'outline-2 outline-offset-4 outline-primary outline-dashed')}
      style={{
        left: `${c.x * 100}%`,
        top: `${c.y * 100}%`,
        transform: `translate(-50%, calc(-50% + ${rise}px))`,
        gap: c.style === 'box' ? pad * 2 : size * 0.2,
        opacity: dim ? undefined : a,
      }}
    >
      {c.text.split('\n').map((line, i) => (
        <span
          key={i}
          className="font-sans font-semibold leading-none"
          style={{
            fontSize: size,
            color: c.color,
            padding: c.style === 'box' ? pad : 0,
            background: c.style === 'box' ? 'rgba(0,0,0,.7)' : undefined,
            ...style,
          }}
        >
          {line}
        </span>
      ))}
    </div>
  );
}

function BoxOverlay({ b, height, dim, selected, editor, toFrac }: { b: Highlight; height: number; dim: boolean; selected: boolean; editor: Editor; toFrac: ToFrac }) {
  const thick = Math.max(2, shortSide(editor.state.format, height) * 0.006);
  const r = (n: number) => Math.round(n * 1000) / 1000;
  const sel = () => editor.select({ type: 'box', key: b.key });
  const move = useDrag(toFrac, (p, s) => editor.updateBox(b.key, { x: r(clamp01(Math.min(1 - b.w, b.x + p.x - s.x))), y: r(clamp01(Math.min(1 - b.h, b.y + p.y - s.y))) }), sel);
  const resize = useDrag(toFrac, (p) => editor.updateBox(b.key, { w: r(Math.max(0.02, Math.min(1 - b.x, p.x - b.x))), h: r(Math.max(0.02, Math.min(1 - b.y, p.y - b.y))) }), sel);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Highlight box"
      onPointerDown={move}
      className={cn('absolute cursor-move', dim && 'opacity-40', selected && 'outline-1 outline-offset-2 outline-white/60 outline-dashed')}
      style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`, border: `${thick}px solid ${b.color}` }}
    >
      {selected && (
        <span
          aria-label="Resize"
          onPointerDown={resize}
          className="absolute -right-1.5 -bottom-1.5 size-3 cursor-nwse-resize rounded-sm bg-white ring-1 ring-black/40"
        />
      )}
    </div>
  );
}
