import { iconSvg } from '../icons/lucide-icons.js';

const documentStates = new WeakMap();
const interactiveSelector = 'button, input, select, textarea, a, label, summary, details, [role="button"], [contenteditable="true"]';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeHtmlAttr(value) {
  return escapeHtml(value)
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderItemSwipeShell({ key, cardMarkup, actions = {} } = {}) {
  const mobileSwipeEnabled = globalThis.document?.documentElement?.classList?.contains?.('mobile-swipe-ui') === true;
  const configured = ['right', 'left'].filter(direction => actions?.[direction]);
  if (!mobileSwipeEnabled || configured.length === 0) return cardMarkup || '';
  const actionMarkup = configured.map(direction => {
    const action = actions[direction] || {};
    const tone = action.tone === 'warning' ? 'warning' : 'success';
    const icon = action.icon || (tone === 'warning' ? 'flame' : 'check');
    return `
      <div class="ui-swipe-action" data-ui-swipe-direction="${direction}" data-ui-swipe-tone="${tone}">
        ${iconSvg(icon, 'ui-swipe-action-icon', `data-ui-swipe-icon="${escapeHtmlAttr(icon)}"`)}
        <span>${escapeHtml(action.label || '')}</span>
      </div>
    `;
  }).join('');
  return `
    <div class="ui-swipe-shell" data-ui-swipe-key="${escapeHtmlAttr(String(key ?? ''))}">
      <div class="ui-swipe-underlay" aria-hidden="true">${actionMarkup}</div>
      ${cardMarkup || ''}
    </div>
  `;
}

function stateFor(documentTarget, windowTarget) {
  let state = documentStates.get(documentTarget);
  if (state) return state;
  state = {
    documentTarget,
    windowTarget,
    adapters: new Map(),
    active: null,
    suppressClickUntil: 0,
    suppressClickItem: null,
    visualFrame: 0,
    visualFrameIsTimeout: false,
    pendingVisual: null,
  };
  documentStates.set(documentTarget, state);
  bindState(state);
  return state;
}

function directionFor(dx) {
  return dx < 0 ? 'left' : 'right';
}

function actionFor(active, direction) {
  if (!active) return null;
  if (active.shell) return active.shell.querySelector?.(`[data-ui-swipe-direction="${direction}"]`) || null;
  return active.adapter.directions?.includes?.(direction) ? { direction } : null;
}

function elasticSwipeDistance(rawDx, width) {
  const sign = rawDx < 0 ? -1 : 1;
  const distance = Math.abs(rawDx);
  const max = Math.max(0, width);
  const direct = Math.min(120, max * 0.32);
  if (!max || distance <= direct) return rawDx;
  const inputRange = Math.max(1, max * 0.95 - direct);
  const progress = Math.min(1, (distance - direct) / inputRange);
  const eased = direct + (max - direct) * (1 - Math.pow(1 - progress, 0.65));
  return sign * Math.min(max, eased);
}

function setSwipeVisual(item, shell, visualDx, rawDx, actionThreshold) {
  const progress = Math.min(1, Math.abs(rawDx) / Math.max(1, actionThreshold));
  const direction = directionFor(visualDx || rawDx);
  item.style.setProperty('--swipe-x', `${visualDx}px`);
  item.style.setProperty('--swipe-progress', progress.toFixed(3));
  item.classList.toggle('swipe-right', direction === 'right' && visualDx !== 0);
  item.classList.toggle('swipe-left', direction === 'left' && visualDx !== 0);
  item.classList.toggle('swipe-ready', progress >= 1);
  shell?.classList.toggle('swipe-right', direction === 'right' && visualDx !== 0);
  shell?.classList.toggle('swipe-left', direction === 'left' && visualDx !== 0);
  shell?.classList.toggle('swipe-ready', progress >= 1);
}

function cancelScheduledVisual(state) {
  if (state.visualFrame) {
    if (state.visualFrameIsTimeout) state.windowTarget.clearTimeout(state.visualFrame);
    else state.windowTarget.cancelAnimationFrame?.(state.visualFrame);
  }
  state.visualFrame = 0;
  state.visualFrameIsTimeout = false;
  state.pendingVisual = null;
}

function flushScheduledVisual(state) {
  state.visualFrame = 0;
  state.visualFrameIsTimeout = false;
  const pending = state.pendingVisual;
  state.pendingVisual = null;
  if (!pending?.item?.isConnected || !pending.item.classList.contains('swiping')) return;
  setSwipeVisual(pending.item, pending.shell, pending.visualDx, pending.rawDx, pending.actionThreshold);
}

function scheduleVisual(state, item, shell, visualDx, rawDx, actionThreshold) {
  state.pendingVisual = { item, shell, visualDx, rawDx, actionThreshold };
  if (state.visualFrame) return;
  if (state.windowTarget.requestAnimationFrame) {
    state.visualFrame = state.windowTarget.requestAnimationFrame(() => flushScheduledVisual(state));
    state.visualFrameIsTimeout = false;
  } else {
    state.visualFrame = state.windowTarget.setTimeout(() => flushScheduledVisual(state), 16);
    state.visualFrameIsTimeout = true;
  }
}

function cleanupVisual(state, item, shell = item?.closest?.('.ui-swipe-shell')) {
  cancelScheduledVisual(state);
  shell?.classList.remove('is-swiping', 'swipe-right', 'swipe-left', 'swipe-ready');
  item?.classList.remove('swiping', 'swipe-right', 'swipe-left', 'swipe-ready', 'swipe-settling', 'swipe-committing');
  item?.style.removeProperty('--swipe-x');
  item?.style.removeProperty('--swipe-progress');
  item?.removeAttribute('data-swipe-right-label');
  item?.removeAttribute('data-swipe-left-label');
}

function restoreDraggable(active) {
  if (!active?.item) return;
  if (active.originalDraggable === null) active.item.removeAttribute('draggable');
  else active.item.setAttribute('draggable', active.originalDraggable);
}

function capturePointer(active) {
  if (!active?.item || active.capturedPointer) return;
  try {
    active.item.setPointerCapture?.(active.pointerId);
    active.capturedPointer = true;
  } catch (_) {}
}

function releasePointer(active) {
  if (!active?.capturedPointer) return;
  try { active.item?.releasePointerCapture?.(active.pointerId); } catch (_) {}
  active.capturedPointer = false;
}

function cancelActive(state, { suppressClick = true } = {}) {
  if (!state.active) return;
  const current = state.active;
  state.active = null;
  cleanupVisual(state, current.item, current.shell);
  restoreDraggable(current);
  releasePointer(current);
  if (suppressClick && current.swiped) state.suppressClickUntil = Date.now() + 450;
  if (suppressClick && current.swiped) state.suppressClickItem = current.item;
}

function wait(state, ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => state.windowTarget.setTimeout(resolve, ms));
}

function reducedMotion(state) {
  return state.windowTarget.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

function findAdapter(state, target) {
  const adapters = Array.from(state.adapters.values()).reverse();
  for (const adapter of adapters) {
    const item = target?.closest?.(adapter.cardSelector);
    if (item && adapter.canStart(item, target) !== false) return { adapter, item };
  }
  return null;
}

function bindState(state) {
  const { documentTarget, windowTarget } = state;
  const thresholdPx = 80;
  const thresholdRatio = 0.35;
  const lockThreshold = 10;
  const leftEdgeSwipeDeadzonePx = 72;
  const protectedZoneLockThreshold = 36;

  documentTarget.addEventListener('click', event => {
    if (Date.now() > state.suppressClickUntil) {
      state.suppressClickItem = null;
      return;
    }
    if (event.target?.closest?.('.ui-swipe-card') !== state.suppressClickItem) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }, true);

  documentTarget.addEventListener('pointerdown', event => {
    if (!event.isPrimary || (event.pointerType && event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
    const match = findAdapter(state, event.target);
    if (!match) return;
    const { adapter, item } = match;
    const protectedStart = Boolean(adapter.protectedStartSelector && event.target?.closest?.(adapter.protectedStartSelector));
    const interactiveStart = Boolean(adapter.interactiveStartSelector && event.target?.closest?.(adapter.interactiveStartSelector));
    if (event.target?.closest?.(interactiveSelector) && !protectedStart && !interactiveStart) return;
    state.active = {
      adapter,
      item,
      shell: item.closest('.ui-swipe-shell'),
      key: adapter.keyFromCard(item),
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      dy: 0,
      locked: null,
      direction: null,
      swiped: false,
      protectedStart,
      originalDraggable: item.getAttribute('draggable'),
      capturedPointer: false,
    };
  }, { passive: true });

  documentTarget.addEventListener('pointermove', event => {
    const active = state.active;
    if (!active || event.pointerId !== active.pointerId) return;
    const dragDropActive = documentTarget.body?.classList?.contains('native-pointer-dragging') || active.item.classList.contains('dragging');
    if (dragDropActive) {
      cancelActive(state);
      return;
    }
    active.dx = event.clientX - active.startX;
    active.dy = event.clientY - active.startY;

    if (!active.locked) {
      const absX = Math.abs(active.dx);
      const absY = Math.abs(active.dy);
      const requiredLockThreshold = active.protectedStart ? protectedZoneLockThreshold : lockThreshold;
      if (absX < requiredLockThreshold && absY < lockThreshold) return;
      const direction = directionFor(active.dx);
      const fromLeftEdge = direction === 'right' && active.startX < leftEdgeSwipeDeadzonePx && !active.protectedStart;
      const horizontal = absX >= requiredLockThreshold && absX > absY * 1.25 && !fromLeftEdge;
      if (!horizontal) {
        active.locked = 'vertical';
        return;
      }
      if (!actionFor(active, direction)) {
        active.locked = 'ignored';
        return;
      }
      active.locked = 'horizontal';
      active.direction = direction;
      capturePointer(active);
      active.item.setAttribute('draggable', 'false');
      if (!active.shell) {
        active.item.setAttribute('data-swipe-right-label', active.adapter.labelFor?.('right', active.item) || '');
        active.item.setAttribute('data-swipe-left-label', active.adapter.labelFor?.('left', active.item) || '');
      }
      active.adapter.onActivate?.(active.item, active.shell);
      active.item.classList.add('swiping');
      active.shell?.classList.add('is-swiping');
    }

    if (active.locked !== 'horizontal') return;
    const currentDirection = directionFor(active.dx);
    if (!actionFor(active, currentDirection)) return;
    event.preventDefault();
    const actionThreshold = Math.max(thresholdPx, active.item.clientWidth * thresholdRatio);
    const dx = elasticSwipeDistance(active.dx, active.item.clientWidth);
    scheduleVisual(state, active.item, active.shell, dx, active.dx, actionThreshold);
    active.swiped = true;
  }, { passive: false });

  const finish = async event => {
    const current = state.active;
    if (!current || event.pointerId !== current.pointerId) return;
    state.active = null;
    if (current.locked === 'ignored' || current.locked === 'vertical' || !current.locked) {
      releasePointer(current);
      restoreDraggable(current);
      return;
    }
    const item = current.item;
    const actionThreshold = Math.max(thresholdPx, item.clientWidth * thresholdRatio);
    const direction = directionFor(current.dx);
    const supported = Boolean(actionFor(current, direction));
    const shouldAct = current.locked === 'horizontal' && supported && Math.abs(current.dx) >= actionThreshold;
    cancelScheduledVisual(state);
    releasePointer(current);

    if (current.swiped || shouldAct) {
      state.suppressClickUntil = Date.now() + 450;
      state.suppressClickItem = current.item;
    }
    event.preventDefault();

    if (!shouldAct) {
      if (current.swiped) {
        item.classList.add('swipe-settling');
        windowTarget.requestAnimationFrame?.(() => setSwipeVisual(item, current.shell, 0, 0, actionThreshold));
        await wait(state, reducedMotion(state) ? 0 : 180);
      }
      cleanupVisual(state, item, current.shell);
      restoreDraggable(current);
      return;
    }

    item.classList.add('swipe-committing');
    setSwipeVisual(item, current.shell, direction === 'left' ? -item.clientWidth : item.clientWidth, current.dx, actionThreshold);
    await wait(state, reducedMotion(state) ? 0 : 130);
    cleanupVisual(state, item, current.shell);
    restoreDraggable(current);
    await current.adapter.onCommit?.({ key: current.key, direction, item });
  };

  documentTarget.addEventListener('pointerup', event => { void finish(event); }, { passive: false });
  documentTarget.addEventListener('pointercancel', event => {
    if (state.active && event.pointerId === state.active.pointerId) cancelActive(state);
  }, { passive: true });
  documentTarget.addEventListener('lostpointercapture', event => {
    if (state.active && event.pointerId === state.active.pointerId) state.active.capturedPointer = false;
  }, { passive: true });
  documentTarget.addEventListener('visibilitychange', () => {
    if (documentTarget.hidden) cancelActive(state);
  }, { passive: true });
  windowTarget.addEventListener('blur', () => cancelActive(state), { passive: true });
  windowTarget.addEventListener('pagehide', () => cancelActive(state), { passive: true });
}

export function registerItemSwipeAdapter({
  id,
  cardSelector,
  keyFromCard,
  directions = [],
  canStart = () => true,
  interactiveStartSelector = '',
  protectedStartSelector = '',
  labelFor = () => '',
  onActivate = () => {},
  onCommit = async () => {},
  documentTarget = globalThis.document,
  windowTarget = globalThis.window,
} = {}) {
  if (!id || !cardSelector || typeof keyFromCard !== 'function' || !documentTarget || !windowTarget) return () => {};
  const state = stateFor(documentTarget, windowTarget);
  const adapter = { id, cardSelector, keyFromCard, directions, canStart, interactiveStartSelector, protectedStartSelector, labelFor, onActivate, onCommit };
  state.adapters.set(id, adapter);
  return () => {
    if (state.adapters.get(id) === adapter) state.adapters.delete(id);
  };
}
