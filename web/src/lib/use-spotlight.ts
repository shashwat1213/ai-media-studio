import { useCallback } from 'react';

/**
 * Pointer-following glow for `.spotlight` elements (see index.css): writes the pointer position
 * into CSS variables. No React state, so moving the mouse never re-renders anything.
 */
export function useSpotlight<T extends HTMLElement>() {
  return useCallback((e: React.PointerEvent<T>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--x', `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty('--y', `${e.clientY - r.top}px`);
  }, []);
}
