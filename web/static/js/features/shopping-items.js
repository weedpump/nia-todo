import { iconSvg } from '../icons/lucide-icons.js';

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

function sameId(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null && String(left) === String(right);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export function formatShoppingQuantity(item = {}, locale = undefined) {
  const hasValue = item.quantity_value !== null && item.quantity_value !== undefined && item.quantity_value !== '';
  const numericValue = hasValue ? Number(item.quantity_value) : null;
  const quantity = hasValue && Number.isFinite(numericValue)
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: 20 }).format(numericValue)
    : '';
  const unit = String(item.quantity_unit ?? '').trim();
  return [quantity, unit].filter(Boolean).join(' ');
}

export function renderShoppingItem({ item = {}, canEdit = false, locale = undefined, labels = {} } = {}) {
  const completed = item.completed === true || item.completed === 1;
  const editable = canEdit === true;
  const id = escapeHtmlAttr(String(item.id ?? ''));
  const quantity = formatShoppingQuantity(item, locale);
  const ariaLabel = completed ? labels.markOpen : labels.markCompleted;
  const classes = [
    'ui-item-card',
    'shopping-item-card',
    completed ? 'is-completed' : '',
    item.is_pending === true ? 'is-pending' : '',
  ].filter(Boolean).join(' ');
  return `
    <div class="${classes}" data-shopping-item-key="${id}">
      <button type="button" class="shopping-item-check" role="checkbox" aria-checked="${completed ? 'true' : 'false'}" aria-label="${escapeHtmlAttr(ariaLabel || '')}"${editable ? ` data-shopping-item-action="toggle-completed" data-shopping-item-id="${id}"` : ' disabled'}>
        <span class="shopping-item-check-icon" aria-hidden="true">${completed ? iconSvg('check') : ''}</span>
      </button>
      <span class="shopping-item-title">${escapeHtml(item.name || '')}</span>
      ${quantity ? `<span class="ui-badge shopping-item-quantity">${escapeHtml(quantity)}</span>` : ''}
    </div>
  `;
}

export function createShoppingItemsController({
  getLists = () => [],
  setLists = () => {},
  getActiveListId = () => null,
  commitMutation,
  render = () => {},
  isOnlineForSync = () => false,
  syncWithServer = async () => {},
  onError = () => {},
} = {}) {
  const inFlight = new Map();
  const listQueues = new Map();
  let root = null;

  function currentList(listId) {
    if (!sameId(getActiveListId(), listId)) return null;
    return getLists().find(list => sameId(list.id, listId)) || null;
  }

  function publish(mutation) {
    if (!mutation?.list) return null;
    setLists(getLists().map(list => sameId(list.id, mutation.list.id) ? mutation.list : list));
    render();
    if (isOnlineForSync()) syncWithServer().catch(onError);
    return mutation.result || null;
  }

  function enqueueForList(listIdentity, task) {
    const key = String(listIdentity);
    const previous = listQueues.get(key);
    const ready = previous ? previous.catch(() => null) : Promise.resolve();
    const operation = ready.then(task);
    listQueues.set(key, operation);
    operation.finally(() => {
      if (listQueues.get(key) === operation) listQueues.delete(key);
    }).catch(() => {});
    return operation;
  }

  function toggleCompleted(listId, itemId) {
    const live = currentList(listId);
    const initialItem = (live?.items || []).find(item => sameId(item.id, itemId));
    if (live?.can_edit !== true || !initialItem) return Promise.resolve(null);
    const stableListIdentity = live.client_mutation_id ?? live.id;
    const stableIdentity = initialItem.client_mutation_id ?? initialItem.id;
    const key = `${String(listId)}\u0000${String(stableIdentity)}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const operation = enqueueForList(stableListIdentity, async () => {
      const mutation = await commitMutation(() => {
        const latest = currentList(listId);
        if (latest?.can_edit !== true) return null;
        const item = (latest.items || []).find(candidate => (
          sameId(candidate.id, itemId)
          || sameId(candidate.client_mutation_id, stableIdentity)
        ));
        if (!item) return null;
        const completed = !Boolean(item.completed);
        const updated = { ...clone(item), completed, is_pending: true };
        return {
          list: {
            ...clone(latest),
            items: latest.items.map(candidate => sameId(candidate.id, item.id) ? updated : clone(candidate)),
          },
          action: 'UPDATE_SHOPPING_ITEM',
          data: { shopping_list_id: latest.id, item_id: item.id, changes: { completed } },
          result: updated,
        };
      });
      return publish(mutation);
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, operation);
    return operation;
  }

  async function onClick(event) {
    const target = event.target?.closest?.('[data-shopping-item-action="toggle-completed"]');
    if (!target || !root?.contains?.(target)) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    const restoreFocus = target.ownerDocument?.activeElement === target;
    try {
      const updated = await toggleCompleted(getActiveListId(), target.dataset.shoppingItemId);
      if (restoreFocus && updated) {
        Array.from(root?.querySelectorAll?.('[data-shopping-item-action="toggle-completed"]') || [])
          .find(button => sameId(button.dataset.shoppingItemId, updated.id))
          ?.focus?.();
      }
    } catch (error) {
      onError(error);
    }
  }

  return {
    toggleCompleted,
    bindRoot(nextRoot) {
      if (root === nextRoot) return;
      root?.removeEventListener?.('click', onClick);
      root = nextRoot || null;
      root?.addEventListener?.('click', onClick);
    },
    destroy() {
      root?.removeEventListener?.('click', onClick);
      root = null;
      inFlight.clear();
      listQueues.clear();
    },
  };
}
