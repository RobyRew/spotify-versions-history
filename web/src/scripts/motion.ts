/**
 * The page's entrance: elements matching the selector rise into place in a short stagger. Nothing is
 * hidden before the script runs, and under reduced motion nothing moves at all.
 */
import { gsap } from 'gsap';

export function reveal(selector: string): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const items = gsap.utils.toArray<HTMLElement>(selector);
  if (!items.length) return;
  gsap.from(items, { y: 14, opacity: 0, duration: 0.5, ease: 'power2.out', stagger: 0.04, clearProps: 'transform,opacity' });
}
