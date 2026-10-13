import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUp, Check, ChevronDown, Coins, Dices, Loader2, Square, RectangleHorizontal, RectangleVertical } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { ApiError, type ModelCatalog } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form';
import { useGenerate } from './use-generation';

// Mirrors the API's Zod schema, so users see the same rules before the request is even sent.
const schema = z.object({
  prompt: z.string().trim().min(3, 'Describe the image in at least 3 characters').max(1000, 'Keep it under 1000 characters'),
  model: z.string().min(1, 'Pick a model'),
  aspectRatio: z.string().min(1),
});
type Values = z.infer<typeof schema>;

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

interface Props {
  catalog: ModelCatalog;
  balance: number;
  /** Lets the page push a prompt into the composer (e.g. "remix" from a result). */
  seed?: { prompt: string; n: number };
}

/**
 * The composer: one big prompt box with the controls docked inside it (model menu, ratio
 * chips, surprise-me, cost + send button). Ctrl/Cmd+Enter sends.
 */
export function GenerateForm({ catalog, balance, seed }: Props) {
  const generate = useGenerate();
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const [focused, setFocused] = useState(false);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { prompt: '', model: catalog.models[0]?.id ?? '', aspectRatio: '1:1' },
  });

  const [modelId, prompt, ratio] = useWatch({ control: form.control, name: ['model', 'prompt', 'aspectRatio'] });
  const selected = catalog.models.find((m) => m.id === modelId);
  const ratios = selected?.aspectRatios ?? catalog.aspectRatios;
  const cost = selected?.credits ?? 0;
  const tooPoor = balance < cost;

  // Keep the chosen ratio valid when switching to a model that supports fewer ratios.
  useEffect(() => {
    if (!ratios.includes(ratio)) form.setValue('aspectRatio', ratios[0] ?? '1:1');
  }, [ratios, ratio, form]);

  useEffect(() => {
    if (!seed) return;
    form.setValue('prompt', seed.prompt, { shouldValidate: false });
    textarea.current?.focus();
  }, [seed, form]);

  // Auto-grow the textarea with its content (up to a cap).
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [prompt]);

  async function submit(values: Values) {
    try {
      await generate.mutateAsync(values);
      toast.success('Rendering…', { description: `${cost} credits reserved. Refunded automatically if it fails.` });
      form.resetField('prompt');
    } catch (err) {
      if (err instanceof ApiError && err.details?.prompt) {
        form.setError('prompt', { message: err.details.prompt[0] });
      } else {
        // 402 / 429 / 503 messages from the API are already written for humans.
        toast.error(err instanceof Error ? err.message : 'Something went wrong');
      }
    }
  }

  function surprise() {
    const pick = SURPRISE[Math.floor(Math.random() * SURPRISE.length)]!;
    form.setValue('prompt', pick, { shouldValidate: true });
    textarea.current?.focus();
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} noValidate>
        <motion.div
          animate={{ boxShadow: focused ? '0 0 0 1px oklch(0.64 0.25 293 / 55%), 0 30px 80px -30px oklch(0.64 0.25 293 / 55%)' : '0 0 0 1px oklch(1 0 0 / 8%), 0 20px 60px -30px oklch(0 0 0 / 80%)' }}
          transition={{ duration: 0.2 }}
          className="glass rounded-2xl p-2"
        >
          <FormField
            control={form.control}
            name="prompt"
            render={({ field }) => (
              <FormItem className="gap-0">
                <FormControl>
                  <textarea
                    {...field}
                    ref={(el) => {
                      field.ref(el);
                      textarea.current = el;
                    }}
                    rows={2}
                    maxLength={MAX}
                    aria-label="Prompt"
                    placeholder="Describe the image you want to create…"
                    onFocus={() => setFocused(true)}
                    onBlur={() => {
                      setFocused(false);
                      field.onBlur();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void form.handleSubmit(submit)();
                    }}
                    className="block w-full resize-none bg-transparent px-3 pb-2 pt-3 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/70"
                  />
                </FormControl>
                <FormMessage className="px-3 pb-1" />
              </FormItem>
            )}
          />

          <div className="flex flex-wrap items-center gap-1.5 px-1 pb-0.5">
            {/* Model menu */}
            <FormField
              control={form.control}
              name="model"
              render={({ field }) => (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.05] px-2.5 text-xs font-medium ring-1 ring-white/10 transition hover:bg-white/[0.09]" aria-label="Model">
                      <span className="size-1.5 rounded-full bg-primary shadow-[0_0_8px_var(--glow)]" />
                      {selected?.name ?? 'Model'}
                      <ChevronDown className="size-3.5 text-muted-foreground" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-72">
                    <DropdownMenuLabel className="text-xs text-muted-foreground">Model</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {catalog.models.map((m) => (
                      <DropdownMenuItem key={m.id} onSelect={() => field.onChange(m.id)} className="items-start gap-3 py-2">
                        <Check className={cn('mt-0.5 size-4', field.value === m.id ? 'opacity-100 text-primary' : 'opacity-0')} />
                        <div className="flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">{m.name}</span>
                            <span className="inline-flex items-center gap-1 text-xs tabular-nums text-warning">
                              <Coins className="size-3" />
                              {m.credits}
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">{m.description}</p>
                        </div>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            />

            {/* Ratio chips */}
            <FormField
              control={form.control}
              name="aspectRatio"
              render={({ field }) => (
                <div role="radiogroup" aria-label="Aspect ratio" className="flex items-center gap-0.5 rounded-lg bg-white/[0.03] p-0.5 ring-1 ring-white/10">
                  {ratios.map((r) => {
                    const Icon = ratioIcon(r);
                    const active = field.value === r;
                    return (
                      <button
                        key={r}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        aria-label={`Aspect ratio ${r}`}
                        onClick={() => field.onChange(r)}
                        className={cn('relative inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs tabular-nums transition', active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
                      >
                        {active && <motion.span layoutId="ratio-pill" className="absolute inset-0 rounded-md bg-white/10" transition={{ type: 'spring', stiffness: 500, damping: 35 }} />}
                        <Icon className="relative size-3.5" />
                        <span className="relative">{r}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            />

            <button
              type="button"
              onClick={surprise}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition hover:bg-white/[0.05] hover:text-foreground"
            >
              <Dices className="size-3.5" />
              Surprise me
            </button>

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
        </motion.div>
        <p className={cn('mt-2 text-center text-xs', tooPoor ? 'text-destructive' : 'text-muted-foreground/70')}>
          {tooPoor ? `Not enough credits: you have ${balance}, this costs ${cost}.` : `${balance} credits left · Ctrl + Enter to generate`}
        </p>
      </form>
    </Form>
  );
}
