import { ArrowLeft, ArrowRight, MousePointerClick, Trash2 } from 'lucide-react';
import { cn } from 'cn';
import type { EditorConfig, ImageMotion, TextAnim, TextSize, TextStyle } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { clipLength, round2, type Editor } from './edit-state';

const MOTION_LABEL: Record<string, string> = {
  auto: 'Auto (varied)',
  none: 'None (still)',
  'zoom-in': 'Zoom in',
  'zoom-out': 'Zoom out',
  'pan-left': 'Pan left',
  'pan-right': 'Pan right',
  'pan-up': 'Pan up',
  'pan-down': 'Pan down',
};
const GRADIENTS: [string, string][] = [
  ['#7c3aed', '#db2777'],
  ['#0ea5e9', '#14b8a6'],
  ['#f97316', '#e11d48'],
  ['#111827', '#312e81'],
  ['#0f766e', '#115e59'],
  ['#111111', '#111111'],
  ['#ffffff', '#ffffff'],
];

const COLORS = ['#ffffff', '#facc15', '#f472b6', '#22d3ee', '#4ade80', '#a78bfa', '#ef4444', '#000000'];

/** Edits whatever is selected on the timeline / preview. */
export function Inspector({ editor, config, time }: { editor: Editor; config: EditorConfig; time: number }) {
  const { selected, state, byId, spans, total } = editor;
  const at = round2(time);

  if (!selected) {
    return (
      <div className="flex items-center gap-2 rounded-2xl bg-white/[0.02] p-4 text-xs text-muted-foreground ring-1 ring-white/[0.06]">
        <MousePointerClick className="size-4 shrink-0" />
        Click a clip, caption or highlight to edit it. Drag captions and boxes on the preview to place them.
      </div>
    );
  }

  if (selected.type === 'clip') {
    const any = state.clips.find((x) => x.key === selected.key);
    if (!any) return null;
    const i = state.clips.indexOf(any);
    const order = (
      <div className="flex gap-1.5">
        <Button size="sm" variant="secondary" className="rounded-lg" disabled={i === 0} onClick={() => editor.moveClip(any.key, -1)}>
          <ArrowLeft />
          Earlier
        </Button>
        <Button size="sm" variant="secondary" className="rounded-lg" disabled={i === state.clips.length - 1} onClick={() => editor.moveClip(any.key, 1)}>
          Later
          <ArrowRight />
        </Button>
      </div>
    );
    if (any.kind === 'card') {
      const k = any.card;
      return (
        <Panel title={`Card · clip ${i + 1}`} onDelete={() => editor.removeClip(any.key)}>
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Title (2 lines max)</span>
            <Textarea
              aria-label="Card title"
              rows={2}
              maxLength={80}
              value={k.title}
              onChange={(e) => e.target.value.split('\n').length <= 2 && editor.updateCard(any.key, { title: e.target.value })}
              className="resize-none rounded-lg text-sm"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Subtitle</span>
            <Input aria-label="Card subtitle" maxLength={120} value={k.subtitle} onChange={(e) => editor.updateCard(any.key, { subtitle: e.target.value })} className="h-8 rounded-lg" />
          </label>
          <NumberField label="Show for (s)" value={any.durationS} min={0.5} max={10} step={0.5} onChange={(v) => editor.updateClip(any.key, { durationS: v })} />
          <div className="space-y-1">
            <span className="text-[11px] text-muted-foreground">Background</span>
            <div className="flex flex-wrap gap-1.5">
              {GRADIENTS.map(([a, b]) => (
                <button
                  key={a + b}
                  type="button"
                  aria-label={`Background ${a} to ${b}`}
                  onClick={() => editor.updateCard(any.key, { bg: a, bg2: b })}
                  className={cn('size-7 rounded-lg ring-1 ring-white/20', k.bg === a && (k.bg2 ?? a) === b && 'ring-2 ring-primary ring-offset-2 ring-offset-background')}
                  style={{ background: a === b ? a : `linear-gradient(135deg, ${a}, ${b})` }}
                />
              ))}
            </div>
          </div>
          <Swatches value={k.color} onChange={(color) => editor.updateCard(any.key, { color })} />
          {order}
        </Panel>
      );
    }
    const c = any;
    const u = byId.get(c.uploadId);
    const span = spans.find((s) => s.clip.key === c.key);
    const srcS = (u?.durationMs ?? 0) / 1000;
    // Playhead -> position inside this recording (for "set from playhead").
    const inClip = span ? round2(c.trimStartS + Math.min(Math.max(0, time - span.start), span.end - span.start)) : c.trimStartS;
    return (
      <Panel title={`Clip ${i + 1} · ${u?.fileName ?? ''}`} onDelete={() => editor.removeClip(c.key)}>
        {u?.kind === 'video' ? (
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Start in recording (s)" value={c.trimStartS} min={0} max={Math.max(0, c.trimEndS - 0.5)} onChange={(v) => editor.updateClip(c.key, { trimStartS: v })}>
              <MiniBtn onClick={() => editor.updateClip(c.key, { trimStartS: Math.min(inClip, c.trimEndS - 0.5) })}>at playhead</MiniBtn>
            </NumberField>
            <NumberField label="End in recording (s)" value={c.trimEndS} min={c.trimStartS + 0.5} max={srcS} onChange={(v) => editor.updateClip(c.key, { trimEndS: v })}>
              <MiniBtn onClick={() => editor.updateClip(c.key, { trimEndS: Math.max(inClip, c.trimStartS + 0.5) })}>at playhead</MiniBtn>
            </NumberField>
            <p className="col-span-2 text-[11px] text-muted-foreground">
              Using {clipLength(c, u).toFixed(1)}s of a {srcS.toFixed(1)}s recording.
            </p>
          </div>
        ) : (
          <>
            <NumberField label="Show for (s)" value={c.durationS} min={config.limits.minClipS} max={config.limits.maxImageClipS} step={0.5} onChange={(v) => editor.updateClip(c.key, { durationS: v })} />
            <div className="space-y-1">
              <span className="text-[11px] text-muted-foreground">Camera move</span>
              <select
                aria-label="Camera move"
                value={c.motion}
                onChange={(e) => editor.updateClip(c.key, { motion: e.target.value as ImageMotion | 'auto' })}
                className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
              >
                {(['auto', ...config.motions] as const).map((m) => (
                  <option key={m} value={m}>
                    {MOTION_LABEL[m] ?? m}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        <Segmented
          label="Fit"
          value={c.fit}
          options={[
            ['contain', 'Fit (bars)'],
            ['cover', 'Fill (crop)'],
          ]}
          onChange={(v) => editor.updateClip(c.key, { fit: v })}
        />
        {order}
      </Panel>
    );
  }

  if (selected.type === 'text') {
    const t = state.texts.find((x) => x.key === selected.key);
    if (!t) return null;
    const lines = t.text.split('\n').length;
    return (
      <Panel title="Caption" onDelete={() => editor.removeText(t.key)}>
        <div>
          <Textarea
            aria-label="Caption text"
            value={t.text}
            maxLength={config.limits.textChars}
            rows={2}
            onChange={(e) => {
              const v = e.target.value;
              if (v.split('\n').length <= config.limits.textLines) editor.updateText(t.key, { text: v });
            }}
            className="resize-none rounded-lg text-sm"
          />
          <p className="mt-1 text-right text-[11px] tabular-nums text-muted-foreground">
            {t.text.length}/{config.limits.textChars} · {lines}/{config.limits.textLines} lines
          </p>
        </div>
        <TimeRange startS={t.startS} endS={t.endS} total={total} at={at} onChange={(p) => editor.updateText(t.key, p)} />
        <Segmented
          label="Size"
          value={t.size}
          options={(['s', 'm', 'l', 'xl'] as TextSize[]).map((s) => [s, s.toUpperCase()] as [TextSize, string])}
          onChange={(v) => editor.updateText(t.key, { size: v })}
        />
        <Segmented
          label="Style"
          value={t.style}
          options={(
            [
              ['box', 'Box'],
              ['outline', 'Outline'],
              ['plain', 'Shadow'],
            ] as [TextStyle, string][]
          )}
          onChange={(v) => editor.updateText(t.key, { style: v })}
        />
        <Segmented
          label="Animation"
          value={t.anim}
          options={(
            [
              ['none', 'None'],
              ['fade', 'Fade'],
              ['slide', 'Slide up'],
            ] as [TextAnim, string][]
          )}
          onChange={(v) => editor.updateText(t.key, { anim: v })}
        />
        <Swatches value={t.color} onChange={(color) => editor.updateText(t.key, { color })} />
        <Segmented
          label="Position"
          value={t.y < 0.33 ? 'top' : t.y > 0.66 ? 'bottom' : 'middle'}
          options={[
            ['top', 'Top'],
            ['middle', 'Middle'],
            ['bottom', 'Bottom'],
          ]}
          onChange={(v) => editor.updateText(t.key, { x: 0.5, y: v === 'top' ? 0.12 : v === 'middle' ? 0.5 : 0.85 })}
        />
      </Panel>
    );
  }

  const b = state.boxes.find((x) => x.key === selected.key);
  if (!b) return null;
  return (
    <Panel title="Highlight box" onDelete={() => editor.removeBox(b.key)}>
      <p className="text-[11px] text-muted-foreground">Drag the box on the preview to move it; drag its corner to resize.</p>
      <TimeRange startS={b.startS} endS={b.endS} total={total} at={at} onChange={(p) => editor.updateBox(b.key, p)} />
      <Swatches value={b.color} onChange={(color) => editor.updateBox(b.key, { color })} />
    </Panel>
  );
}

function Panel({ title, onDelete, children }: { title: string; onDelete: () => void; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="space-y-3 rounded-2xl bg-white/[0.02] p-4 ring-1 ring-white/[0.06]">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-sm font-medium">{title}</h3>
        <Button size="sm" variant="ghost" className="h-7 rounded-lg text-muted-foreground hover:text-destructive" onClick={onDelete}>
          <Trash2 />
          Remove
        </Button>
      </div>
      {children}
    </section>
  );
}

function TimeRange({ startS, endS, total, at, onChange }: { startS: number; endS: number; total: number; at: number; onChange: (p: { startS: number; endS: number }) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <NumberField label="Appears at (s)" value={startS} min={0} max={Math.max(0, endS - 0.1)} step={0.1} onChange={(v) => onChange({ startS: v, endS })}>
        <MiniBtn onClick={() => at < endS && onChange({ startS: at, endS })}>at playhead</MiniBtn>
      </NumberField>
      <NumberField label="Disappears at (s)" value={endS} min={startS + 0.1} max={Math.max(total, startS + 0.1)} step={0.1} onChange={(v) => onChange({ startS, endS: v })}>
        <MiniBtn onClick={() => at > startS && onChange({ startS, endS: at })}>at playhead</MiniBtn>
      </NumberField>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 0.1,
  onChange,
  children,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  children?: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(round2(Math.min(max, Math.max(min, v))));
        }}
        className="h-8 w-full rounded-lg border border-input bg-white/[0.03] px-2 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {children}
    </label>
  );
}

function MiniBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="text-[11px] text-primary hover:underline">
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="space-y-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-lg bg-white/[0.03] p-0.5">
        {options.map(([v, text]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            onClick={() => onChange(v)}
            className={cn('flex-1 rounded-md px-2 py-1 text-xs transition', value === v ? 'bg-primary/20 text-foreground ring-1 ring-primary/40' : 'text-muted-foreground hover:text-foreground')}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function Swatches({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="space-y-1">
      <span className="text-[11px] text-muted-foreground">Color</span>
      <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-1.5">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={value === c}
            aria-label={c}
            onClick={() => onChange(c)}
            className={cn('size-6 rounded-full ring-1 ring-white/20 transition', value === c && 'ring-2 ring-primary ring-offset-2 ring-offset-background')}
            style={{ background: c }}
          />
        ))}
      </div>
    </div>
  );
}
