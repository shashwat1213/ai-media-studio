import { useState } from 'react';
import { Link } from 'react-router';
import { motion } from 'framer-motion';
import { Images, Loader2, Plus } from 'lucide-react';
import type { Asset } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AssetLightbox } from '@/features/generation/asset-lightbox';
import { useAssets, useModels } from '@/features/generation/use-generation';
import { aspectClass } from '@/features/generation/format';

export function GalleryPage() {
  const assets = useAssets(24);
  const models = useModels();
  const [index, setIndex] = useState<number | null>(null);
  const items = assets.data?.pages.flatMap((p) => p.items) ?? [];
  const open: Asset | null = index === null ? null : (items[index] ?? null);

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Gallery</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {items.length ? `${items.length}${assets.hasNextPage ? '+' : ''} images` : 'Every image you create lands here.'}
          </p>
        </div>
        <Button asChild className="btn-glow rounded-xl">
          <Link to="/generate">
            <Plus />
            New image
          </Link>
        </Button>
      </div>

      {assets.isLoading ? (
        <div className="columns-2 gap-3 md:columns-3 lg:columns-4 xl:columns-5">
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className={`mb-3 w-full rounded-2xl ${i % 3 ? 'aspect-square' : 'aspect-[3/4]'}`} />
          ))}
        </div>
      ) : assets.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn't load your gallery: {assets.error.message}
        </p>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-white/10 py-20 text-center">
          <div className="grid size-12 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/25">
            <Images className="size-5" />
          </div>
          <div>
            <p className="font-medium">No images yet</p>
            <p className="text-sm text-muted-foreground">Generate your first one and it will appear here.</p>
          </div>
          <Button asChild className="btn-glow rounded-xl">
            <Link to="/generate">Start creating</Link>
          </Button>
        </div>
      ) : (
        <>
          {/* Masonry via CSS columns: each image keeps its own aspect ratio. */}
          <div className="columns-2 gap-3 md:columns-3 lg:columns-4 xl:columns-5">
            {items.map((a, i) => (
              <motion.button
                key={a.id}
                type="button"
                onClick={() => setIndex(i)}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i, 15) * 0.03 }}
                className={`group relative mb-3 block w-full break-inside-avoid overflow-hidden rounded-2xl bg-card ring-1 ring-white/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${aspectClass[a.aspectRatio ?? '1:1'] ?? 'aspect-square'}`}
                aria-label={`Open: ${a.prompt}`}
              >
                <img
                  src={a.url}
                  alt={a.prompt ?? 'Generated image'}
                  loading="lazy"
                  className="size-full object-cover transition duration-500 group-hover:scale-105 group-hover:brightness-110"
                />
                <span className="absolute inset-x-0 bottom-0 translate-y-2 bg-gradient-to-t from-black/85 to-transparent p-3 pt-10 text-left text-xs leading-snug text-white opacity-0 transition duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
                  <span className="line-clamp-2">{a.prompt}</span>
                </span>
              </motion.button>
            ))}
          </div>
          {assets.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" className="rounded-xl" onClick={() => assets.fetchNextPage()} disabled={assets.isFetchingNextPage}>
                {assets.isFetchingNextPage && <Loader2 className="animate-spin" />}
                Load more
              </Button>
            </div>
          )}
        </>
      )}

      <AssetLightbox
        asset={open}
        models={models.data?.models}
        onClose={() => setIndex(null)}
        onPrev={index !== null && index > 0 ? () => setIndex(index - 1) : undefined}
        onNext={index !== null && index < items.length - 1 ? () => setIndex(index + 1) : undefined}
      />
    </div>
  );
}
