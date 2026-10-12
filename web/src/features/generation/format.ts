import type { ModelOption } from '@/lib/api';

/** Tailwind classes for each aspect ratio, so placeholders/skeletons have the right shape. */
export const aspectClass: Record<string, string> = {
  '1:1': 'aspect-square',
  '4:3': 'aspect-[4/3]',
  '3:4': 'aspect-[3/4]',
  '16:9': 'aspect-video',
  '9:16': 'aspect-[9/16]',
};

export const modelName = (models: ModelOption[] | undefined, id: string) => models?.find((m) => m.id === id)?.name ?? id;

export const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "12s" / "1m 05s" between two timestamps. */
export function duration(from: string | null, to: string | null) {
  if (!from || !to) return null;
  const s = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
