import { useState } from 'react';
import { Link } from 'react-router';
import { motion } from 'framer-motion';
import { Images, Loader2, Wand2 } from 'lucide-react';
import type { Asset } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AssetLightbox } from '@/features/generation/asset-lightbox';
import { useAssets, useModels } from '@/features/generation/use-generation';

export function GalleryPage() {
  const assets = useAssets(24);
  const models = useModels();
  const [open, setOpen] = useState<Asset | null>(null);
  const items = assets.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <motion.div className="mx-auto max-w-6xl space-y-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Gallery</h1>
          <p className="text-sm text-muted-foreground">Every image you've generated. Click one for details.</p>
        </div>
        <Button asChild>
          <Link to="/generate">
            <Wand2 />
            New image
          </Link>
        </Button>
      </div>

      {assets.isLoading ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="aspect-square w-full rounded-xl" />
          ))}
        </div>
      ) : assets.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn't load your gallery: {assets.error.message}
        </p>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center">
          <Images className="size-8 text-muted-foreground" />
          <div>
            <p className="font-medium">No images yet</p>
            <p className="text-sm text-muted-foreground">Generate your first one and it will appear here.</p>
          </div>
          <Button asChild variant="outline">
            <Link to="/generate">Start generating</Link>
          </Button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {items.map((a, i) => (
              <motion.button
                key={a.id}
                type="button"
                onClick={() => setOpen(a)}
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: Math.min(i, 12) * 0.02 }}
                className="group relative aspect-square overflow-hidden rounded-xl bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Open: ${a.prompt}`}
              >
                <img
                  src={a.url}
                  alt={a.prompt ?? 'Generated image'}
                  loading="lazy"
                  className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
                <span className="absolute inset-x-0 bottom-0 line-clamp-2 bg-gradient-to-t from-black/70 to-transparent p-2 pt-6 text-left text-xs text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  {a.prompt}
                </span>
              </motion.button>
            ))}
          </div>
          {assets.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => assets.fetchNextPage()} disabled={assets.isFetchingNextPage}>
                {assets.isFetchingNextPage && <Loader2 className="animate-spin" />}
                Load more
              </Button>
            </div>
          )}
        </>
      )}

      <AssetLightbox asset={open} models={models.data?.models} onClose={() => setOpen(null)} />
    </motion.div>
  );
}
