import { motion } from 'framer-motion';
import { Clapperboard, Download, ImageOff, Maximize2, RotateCcw, Wand2 } from 'lucide-react';
import { cn } from 'cn';
import type { Job, ModelOption } from '@/lib/api';
import { AssetMedia } from './asset-media';
import { aspectClass, duration, modelName } from './format';

interface Props {
  job: Job;
  models?: ModelOption[];
  onOpen?: (job: Job) => void;
  onRemix?: (prompt: string) => void;
  /** Images only: send to the Motion tool. */
  onAnimate?: (assetId: string) => void;
}

/**
 * One generation in the feed. While running: an animated shimmer "developing" placeholder with a
 * stage label. Done: the image with hover actions. Failed: the reason + the refund.
 */
export function JobCard({ job, models, onOpen, onRemix, onAnimate }: Props) {
  const running = job.status === 'QUEUED' || job.status === 'PROCESSING';
  const took = duration(job.startedAt ?? job.createdAt, job.finishedAt);
  const done = job.status === 'DONE' && job.asset;
  const isMotion = job.kind === 'MOTION';
  // Videos come out at the source image's ratio; the API stores it on the job too.
  const label = isMotion ? `${presetName(job.motion?.preset)} · ${job.motion?.durationS ?? '?'}s` : `${modelName(models, job.model)} · ${job.aspectRatio}`;

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 260, damping: 26 }}
      className="group relative overflow-hidden rounded-2xl bg-card ring-1 ring-white/[0.07]"
    >
      <div className={cn('relative w-full', aspectClass[job.aspectRatio] ?? 'aspect-square')}>
        {done ? (
          <>
            <motion.div
              initial={{ opacity: 0, filter: 'blur(16px)', scale: 1.04 }}
              animate={{ opacity: 1, filter: 'blur(0px)', scale: 1 }}
              transition={{ duration: 0.7, ease: 'easeOut' }}
              className="size-full cursor-zoom-in"
              onClick={() => onOpen?.(job)}
            >
              <AssetMedia asset={{ ...job.asset!, prompt: job.prompt }} className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
            </motion.div>
            {/* hover overlay */}
            <div className="pointer-events-none absolute inset-0 flex flex-col justify-between bg-gradient-to-t from-black/80 via-black/0 to-black/30 p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
              <div className="pointer-events-auto flex justify-end gap-1.5">
                {!isMotion && onAnimate && (
                  <IconBtn label="Animate this image" onClick={() => onAnimate(job.asset!.id)}>
                    <Clapperboard />
                  </IconBtn>
                )}
                {!isMotion && (
                  <IconBtn label="Remix this prompt" onClick={() => onRemix?.(job.prompt)}>
                    <Wand2 />
                  </IconBtn>
                )}
                <IconBtn label="Open" onClick={() => onOpen?.(job)}>
                  <Maximize2 />
                </IconBtn>
                <a href={job.asset!.downloadUrl} aria-label="Download" className="grid size-8 place-items-center rounded-lg bg-black/50 text-white backdrop-blur transition hover:bg-black/70 [&_svg]:size-4">
                  <Download />
                </a>
              </div>
              <p className="line-clamp-2 text-xs text-white/90">{job.prompt}</p>
            </div>
          </>
        ) : running ? (
          <div className="shimmer flex size-full flex-col items-center justify-center gap-3 p-4 text-center">
            <div className="relative size-10">
              <span className="absolute inset-0 animate-ping rounded-full bg-primary/30" />
              <span className="absolute inset-2 rounded-full bg-primary shadow-[0_0_24px_var(--glow)]" />
            </div>
            <p className="text-xs font-medium text-foreground/90">
              {job.status === 'QUEUED' ? 'In queue…' : job.attempts > 1 ? `Retrying · attempt ${job.attempts}` : isMotion ? 'Rendering video…' : 'Rendering…'}
            </p>
            <p className="line-clamp-2 max-w-[90%] text-[11px] text-muted-foreground">{job.prompt}</p>
          </div>
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 bg-[radial-gradient(circle_at_50%_40%,oklch(0.66_0.21_22/12%),transparent_60%)] p-4 text-center">
            <ImageOff className="size-6 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">{job.status === 'DONE' ? 'Image deleted' : job.error}</p>
            {job.status === 'FAILED' && (
              <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
                <RotateCcw className="size-3" />
                {job.creditsCost} credits refunded
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          {isMotion && <Clapperboard className="size-3 shrink-0 text-primary" />}
          <span className="truncate">
            {label}
            {took && job.status === 'DONE' ? ` · ${took}` : ''}
          </span>
        </span>
        <span className={cn('shrink-0 tabular-nums', job.status === 'FAILED' && 'line-through')}>−{job.creditsCost}</span>
      </div>
    </motion.article>
  );
}

const PRESET_NAMES: Record<string, string> = {
  'push-in': 'Push in',
  'pull-out': 'Pull out',
  'pan-right': 'Pan right',
  'pan-left': 'Pan left',
  'crane-up': 'Crane up',
  drift: 'Drift',
};
const presetName = (id?: string) => (id ? (PRESET_NAMES[id] ?? id) : 'Motion');

function IconBtn({ label, onClick, children }: { label: string; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-lg bg-black/50 text-white backdrop-blur transition hover:bg-black/70 [&_svg]:size-4"
    >
      {children}
    </button>
  );
}
