/**
 * The site's motion, all GSAP. Every element is visible in the HTML: with no script, a failed load or
 * reduced motion nothing hides and nothing moves. Only elements below the fold are hidden by script,
 * and only until they scroll in.
 */
import { gsap } from 'gsap';

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The home hero: its copy rises in order, the status panel follows. */
export function heroIn(): void {
  if (still()) return;
  const copy = gsap.utils.toArray<HTMLElement>('[data-hero]');
  const panel = document.querySelector<HTMLElement>('[data-hero-panel]');
  const timeline = gsap.timeline({ defaults: { ease: 'power3.out' } });
  if (copy.length) timeline.from(copy, { y: 18, opacity: 0, duration: 0.7, stagger: 0.07, clearProps: 'transform,opacity' });
  if (panel) timeline.from(panel, { y: 28, opacity: 0, duration: 0.8, clearProps: 'transform,opacity' }, 0.15);
}

const NUMBER = new Intl.NumberFormat('en');

/** Numbers in `[data-count]` tick up from zero the first time they are on screen. */
export function countUp(selector: string): void {
  if (still()) return;
  const items = gsap.utils.toArray<HTMLElement>(selector);
  const run = (element: HTMLElement) => {
    const target = Number(element.dataset.count);
    if (!Number.isFinite(target) || target <= 0) return;
    const state = { value: 0 };
    gsap.to(state, {
      value: target,
      duration: Math.min(1.4, 0.5 + target / 400),
      ease: 'power2.out',
      onUpdate: () => { element.textContent = NUMBER.format(Math.round(state.value)); },
      onComplete: () => { element.textContent = NUMBER.format(target); },
    });
  };
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      run(entry.target as HTMLElement);
    }
  });
  for (const item of items) observer.observe(item);
}

/**
 * Elements matching the selector rise into place as they scroll into view, in a short stagger per
 * batch. Checked on scroll once per frame rather than with an IntersectionObserver: a fast scroll or
 * an anchor jump can carry an element from below the viewport to above it between two observations,
 * and it must still appear, so anything at or above the fold's line is revealed.
 */
export function revealOnScroll(selector: string): void {
  if (still()) return;
  const items = gsap.utils.toArray<HTMLElement>(selector);
  const line = () => innerHeight * 0.92;
  const above = items.filter(item => item.getBoundingClientRect().top < line());
  let pending = items.filter(item => !above.includes(item));
  if (above.length) gsap.from(above, { y: 14, opacity: 0, duration: 0.5, ease: 'power2.out', stagger: 0.05, clearProps: 'transform,opacity' });
  if (!pending.length) return;
  gsap.set(pending, { y: 18, opacity: 0 });
  let queued = false;
  const check = () => {
    queued = false;
    const due = pending.filter(item => item.getBoundingClientRect().top < line());
    if (!due.length) return;
    pending = pending.filter(item => !due.includes(item));
    gsap.to(due, { y: 0, opacity: 1, duration: 0.55, ease: 'power2.out', stagger: 0.06, clearProps: 'transform,opacity' });
    if (!pending.length) {
      removeEventListener('scroll', onScroll);
      removeEventListener('resize', onScroll);
    }
  };
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(check);
  };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll, { passive: true });
}

/** Rows a Load more just appended fade up in sequence. */
export function staggerIn(nodes: readonly Node[]): void {
  if (still()) return;
  const elements = nodes.filter((node): node is HTMLElement => node instanceof HTMLElement);
  // The whole batch arrives within about half a second, however many rows it has.
  if (elements.length) gsap.from(elements, { y: 10, opacity: 0, duration: 0.4, ease: 'power2.out', stagger: { amount: Math.min(0.5, elements.length * 0.025) }, clearProps: 'transform,opacity' });
}
