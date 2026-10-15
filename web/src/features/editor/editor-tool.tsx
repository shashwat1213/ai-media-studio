import { useEffect, useRef, useState } from 'react';
import { Clapperboard, Coins, Info, LayoutTemplate, Loader2, Pause, Play, RotateCcw, Sparkles, Square, Type } from 'lucide-react';
import { toast } from 'sonner';
import type { EditorConfig, EditFormat, Transition, Upload } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsGroup } from '@/features/studio/studio-layout';
import { toRequest, useEditState, type Editor } from './edit-state';
import { Inspector, Segmented } from './inspector';
import { MediaLibrary } from './media-library';
import { Preview } from './preview';
import { Timeline } from './timeline';
import { TemplatePicker } from './template-picker';
import { AudioPanel, AudioTrackInspector } from './audio-panel';
import { useRenderEdit } from './use-editor';

/** Editor state + playback clock, shared by the canvas and the settings panel. */
export function useEditorTool(uploads: Upload[] | undefined) {
  const editor = useEditState(uploads);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Where playback starts from. Written only in event handlers, read only in the effect.
  const from = useRef(0);
  const total = editor.total;

  // The playback clock: requestAnimationFrame from `from` to the end. Time lives in a local
  // variable inside the loop, so it never reads stale React state.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const t0 = performance.now();
    const start = from.current;
    const tick = (now: number) => {
      const t = start + (now - t0) / 1000;
      if (t >= total) {
        setTime(total);
        setPlaying(false);
        return;
      }
      setTime(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total]);

  const shown = Math.min(time, total);
  return {
    editor,
    time: shown,
    playing,
    seek: (t: number) => {
      const v = Math.max(0, Math.min(total, t));
      setPlaying(false);
      setTime(v);
    },
    toggle: () => {
      if (playing) {
        setPlaying(false);
        return;
      }
      if (total <= 0) return;
      from.current = shown >= total - 0.01 ? 0 : shown;
      setPlaying(true);
    },
  };
}

export type EditorTool = ReturnType<typeof useEditorTool>;

export function EditorCanvas({ tool, config, uploads }: { tool: EditorTool; config: EditorConfig; uploads: Upload[] }) {
  const { editor, time, playing, toggle, seek } = tool;
  const empty = editor.state.clips.length === 0;
  const [picker, setPicker] = useState(false);
  const [audioSel, setAudioSel] = useState<string | null>(null);
  // Selecting a clip/caption/box closes the audio inspector.
  const sel = editor.selected?.key;
  const [lastSel, setLastSel] = useState(sel);
  if (sel !== lastSel) {
    setLastSel(sel);
    if (sel) setAudioSel(null);
  }
  return (
    <div className="space-y-3">
      {empty && (
        <button
          type="button"
          onClick={() => setPicker(true)}
          className="flex w-full items-center gap-3 rounded-2xl bg-gradient-to-r from-primary/20 to-fuchsia-500/10 p-4 text-left ring-1 ring-primary/30 transition hover:ring-primary/60"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/25 text-primary">
            <Sparkles className="size-5" />
          </span>
          <span>
            <span className="block text-sm font-medium">Start from a template</span>
            <span className="block text-xs text-muted-foreground">Reel, travel story, product demo, tutorial… pick files and the whole video is laid out for you.</span>
          </span>
        </button>
      )}
      <Preview editor={editor} time={time} playing={playing} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="rounded-lg" onClick={toggle} disabled={empty} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause /> : <Play />}
          {playing ? 'Pause' : 'Play'}
        </Button>
        <Button size="sm" variant="secondary" className="rounded-lg" disabled={empty || editor.state.texts.length >= config.limits.texts} onClick={() => editor.addText(time)}>
          <Type />
          Add text
        </Button>
        <Button size="sm" variant="secondary" className="rounded-lg" disabled={empty || editor.state.boxes.length >= config.limits.boxes} onClick={() => editor.addBox(time)}>
          <Square />
          Add highlight
        </Button>
        <Button size="sm" variant="secondary" className="rounded-lg" onClick={() => editor.addCard(editor.state.clips.length ? 'end' : 'start')}>
          <LayoutTemplate />
          Add card
        </Button>
        <Button size="sm" variant="ghost" className="rounded-lg" onClick={() => setPicker(true)}>
          <Sparkles />
          Templates
        </Button>
        <span className="ml-auto text-[11px] text-muted-foreground">Preview is approximate; the MP4 is rendered on the server.</span>
      </div>
      <TemplatePicker open={picker} onOpenChange={setPicker} config={config} uploads={uploads} editor={editor} />
      <Timeline editor={editor} time={time} onSeek={seek} audioSelected={audioSel} onSelectAudio={setAudioSel} />
      {audioSel && editor.state.audio.some((a) => a.key === audioSel) ? (
        <AudioTrackInspector editor={editor} trackKey={audioSel} uploads={editor.byId} />
      ) : (
        <Inspector editor={editor} config={config} time={time} />
      )}
    </div>
  );
}

export function EditorSettings({
  tool,
  config,
  uploads,
  uploadsLoading,
  balance,
}: {
  tool: EditorTool;
  config: EditorConfig;
  uploads: Upload[];
  uploadsLoading: boolean;
  balance: number;
}) {
  const { editor } = tool;
  const render = useRenderEdit();
  const { state, total } = editor;
  const cost = Math.max(1, Math.ceil(total / config.secondsPerCredit - 1e-9));
  const problem =
    state.clips.length === 0
      ? 'Add at least one clip'
      : total > config.limits.maxTotalS
        ? `Too long: ${total.toFixed(1)}s (max ${config.limits.maxTotalS}s)`
        : balance < cost
          ? `Not enough credits: you have ${balance}, this costs ${cost}`
          : null;

  async function run() {
    try {
      await render.mutateAsync(toRequest(editor));
      toast.success('Rendering your video…', { description: `${cost} credit${cost > 1 ? 's' : ''} reserved. Refunded automatically if it fails.` });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    }
  }

  return (
    <>
      <SettingsGroup title="Project">
        <Input aria-label="Title" placeholder="Title (optional)" maxLength={100} value={state.title} onChange={(e) => editor.patch({ title: e.target.value })} className="h-9 rounded-lg" />
        <Segmented<EditFormat>
          label="Format"
          value={state.format}
          options={[
            ['16:9', '16:9 · YouTube'],
            ['9:16', '9:16 · Reels'],
            ['1:1', '1:1'],
          ]}
          onChange={(format) => editor.patch({ format })}
        />
        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">Between clips</span>
          <select
            aria-label="Transition"
            value={state.transition}
            onChange={(e) => editor.patch({ transition: e.target.value as Transition })}
            className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
          >
            {config.transitions.map((t) => (
              <option key={t} value={t}>
                {TRANSITION_LABEL[t] ?? t}
              </option>
            ))}
          </select>
        </label>
      </SettingsGroup>

      <SettingsGroup title="Your files" aside={<span className="text-[11px] text-muted-foreground">{uploads.filter((u) => u.kind !== 'audio').length}</span>}>
        <MediaLibrary config={config} uploads={uploads.filter((u) => u.kind !== 'audio')} loading={uploadsLoading} onAdd={editor.addClip} />
      </SettingsGroup>

      <SettingsGroup title="Audio & captions">
        <AudioPanel editor={editor} uploads={uploads} time={tool.time} balance={balance} />
      </SettingsGroup>

      <div className="mt-5 space-y-2">
        <Button className="btn-glow h-11 w-full rounded-xl" disabled={Boolean(problem) || render.isPending} onClick={run} title={problem ?? undefined}>
          {render.isPending ? <Loader2 className="animate-spin" /> : <Clapperboard />}
          Render MP4 · {total.toFixed(1)}s
          <span className="inline-flex items-center gap-0.5 text-warning">
            <Coins className="size-3.5" />
            {cost}
          </span>
        </Button>
        {problem && state.clips.length > 0 && <p className="text-[11px] text-destructive">{problem}</p>}
        <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
          <Info className="mt-px size-3 shrink-0" />1 credit per {config.secondsPerCredit}s of video. Rendered with ffmpeg on our server; your draft is saved in this browser.
        </p>
        {state.clips.length > 0 && (
          <ResetButton editor={editor} />
        )}
      </div>
    </>
  );
}

const TRANSITION_LABEL: Record<string, string> = {
  none: 'Cut (no transition)',
  fade: 'Crossfade',
  fadeblack: 'Fade through black',
  dissolve: 'Dissolve',
  slideleft: 'Slide left',
  slideup: 'Slide up',
  smoothleft: 'Smooth wipe',
  wipeleft: 'Wipe',
  zoomin: 'Zoom in',
  circleopen: 'Circle reveal',
};

function ResetButton({ editor }: { editor: Editor }) {
  return (
    <button
      type="button"
      onClick={() => window.confirm('Clear the timeline? Your files stay in the library.') && editor.reset()}
      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive"
    >
      <RotateCcw className="size-3" />
      Start over
    </button>
  );
}
