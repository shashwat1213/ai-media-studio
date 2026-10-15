import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertTriangle, AudioLines, BookUser, Camera, Clapperboard, Coins, Cpu, Film, Loader2, MapPin, Mic, Music, Palette, Pencil, Plus, RotateCcw, Sparkles, Trash2, User, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { useQuery } from '@tanstack/react-query';
import { api, type Upload } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useMe } from '@/features/auth/use-auth';
import { openDraftInEditor } from '@/features/editor/edit-state';
import { uploadFile } from '@/features/editor/use-editor';
import { detectLanguage } from '@/features/director/detect-language';

import {
  useCreateScene,
  useDeleteItem,
  useLibrary,
  useSaveItem,
  useSceneAction,
  useScenes,
  useScenesConfig,
  type LibraryItem,
  type LibraryKind,
  type Scene,
  type SceneLanguage,
} from '@/features/director/api';

const KIND_META: Record<LibraryKind, { label: string; icon: typeof User; hint: string }> = {
  CHARACTER: { label: 'Characters', icon: User, hint: 'Who appears. Describe the look exactly: age, hair, clothes, accessories.' },
  PLACE: { label: 'Places', icon: MapPin, hint: 'Where it happens: setting, time of day, weather, light.' },
  STYLE: { label: 'Styles', icon: Palette, hint: 'A look added to every picture (e.g. "film grain, warm tones").' },
  VOICE: { label: 'Voices', icon: Mic, hint: 'A narrator: Hindi (offline) or English voices.' },
  SOUND: { label: 'Sounds', icon: Music, hint: 'Music or ambience from your files, with tags the director matches.' },
};
const KINDS = Object.keys(KIND_META) as LibraryKind[];

/**
 * Scene Director: write a brief with @mentions of your library -> the local AI writes a shot list
 * (picture, camera, narration, sound, on-screen text), makes every picture and the voice-over, and
 * lays it all out in the Editor for final touches and rendering.
 */
export function DirectorPage() {
  const library = useLibrary();
  const scenes = useScenes();
  const cfg = useScenesConfig();
  const [libOpen, setLibOpen] = useState(false);

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 pt-6 pb-28 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Clapperboard className="size-6 text-primary" /> Scene Director
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Describe a scene. The AI on your computer writes the shots, paints them, voices them, and hands you an edit.</p>
        </div>
        <div className="flex items-center gap-2">
          <LocalAiBadge status={cfg.data?.localAi} />
          <Button variant="secondary" className="rounded-xl" onClick={() => setLibOpen(true)}>
            <BookUser /> Library <span className="text-muted-foreground">{library.data?.length ?? 0}</span>
          </Button>
        </div>
      </header>

      <Composer library={library.data ?? []} onOpenLibrary={() => setLibOpen(true)} />

      <section aria-label="Your scenes" className="space-y-4">
        {scenes.isLoading ? (
          <div className="h-40 animate-pulse rounded-2xl bg-white/[0.03]" />
        ) : scenes.data?.length ? (
          scenes.data.map((s) => <SceneCard key={s.id} scene={s} />)
        ) : (
          <EmptyState />
        )}
      </section>

      <LibraryDialog open={libOpen} onOpenChange={setLibOpen} items={library.data ?? []} />
    </div>
  );
}

function LocalAiBadge({ status }: { status?: { llm: boolean; image: boolean } }) {
  const up = status?.llm && status.image;
  return (
    <span
      title={up ? 'Local AI is running on this computer' : 'Start it with: scripts/local-ai/start.sh'}
      className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring-1', up ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30' : 'bg-amber-500/10 text-amber-300 ring-amber-500/30')}
    >
      <Cpu className="size-3.5" />
      {status === undefined ? 'Checking local AI…' : up ? 'Local AI ready' : 'Local AI offline'}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl bg-white/[0.02] p-8 text-center ring-1 ring-white/[0.06]">
      <Film className="mx-auto size-8 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium">No scenes yet</p>
      <p className="mt-1 text-xs text-muted-foreground">Add a character and a place to your Library, then try: “@riya @mumbai ki baarish mein tapri pe chai peeti hai, cozy aur nostalgic”.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Composer with @mention suggestions

function Composer({ library, onOpenLibrary }: { library: LibraryItem[]; onOpenLibrary: () => void }) {
  const cfg = useScenesConfig();
  const create = useCreateScene();
  const { data: me } = useMe();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState('');
  const [choice, setLanguage] = useState<SceneLanguage | 'auto'>('auto');
  const [format, setFormat] = useState<Scene['format']>('9:16');
  const [targetS, setTargetS] = useState(20);
  const [hdWanted, setHd] = useState(false);
  const [motionWanted, setMotion] = useState<'still' | 'hero' | 'ai'>('still');
  const [voice, setVoice] = useState('');
  const [caret, setCaret] = useState(0);

  // Auto: the language the brief asks for ("English voice-over"), else the one it's written in.
  const detected = useMemo(() => detectLanguage(prompt), [prompt]);
  const language: SceneLanguage = choice === 'auto' ? detected.language : choice;
  const spoken = language === 'en' ? 'en' : 'hi';
  const speaks = (id: string) => (id.startsWith('hi_') ? 'hi' : 'en');
  // Only narrators that SPEAK the scene's language are offered.
  const voiceItems = library.filter((i) => i.kind === 'VOICE' && speaks(String(i.settings.voice ?? '')) === spoken);
  const builtIn = (cfg.data?.voices ?? []).filter((v) => speaks(v.id) === spoken);
  const valid = (v: string) => voiceItems.some((i) => i.handle === v) || builtIn.some((b) => b.id === v);
  const chosenVoice = (voice && valid(voice) ? voice : '') || voiceItems[0]?.handle || builtIn[0]?.id || '';

  // The @word being typed at the caret, if any.
  const token = useMemo(() => {
    const m = /@([a-z0-9_]*)$/i.exec(prompt.slice(0, caret));
    return m ? { q: m[1]!.toLowerCase(), start: caret - m[0].length } : null;
  }, [prompt, caret]);
  const suggestions = token ? library.filter((i) => i.kind !== 'VOICE' && i.handle.startsWith(token.q)).slice(0, 6) : [];
  const mentioned = [...prompt.matchAll(/@([a-z0-9_]{2,32})/gi)].map((m) => m[1]!.toLowerCase());
  const unknown = mentioned.filter((h) => !library.some((i) => i.handle === h));

  function insert(handle: string) {
    if (!token) return;
    const next = `${prompt.slice(0, token.start)}@${handle} ${prompt.slice(caret)}`;
    setPrompt(next);
    const pos = token.start + handle.length + 2;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  }

  async function submit() {
    try {
      await create.mutateAsync({ prompt, language: choice, format, targetS, voice: chosenVoice || undefined, hd, motion });
      toast.success('Scene started', {
        description:
          motion === 'ai'
            ? 'Writing the script, painting each shot, then animating every shot with AI video (~7 min per shot). You can leave this page.'
            : motion === 'hero'
              ? 'Writing the script, painting each shot, then animating the first and last shot (~3 min each). You can leave this page.'
            : hd
              ? 'Writing the script, then painting + upscaling each shot. About 45 s per shot on this computer.'
              : 'Writing the script, then painting each shot. Takes 1-3 minutes on this computer.',
      });
      setPrompt('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the scene');
    }
  }

  const hdReady = cfg.data?.localAi.upscale ?? false;
  // Only send HD when the machine can make it (the API refuses otherwise, before charging).
  const hd = hdWanted && hdReady;
  const videoReady = cfg.data?.localAi.video ?? false;
  const motion = motionWanted !== 'still' && videoReady ? motionWanted : 'still';
  const motionExtra = motion === 'ai' ? (cfg.data?.aiMotionExtra ?? 10) : motion === 'hero' ? (cfg.data?.heroMotionExtra ?? 4) : 0;
  const cost = (hd ? (cfg.data?.hdCost ?? 8) : (cfg.data?.cost ?? 5)) + motionExtra;
  // Rough GPU time: ~4 shots per 20 s; full AI video ~7 min per shot, hero = 2 shots at ~3 min.
  const etaMin = motion === 'ai' ? Math.round(Math.max(2, Math.round(targetS / 5)) * 7.5) : motion === 'hero' ? 7 : 0;
  const offline = cfg.data && !(cfg.data.localAi.llm && cfg.data.localAi.image);
  return (
    <section aria-label="New scene" className="space-y-3 rounded-2xl bg-white/[0.02] p-4 ring-1 ring-white/[0.06]">
      <div className="relative">
        <Textarea
          ref={ref}
          aria-label="Scene brief"
          rows={3}
          maxLength={cfg.data?.limits.prompt ?? 2000}
          value={prompt}
          placeholder="Describe the scene, the voice-over and the sound… e.g. “English voice-over. A boy cycles through misty Shimla at dawn. VO: ‘Some roads you only ride once.’ Sound: wind, bicycle bell.” Type @ for your library."
          onChange={(e) => {
            setPrompt(e.target.value);
            setCaret(e.target.selectionStart);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (suggestions.length && (e.key === 'Enter' || e.key === 'Tab')) {
              e.preventDefault();
              insert(suggestions[0]!.handle);
            }
          }}
          className="resize-none rounded-xl text-sm"
        />
        {suggestions.length > 0 && (
          <ul role="listbox" aria-label="Library suggestions" className="absolute z-10 mt-1 w-72 overflow-hidden rounded-xl bg-popover p-1 shadow-xl ring-1 ring-white/10">
            {suggestions.map((i) => {
              const Icon = KIND_META[i.kind].icon;
              return (
                <li key={i.id}>
                  <button type="button" role="option" aria-selected={false} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(i.handle)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/5">
                    <Icon className="size-3.5 text-primary" />
                    <span className="font-medium">@{i.handle}</span>
                    <span className="truncate text-xs text-muted-foreground">{i.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {mentioned.length > 0 && (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {mentioned.map((h) => {
            const item = library.find((i) => i.handle === h);
            return (
              <span key={h} className={cn('rounded-md px-1.5 py-0.5 ring-1', item ? 'bg-primary/10 ring-primary/30' : 'bg-destructive/10 text-destructive ring-destructive/30')} title={item?.description ?? 'Not in your library'}>
                @{h}
                {!item && ' ?'}
              </span>
            );
          })}
          {unknown.length > 0 && (
            <button type="button" className="text-muted-foreground underline" onClick={onOpenLibrary}>
              add to library
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <Seg
          label="Voice-over language"
          value={choice}
          options={[
            ['auto', 'Auto'],
            ['en', 'English'],
            ['hi', 'हिंदी'],
            ['hinglish', 'Hinglish'],
          ]}
          onChange={(v) => {
            setLanguage(v);
            setVoice('');
          }}
        />
        <Seg label="Format" value={format} options={[['9:16', 'Reel'], ['16:9', 'YouTube'], ['1:1', 'Square']]} onChange={setFormat} />
        <label className="space-y-1">
          <span className="block text-[11px] text-muted-foreground">Length · {targetS}s</span>
          <input type="range" min={6} max={60} step={2} value={targetS} onChange={(e) => setTargetS(Number(e.target.value))} className="w-32 accent-[var(--primary)]" />
        </label>
        <Seg
          label={hdReady ? 'Pictures' : 'Pictures · HD needs the upscaler'}
          value={hd ? 'hd' : 'sd'}
          options={hdReady ? [['sd', 'Fast'], ['hd', 'HD ×4']] : [['sd', 'Fast']]}
          onChange={(v) => setHd(v === 'hd')}
        />
        <Seg
          label={videoReady ? 'Motion' : 'Motion · AI video needs the Wan models'}
          value={motion}
          options={videoReady ? [['still', 'Camera moves'], ['hero', 'Hero shots'], ['ai', 'AI video']] : [['still', 'Camera moves']]}
          onChange={(v) => setMotion(v as 'still' | 'hero' | 'ai')}
        />
        <label className="min-w-0 flex-1 space-y-1 sm:max-w-64">
          <span className="block text-[11px] text-muted-foreground">Narrator</span>
          <select aria-label="Narrator voice" value={chosenVoice} onChange={(e) => setVoice(e.target.value)} className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm">
            {voiceItems.length > 0 && (
              <optgroup label="Your voices">
                {voiceItems.map((v) => (
                  <option key={v.id} value={v.handle}>
                    @{v.handle} · {v.name}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Built-in">
              {builtIn.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} · {v.style}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <Button className="btn-glow ml-auto h-10 rounded-xl" disabled={prompt.trim().length < 3 || !chosenVoice || create.isPending || (me?.credits ?? 0) < cost} onClick={submit}>
          {create.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
          Direct scene
          <span className="inline-flex items-center gap-0.5 text-warning">
            <Coins className="size-3.5" />
            {cost}
          </span>
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {choice === 'auto' && (
          <span className="mr-1 rounded bg-primary/10 px-1 py-0.5 text-foreground ring-1 ring-primary/30">
            Auto → {language === 'en' ? 'English' : language === 'hi' ? 'हिंदी' : 'Hinglish'}
            {prompt.trim() ? (detected.reason === 'asked' ? ' (asked in the brief)' : ' (from how the brief is written)') : ''}
          </span>
        )}
        {language === 'hinglish'
          ? 'Hindi voice-over, captions in Roman letters (“Subah subah chai, yaar”).'
          : language === 'hi'
            ? 'Hindi voice-over, captions in Devanagari.'
            : 'English voice-over and captions.'}
        {hd && ' HD: every shot is upscaled ×4 on the GPU (sharp at 1080×1920), ~45 s per shot.'}
        {motion === 'ai' && ` AI video: every shot really moves (people walk, dance, hair and clothes flow). Slow on this computer: about ${etaMin} min for ${targetS}s. It runs in the background.`}
        {motion === 'hero' && ` Hero shots: the opening and closing shots really move (fast preset), the others use camera moves. About ${etaMin} min.`}
      </p>
      {offline && (
        <p className="flex items-center gap-1.5 text-xs text-amber-300">
          <AlertTriangle className="size-3.5" /> The local AI isn’t running. Start it on this computer with <code className="rounded bg-white/5 px-1">scripts/local-ai/start.sh</code>.
        </p>
      )}
    </section>
  );
}

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="space-y-1">
      <span className="block text-[11px] text-muted-foreground">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex rounded-lg bg-white/[0.04] p-0.5 ring-1 ring-white/[0.06]">
        {options.map(([v, l]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)} className={cn('rounded-md px-2.5 py-1 text-xs transition', value === v ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground')}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Storyboard

function SceneCard({ scene }: { scene: Scene }) {
  const navigate = useNavigate();
  const action = useSceneAction();
  const busy = scene.status === 'PLANNING' || scene.status === 'PRODUCING';
  const shots = scene.script?.shots ?? [];
  const ratio = scene.format === '9:16' ? '9 / 16' : scene.format === '1:1' ? '1 / 1' : '16 / 9';

  function open() {
    if (!scene.draft) return;
    openDraftInEditor(scene.draft, scene.title ?? '');
    navigate('/studio?tool=editor');
  }

  return (
    <article className="space-y-3 rounded-2xl bg-white/[0.02] p-4 ring-1 ring-white/[0.06]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-base font-medium">{scene.title ?? 'Untitled scene'}</h2>
          <p className="line-clamp-1 text-xs text-muted-foreground">{scene.prompt}</p>
        </div>
        <div className="flex items-center gap-2">
          {busy && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary ring-1 ring-primary/30">
              <Loader2 className="size-3 animate-spin" /> {scene.progress ?? 'Queued…'}
            </span>
          )}
          {scene.status === 'READY' && (
            <Button size="sm" className="rounded-lg" onClick={open}>
              <Wand2 /> Open in Editor
            </Button>
          )}
          {scene.status === 'FAILED' && (
            <Button size="sm" variant="secondary" className="rounded-lg" disabled={action.isPending} onClick={() => action.mutate({ id: scene.id, action: 'retry' }, { onError: (e) => toast.error(e.message) })}>
              <RotateCcw /> Retry
            </Button>
          )}
          {!busy && (
            <Button size="sm" variant="ghost" aria-label="Delete scene" className="rounded-lg text-muted-foreground hover:text-destructive" onClick={() => action.mutate({ id: scene.id, action: 'delete' })}>
              <Trash2 />
            </Button>
          )}
        </div>
      </div>
      {scene.status === 'FAILED' && scene.error && <p className="text-xs text-destructive">{scene.error} Pictures already made are kept; Retry continues from there.</p>}

      {shots.length > 0 ? (
        <ol className="flex snap-x gap-3 overflow-x-auto pb-1" aria-label="Storyboard">
          {shots.map((s, i) => {
            const url = s.imageUploadId ? scene.images?.[s.imageUploadId] : undefined;
            const videoUrl = s.videoUploadId ? scene.images?.[s.videoUploadId] : undefined;
            return (
              <li key={i} className="w-44 shrink-0 snap-start space-y-1.5">
                <div className="relative overflow-hidden rounded-xl bg-black ring-1 ring-white/10" style={{ aspectRatio: ratio }}>
                  {videoUrl ? (
                    <video src={videoUrl} poster={url} aria-label={s.visual} className="size-full object-cover" muted loop autoPlay playsInline />
                  ) : url ? (
                    <img src={url} alt={s.visual} className="size-full object-cover" loading="lazy" />
                  ) : (
                    <div className="grid size-full place-items-center text-muted-foreground">{busy ? <Loader2 className="size-5 animate-spin" /> : <Camera className="size-5" />}</div>
                  )}
                  <span className="absolute top-1 left-1 rounded bg-black/70 px-1.5 text-[10px] text-white tabular-nums">
                    {i + 1} · {s.durationS.toFixed(1)}s{videoUrl ? ' · moving' : ''}
                  </span>
                  {s.onScreen && <span className="absolute inset-x-1 top-6 truncate rounded bg-black/60 px-1 text-center text-[10px] text-white">{s.onScreen}</span>}
                </div>
                <p className="line-clamp-2 text-[11px] text-foreground/90" title={s.narration}>
                  {s.narration ? `“${scene.language === 'hinglish' && s.roman ? s.roman : s.narration}”` : <span className="text-muted-foreground">(no narration)</span>}
                </p>
                {scene.language === 'hinglish' && s.roman && s.narration && <p className="line-clamp-1 text-[10px] text-muted-foreground">{s.narration}</p>}
                <p className="flex items-center gap-1 text-[10px] text-muted-foreground" title={s.sound}>
                  <AudioLines className="size-3 shrink-0" />
                  <span className="truncate">{s.sound || '—'}</span>
                </p>
                <p className="flex items-center gap-1 text-[10px] text-muted-foreground" title={s.visual}>
                  <Camera className="size-3 shrink-0" />
                  <span className="truncate">{s.camera} · {s.visual}</span>
                </p>
              </li>
            );
          })}
        </ol>
      ) : busy ? (
        <div className="flex h-24 items-center justify-center gap-2 rounded-xl bg-white/[0.02] text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> The director is writing the shot list…
        </div>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------------------------
// Library manager

function LibraryDialog({ open, onOpenChange, items }: { open: boolean; onOpenChange: (o: boolean) => void; items: LibraryItem[] }) {
  const [kind, setKind] = useState<LibraryKind>('CHARACTER');
  const [editing, setEditing] = useState<Partial<LibraryItem> | null>(null);
  const del = useDeleteItem();
  const list = items.filter((i) => i.kind === kind);
  const Meta = KIND_META[kind];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookUser className="size-4 text-primary" /> Library
          </DialogTitle>
          <DialogDescription>Things your scenes can mention with @. The director copies their descriptions into every shot, so they look the same each time.</DialogDescription>
        </DialogHeader>

        <div role="tablist" aria-label="Library sections" className="flex flex-wrap gap-1">
          {KINDS.map((k) => {
            const Icon = KIND_META[k].icon;
            const n = items.filter((i) => i.kind === k).length;
            return (
              <button key={k} role="tab" aria-selected={kind === k} type="button" onClick={() => { setKind(k); setEditing(null); }} className={cn('inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs ring-1 transition', kind === k ? 'bg-primary/15 ring-primary/40' : 'ring-white/10 text-muted-foreground hover:text-foreground')}>
                <Icon className="size-3.5" /> {KIND_META[k].label} <span className="text-muted-foreground">{n}</span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">{Meta.hint}</p>

        {editing ? (
          <ItemForm key={editing.id ?? 'new'} kind={kind} item={editing} onDone={() => setEditing(null)} />
        ) : (
          <>
            <ul className="grid gap-2 sm:grid-cols-2">
              {list.map((i) => (
                <li key={i.id} className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/[0.06]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      @{i.handle} <span className="font-normal text-muted-foreground">· {i.name}</span>
                    </span>
                    <span className="flex shrink-0 gap-0.5">
                      <Button size="icon" variant="ghost" className="size-7" aria-label={`Edit @${i.handle}`} onClick={() => setEditing(i)}>
                        <Pencil />
                      </Button>
                      <Button size="icon" variant="ghost" className="size-7 hover:text-destructive" aria-label={`Delete @${i.handle}`} onClick={() => del.mutate(i.id)}>
                        <Trash2 />
                      </Button>
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{i.description || summary(i)}</p>
                </li>
              ))}
            </ul>
            <Button variant="secondary" className="rounded-xl" onClick={() => setEditing({ kind })}>
              <Plus /> Add {Meta.label.toLowerCase().replace(/s$/, '')}
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The user's files for the storyboard / sound picker. Own key under 'uploads' so editor changes refresh it. */
function useDirectorUploads() {
  return useQuery({ queryKey: ['uploads', 'director'], queryFn: () => api<{ items: Upload[] }>('/uploads?limit=50').then((r) => r.items), staleTime: 5_000 });
}

const summary = (i: LibraryItem) =>
  i.kind === 'VOICE' ? `${String(i.settings.engine)} · ${String(i.settings.voice)}` : i.kind === 'SOUND' ? ((i.settings.tags as string[] | undefined) ?? []).join(', ') : '';

function ItemForm({ kind, item, onDone }: { kind: LibraryKind; item: Partial<LibraryItem>; onDone: () => void }) {
  const save = useSaveItem();
  const cfg = useScenesConfig();
  const uploads = useDirectorUploads();
  const [handle, setHandle] = useState(item.handle ?? '');
  const [name, setName] = useState(item.name ?? '');
  const [description, setDescription] = useState(item.description ?? '');
  const [settings, setSettings] = useState<Record<string, unknown>>(item.settings ?? (kind === 'VOICE' ? { engine: 'piper', voice: 'hi_IN-rohan-medium', language: 'hi', speed: 1 } : {}));
  const [imageUploadId, setImageUploadId] = useState<string | null>(item.imageUploadId ?? null);
  const [uploading, setUploading] = useState(false);
  const facePreview = (uploads.data ?? []).find((u) => u.id === imageUploadId);

  async function pickFace(file: File | undefined) {
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) return toast.error('Use a PNG or JPEG photo');
    setUploading(true);
    try {
      const up = await uploadFile(file, file.name);
      setImageUploadId(up.id);
      await uploads.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }
  const set = (k: string, v: unknown) => setSettings((s) => ({ ...s, [k]: v === '' ? undefined : v }));

  async function submit() {
    try {
      await save.mutateAsync({ id: item.id, kind, handle, name, description, settings, imageUploadId });
      toast.success(`@${handle} saved`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    }
  }

  const voices = cfg.data?.voices ?? [];
  return (
    <div className="space-y-3 rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/[0.06]">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Handle (what you type after @)</span>
          <Input value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} placeholder="riya" maxLength={32} className="h-9 rounded-lg" />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Riya" maxLength={60} className="h-9 rounded-lg" />
        </label>
      </div>
      {kind !== 'VOICE' && (
        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">Description (English works best for pictures)</span>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={1000} placeholder={kind === 'CHARACTER' ? 'young Indian woman, curly black hair, yellow kurta, silver jhumka earrings' : kind === 'PLACE' ? 'rainy Mumbai street at dusk, yellow-black taxis, Devanagari shop signs' : ''} className="resize-none rounded-lg text-sm" />
        </label>
      )}

      {kind === 'CHARACTER' && (
        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">Look seed (same number = closer look across shots)</span>
          <Input type="number" min={0} value={(settings.seed as number | undefined) ?? ''} onChange={(e) => set('seed', e.target.value === '' ? '' : Number(e.target.value))} placeholder="e.g. 4242" className="h-9 w-40 rounded-lg" />
        </label>
      )}
      {kind === 'CHARACTER' && (
        <div className="space-y-2 rounded-lg bg-white/[0.02] p-2.5 ring-1 ring-white/[0.06]">
          <div className="flex items-start gap-3">
            <div className="size-20 shrink-0 overflow-hidden rounded-lg bg-white/5 ring-1 ring-white/10">
              {facePreview?.url ? <img src={facePreview.url} alt="Face reference" className="size-full object-cover" /> : <User className="m-auto mt-6 size-8 text-muted-foreground" />}
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <p className="text-xs font-medium">Same face in every shot</p>
              <p className="text-[11px] text-muted-foreground">A clear, front-facing photo (PNG/JPEG). The local AI keeps this face in every picture of @{handle || 'character'}.</p>
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1 text-xs ring-1 ring-white/10 hover:bg-white/10">
                {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />}
                {imageUploadId ? 'Change photo' : 'Upload photo'}
                <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => void pickFace(e.target.files?.[0])} />
              </label>
              {imageUploadId && (
                <button type="button" className="ml-2 text-[11px] text-muted-foreground underline" onClick={() => { setImageUploadId(null); setSettings((s) => ({ ...s, faceRef: undefined, faceConsent: undefined })); }}>
                  remove
                </button>
              )}
            </div>
          </div>
          {imageUploadId && (
            <fieldset className="space-y-1">
              <legend className="text-[11px] text-muted-foreground">This photo is… (required to use it as a face)</legend>
              {([
                ['self', 'Me'],
                ['consented', 'Someone who agreed to this'],
                ['ai_generated', 'AI-generated (not a real person)'],
              ] as const).map(([v, l]) => (
                <label key={v} className="mr-3 inline-flex items-center gap-1.5 text-xs">
                  <input type="radio" name="faceConsent" checked={settings.faceConsent === v} onChange={() => setSettings((s) => ({ ...s, faceRef: true, faceConsent: v }))} />
                  {l}
                </label>
              ))}
              <p className="text-[10px] text-muted-foreground">Never use photos of other people without their permission. Videos are labelled AI-generated.</p>
            </fieldset>
          )}
        </div>
      )}
      {kind === 'STYLE' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-[11px] text-muted-foreground">Added to every picture</span>
            <Input value={(settings.promptSuffix as string) ?? ''} onChange={(e) => set('promptSuffix', e.target.value)} placeholder="film grain, warm tones, 35mm" className="h-9 rounded-lg" />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-muted-foreground">Avoid</span>
            <Input value={(settings.negative as string) ?? ''} onChange={(e) => set('negative', e.target.value)} placeholder="cartoon, anime" className="h-9 rounded-lg" />
          </label>
        </div>
      )}
      {kind === 'VOICE' && (
        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">Voice</span>
          <select
            value={String(settings.voice ?? '')}
            onChange={(e) => {
              const v = e.target.value;
              const hi = v.startsWith('hi_');
              setSettings({ engine: v.includes('_') ? 'piper' : 'aura', voice: v, language: hi ? 'hi' : 'en', speed: 1 });
            }}
            className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
          >
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} · {v.style}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === 'SOUND' && (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 sm:col-span-2">
            <span className="text-[11px] text-muted-foreground">Audio file (upload it in the Editor first)</span>
            <select value={String(settings.uploadId ?? '')} onChange={(e) => set('uploadId', e.target.value)} className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm">
              <option value="">Choose…</option>
              {(uploads.data ?? [])
                .filter((u) => u.kind === 'audio' && u.source !== 'TTS')
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fileName}
                  </option>
                ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-muted-foreground">Kind</span>
            <select value={String(settings.role ?? 'ambience')} onChange={(e) => set('role', e.target.value)} className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm">
              <option value="music">Music bed</option>
              <option value="ambience">Ambience</option>
              <option value="sfx">Sound effect</option>
            </select>
          </label>
          <label className="space-y-1 sm:col-span-3">
            <span className="text-[11px] text-muted-foreground">Tags (comma separated: rain, beach, calm…)</span>
            <Input value={((settings.tags as string[] | undefined) ?? []).join(', ')} onChange={(e) => set('tags', e.target.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 12))} className="h-9 rounded-lg" />
          </label>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" className="rounded-lg" onClick={onDone}>
          Cancel
        </Button>
        <Button className="rounded-lg" disabled={handle.length < 2 || !name.trim() || save.isPending} onClick={submit}>
          {save.isPending && <Loader2 className="animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}
