import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { cn } from 'cn';
import type { JobStatus } from '@/lib/api';

const styles: Record<JobStatus, { label: string; className: string; Icon: typeof Clock; spin?: boolean }> = {
  QUEUED: { label: 'Queued', className: 'bg-muted text-muted-foreground', Icon: Clock },
  PROCESSING: { label: 'Generating', className: 'bg-primary/10 text-primary', Icon: Loader2, spin: true },
  DONE: { label: 'Done', className: 'bg-success/10 text-success', Icon: CheckCircle2 },
  FAILED: { label: 'Failed', className: 'bg-destructive/10 text-destructive', Icon: XCircle },
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const s = styles[status];
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', s.className)}
      // Screen readers announce status changes as the poll updates them.
      role="status"
      aria-live="polite"
    >
      <s.Icon className={cn('size-3.5', s.spin && 'animate-spin')} aria-hidden />
      {s.label}
    </span>
  );
}
