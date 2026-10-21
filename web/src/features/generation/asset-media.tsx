import { useEffect, useRef } from 'react';
import { Play } from 'lucide-react';
import { cn } from 'cn';
import type { Asset } from '@/lib/api';

const canHover = () => typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches;

interface Props {
  asset: Pick<Asset, 'url' | 'kind' | 'prompt' | 'durationMs'>;
  className?: string;
  /** Videos: play while hovered (desktop) / while on screen (touch). */
  hoverPlay?: boolean;
  /** Show the small "▶ 5s" badge on videos. */
  badge?: boolean;
}

/**
 * Renders an asset whatever it is. Images: lazy <img>. Videos: muted, looping, inline <video>
 * that only plays when you look at it (hover on desktop, in-viewport on touch), so a gallery of
 * 30 clips doesn't decode 30 videos at once.
 */
export function AssetMedia({ asset, className, hoverPlay = true, badge = true }: Props) {
  if (asset.kind !== 'video') {
    return <img src={asset.url} alt={asset.prompt ?? 'Generated image'} loading="lazy" draggable={false} className={className} />;
  }
  return <HoverVideo src={asset.url} label={asset.prompt} durationMs={asset.durationMs} className={className} hoverPlay={hoverPlay} badge={badge} />;
}

function HoverVideo({
  src,
  label,
  durationMs,
  className,
  hoverPlay,
  badge,
}: {
  src: string;
  label?: string;
  durationMs: number | null;
  className?: string;
  hoverPlay: boolean;
  badge: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  // Touch devices have no hover: play while at least half visible instead.
  useEffect(() => {
    const v = ref.current;
    if (!v || !hoverPlay || canHover()) return;
    const io = new IntersectionObserver(([e]) => (e?.isIntersecting ? void v.play().catch(() => undefined) : v.pause()), {
      threshold: 0.5,
    });
    io.observe(v);
    return () => io.disconnect();
  }, [hoverPlay]);

  const play = () => hoverPlay && canHover() && void ref.current?.play().catch(() => undefined);
  const stop = () => {
    const v = ref.current;
    if (!v || !hoverPlay || !canHover()) return;
    v.pause();
    v.currentTime = 0.1;
  };

  return (
    <span className="relative block size-full" onPointerEnter={play} onPointerLeave={stop}>
      <video
        ref={ref}
        // #t=0.1 makes browsers paint the first frame as a poster without downloading the clip.
        src={`${src}#t=0.1`}
        aria-label={label ?? 'Generated video'}
        muted
        loop
        playsInline
        preload="metadata"
        className={className}
      />
      {badge && (
        <span className="pointer-events-none absolute left-2 top-2 inline-flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white backdrop-blur">
          <Play className="size-2.5 fill-current" />
          {durationMs ? `${Math.round(durationMs / 1000)}s` : 'Video'}
        </span>
      )}
    </span>
  );
}

/** Same element, with a class hook for "has video" styling. */
export const isVideo = (a: Pick<Asset, 'kind'> | null | undefined) => a?.kind === 'video';
export const mediaClass = (a: Pick<Asset, 'kind'> | null | undefined, base: string) => cn(base, isVideo(a) && 'bg-black');
