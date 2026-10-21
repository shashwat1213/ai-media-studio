import { useRef, type PointerEvent as RPointerEvent } from 'react';
import { Captions, FileVideo, ImageIcon, LayoutTemplate, Music, Square, Type } from 'lucide-react';
import { cn } from 'cn';
import { formatTime, round2, type Editor } from './edit-state';

/**
 * Three tracks on one time axis: clips, captions, highlights. Click the ruler (or anywhere on a
 * track) to move the playhead; click an item to edit it; drag a caption/highlight to move it in time.
 */
export function Timeline({
  editor,
  time,
  onSeek,
  audioSelected,
  onSelectAudio,
}: {
  editor: Editor;
  time: number;
  onSeek: (t: number) => void;
  audioSelected?: string | null;
  onSelectAudio?: (key: string | null) => void;
}) {
  const { spans, total, state, selected, byId } = editor;
  const area = useRef<HTMLDivElement>(null);
  const span = Math.max(total, 1);
  const pct = (s: number) => `${(s / span) * 100}%`;

  const timeAt = (clientX: number) => {
    const r = area.current!.getBoundingClientRect();
    return Math.min(total, Math.max(0, ((clientX - r.left) / r.width) * span));
  };
  const scrub = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.track) return;
    onSeek(timeAt(e.clientX));
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => onSeek(timeAt(ev.clientX));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  /** Drag an overlay along the time axis, keeping its length. */
  const dragInTime = (list: 'texts' | 'boxes', key: string, startS: number, endS: number) => (e: RPointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    editor.select({ type: list === 'texts' ? 'text' : 'box', key });
    const x0 = e.clientX;
    const len = endS - startS;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = area.current!.getBoundingClientRect();
      const s = round2(Math.min(Math.max(0, total - len), Math.max(0, startS + ((ev.clientX - x0) / r.width) * span)));
      const p = { startS: s, endS: round2(s + len) };
      if (list === 'texts') editor.updateText(key, p);
      else editor.updateBox(key, p);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const ticks = Array.from({ length: Math.floor(span) + 1 }, (_, i) => i).filter((s) => span <= 20 || s % 5 === 0);

  return (
    <div className="rounded-2xl bg-white/[0.02] p-3 ring-1 ring-white/[0.06]">
      <div className="flex">
        <div className="w-7 shrink-0 space-y-1.5 pt-5 text-muted-foreground [&>div]:grid [&>div]:h-9 [&>div]:place-items-center">
          <div title="Clips">
            <FileVideo className="size-3.5" />
          </div>
          <div title="Captions">
            <Type className="size-3.5" />
          </div>
          <div title="Highlights">
            <Square className="size-3.5" />
          </div>
          <div title="Audio" style={{ height: `${Math.max(1, state.audio.length) * 1.75 + 0.5}rem` }}>
            <Music className="size-3.5" />
          </div>
        </div>

        <div ref={area} className="relative min-w-0 flex-1 touch-none" onPointerDown={scrub}>
          {/* ruler */}
          <div data-track className="relative mb-1.5 h-4 cursor-pointer">
            {ticks.map((s) => (
              <span key={s} className="pointer-events-none absolute top-0 -translate-x-1/2 text-[10px] tabular-nums text-muted-foreground" style={{ left: pct(s) }}>
                {s}s
              </span>
            ))}
          </div>

          <div className="space-y-1.5">
            <div data-track className="relative h-9 rounded-lg bg-white/[0.03]">
              {spans.map(({ clip, start, end }, i) => {
                const u = clip.kind === 'media' ? byId.get(clip.uploadId) : undefined;
                const sel = selected?.key === clip.key;
                const name = clip.kind === 'card' ? clip.card.title.split('\n')[0] : u?.fileName;
                return (
                  <button
                    key={clip.key}
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => editor.select({ type: 'clip', key: clip.key })}
                    title={`${name ?? 'Clip'} · ${(end - start).toFixed(1)}s`}
                    className={cn(
                      'absolute inset-y-0 flex items-center gap-1 overflow-hidden rounded-md border-x border-black/40 px-1.5 text-left text-[11px]',
                      clip.kind === 'card' ? 'bg-fuchsia-500/35' : i % 2 ? 'bg-primary/25' : 'bg-primary/35',
                      sel && 'ring-2 ring-primary ring-inset',
                    )}
                    style={{ left: pct(start), width: pct(end - start) }}
                  >
                    {clip.kind === 'card' ? (
                      <LayoutTemplate className="size-3 shrink-0" />
                    ) : u?.kind === 'image' ? (
                      <ImageIcon className="size-3 shrink-0" />
                    ) : (
                      <FileVideo className="size-3 shrink-0" />
                    )}
                    <span className="truncate">{name}</span>
                  </button>
                );
              })}
            </div>
            <div data-track className="relative h-9 rounded-lg bg-white/[0.03]">
              {state.texts.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onPointerDown={dragInTime('texts', c.key, c.startS, c.endS)}
                  title={c.text}
                  className={cn(
                    'absolute inset-y-1 cursor-grab truncate rounded-md bg-sky-500/30 px-1.5 text-left text-[11px] active:cursor-grabbing',
                    selected?.key === c.key && 'ring-2 ring-sky-400 ring-inset',
                  )}
                  style={{ left: pct(c.startS), width: pct(Math.max(0.2, Math.min(c.endS, total) - c.startS)) }}
                >
                  {c.text.split('\n')[0]}
                </button>
              ))}
            </div>
            <div data-track className="relative h-9 rounded-lg bg-white/[0.03]">
              {state.boxes.map((b) => (
                <button
                  key={b.key}
                  type="button"
                  aria-label="Highlight"
                  onPointerDown={dragInTime('boxes', b.key, b.startS, b.endS)}
                  className={cn('absolute inset-y-1 cursor-grab rounded-md border-2 active:cursor-grabbing', selected?.key === b.key && 'ring-2 ring-white/70 ring-inset')}
                  style={{ left: pct(b.startS), width: pct(Math.max(0.2, Math.min(b.endS, total) - b.startS)), borderColor: b.color, background: `${b.color}22` }}
                />
              ))}
            </div>
            {/* One row per audio track, so voice and music never overlap visually. */}
            <div data-track className="relative rounded-lg bg-white/[0.03]" style={{ height: `${Math.max(1, state.audio.length) * 1.75 + 0.5}rem` }}>
              {state.audio.map((a, row) => {
                const u = byId.get(a.uploadId);
                const len = Math.max(0.2, Math.min((u?.durationMs ?? 0) / 1000 - a.trimStartS, total - a.atS));
                const sel = audioSelected === a.key;
                return (
                  <button
                    key={a.key}
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      editor.select(null);
                      onSelectAudio?.(a.key);
                    }}
                    title={`${u?.fileName ?? 'Audio'}${a.duck ? ' · ducked music' : ''}`}
                    className={cn(
                      'absolute flex h-6 items-center gap-1 overflow-hidden rounded-md px-1.5 text-left text-[11px]',
                      a.duck ? 'bg-emerald-500/25' : 'bg-amber-500/30',
                      sel && 'ring-2 ring-white/70 ring-inset',
                    )}
                    style={{ left: pct(a.atS), width: pct(len), top: `${row * 1.75 + 0.25}rem` }}
                  >
                    {a.duck ? <Music className="size-3 shrink-0" /> : <Captions className="size-3 shrink-0" />}
                    <span className="truncate">{u?.fileName}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* playhead */}
          <div className="pointer-events-none absolute -top-0.5 bottom-0 w-px bg-white" style={{ left: pct(Math.min(time, span)) }}>
            <span className="absolute -top-0.5 left-1/2 size-2 -translate-x-1/2 rotate-45 bg-white" />
          </div>
        </div>
      </div>
      <p className="mt-2 text-right text-[11px] tabular-nums text-muted-foreground">
        {formatTime(time)} / {formatTime(total)}
      </p>
    </div>
  );
}
