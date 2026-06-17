const SCROLLING_CLASS = 'is-scrolling';
const SCROLL_IDLE_MS = 900;
const timers = new WeakMap();

function getScrollTarget(event) {
  const target = event?.target;
  if (!target || target === document || target === window) {
    return document.scrollingElement || document.documentElement;
  }
  if (target === document.documentElement || target === document.body) {
    return document.scrollingElement || document.documentElement;
  }
  return target instanceof Element ? target : document.scrollingElement || document.documentElement;
}

function markScrolling(element) {
  if (!element?.classList) return;
  element.classList.add(SCROLLING_CLASS);

  const existingTimer = timers.get(element);
  if (existingTimer) clearTimeout(existingTimer);

  const nextTimer = setTimeout(() => {
    element.classList.remove(SCROLLING_CLASS);
    timers.delete(element);
  }, SCROLL_IDLE_MS);

  timers.set(element, nextTimer);
}

export function initAutoScrollbars() {
  if (document.documentElement.dataset.autoScrollbars === 'ready') return;
  document.documentElement.dataset.autoScrollbars = 'ready';

  document.addEventListener('scroll', (event) => {
    markScrolling(getScrollTarget(event));
  }, { capture: true, passive: true });
}
