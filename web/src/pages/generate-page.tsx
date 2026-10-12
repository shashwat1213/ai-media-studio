import { useState } from 'react';
import { motion } from 'framer-motion';
import { FlaskConical } from 'lucide-react';
import type { Asset, Job } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '@/features/auth/use-auth';
import { GenerateForm } from '@/features/generation/generate-form';
import { JobCard } from '@/features/generation/job-card';
import { AssetLightbox } from '@/features/generation/asset-lightbox';
import { useModels, useRecentJobs } from '@/features/generation/use-generation';

const toAsset = (j: Job): Asset | null =>
  j.asset ? { ...j.asset, prompt: j.prompt, model: j.model, aspectRatio: j.aspectRatio } : null;

export function GeneratePage() {
  const { data: user } = useMe();
  const models = useModels();
  const jobs = useRecentJobs(12);
  const [open, setOpen] = useState<Asset | null>(null);

  return (
    <motion.div className="mx-auto max-w-5xl space-y-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Generate</h1>
        <p className="text-sm text-muted-foreground">Describe an image. It runs in the background, so you can keep working.</p>
      </div>

      {models.data?.mode === 'stub' && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900">
          <FlaskConical className="mt-0.5 size-4 shrink-0" />
          <p>
            <span className="font-medium">Demo mode.</span> No AI key is configured, so images are free placeholder art
            generated on the server. The queue, worker, storage and credits are all real. Add{' '}
            <code className="rounded bg-amber-500/15 px-1">[fail]</code> or <code className="rounded bg-amber-500/15 px-1">[flaky]</code> to a
            prompt to see a failure and the automatic refund.
          </p>
        </div>
      )}

      <Card>
        <CardContent className="pt-6">
          {models.isLoading || !user ? (
            <div className="space-y-4">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-10 w-48" />
            </div>
          ) : models.isError ? (
            <p role="alert" className="text-sm text-destructive">
              Couldn't load models: {models.error.message}
            </p>
          ) : (
            <GenerateForm catalog={models.data!} balance={user.credits} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent generations</CardTitle>
          <CardDescription>Updates live while a job is running.</CardDescription>
        </CardHeader>
        <CardContent>
          {jobs.isLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="aspect-square w-full" />
              ))}
            </div>
          ) : jobs.isError ? (
            <p role="alert" className="text-sm text-destructive">
              Couldn't load jobs: {jobs.error.message}
            </p>
          ) : !jobs.data?.items.length ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Nothing yet. Your first image will show up here.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {jobs.data.items.map((j) => (
                <JobCard key={j.id} job={j} models={models.data?.models} onOpen={(job) => setOpen(toAsset(job))} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <AssetLightbox asset={open} models={models.data?.models} onClose={() => setOpen(null)} />
    </motion.div>
  );
}
