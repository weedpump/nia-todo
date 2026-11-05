import { iconSvg } from '../icons/lucide-icons.js';
import { registerItemSwipeAdapter, renderItemSwipeShell } from '../ui/item-swipe.js';

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
  const editLabel = labels.edit || item.name || '';
  const classes = [
    'ui-item-card',
    'shopping-item-card',
    editable ? 'ui-swipe-card' : '',
    completed ? 'is-completed' : '',
    item.is_pending === true ? 'is-pending' : '',
  ].filter(Boolean).join(' ');
  const cardMarkup = `
    <div class="${classes}" data-shopping-item-key="${id}"${editable ? ' data-item-dnd="true" draggable="true"' : ''}>
      <button type="button" class="shopping-item-check" role="checkbox" aria-checked="${completed ? 'true' : 'false'}" aria-label="${escapeHtmlAttr(ariaLabel || '')}"${editable ? ` data-shopping-item-action="toggle-completed" data-shopping-item-id="${id}"` : ' disabled'}>
        <span class="shopping-item-check-icon" aria-hidden="true">${completed ? iconSvg('check') : ''}</span>
      </button>
      ${editable ? `
        <button type="button" class="shopping-item-edit-trigger" data-shopping-item-action="open-edit" data-shopping-item-id="${id}" aria-label="${escapeHtmlAttr(editLabel)}">
          <span class="shopping-item-title">${escapeHtml(item.name || '')}</span>
          ${quantity ? `<span class="ui-badge shopping-item-quantity">${escapeHtml(quantity)}</span>` : ''}
        </button>
      ` : `
        <div class="shopping-item-content">
          <span class="shopping-item-title">${escapeHtml(item.name || '')}</span>
          ${quantity ? `<span class="ui-badge shopping-item-quantity">${escapeHtml(quantity)}</span>` : ''}
        </div>
      `}
    </div>
  `;
  if (!editable) return cardMarkup;
  return renderItemSwipeShell({
    key: id,
    cardMarkup,
    actions: {
      left: {
        icon: 'check',
        label: completed ? labels.swipeReopen : labels.swipeComplete,
        tone: 'success',
      },
    },
  });
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
  onEdit = () => {},
  enqueueListMutation = null,
  createTempId = () => `temp-shopping-item-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
} = {}) {
  const inFlight = new Map();
  const scopedCreates = new WeakMap();
  const listQueues = new Map();
  let root = null;

  registerItemSwipeAdapter({
    id: 'shopping-items',
    cardSelector: '.shopping-item-card.ui-swipe-card[data-shopping-item-key]',
    keyFromCard: item => item.dataset.shoppingItemKey,
    directions: ['left'],
    canStart: item => item.closest('.ui-swipe-shell') !== null,
    interactiveStartSelector: '.shopping-item-edit-trigger',
    protectedStartSelector: '.shopping-item-check',
    onCommit: async ({ key }) => {
      try {
        await toggleCompleted(getActiveListId(), key);
      } catch (error) {
        onError(error);
      }
    },
  });

  function listByIdentity(listId) {
    return getLists().find(candidate => (
      sameId(candidate.id, listId)
      || sameId(candidate.client_mutation_id, listId)
    )) || null;
  }

  function currentList(listId) {
    const list = listByIdentity(listId);
    if (!list) return null;
    const activeId = getActiveListId();
    if (!sameId(list.id, activeId) && !sameId(list.client_mutation_id, activeId)) return null;
    return list;
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

  function enqueueLocallyForList(listIdentity, task) {
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
  const runListMutation = enqueueListMutation || enqueueLocallyForList;

  function canUseCreateStore(store, list) {
    return store != null && store.active !== false
      && (sameId(store.shopping_list_id, list.id) || sameId(store.shopping_list_id, list.client_mutation_id));
  }

  function prepareCreateInput(input = {}, live) {
    if (!input || typeof input !== 'object') return null;
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
    if (!name || name.length > 500) return null;
    if (quantity !== null && (!Number.isFinite(quantity) || quantity < 0)) return null;
    if (unit.length > 40) return null;
    if (suppliedStoreIds !== undefined && (!Array.isArray(suppliedStoreIds) || suppliedStoreIds.length > 1)) return null;
    const storeValue = input.storeId ?? suppliedStoreIds?.[0] ?? null;
    const storeInput = storeValue === '' ? null : storeValue;
    const section = sectionInput == null ? null : (live.sections || []).find(candidate => (
      sameId(candidate.id, sectionInput) || sameId(candidate.client_mutation_id, sectionInput)
    ));
    if (sectionInput != null && !section) return null;
    const store = storeInput == null ? null : getStores().find(candidate => (
      sameId(candidate.id, storeInput) || sameId(candidate.client_mutation_id, storeInput)
    ));
    if (storeInput != null && !canUseCreateStore(store, live)) return null;
    return {
      name, quantity, unit,
      sectionIdentity: section?.client_mutation_id ?? section?.id ?? null,
      storeIdentity: store?.client_mutation_id ?? store?.id ?? null,
    };
  }

  function buildCreateRecord(latest, input, tempId, sortOrder) {
    const section = input.sectionIdentity == null ? null : (latest.sections || []).find(candidate => (
      sameId(candidate.id, input.sectionIdentity) || sameId(candidate.client_mutation_id, input.sectionIdentity)
    ));
    if (input.sectionIdentity != null && !section) return null;
    const store = input.storeIdentity == null ? null : getStores().find(candidate => (
      sameId(candidate.id, input.storeIdentity) || sameId(candidate.client_mutation_id, input.storeIdentity)
    ));
    if (input.storeIdentity != null && !canUseCreateStore(store, latest)) return null;
    const itemData = {
      name: input.name,
      section_id: section?.id ?? null,
      quantity_value: input.quantity,
      quantity_unit: input.unit || null,
      store_ids: store ? [store.id] : [],
      sort_order: sortOrder,
      client_mutation_id: tempId,
    };
    return {
      item: {
        id: tempId,
        shopping_list_id: latest.id,
        ...clone(itemData),
        stores: store ? [clone(store)] : [],
        completed: false,
        is_pending: true,
      },
      mutation: {
        action: 'CREATE_SHOPPING_ITEM',
        data: { shopping_list_id: latest.id, temp_id: tempId, item: itemData, client_mutation_id: tempId },
      },
    };
  }

  function submitCreates(live, inputs, { single = false, isCurrent = () => true, submissionScope = null } = {}) {
    // Editor sessions deduplicate locally without inheriting an abandoned guard.
    let pending = inFlight;
    if (submissionScope) {
      if (!scopedCreates.has(submissionScope)) scopedCreates.set(submissionScope, new Map());
      pending = scopedCreates.get(submissionScope);
    }
    const stableListIdentity = live.client_mutation_id ?? live.id;
    const submissionKey = `${single ? 'create' : 'create-many'}\u0000${String(stableListIdentity)}\u0000${JSON.stringify(inputs)}`;
    if (pending.has(submissionKey)) return pending.get(submissionKey);
    const tempIds = inputs.map(() => createTempId());
    const operation = runListMutation(stableListIdentity, async () => {
      const mutation = await commitMutation(() => {
        const latest = listByIdentity(stableListIdentity);
        if (latest?.can_edit !== true || !isCurrent()) return null;
        const firstOrder = (latest.items || []).reduce((maximum, item) => {
          const candidate = Number(item.sort_order);
          return Number.isFinite(candidate) ? Math.max(maximum, candidate) : maximum;
        }, -1) + 1;
        const records = inputs.map((input, index) => buildCreateRecord(latest, input, tempIds[index], firstOrder + index));
        if (records.some(record => !record)) return null;
        const list = { ...clone(latest), items: [...(latest.items || []).map(clone), ...records.map(record => record.item)] };
        if (single) return { list, ...records[0].mutation, result: records[0].item };
        return { list, mutations: records.map(record => record.mutation), result: records.map(record => record.item) };
      });
      return publish(mutation, { waitForSync: single });
    }).finally(() => pending.delete(submissionKey));
    pending.set(submissionKey, operation);
    return operation;
  }

  function create(input = {}) {
    const live = currentList(getActiveListId());
    if (live?.can_edit !== true) return Promise.resolve(null);
    const prepared = prepareCreateInput(input, live);
    if (!prepared) return Promise.resolve(null);
    return submitCreates(live, [prepared], { single: true });
  }

  function createMany(inputs, { listId = getActiveListId(), isCurrent = () => true, submissionScope = null } = {}) {
    const live = currentList(listId);
    if (live?.can_edit !== true || !Array.isArray(inputs) || inputs.length === 0 || inputs.length > 50) return Promise.resolve(null);
    const prepared = inputs.map(input => prepareCreateInput(input, live));
    if (prepared.some(input => !input)) return Promise.resolve(null);
    return submitCreates(live, prepared, { isCurrent, submissionScope });
  }

  function update(listId, itemId, input = {}) {
    const live = currentList(listId);
    const initialItem = (live?.items || []).find(item => (
      sameId(item.id, itemId)
      || sameId(item.client_mutation_id, itemId)
    ));
    if (live?.can_edit !== true || !initialItem) return Promise.resolve(null);
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
    if (storeInput != null && (!initialStore || initialStore.active === false)) return Promise.resolve(null);
    const stableItemIdentity = initialItem.client_mutation_id ?? initialItem.id;
    const stableSectionIdentity = initialSection?.client_mutation_id ?? initialSection?.id ?? null;
    const stableStoreIdentity = initialStore?.client_mutation_id ?? initialStore?.id ?? null;
    const stableListIdentity = live.client_mutation_id ?? live.id;
    const submissionKey = `update\u0000${String(stableListIdentity)}\u0000${String(stableItemIdentity)}`;
    if (inFlight.has(submissionKey)) return inFlight.get(submissionKey);
    const operation = runListMutation(stableListIdentity, async () => {
      const mutation = await commitMutation(() => {
        const latest = listByIdentity(stableListIdentity);
        if (latest?.can_edit !== true) return null;
        const item = (latest.items || []).find(candidate => (
          sameId(candidate.id, itemId)
          || sameId(candidate.client_mutation_id, stableItemIdentity)
        ));
        if (!item) return null;
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
        if (stableStoreIdentity != null && (!store || store.active === false)) return null;
        const enumerableStores = getStores();
        const retainedHiddenStoreIds = (item.store_ids || []).filter(storeId => !enumerableStores.some(candidate => (
          sameId(candidate.id, storeId)
          || sameId(candidate.client_mutation_id, storeId)
        )));
        const storeIds = [...retainedHiddenStoreIds, ...(store ? [store.id] : [])]
          .filter((storeId, index, values) => values.findIndex(candidate => sameId(candidate, storeId)) === index);
        const changes = {
          name,
          section_id: section?.id ?? null,
          quantity_value: quantity,
          quantity_unit: unit || null,
          store_ids: storeIds,
        };
        const updated = {
          ...clone(item),
          ...clone(changes),
          stores: store ? [clone(store)] : [],
          is_pending: true,
        };
        return {
          list: {
            ...clone(latest),
            items: latest.items.map(candidate => sameId(candidate.id, item.id) ? updated : clone(candidate)),
          },
          action: 'UPDATE_SHOPPING_ITEM',
          data: { shopping_list_id: latest.id, item_id: item.id, changes },
          result: updated,
        };
      });
      return publish(mutation);
    }).finally(() => inFlight.delete(submissionKey));
    inFlight.set(submissionKey, operation);
    return operation;
  }

  function remove(listId, itemId) {
    const live = currentList(listId);
    const initialItem = (live?.items || []).find(item => (
      sameId(item.id, itemId)
      || sameId(item.client_mutation_id, itemId)
    ));
    if (live?.can_edit !== true || !initialItem) return Promise.resolve(null);
    const stableListIdentity = live.client_mutation_id ?? live.id;
    const stableItemIdentity = initialItem.client_mutation_id ?? initialItem.id;
    const submissionKey = `delete\u0000${String(stableListIdentity)}\u0000${String(stableItemIdentity)}`;
    if (inFlight.has(submissionKey)) return inFlight.get(submissionKey);
    const operation = runListMutation(stableListIdentity, async () => {
      const mutation = await commitMutation(() => {
        const latest = listByIdentity(stableListIdentity);
        if (latest?.can_edit !== true) return null;
        const item = (latest.items || []).find(candidate => (
          sameId(candidate.id, itemId)
          || sameId(candidate.client_mutation_id, stableItemIdentity)
        ));
        if (!item) return null;
        return {
          list: {
            ...clone(latest),
            items: latest.items.filter(candidate => !sameId(candidate.id, item.id)).map(clone),
          },
          action: 'DELETE_SHOPPING_ITEM',
          data: { shopping_list_id: latest.id, item_id: item.id },
          result: clone(item),
        };
      });
      return publish(mutation);
    }).finally(() => inFlight.delete(submissionKey));
    inFlight.set(submissionKey, operation);
    return operation;
  }

  function toggleCompleted(listId, itemId) {
    const live = currentList(listId);
    const initialItem = (live?.items || []).find(item => (
      sameId(item.id, itemId)
      || sameId(item.client_mutation_id, itemId)
    ));
    if (live?.can_edit !== true || !initialItem) return Promise.resolve(null);
    const stableListIdentity = live.client_mutation_id ?? live.id;
    const stableIdentity = initialItem.client_mutation_id ?? initialItem.id;
    const key = `${String(stableListIdentity)}\u0000${String(stableIdentity)}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const operation = runListMutation(stableListIdentity, async () => {
      const mutation = await commitMutation(() => {
        const latest = listByIdentity(stableListIdentity);
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

  function moveToSection(listId, itemId, sectionId) {
    const live = currentList(listId);
    const initialItem = (live?.items || []).find(item => (
      sameId(item.id, itemId)
      || sameId(item.client_mutation_id, itemId)
    ));
    const initialSection = sectionId == null
      ? null
      : (live?.sections || []).find(section => (
        sameId(section.id, sectionId)
        || sameId(section.client_mutation_id, sectionId)
      ));
    if (live?.can_edit !== true || !initialItem || (sectionId != null && !initialSection)) return Promise.resolve(null);
    const stableListIdentity = live.client_mutation_id ?? live.id;
    const stableItemIdentity = initialItem.client_mutation_id ?? initialItem.id;
    const stableSectionIdentity = initialSection?.client_mutation_id ?? initialSection?.id ?? null;
    const submissionKey = `move-section\u0000${String(stableListIdentity)}\u0000${String(stableItemIdentity)}`;
    if (inFlight.has(submissionKey)) return inFlight.get(submissionKey);
    const operation = runListMutation(stableListIdentity, async () => {
      const mutation = await commitMutation(() => {
        const latest = listByIdentity(stableListIdentity);
        if (latest?.can_edit !== true) return null;
        const item = (latest.items || []).find(candidate => (
          sameId(candidate.id, itemId)
          || sameId(candidate.client_mutation_id, stableItemIdentity)
        ));
        if (!item) return null;
        const section = stableSectionIdentity == null
          ? null
          : (latest.sections || []).find(candidate => (
            sameId(candidate.id, stableSectionIdentity)
            || sameId(candidate.client_mutation_id, stableSectionIdentity)
          ));
        if (stableSectionIdentity != null && !section) return null;
        const nextSectionId = section?.id ?? null;
        if (sameId(item.section_id, nextSectionId) || (item.section_id == null && nextSectionId == null)) return null;
        const updated = { ...clone(item), section_id: nextSectionId, is_pending: true };
        return {
          list: {
            ...clone(latest),
            items: latest.items.map(candidate => sameId(candidate.id, item.id) ? updated : clone(candidate)),
          },
          action: 'UPDATE_SHOPPING_ITEM',
          data: { shopping_list_id: latest.id, item_id: item.id, changes: { section_id: nextSectionId } },
          result: updated,
        };
      });
      return publish(mutation);
    }).finally(() => inFlight.delete(submissionKey));
    inFlight.set(submissionKey, operation);
    return operation;
  }

  const dragAdapter = {
    interactiveStartSelector: '.shopping-item-edit-trigger',
    protectedStartSelector: '.shopping-item-check',
    canDrag: () => currentList(getActiveListId())?.can_edit === true,
    keyFromElement: element => element?.dataset?.shoppingItemKey,
    resolveSectionId(rawId) {
      if (rawId === 'null' || rawId == null) return null;
      const live = currentList(getActiveListId());
      return (live?.sections || []).find(section => (
        sameId(section.id, rawId)
        || sameId(section.client_mutation_id, rawId)
      ))?.id ?? rawId;
    },
    moveToSection: (itemId, sectionId) => moveToSection(getActiveListId(), itemId, sectionId),
    focusItem(itemId) {
      const live = currentList(getActiveListId());
      const item = (live?.items || []).find(candidate => (
        sameId(candidate.id, itemId)
        || sameId(candidate.client_mutation_id, itemId)
      ));
      if (!item) return;
      Array.from(root?.querySelectorAll?.('.shopping-item-card[data-shopping-item-key]') || [])
        .find(element => sameId(element.dataset.shoppingItemKey, item.id))
        ?.querySelector?.('.shopping-item-edit-trigger')
        ?.focus?.();
    },
  };

  async function onClick(event) {
    const editTarget = event.target?.closest?.('[data-shopping-item-action="open-edit"]');
    if (editTarget && root?.contains?.(editTarget)) {
      event.preventDefault?.();
      event.stopPropagation?.();
      onEdit(getActiveListId(), editTarget.dataset.shoppingItemId, editTarget);
      return;
    }
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
    createMany,
    update,
    remove,
    toggleCompleted,
    moveToSection,
    dragAdapter,
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
