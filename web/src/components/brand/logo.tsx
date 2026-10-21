import { cn } from 'cn';

/** Wordmark: a violet "aperture" glyph + name. */
export function Logo({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <span className="relative grid size-7 place-items-center rounded-lg bg-gradient-to-br from-primary to-violet-2 shadow-[0_0_24px_-4px_var(--glow)]">
        <svg viewBox="0 0 24 24" className="size-4 text-white" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
          <path d="M12 3l2.6 5.6L20 9.5l-4 4 1 5.9L12 16.6 7 19.4l1-5.9-4-4 5.4-.9z" strokeLinejoin="round" />
        </svg>
      </span>
      {!compact && <span>AI Media Studio</span>}
    </span>
  );
}
