import { cn } from 'cn';

/**
 * Slow-moving blurred colour fields behind a hero. Pure CSS (transform-only animation, GPU
 * composited), so it costs no JS per frame and respects prefers-reduced-motion via index.css.
 */
export function Aurora({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      <div className="absolute -top-1/3 left-1/2 h-[70vmax] w-[70vmax] -translate-x-1/2 animate-aurora rounded-full bg-[radial-gradient(closest-side,oklch(0.55_0.25_293/55%),transparent)] blur-3xl" />
      <div
        className="absolute -right-1/4 top-1/4 h-[50vmax] w-[50vmax] animate-aurora rounded-full bg-[radial-gradient(closest-side,oklch(0.62_0.22_320/35%),transparent)] blur-3xl"
        style={{ animationDelay: '-6s' }}
      />
      <div
        className="absolute -left-1/4 bottom-0 h-[45vmax] w-[45vmax] animate-aurora rounded-full bg-[radial-gradient(closest-side,oklch(0.5_0.2_265/35%),transparent)] blur-3xl"
        style={{ animationDelay: '-12s' }}
      />
      <div className="bg-grid absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]" />
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-background to-transparent" />
    </div>
  );
}
