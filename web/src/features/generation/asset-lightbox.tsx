import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Clapperboard, Copy, Download, Trash2, Wand2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { Asset, ModelOption } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useDeleteAsset } from './use-generation';
import { dateFmt, formatBytes, modelName } from './format';

interface Props {
  asset: Asset | null;
  models?: ModelOption[];
  onClose: () => void;
  /** Gallery navigation (← / → keys too). Omit to hide the arrows. */
  onPrev?: () => void;
  onNext?: () => void;
  /** Put this prompt back into the composer. Default: go to the Studio with it. */
  onRemix?: (prompt: string) => void;
  /** Send this image to the Motion tool. Default: navigate there. */
  onAnimate?: (assetId: string) => void;
}

/** Full-screen viewer: image on black, details panel, keyboard navigation. */
export function AssetLightbox({ asset, models, onClose, onPrev, onNext, onRemix, onAnimate }: Props) {
  const del = useDeleteAsset();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!asset) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') onPrev?.();
      if (e.key === 'ArrowRight') onNext?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [asset, onPrev, onNext]);

  async function copyPrompt() {
    if (!asset?.prompt) return;
    await navigator.clipboard.writeText(asset.prompt);
    toast.success('Prompt copied');
  }

  function remix() {
    if (!asset?.prompt) return;
    if (onRemix) onRemix(asset.prompt);
    else navigate('/studio?tool=image', { state: { remix: asset.prompt } });
    onClose();
  }

  function animate() {
    if (!asset) return;
    if (onAnimate) onAnimate(asset.id);
    else navigate(`/studio?tool=motion&src=${asset.id}`);
    onClose();
  }

  const video = asset?.kind === 'video';

  async function remove() {
    if (!asset) return;
    try {
      await del.mutateAsync(asset.id);
      toast.success('Image deleted');
      setConfirming(false);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete');
    }
  }

  return (
    <>
      <Dialog open={Boolean(asset)} onOpenChange={(o) => !o && onClose()}>
        <DialogContent
          showCloseButton={false}
          className="max-w-6xl gap-0 overflow-hidden rounded-2xl border-white/10 bg-card p-0 sm:max-w-6xl"
        >
          {asset && (
            <div className="grid max-h-[90vh] md:grid-cols-[1fr_320px]">
              <div className="relative flex min-h-[40vh] items-center justify-center bg-black">
                <AnimatePresence mode="wait">
                  {video ? (
                    <motion.video
                      key={asset.id}
                      src={asset.url}
                      aria-label={asset.prompt ?? 'Generated video'}
                      controls
                      autoPlay
                      loop
                      muted
                      playsInline
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="max-h-[78vh] w-full object-contain"
                    />
                  ) : (
                    <motion.img
                      key={asset.id}
                      src={asset.url}
                      alt={asset.prompt ?? 'Generated image'}
                      initial={{ opacity: 0, scale: 0.98 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="max-h-[78vh] w-full object-contain"
                    />
                  )}
                </AnimatePresence>
                {onPrev && (
                  <NavArrow side="left" onClick={onPrev} label="Previous image">
                    <ChevronLeft />
                  </NavArrow>
                )}
                {onNext && (
                  <NavArrow side="right" onClick={onNext} label="Next image">
                    <ChevronRight />
                  </NavArrow>
                )}
              </div>

              <div className="flex flex-col gap-5 overflow-y-auto border-l border-white/[0.06] p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <DialogTitle className="text-base">Details</DialogTitle>
                    <DialogDescription className="text-xs">{dateFmt.format(new Date(asset.createdAt))}</DialogDescription>
                  </div>
                  <DialogClose className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-white/5 hover:text-foreground" aria-label="Close">
                    <X className="size-4" />
                  </DialogClose>
                </div>

                <div className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/[0.06]">
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Prompt</p>
                  <p className="max-h-40 overflow-y-auto text-sm leading-relaxed">{asset.prompt}</p>
                </div>

                <dl className="grid grid-cols-2 gap-y-2 text-xs">
                  <dt className="text-muted-foreground">Type</dt>
                  <dd className="text-right">{video ? `Video · ${Math.round((asset.durationMs ?? 0) / 1000)}s` : 'Image'}</dd>
                  <dt className="text-muted-foreground">{video ? 'Engine' : 'Model'}</dt>
                  <dd className="text-right">{video ? 'Camera motion' : asset.model ? modelName(models, asset.model) : '—'}</dd>
                  <dt className="text-muted-foreground">Aspect ratio</dt>
                  <dd className="text-right">{asset.aspectRatio ?? '—'}</dd>
                  {asset.width && asset.height && (
                    <>
                      <dt className="text-muted-foreground">Resolution</dt>
                      <dd className="text-right tabular-nums">
                        {asset.width}×{asset.height}
                      </dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">File</dt>
                  <dd className="text-right tabular-nums">
                    {formatBytes(asset.bytes)} · {asset.mimeType.split('/')[1]?.toUpperCase()}
                  </dd>
                </dl>

                <div className="mt-auto grid gap-2">
                  {!video && (
                    <Button className="btn-glow rounded-xl" onClick={animate}>
                      <Clapperboard />
                      Animate
                    </Button>
                  )}
                  <Button variant={video ? 'default' : 'secondary'} className={video ? 'btn-glow rounded-xl' : 'rounded-xl'} onClick={remix}>
                    <Wand2 />
                    Remix prompt
                  </Button>
                  <div className="grid grid-cols-2 gap-2">
                    <Button asChild variant="outline" className="rounded-xl">
                      <a href={asset.downloadUrl}>
                        <Download />
                        Download
                      </a>
                    </Button>
                    <Button variant="outline" className="rounded-xl" onClick={copyPrompt}>
                      <Copy />
                      Copy
                    </Button>
                  </div>
                  <Button variant="ghost" className="rounded-xl text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setConfirming(true)}>
                    <Trash2 />
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this image?</AlertDialogTitle>
            <AlertDialogDescription>
              The file is removed from storage permanently. Credits are not refunded for completed generations. Videos made from it are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove} disabled={del.isPending} className="rounded-xl bg-destructive text-white hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function NavArrow({ side, onClick, label, children }: { side: 'left' | 'right'; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`absolute top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white ring-1 ring-white/15 backdrop-blur transition hover:bg-black/75 [&_svg]:size-5 ${side === 'left' ? 'left-3' : 'right-3'}`}
    >
      {children}
    </button>
  );
}
