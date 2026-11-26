/**
 * The version a visitor clicks moves into the release page's title during the cross-document view
 * transition (global.css). The release page's title always carries the name `release-version`; on the
 * page being left, the link to that release takes the same name just before the old page is captured,
 * and gives it back when the transition ends. Names are set through the CSSOM, which the CSP allows.
 */
interface SwapEvent extends Event {
  viewTransition: { finished: Promise<void> } | null;
  activation: { entry: { url: string } } | null;
}

// A page can link one release several times (the home page's panel, cards and timeline): the clicked
// link is the one that moves.
let clicked: HTMLElement | null = null;
addEventListener('click', event => {
  clicked = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-vt-release]') : null;
}, { capture: true });

addEventListener('pageswap', event => {
  const { viewTransition, activation } = event as SwapEvent;
  if (!viewTransition || !activation) return;
  const path = new URL(activation.entry.url).pathname;
  if (!path.startsWith('/v/')) return;
  const link = clicked?.dataset.vtRelease === path ? clicked : document.querySelector<HTMLElement>(`[data-vt-release="${CSS.escape(path)}"]`);
  if (!link || document.querySelector('.vt-release-title')) return;
  link.style.viewTransitionName = 'release-version';
  void viewTransition.finished.finally(() => { link.style.viewTransitionName = ''; });
});
