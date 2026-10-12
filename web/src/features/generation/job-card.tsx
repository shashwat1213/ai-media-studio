import { motion } from 'framer-motion';
import { Download, ImageOff, Loader2, RotateCcw } from 'lucide-react';
import { cn } from 'cn';
import type { Job, ModelOption } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { JobStatusBadge } from './job-status-badge';
import { aspectClass, dateFmt, duration, modelName } from './format';

interface Props {
  job: Job;
  models?: ModelOption[];
  onOpen?: (job: Job) => void;
}

/** One generation: live status while running, the image when done, the reason + refund when failed. */
export function JobCard({ job, models, onOpen }: Props) {
  const running = job.status === 'QUEUED' || job.status === 'PROCESSING';
  const took = duration(job.startedAt ?? job.createdAt, job.finishedAt);

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="overflow-hidden rounded-xl border bg-card"
    >
      <div className={cn('relative w-full bg-muted', aspectClass[job.aspectRatio] ?? 'aspect-square')}>
        {job.status === 'DONE' && job.asset ? (
          <button type="button" className="group size-full" onClick={() => onOpen?.(job)} aria-label="Open image">
            <img
              src={job.asset.url}
              alt={job.prompt}
              loading="lazy"
              className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            />
          </button>
        ) : running ? (
          <div className="flex size-full animate-pulse flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            {job.status === 'QUEUED' ? 'Waiting in queue…' : job.attempts > 1 ? `Retrying (attempt ${job.attempts})…` : 'Generating…'}
          </div>
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
            <ImageOff className="size-6" />
            {job.status === 'DONE' ? 'Image deleted' : job.error}
          </div>
        )}
      </div>

      <div className="space-y-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <JobStatusBadge status={job.status} />
          <span className="text-xs text-muted-foreground">{dateFmt.format(new Date(job.createdAt))}</span>
        </div>
        <p className="line-clamp-2 text-sm" title={job.prompt}>
          {job.prompt}
        </p>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate">
            {modelName(models, job.model)} · {job.aspectRatio}
            {took && job.status === 'DONE' ? ` · ${took}` : ''}
          </span>
          {job.status === 'FAILED' ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-emerald-700">
              <RotateCcw className="size-3" />
              {job.creditsCost} refunded
            </span>
          ) : (
            <span className="shrink-0 tabular-nums">−{job.creditsCost} credits</span>
          )}
        </div>
        {job.status === 'DONE' && job.asset && (
          <Button asChild variant="outline" size="sm" className="w-full">
            <a href={job.asset.downloadUrl}>
              <Download />
              Download
            </a>
          </Button>
        )}
      </div>
    </motion.article>
  );
}
