const interactiveSelector = 'button, input, select, textarea, a, label, summary, details, [role="button"], [contenteditable="true"]';

function escapeAttribute(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function renderAttributes(attributes) {
  return Object.entries(attributes).filter(([, value]) => value !== null && value !== undefined)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('');
}

// Modules supply content and domain controls; this shell declares every shared
// surface state so CSS never has to infer the card shape from module markup.
export function renderItemCard({ content, className = '', attributes = {}, interactive = true, completed = false, details = false }) {
  const classes = className.split(/\s+/).filter(Boolean);
  if (!classes.includes('ui-item-card')) classes.push('ui-item-card');
  const attrs = renderAttributes({
    ...attributes,
    'data-item-card': 'true',
    'data-item-card-openable': interactive ? 'true' : null,
    'data-item-card-completed': completed ? 'true' : null,
    'data-item-card-details': details ? 'true' : null,
    'data-item-dnd': interactive ? 'true' : null,
    draggable: interactive ? 'true' : null,
  });
  return `<div class="${escapeAttribute(classes.join(' '))}"${attrs}>${content}</div>`;
}

// The title action provides keyboard access without turning a card containing
// checkboxes, menus or links into a nested button.
export function renderItemCardOpenAction({ content, label, className = '', attributes = {} }) {
  const attrs = renderAttributes(attributes);
  return `<button type="button" class="ui-item-card-open ${escapeAttribute(className)}" data-item-card-open aria-label="${escapeAttribute(label)}"${attrs}>${content}</button>`;
}

export function isItemCardInteractiveTarget(target, protectedTargetSelector = '') {
  if (protectedTargetSelector && target?.closest?.(protectedTargetSelector)) return true;
  const control = target?.closest?.(interactiveSelector);
  return Boolean(control && !control.matches?.('[data-item-card-open]'));
}

export function clearItemCardPress(item) {
  item?.classList?.remove('ui-item-card-press-active');
}

export function bindItemCardKeyboardShortcuts({ root, cardSelector, keyFromCard, isActive = () => true, getScope = () => null, canAct = () => true, onToggle, onDelete, onError = console.error }) {
  const doc = root?.ownerDocument || root;
  let hovered = null;
  const cardFromTarget = target => {
    const card = target?.closest?.(cardSelector);
    return card && root?.contains?.(card) && !card.classList.contains('native-drag-ghost') ? card : null;
  };
  const reset = () => { hovered = null; };
  const onPointerOver = event => {
    if (!isActive()) return reset();
    const item = cardFromTarget(event.target);
    if (item) hovered = { key: keyFromCard(item), scope: getScope() };
  };
  const onPointerOut = event => {
    const item = cardFromTarget(event.target);
    if (item && !item.contains(event.relatedTarget) && String(hovered?.key) === String(keyFromCard(item))) reset();
  };
  const onKeyDown = async event => {
    const action = event.key === 'Delete' ? onDelete : (event.key === ' ' || event.key === 'Spacebar') ? onToggle : null;
    if (!action || event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!isActive()) return reset();
    // Native controls (including the title action) keep their own keyboard
    // behavior. Hover shortcuts never act through an editor or open dialog.
    if (doc?.activeElement?.isContentEditable || event.target?.isContentEditable
      || doc?.activeElement?.closest?.(interactiveSelector)
      || event.target?.closest?.(interactiveSelector)
      || doc?.querySelector?.('.modal.active, dialog[open]')
      || doc?.body?.classList?.contains('native-pointer-dragging')) return;
    let item = cardFromTarget(doc?.activeElement);
    if (!item && hovered && hovered.scope === getScope()) {
      item = Array.from(root?.querySelectorAll?.(cardSelector) || [])
        .find(card => String(keyFromCard(card)) === String(hovered.key));
    }
    if (!item || !canAct(item) || item.matches('.dragging, .swiping')) return;
    event.preventDefault();
    try {
      await action(keyFromCard(item), item);
    } catch (error) {
      onError(error);
    }
  };
  root?.addEventListener?.('pointerover', onPointerOver, { passive: true });
  root?.addEventListener?.('pointerout', onPointerOut, { passive: true });
  doc?.addEventListener?.('keydown', onKeyDown);
  return {
    reset,
    remapKey(from, to) {
      if (hovered && String(hovered.key) === String(from)) hovered.key = to;
    },
    destroy() {
      reset();
      root?.removeEventListener?.('pointerover', onPointerOver);
      root?.removeEventListener?.('pointerout', onPointerOut);
      doc?.removeEventListener?.('keydown', onKeyDown);
    },
  };
}

export function bindItemCardInteractions({ root, cardSelector, onActivate, canActivate = () => true, protectedTargetSelector = '' }) {
  const doc = root?.ownerDocument || root;
  let press = null;
  const cardFromTarget = target => {
    const card = target?.closest?.(cardSelector);
    return card && root?.contains?.(card) && !card.classList.contains('native-drag-ghost') ? card : null;
  };
  const clearPress = () => {
    clearItemCardPress(press?.item);
    press = null;
  };
  const onPointerDown = event => {
    clearPress();
    if (!event.isPrimary || event.button > 0) return;
    const item = cardFromTarget(event.target);
    if (!item || !canActivate(item, event) || isItemCardInteractiveTarget(event.target, protectedTargetSelector)) return;
    press = { item, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    item.classList.add('ui-item-card-press-active');
  };
  const onPointerMove = event => {
    if (!press || event.pointerId !== press.pointerId) return;
    if (Math.abs(event.clientX - press.x) > 6 || Math.abs(event.clientY - press.y) > 6) clearPress();
  };
  const onPointerEnd = event => {
    if (event.pointerId === press?.pointerId) clearPress();
  };
  const onClick = event => {
    if (event.defaultPrevented) return;
    const item = cardFromTarget(event.target);
    if (!item || isItemCardInteractiveTarget(event.target, protectedTargetSelector)) return;
    if (!canActivate(item, event)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    onActivate(item, item.querySelector('[data-item-card-open]'), event);
  };
  root?.addEventListener?.('pointerdown', onPointerDown, { passive: true });
  root?.addEventListener?.('click', onClick);
  doc?.addEventListener?.('pointermove', onPointerMove, { passive: true });
  doc?.addEventListener?.('pointerup', onPointerEnd, { passive: true });
  doc?.addEventListener?.('pointercancel', onPointerEnd, { passive: true });
  doc?.addEventListener?.('dragstart', clearPress);
  return () => {
    clearPress();
    root?.removeEventListener?.('pointerdown', onPointerDown);
    root?.removeEventListener?.('click', onClick);
    doc?.removeEventListener?.('pointermove', onPointerMove);
    doc?.removeEventListener?.('pointerup', onPointerEnd);
    doc?.removeEventListener?.('pointercancel', onPointerEnd);
    doc?.removeEventListener?.('dragstart', clearPress);
  };
}
