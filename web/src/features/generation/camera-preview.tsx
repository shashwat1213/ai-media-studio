import type { CSSProperties } from 'react';
import { motion, type TargetAndTransition } from 'framer-motion';
import { cn } from 'cn';

/**
 * Live, in-browser approximation of each server preset, so users SEE the move before paying
 * for it. The server renders the real thing with ffmpeg (same easing: start and end at rest).
 *
 * Direction logic: a camera panning RIGHT means the picture slides LEFT inside the frame.
 */
const MOVES: Record<string, { from: TargetAndTransition; to: TargetAndTransition }> = {
  'push-in': { from: { scale: 1 }, to: { scale: 1.3 } },
  'pull-out': { from: { scale: 1.3 }, to: { scale: 1 } },
  'pan-right': { from: { scale: 1.22, x: '9%' }, to: { scale: 1.22, x: '-9%' } },
  'pan-left': { from: { scale: 1.22, x: '-9%' }, to: { scale: 1.22, x: '9%' } },
  'crane-up': { from: { scale: 1.22, y: '-9%' }, to: { scale: 1.22, y: '9%' } },
  drift: { from: { scale: 1.08, x: '6%', y: '-5%' }, to: { scale: 1.26, x: '-6%', y: '4%' } },
};

interface Props {
  src: string;
  preset: string;
  /** Animate continuously (selected) or rest on the first frame. */
  playing: boolean;
  /** Seconds per loop; the real clip length is a good default. */
  seconds?: number;
  className?: string;
  style?: CSSProperties;
  alt?: string;
}

export function CameraPreview({ src, preset, playing, seconds = 3, className, style, alt = '' }: Props) {
  const move = MOVES[preset] ?? MOVES['push-in']!;
  return (
    <div className={cn('relative overflow-hidden', className)} style={style}>
      <motion.img
        key={preset /* restart from the first frame when the preset changes */}
        src={src}
        alt={alt}
        draggable={false}
        initial={move.from}
        animate={playing ? move.to : move.from}
        transition={playing ? { duration: seconds, ease: [0.45, 0, 0.55, 1], repeat: Infinity, repeatDelay: 0.5 } : { duration: 0.3 }}
        className="size-full object-cover will-change-transform"
      />
    </div>
  );
}
