import { useState } from 'react';
import { Copy, Download, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { Asset, ModelOption } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
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
}

/** Full-size view of one image with its details and actions. */
export function AssetLightbox({ asset, models, onClose }: Props) {
  const del = useDeleteAsset();
  const [confirming, setConfirming] = useState(false);

  async function copyPrompt() {
    if (!asset?.prompt) return;
    await navigator.clipboard.writeText(asset.prompt);
    toast.success('Prompt copied');
  }

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
        <DialogContent className="max-w-4xl gap-0 overflow-hidden p-0 sm:max-w-4xl">
          {asset && (
            <div className="grid md:grid-cols-[1fr_280px]">
              <div className="flex items-center justify-center bg-muted">
                <img src={asset.url} alt={asset.prompt ?? 'Generated image'} className="max-h-[75vh] w-full object-contain" />
              </div>
              <div className="flex flex-col gap-4 p-5">
                <div className="space-y-1">
                  <DialogTitle className="text-base">Image details</DialogTitle>
                  <DialogDescription className="text-xs">{dateFmt.format(new Date(asset.createdAt))}</DialogDescription>
                </div>
                <p className="max-h-48 overflow-y-auto text-sm leading-relaxed">{asset.prompt}</p>
                <dl className="grid grid-cols-2 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">Model</dt>
                  <dd className="text-right">{asset.model ? modelName(models, asset.model) : '—'}</dd>
                  <dt className="text-muted-foreground">Aspect ratio</dt>
                  <dd className="text-right">{asset.aspectRatio ?? '—'}</dd>
                  {asset.width && asset.height && (
                    <>
                      <dt className="text-muted-foreground">Size</dt>
                      <dd className="text-right tabular-nums">
                        {asset.width}×{asset.height}
                      </dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">File</dt>
                  <dd className="text-right tabular-nums">{formatBytes(asset.bytes)}</dd>
                </dl>
                <div className="mt-auto grid gap-2">
                  <Button asChild>
                    <a href={asset.downloadUrl}>
                      <Download />
                      Download
                    </a>
                  </Button>
                  <Button variant="outline" onClick={copyPrompt}>
                    <Copy />
                    Copy prompt
                  </Button>
                  <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirming(true)}>
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
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this image?</AlertDialogTitle>
            <AlertDialogDescription>
              The file is removed from storage permanently. Credits are not refunded for completed generations.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove} disabled={del.isPending} className="bg-destructive text-white hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
