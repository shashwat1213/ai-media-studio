import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUp, Check, Coins, Dices, Loader2, RectangleHorizontal, RectangleVertical, Square } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { ApiError, type ModelCatalog } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { SettingsGroup } from '@/features/studio/studio-layout';
import { useGenerate } from './use-generation';

// Mirrors the API's rules, so users see them before the request is even sent.
const PromptSchema = z.string().trim().min(3, 'Describe the image in at least 3 characters').max(1000, 'Keep it under 1000 characters');
const MAX = 1000;

export const SURPRISE = [
  'a lone astronaut in a field of glowing violet flowers, 35mm film, soft grain',
  'neon-lit Tokyo alley in the rain, cinematic, reflections on wet asphalt',
  'a glass whale floating above the clouds at golden hour, dreamy',
  'portrait of an old fisherman, dramatic rim light, ultra detailed',
  'isometric tiny cozy library inside a mushroom, warm lamps, miniature',
  'macro photo of a dew drop on a fern leaf, bokeh, morning light',
  'brutalist concrete house on a cliff above a stormy sea, moody',
  'a red fox curled up in fresh snow, wildlife photography, 600mm',
];

const ratioIcon = (r: string) => (r === '1:1' ? Square : Number(r.split(':')[0]) > Number(r.split(':')[1]) ? RectangleHorizontal : RectangleVertical);

/** Model + ratio, owned by the Studio page so the settings panel and the composer share them. */
export interface ImageSettingsValue {
  model: string;
  aspectRatio: string;
}

export function useImageSettings(catalog: ModelCatalog | undefined) {
  const [value, setValue] = useState<ImageSettingsValue>({ model: '', aspectRatio: '1:1' });
  const model = catalog?.models.find((m) => m.id === value.model) ?? catalog?.models[0];
  const ratios = model?.aspectRatios ?? catalog?.aspectRatios ?? ['1:1'];
  // Keep the ratio valid when switching to a model that supports fewer ratios.
  const aspectRatio = ratios.includes(value.aspectRatio) ? value.aspectRatio : (ratios[0] ?? '1:1');
  return { model, ratios, aspectRatio, set: (patch: Partial<ImageSettingsValue>) => setValue((v) => ({ ...v, ...patch })) };
}

type Settings = ReturnType<typeof useImageSettings>;

/** Right panel: model cards with prices, ratio grid. */
export function ImageSettings({ catalog, settings }: { catalog: ModelCatalog; settings: Settings }) {
  return (
    <>
      <SettingsGroup title="Model">
        <div role="radiogroup" aria-label="Model" className="space-y-1.5">
          {catalog.models.map((m) => {
            const active = settings.model?.id === m.id;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => settings.set({ model: m.id })}
                className={cn(
                  'flex w-full items-start gap-3 rounded-xl p-3 text-left ring-1 transition',
                  active ? 'bg-primary/10 ring-primary/40' : 'bg-white/[0.02] ring-white/[0.06] hover:bg-white/[0.05]',
                )}
              >
                <span className={cn('mt-0.5 grid size-4 shrink-0 place-items-center rounded-full ring-1', active ? 'bg-primary ring-primary' : 'ring-white/20')}>
                  {active && <Check className="size-3 text-white" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{m.name}</span>
                    <span className="inline-flex items-center gap-1 text-xs tabular-nums text-warning">
                      <Coins className="size-3" />
                      {m.credits}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{m.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Aspect ratio" aside={settings.ratios.length === 1 ? <span className="text-[11px] text-muted-foreground">Square only</span> : null}>
        <div role="radiogroup" aria-label="Aspect ratio" className="grid grid-cols-5 gap-1.5">
          {catalog.aspectRatios.map((r) => {
            const Icon = ratioIcon(r);
            const supported = settings.ratios.includes(r);
            const active = settings.aspectRatio === r;
            return (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={`Aspect ratio ${r}`}
                disabled={!supported}
                title={supported ? r : `${settings.model?.name} only supports ${settings.ratios.join(', ')}`}
                onClick={() => settings.set({ aspectRatio: r })}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-lg py-2 text-[11px] tabular-nums ring-1 transition disabled:cursor-not-allowed disabled:opacity-30',
                  active ? 'bg-primary/10 text-foreground ring-primary/40' : 'text-muted-foreground ring-white/[0.06] hover:text-foreground enabled:hover:bg-white/[0.04]',
                )}
              >
                <Icon className="size-4" />
                {r}
              </button>
            );
          })}
        </div>
      </SettingsGroup>
    </>
  );
}

interface ComposerProps {
  settings: Settings;
  balance: number;
  /** Lets the page push a prompt in (remix / "try this" from Explore). */
  seed?: { prompt: string; n: number };
}

/** The prompt box at the top of the canvas. Ctrl/Cmd+Enter sends. */
export function ImageComposer({ settings, balance, seed }: ComposerProps) {
  const generate = useGenerate();
  const ref = useRef<HTMLTextAreaElement>(null);
  // A new seed remounts this component (see `key` in the Studio), so it starts from it.
  const [prompt, setPrompt] = useState(seed?.prompt ?? '');
  const [error, setError] = useState<string>();
  const [focused, setFocused] = useState(false);
  const cost = settings.model?.credits ?? 0;
  const tooPoor = balance < cost;

  // Focus the box when a seed arrives (DOM side effect only, no state).
  useEffect(() => {
    if (seed) ref.current?.focus();
  }, [seed]);

  // Auto-grow with the content (up to a cap).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [prompt]);

  async function submit() {
    const parsed = PromptSchema.safeParse(prompt);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message);
    if (!settings.model) return;
    setError(undefined);
    try {
      await generate.mutateAsync({ prompt: parsed.data, model: settings.model.id, aspectRatio: settings.aspectRatio });
      toast.success('Rendering…', { description: `${cost} credits reserved. Refunded automatically if it fails.` });
      setPrompt('');
    } catch (err) {
      if (err instanceof ApiError && err.details?.prompt) setError(err.details.prompt[0]);
      // 402 / 429 / 503 messages from the API are already written for humans.
      else toast.error(err instanceof Error ? err.message : 'Something went wrong');
    }
  }

  return (
    <div>
      <motion.form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
        animate={{
          boxShadow: focused
            ? '0 0 0 1px oklch(0.64 0.25 293 / 55%), 0 30px 80px -30px oklch(0.64 0.25 293 / 55%)'
            : '0 0 0 1px oklch(1 0 0 / 8%), 0 20px 60px -30px oklch(0 0 0 / 80%)',
        }}
        transition={{ duration: 0.2 }}
        className="glass rounded-2xl p-2"
      >
        <textarea
          ref={ref}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={2}
          maxLength={MAX}
          aria-label="Prompt"
          aria-invalid={Boolean(error)}
          placeholder="Describe the image you want to create…"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          }}
          className="block w-full resize-none bg-transparent px-3 pb-2 pt-3 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/70"
        />
        {error && (
          <p role="alert" className="px-3 pb-1 text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-center gap-1.5 px-1 pb-0.5">
          <button
            type="button"
            onClick={() => {
              setPrompt(SURPRISE[Math.floor(Math.random() * SURPRISE.length)]!);
              setError(undefined);
              ref.current?.focus();
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition hover:bg-white/[0.05] hover:text-foreground"
          >
            <Dices className="size-3.5" />
            Surprise me
          </button>
          <span className="hidden truncate text-xs text-muted-foreground/70 sm:inline">
            {settings.model?.name} · {settings.aspectRatio}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <span className={cn('hidden text-xs tabular-nums sm:inline', prompt.length > MAX * 0.9 ? 'text-warning' : 'text-muted-foreground/70')}>
              {prompt.length}/{MAX}
            </span>
            <Button
              type="submit"
              disabled={generate.isPending || tooPoor || prompt.trim().length < 3}
              className="btn-glow h-9 rounded-xl px-3.5"
              title={tooPoor ? `Not enough credits: you have ${balance}, this costs ${cost}` : 'Generate (Ctrl + Enter)'}
            >
              <AnimatePresence mode="wait" initial={false}>
                {generate.isPending ? (
                  <motion.span key="l" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <Loader2 className="animate-spin" />
                  </motion.span>
                ) : (
                  <motion.span key="c" className="inline-flex items-center gap-1.5" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <Coins className="size-3.5" />
                    <span className="tabular-nums">{cost}</span>
                  </motion.span>
                )}
              </AnimatePresence>
              <span className="mx-0.5 h-4 w-px bg-white/25" />
              <ArrowUp className="size-4" />
              <span className="sr-only">Generate</span>
            </Button>
          </div>
        </div>
      </motion.form>
      <p className={cn('mt-2 text-center text-xs', tooPoor ? 'text-destructive' : 'text-muted-foreground/70')}>
        {tooPoor ? `Not enough credits: you have ${balance}, this costs ${cost}.` : `${balance} credits left · Ctrl + Enter to generate`}
      </p>
    </div>
  );
}
