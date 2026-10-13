import { useState } from 'react';
import { useLocation } from 'react-router';
import { motion } from 'framer-motion';
import { FlaskConical, Sparkles } from 'lucide-react';
import type { Asset, Job } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '@/features/auth/use-auth';
import { GenerateForm, SURPRISE } from '@/features/generation/generate-form';
import { JobCard } from '@/features/generation/job-card';
import { AssetLightbox } from '@/features/generation/asset-lightbox';
import { useModels, useRecentJobs } from '@/features/generation/use-generation';

const toAsset = (j: Job): Asset | null =>
  j.asset ? { ...j.asset, prompt: j.prompt, model: j.model, aspectRatio: j.aspectRatio } : null;

export function GeneratePage() {
  const { data: user } = useMe();
  const models = useModels();
  const jobs = useRecentJobs(24);
  const [open, setOpen] = useState<Asset | null>(null);
  const incoming = (useLocation().state as { remix?: string } | null)?.remix;
  const [seed, setSeed] = useState<{ prompt: string; n: number } | undefined>(incoming ? { prompt: incoming, n: 0 } : undefined);
  const remix = (prompt: string) => setSeed((s) => ({ prompt, n: (s?.n ?? 0) + 1 }));
  const items = jobs.data?.items ?? [];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mx-auto max-w-3xl text-center">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          What will you <span className="text-gradient">create</span> today?
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">Describe it. It renders in the background, so keep going.</p>
      </div>

      <div className="sticky top-[76px] z-30 mx-auto mt-6 max-w-3xl md:top-[84px]">
        {models.isLoading || !user ? (
          <Skeleton className="h-[116px] w-full rounded-2xl" />
        ) : models.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Couldn't load models: {models.error.message}
          </p>
        ) : (
          <GenerateForm catalog={models.data!} balance={user.credits} seed={seed} />
        )}
      </div>

      {models.data?.mode === 'stub' && (
        <div className="mx-auto mt-4 flex max-w-3xl items-start gap-3 rounded-xl border border-warning/20 bg-warning/[0.06] p-3 text-xs text-warning/90">
          <FlaskConical className="mt-0.5 size-4 shrink-0" />
          <p>
            <span className="font-medium">Demo mode:</span> no AI provider configured, so images are free placeholder art. The queue, worker, storage
            and credits are all real. Add <code className="rounded bg-warning/15 px-1">[fail]</code> or{' '}
            <code className="rounded bg-warning/15 px-1">[flaky]</code> to a prompt to see the automatic refund.
          </p>
        </div>
      )}

      <section aria-label="Your generations" className="mt-10">
        {jobs.isLoading ? (
          <div className="columns-2 gap-3 md:columns-3 lg:columns-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="mb-3 aspect-square w-full rounded-2xl" />
            ))}
          </div>
        ) : jobs.isError ? (
          <p role="alert" className="text-center text-sm text-destructive">
            Couldn't load jobs: {jobs.error.message}
          </p>
        ) : items.length === 0 ? (
          <EmptyState onPick={remix} />
        ) : (
          <motion.div layout className="columns-2 gap-3 md:columns-3 lg:columns-4 [&>*]:mb-3 [&>*]:break-inside-avoid">
            {items.map((j) => (
              <JobCard key={j.id} job={j} models={models.data?.models} onOpen={(job) => setOpen(toAsset(job))} onRemix={remix} />
            ))}
          </motion.div>
        )}
      </section>

      <AssetLightbox asset={open} models={models.data?.models} onClose={() => setOpen(null)} onRemix={remix} />
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (p: string) => void }) {
  return (
    <div className="mx-auto max-w-3xl rounded-2xl border border-dashed border-white/10 px-6 py-12 text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/25">
        <Sparkles className="size-5" />
      </div>
      <p className="mt-4 font-medium">Your canvas is empty</p>
      <p className="mt-1 text-sm text-muted-foreground">Try one of these to get started:</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {SURPRISE.slice(0, 4).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            className="max-w-xs truncate rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}
