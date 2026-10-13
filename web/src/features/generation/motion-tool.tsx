import { useState } from 'react';
import { Link } from 'react-router';
import { Check, Clapperboard, Coins, ImageIcon, Info, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import type { Asset, MotionCatalog } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SettingsGroup } from '@/features/studio/studio-layout';
import { CameraPreview } from './camera-preview';
import { useAnimate, useAssets } from './use-generation';

export interface MotionState {
  sourceId: string | null;
  preset: string;
  durationS: number;
}

/**
 * Shared between the settings panel and the canvas.
 * The chosen image lives in the URL (?src=), so "Animate" from anywhere is just a link and the
 * choice survives a refresh. Preset + length are local UI state.
 */
export function useMotionState(catalog: MotionCatalog | undefined, sourceId: string | null, setSourceId: (id: string) => void) {
  const [local, setLocal] = useState({ preset: 'push-in', durationS: 5 });
  const images = useAssets(30, 'image');
  const list = images.data?.pages.flatMap((p) => p.items) ?? [];
  // No ?src= yet: default to the newest image so the canvas is never empty when the user has any.
  const source = sourceId ? list.find((a) => a.id === sourceId) : list[0];
  const state: MotionState = { sourceId: source?.id ?? sourceId, ...local };
  const price = catalog?.durations.find((d) => d.seconds === local.durationS)?.credits ?? local.durationS;
  const set = ({ sourceId: id, ...rest }: Partial<MotionState>) => {
    if (id) setSourceId(id);
    if (Object.keys(rest).length) setLocal((s) => ({ ...s, ...rest }));
  };
  return { state, set, images, list, source, price };
}

type Motion = ReturnType<typeof useMotionState>;

export function MotionSettings({ catalog, m, balance }: { catalog: MotionCatalog; m: Motion; balance: number }) {
  const animate = useAnimate();
  const tooPoor = balance < m.price;

  async function run() {
    if (!m.source) return;
    try {
      await animate.mutateAsync({ sourceAssetId: m.source.id, preset: m.state.preset, durationS: m.state.durationS });
      toast.success('Rendering video…', { description: `${m.price} credits reserved. Refunded automatically if it fails.` });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    }
  }

  return (
    <>
      <SettingsGroup title="Source image" aside={<span className="text-[11px] text-muted-foreground">{m.list.length} images</span>}>
        {m.images.isLoading ? (
          <div className="grid grid-cols-4 gap-1.5">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))}
          </div>
        ) : m.list.length === 0 ? (
          <p className="rounded-xl bg-white/[0.03] p-3 text-xs text-muted-foreground">Create an image first, then bring it to life here.</p>
        ) : (
          <div role="radiogroup" aria-label="Source image" className="grid max-h-48 grid-cols-4 gap-1.5 overflow-y-auto pr-0.5">
            {m.list.map((a) => {
              const active = m.source?.id === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={a.prompt ?? 'Image'}
                  title={a.prompt}
                  onClick={() => m.set({ sourceId: a.id })}
                  className={cn('relative aspect-square overflow-hidden rounded-lg ring-2 transition', active ? 'ring-primary' : 'ring-transparent opacity-70 hover:opacity-100')}
                >
                  <img src={a.url} alt="" loading="lazy" className="size-full object-cover" />
                  {active && (
                    <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-primary">
                      <Check className="size-3 text-white" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title="Camera move">
        <div role="radiogroup" aria-label="Camera move" className="grid grid-cols-2 gap-1.5">
          {catalog.presets.map((p) => {
            const active = m.state.preset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={active}
                title={p.description}
                onClick={() => m.set({ preset: p.id })}
                className={cn(
                  'group overflow-hidden rounded-xl text-left ring-1 transition',
                  active ? 'bg-primary/10 ring-primary/50' : 'bg-white/[0.02] ring-white/[0.06] hover:ring-white/20',
                )}
              >
                {m.source ? (
                  <CameraPreview src={m.source.url} preset={p.id} playing={active} seconds={2.5} className="aspect-video" />
                ) : (
                  <div className="grid aspect-video place-items-center bg-white/[0.03]">
                    <ImageIcon className="size-4 text-muted-foreground" />
                  </div>
                )}
                <span className="block px-2 py-1.5 text-xs font-medium">{p.name}</span>
              </button>
            );
          })}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Length">
        <div role="radiogroup" aria-label="Length" className="grid grid-cols-3 gap-1.5">
          {catalog.durations.map((d) => {
            const active = m.state.durationS === d.seconds;
            return (
              <button
                key={d.seconds}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => m.set({ durationS: d.seconds })}
                className={cn(
                  'rounded-lg py-2 text-center ring-1 transition',
                  active ? 'bg-primary/10 ring-primary/40' : 'ring-white/[0.06] hover:bg-white/[0.04]',
                )}
              >
                <span className="block text-sm font-medium tabular-nums">{d.seconds}s</span>
                <span className="inline-flex items-center gap-1 text-[11px] tabular-nums text-warning">
                  <Coins className="size-3" />
                  {d.credits}
                </span>
              </button>
            );
          })}
        </div>
      </SettingsGroup>

      <div className="mt-5 space-y-2">
        <Button
          className="btn-glow h-11 w-full rounded-xl"
          disabled={!m.source || animate.isPending || tooPoor}
          onClick={run}
          title={tooPoor ? `Not enough credits: you have ${balance}, this costs ${m.price}` : undefined}
        >
          {animate.isPending ? <Loader2 className="animate-spin" /> : <Clapperboard />}
          Animate · {m.price} credits
        </Button>
        <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
          <Info className="mt-px size-3 shrink-0" />
          {catalog.engine === 'camera'
            ? 'A cinematic camera move over your still image, rendered on our server. The scene itself stays still.'
            : 'AI image-to-video.'}
        </p>
      </div>
    </>
  );
}

/** Big live preview of the chosen move on the chosen image (top of the canvas). */
export function MotionStage({ m, presets }: { m: Motion; presets: MotionCatalog['presets'] }) {
  const p = presets.find((x) => x.id === m.state.preset);
  if (m.images.isLoading) return <Skeleton className="aspect-video w-full rounded-2xl" />;
  if (!m.source) {
    return (
      <div className="flex aspect-video flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/10 text-center">
        <Clapperboard className="size-6 text-primary" />
        <p className="text-sm text-muted-foreground">No images to animate yet.</p>
        <Button asChild size="sm" className="btn-glow rounded-xl">
          <Link to="/studio?tool=image">Create an image</Link>
        </Button>
      </div>
    );
  }
  return <Stage source={m.source} preset={m.state.preset} seconds={m.state.durationS} label={p?.name} />;
}

function Stage({ source, preset, seconds, label }: { source: Asset; preset: string; seconds: number; label?: string }) {
  return (
    <div className="relative flex justify-center overflow-hidden rounded-2xl bg-black ring-1 ring-white/[0.07]">
      {/* Same shape as the source = same shape as the rendered video, so the preview is honest. */}
      <CameraPreview
        src={source.url}
        preset={preset}
        playing
        seconds={seconds}
        alt={source.prompt}
        className="h-[min(52vh,560px)] max-w-full"
        style={{ aspectRatio: `${source.width ?? 1} / ${source.height ?? 1}` }}
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 bg-gradient-to-t from-black/80 to-transparent p-4 pt-12">
        <p className="line-clamp-1 text-xs text-white/80">{source.prompt}</p>
        <span className="shrink-0 rounded-md bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">
          Preview · {label} · {seconds}s
        </span>
      </div>
    </div>
  );
}
