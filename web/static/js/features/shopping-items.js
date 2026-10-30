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
  getStores = () => [],
  commitMutation,
  render = () => {},
  isOnlineForSync = () => false,
  syncWithServer = async () => {},
  onError = () => {},
  createTempId = () => `temp-shopping-item-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
} = {}) {
  const inFlight = new Map();
  const listQueues = new Map();
  let root = null;

  function currentList(listId) {
    if (!sameId(getActiveListId(), listId)) return null;
    return getLists().find(list => sameId(list.id, listId)) || null;
  }

  async function publish(mutation, { waitForSync = false } = {}) {
    if (!mutation?.list) return null;
    setLists(getLists().map(list => sameId(list.id, mutation.list.id) ? mutation.list : list));
    render();
    let synchronized = false;
    if (isOnlineForSync()) {
      const syncPromise = Promise.resolve(syncWithServer()).catch((error) => {
        onError(error);
        if (waitForSync) throw error;
      });
      if (waitForSync) {
        await syncPromise;
        synchronized = true;
      }
    }
    if (!waitForSync || !synchronized) return mutation.result || null;
    const list = getLists().find(candidate => sameId(candidate.id, mutation.list.id));
    const result = mutation.result || null;
    const visible = (list?.items || []).find(item => sameId(item.id, result?.id)
      || (result?.client_mutation_id && sameId(item.client_mutation_id, result.client_mutation_id)));
    if (!visible) throw new Error('Created shopping item is not visible after synchronization');
    return visible;
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

  function create(input = {}) {
    const live = currentList(getActiveListId());
    if (live?.can_edit !== true) return Promise.resolve(null);
    const name = String(input.name ?? '').trim();
    const quantityInput = input.quantity ?? input.quantity_value;
    const quantityText = typeof quantityInput === 'string' ? quantityInput.trim() : quantityInput;
    const quantity = quantityText === '' || quantityText === null || quantityText === undefined
      ? null
      : Number(quantityText);
    const unit = String(input.unit ?? input.quantity_unit ?? '').trim();
    const sectionValue = input.sectionId ?? input.section_id ?? null;
    const sectionInput = sectionValue === '' ? null : sectionValue;
    const suppliedStoreIds = input.store_ids;
    if (!name || name.length > 500) return Promise.resolve(null);
    if (quantity !== null && (!Number.isFinite(quantity) || quantity < 0)) return Promise.resolve(null);
    if (unit.length > 40) return Promise.resolve(null);
    if (suppliedStoreIds !== undefined && (!Array.isArray(suppliedStoreIds) || suppliedStoreIds.length > 1)) return Promise.resolve(null);
    const storeValue = input.storeId ?? suppliedStoreIds?.[0] ?? null;
    const storeInput = storeValue === '' ? null : storeValue;
    const initialSection = sectionInput == null
      ? null
      : (live.sections || []).find(candidate => (
        sameId(candidate.id, sectionInput)
        || sameId(candidate.client_mutation_id, sectionInput)
      ));
    if (sectionInput != null && !initialSection) return Promise.resolve(null);
    const initialStore = storeInput == null
      ? null
      : getStores().find(candidate => (
        sameId(candidate.id, storeInput)
        || sameId(candidate.client_mutation_id, storeInput)
      ));
    if (storeInput != null && !initialStore) return Promise.resolve(null);
    const stableSectionIdentity = initialSection?.client_mutation_id ?? initialSection?.id ?? null;
    const stableStoreIdentity = initialStore?.client_mutation_id ?? initialStore?.id ?? null;
    const stableListIdentity = live.client_mutation_id ?? live.id;
    const submissionKey = `create\u0000${String(stableListIdentity)}\u0000${JSON.stringify([name, quantity, unit, stableSectionIdentity, stableStoreIdentity])}`;
    if (inFlight.has(submissionKey)) return inFlight.get(submissionKey);
    const tempId = createTempId();
    const operation = enqueueForList(stableListIdentity, async () => {
      const mutation = await commitMutation(() => {
        const latest = currentList(live.id);
        if (latest?.can_edit !== true) return null;
        const section = stableSectionIdentity == null
          ? null
          : (latest.sections || []).find(candidate => (
            sameId(candidate.id, stableSectionIdentity)
            || sameId(candidate.client_mutation_id, stableSectionIdentity)
          ));
        if (stableSectionIdentity != null && !section) return null;
        const store = stableStoreIdentity == null
          ? null
          : getStores().find(candidate => (
            sameId(candidate.id, stableStoreIdentity)
            || sameId(candidate.client_mutation_id, stableStoreIdentity)
          ));
        if (stableStoreIdentity != null && !store) return null;
        const sortOrder = (latest.items || []).reduce((maximum, item) => {
          const candidate = Number(item.sort_order);
          return Number.isFinite(candidate) ? Math.max(maximum, candidate) : maximum;
        }, -1) + 1;
        const itemData = {
          name,
          section_id: section?.id ?? null,
          quantity_value: quantity,
          quantity_unit: unit || null,
          store_ids: store ? [store.id] : [],
          sort_order: sortOrder,
          client_mutation_id: tempId,
        };
        const item = {
          id: tempId,
          shopping_list_id: latest.id,
          ...clone(itemData),
          stores: store ? [clone(store)] : [],
          completed: false,
          is_pending: true,
        };
        return {
          list: { ...clone(latest), items: [...(latest.items || []).map(clone), item] },
          action: 'CREATE_SHOPPING_ITEM',
          data: {
            shopping_list_id: latest.id,
            temp_id: tempId,
            item: itemData,
            client_mutation_id: tempId,
          },
          result: item,
        };
      });
      return publish(mutation, { waitForSync: true });
    }).finally(() => inFlight.delete(submissionKey));
    inFlight.set(submissionKey, operation);
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
    create,
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
