import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Clapperboard, ImageIcon } from 'lucide-react';
import { cn } from 'cn';

export type Tool = 'image' | 'motion';

export const TOOLS: { id: Tool; label: string; hint: string; icon: typeof ImageIcon }[] = [
  { id: 'image', label: 'Image', hint: 'Text to image', icon: ImageIcon },
  { id: 'motion', label: 'Motion', hint: 'Image to video', icon: Clapperboard },
];

/**
 * Tool rail: vertical icon strip on desktop (like Higgsfield / Figma), horizontal segmented
 * control on phones. The active pill slides between tools (shared layoutId).
 */
export function ToolRail({ tool, onChange }: { tool: Tool; onChange: (t: Tool) => void }) {
  return (
    <nav
      aria-label="Tools"
      className="glass flex gap-1 rounded-2xl p-1.5 lg:sticky lg:top-[88px] lg:flex-col lg:self-start"
      role="tablist"
    >
      {TOOLS.map(({ id, label, hint, icon: Icon }) => {
        const active = tool === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            title={hint}
            onClick={() => onChange(id)}
            className={cn(
              'relative flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-xs font-medium transition-colors lg:flex-col lg:gap-1.5 lg:px-2 lg:py-3',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active && (
              <motion.span
                layoutId="tool-pill"
                className="absolute inset-0 rounded-xl bg-primary/15 ring-1 ring-primary/30"
                transition={{ type: 'spring', stiffness: 500, damping: 38 }}
              />
            )}
            <Icon className={cn('relative size-5', active && 'text-primary drop-shadow-[0_0_8px_var(--glow)]')} />
            <span className="relative">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * Three-zone studio: tools | canvas | settings. On phones the zones stack: tools, settings, canvas.
 * Pure layout: each tool decides what goes in each zone.
 */
export function StudioLayout({ rail, settings, children }: { rail: ReactNode; settings: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto grid max-w-[1600px] gap-4 lg:grid-cols-[84px_minmax(0,1fr)_320px] lg:items-start">
      {rail}
      <section className="order-3 min-w-0 lg:order-none">{children}</section>
      <aside
        aria-label="Settings"
        className="glass order-2 rounded-2xl p-4 lg:order-none lg:sticky lg:top-[88px] lg:max-h-[calc(100vh-108px)] lg:overflow-y-auto"
      >
        {settings}
      </aside>
    </div>
  );
}

/** A labelled group inside the settings panel. */
export function SettingsGroup({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-2.5 [&+&]:mt-5 [&+&]:border-t [&+&]:border-white/[0.06] [&+&]:pt-5">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{title}</h3>
        {aside}
      </div>
      {children}
    </div>
  );
}
