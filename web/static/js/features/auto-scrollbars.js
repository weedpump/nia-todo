const SCROLLING_CLASS = 'is-scrolling';
const INDICATOR_CLASS = 'scrollbar-overlay-indicator';
const VISIBLE_CLASS = 'visible';
const SCROLL_IDLE_MS = 900;
const MIN_THUMB_SIZE = 36;
const EDGE_PADDING = 3;
const INDICATOR_WIDTH = 7;

const states = new WeakMap();
const trackedElements = new Set();
let activeElement = null;
let pendingFrame = 0;

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

function isIgnoredScrollbarTarget(element) {
  return Boolean(element?.closest?.('.todo-item'));
}

function canScrollVertically(element) {
  if (!element) return false;
  if (isViewportScroller(element)) {
    const scrollingElement = document.scrollingElement || document.documentElement;
    return scrollingElement.scrollHeight - window.innerHeight > 1;
  }

  const overflowY = window.getComputedStyle(element).overflowY;
  if (!['auto', 'scroll', 'overlay'].includes(overflowY)) return false;

  return element.scrollHeight - element.clientHeight > 1;
}

function nearestScroller(start) {
  let element = start instanceof Element ? start : document.scrollingElement || document.documentElement;
  while (element && element !== document.body && element !== document.documentElement) {
    if (!isIgnoredScrollbarTarget(element) && canScrollVertically(element)) return element;
    element = element.parentElement;
  }
  return document.scrollingElement || document.documentElement;
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
  trackedElements.add(element);
  return state;
}

function getViewportMetrics() {
  const scrollingElement = document.scrollingElement || document.documentElement;
  const clientHeight = window.innerHeight || scrollingElement.clientHeight;
  return {
    scrollTop: window.scrollY || scrollingElement.scrollTop || 0,
    scrollHeight: Math.max(scrollingElement.scrollHeight, document.body?.scrollHeight || 0),
    clientHeight,
    top: 0,
    right: window.innerWidth,
    height: clientHeight,
  };
}

function getElementMetrics(element) {
  const rect = element.getBoundingClientRect();
  const topbar = element.matches('.main') ? element.querySelector(':scope > .topbar') : null;
  const topbarRect = topbar?.getBoundingClientRect();
  const coveredTop = topbarRect ? Math.max(0, Math.min(topbarRect.bottom, rect.bottom) - rect.top) : 0;
  const visibleTop = Math.max(rect.top + coveredTop, EDGE_PADDING);
  const visibleBottom = Math.min(rect.bottom, window.innerHeight - EDGE_PADDING);
  const adjustedClientHeight = Math.max(1, element.clientHeight - coveredTop);
  const adjustedScrollHeight = Math.max(adjustedClientHeight, element.scrollHeight - coveredTop);
  return {
    scrollTop: element.scrollTop,
    scrollHeight: adjustedScrollHeight,
    clientHeight: adjustedClientHeight,
    top: visibleTop,
    right: Math.min(rect.right, window.innerWidth),
    height: Math.max(0, visibleBottom - visibleTop),
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
  const scrollRatio = Math.min(1, Math.max(0, metrics.scrollTop / scrollableDistance));
  const thumbTop = metrics.top + EDGE_PADDING + Math.round(maxThumbTop * scrollRatio);
  const thumbLeft = Math.max(EDGE_PADDING, Math.round(metrics.right - INDICATOR_WIDTH));

  state.indicator.style.height = `${thumbHeight}px`;
  state.indicator.style.transform = `translate3d(${thumbLeft}px, ${thumbTop}px, 0)`;
  state.indicator.classList.add(VISIBLE_CLASS);
}

function markScrolling(element) {
  if (!element?.classList || isIgnoredScrollbarTarget(element)) return;

  activeElement = element;
  element.classList.add(SCROLLING_CLASS);
  updateIndicator(element);

  const state = getState(element);
  if (state.timer) clearTimeout(state.timer);

  state.timer = setTimeout(() => {
    element.classList.remove(SCROLLING_CLASS);
    state.indicator.classList.remove(VISIBLE_CLASS);
    state.timer = null;
    if (activeElement === element) activeElement = null;
  }, SCROLL_IDLE_MS);
}

function scheduleScrollHint(element) {
  activeElement = nearestScroller(element || activeElement || document.scrollingElement || document.documentElement);
  if (pendingFrame) return;
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = 0;
    markScrolling(activeElement || document.scrollingElement || document.documentElement);
  });
}

export function hideAutoScrollbars(root = null) {
  if (pendingFrame) {
    cancelAnimationFrame(pendingFrame);
    pendingFrame = 0;
  }

  trackedElements.forEach((element) => {
    if (root instanceof Element && element !== root && !root.contains(element)) return;
    const state = states.get(element);
    if (state?.timer) clearTimeout(state.timer);
    if (state) state.timer = null;
    element.classList?.remove?.(SCROLLING_CLASS);
    state?.indicator.classList.remove(VISIBLE_CLASS);
    if (activeElement === element) activeElement = null;
  });
}

function bindModalScrollbarCleanup() {
  if (document.documentElement.dataset.autoScrollbarModalCleanup === 'ready') return;
  document.documentElement.dataset.autoScrollbarModalCleanup = 'ready';

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      const target = mutation.target;
      if (!(target instanceof Element) || !target.classList.contains('modal')) return;
      if (target.classList.contains('active')) return;
      hideAutoScrollbars(target);
    });
  });
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
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

  document.addEventListener('wheel', (event) => {
    scheduleScrollHint(event.target);
  }, { capture: true, passive: true });

  document.addEventListener('touchmove', (event) => {
    if (event.target?.closest?.('.todo-item')) return;
    scheduleScrollHint(event.target);
  }, { capture: true, passive: true });

  document.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) return;
    scheduleScrollHint(document.activeElement);
  }, { capture: true });

  window.addEventListener('resize', updateVisibleIndicators, { passive: true });
  bindModalScrollbarCleanup();
}
