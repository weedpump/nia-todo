const SCROLLING_CLASS = 'is-scrolling';
const INDICATOR_CLASS = 'scrollbar-overlay-indicator';
const VISIBLE_CLASS = 'visible';
const SCROLL_IDLE_MS = 900;
const MIN_THUMB_SIZE = 36;
const EDGE_PADDING = 2;

const states = new WeakMap();

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

function isViewportScroller(element) {
  return element === document.documentElement || element === document.body || element === document.scrollingElement;
}

function getState(element) {
  let state = states.get(element);
  if (state) return state;

  const indicator = document.createElement('div');
  indicator.className = INDICATOR_CLASS;
  indicator.setAttribute('aria-hidden', 'true');
  document.body.appendChild(indicator);

  state = { indicator, timer: null };
  states.set(element, state);
  return state;
}

function getViewportMetrics() {
  const scrollingElement = document.scrollingElement || document.documentElement;
  return {
    scrollTop: window.scrollY || scrollingElement.scrollTop || 0,
    scrollHeight: scrollingElement.scrollHeight,
    clientHeight: window.innerHeight || scrollingElement.clientHeight,
    top: 0,
    right: window.innerWidth - EDGE_PADDING,
    height: window.innerHeight || scrollingElement.clientHeight,
  };
}

function getElementMetrics(element) {
  const rect = element.getBoundingClientRect();
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    top: Math.max(rect.top, EDGE_PADDING),
    right: Math.min(rect.right, window.innerWidth) - EDGE_PADDING,
    height: Math.min(rect.height, window.innerHeight - Math.max(rect.top, 0)),
  };
}

function updateIndicator(element) {
  const state = getState(element);
  const metrics = isViewportScroller(element) ? getViewportMetrics() : getElementMetrics(element);
  const scrollableDistance = metrics.scrollHeight - metrics.clientHeight;

  if (scrollableDistance <= 1 || metrics.height <= 0) {
    state.indicator.classList.remove(VISIBLE_CLASS);
    return;
  }

  const trackHeight = Math.max(metrics.height - (EDGE_PADDING * 2), MIN_THUMB_SIZE);
  const thumbHeight = Math.max(MIN_THUMB_SIZE, Math.round((metrics.clientHeight / metrics.scrollHeight) * trackHeight));
  const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
  const scrollRatio = metrics.scrollTop / scrollableDistance;
  const thumbTop = metrics.top + EDGE_PADDING + Math.round(maxThumbTop * scrollRatio);

  state.indicator.style.height = `${thumbHeight}px`;
  state.indicator.style.transform = `translate3d(${Math.round(metrics.right - 6)}px, ${thumbTop}px, 0)`;
  state.indicator.classList.add(VISIBLE_CLASS);
}

function markScrolling(element) {
  if (!element?.classList) return;

  element.classList.add(SCROLLING_CLASS);
  updateIndicator(element);

  const state = getState(element);
  if (state.timer) clearTimeout(state.timer);

  state.timer = setTimeout(() => {
    element.classList.remove(SCROLLING_CLASS);
    state.indicator.classList.remove(VISIBLE_CLASS);
    state.timer = null;
  }, SCROLL_IDLE_MS);
}

function updateVisibleIndicators() {
  const scrollers = [document.scrollingElement || document.documentElement, ...document.querySelectorAll(`.${SCROLLING_CLASS}`)];
  scrollers.forEach((element) => {
    const state = states.get(element);
    if (state?.indicator.classList.contains(VISIBLE_CLASS)) updateIndicator(element);
  });
}

export function initAutoScrollbars() {
  if (document.documentElement.dataset.autoScrollbars === 'ready') return;
  document.documentElement.dataset.autoScrollbars = 'ready';

  document.addEventListener('scroll', (event) => {
    markScrolling(getScrollTarget(event));
  }, { capture: true, passive: true });

  window.addEventListener('resize', updateVisibleIndicators, { passive: true });
}
