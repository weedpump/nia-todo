import { resolveEntityIdentity, resolveEntityMutationReceipt, entityIdentity } from '../core/entity-identity.js';
import { normalizeQuantityUnit } from '../core/quantity-units.js';
import { formatQuantity } from '../core/recipe-quantities.js';
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
  if (item.quantity_text) return String(item.quantity_text).trim();
  return formatQuantity(item.quantity_value, item.quantity_unit, locale, { kitchen: item.quantity_display_mode === 'kitchen' });
}

export function renderShoppingItem({ item = {}, canEdit = false, locale = undefined, labels = {} } = {}) {
  const completed = item.completed === true || item.completed === 1;
  const editable = canEdit === true;
  const id = escapeHtmlAttr(String(item.id ?? ''));
  const quantity = formatShoppingQuantity(item, locale);
  const sourceTitles = [...new Set((item.recipe_sources || []).map(source => source.recipe_title).filter(Boolean))];
  const caption = [item.note, sourceTitles.slice(0, 2).join(', ') + (sourceTitles.length > 2 ? ` +${sourceTitles.length - 2}` : '')].filter(Boolean).join(' · ');
  const copy = `<span class="shopping-item-copy"><span class="shopping-item-title">${escapeHtml(item.name || '')}</span>${caption ? `<span class="shopping-item-caption">${escapeHtml(caption)}</span>` : ''}</span>`;
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
          ${copy}
          ${quantity ? `<span class="ui-badge shopping-item-quantity">${escapeHtml(quantity)}</span>` : ''}
        </button>
      ` : `
        <div class="shopping-item-content">
          ${copy}
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
  getActorId = () => null,
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
  routingMemory = null,
  createTempId = () => `temp-shopping-item-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
} = {}) {
  const inFlight = new Map();
  const scopedCreates = new WeakMap();
  const listQueues = new Map();
  const createdItemAliases = new Map();
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

  const resolve = (records, identity) => resolveEntityIdentity(records, identity, { actorId: getActorId() });
  const storesFor = list => getStores().filter(store => sameId(store.shopping_list_id, list?.id));

  function listByIdentity(listId) {
    return resolve(getLists(), listId);
  }

  function rememberItemAlias(list, item, actorId = getActorId()) {
    if (typeof item?.client_mutation_id === 'string' && String(item.id).startsWith('temp-')
      && item.client_mutation_id !== item.id && sameId(item.created_by_user_id, actorId)) {
      createdItemAliases.set(String(item.id), { actorId, listIdentity: list.id, mutationId: item.client_mutation_id });
    }
  }

  function itemByIdentity(list, identity) {
    if (!list) return null;
    const receipt = String(identity || '').startsWith('temp-') ? createdItemAliases.get(String(identity)) : null;
    if (!receipt) {
      const item = resolve(list.items || [], identity);
      // Restore the same explicit request context when a durable offline draft
      // is opened before its creation receipt arrives after a reload.
      if (item && sameId(item.id, identity)) rememberItemAlias(list, item);
      return item;
    }
    if (!sameId(receipt.actorId, getActorId())
      || !sameId(listByIdentity(receipt.listIdentity)?.id, list.id)) return null;
    const exact = (list.items || []).find(item => sameId(item.id, identity));
    if (exact) return exact;
    return resolveEntityMutationReceipt(list.items || [], receipt.mutationId, { actorId: receipt.actorId });
  }

  function currentList(listId) {
    const list = listByIdentity(listId);
    if (!list) return null;
    const activeId = getActiveListId();
    if (!sameId(listByIdentity(activeId)?.id, list.id)) return null;
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
    const list = listByIdentity(mutation.list.id);
    const result = mutation.result || null;
    const visible = itemByIdentity(list, result?.id);
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
      && sameId(store.shopping_list_id, list.id);
  }

  function routingFeedback(value, allowedFields = ['list', 'section', 'stores']) {
    if (!value || typeof value !== 'object' || typeof value.event_id !== 'string' || !value.event_id.trim()
      || value.event_id.length > 200 || !Number.isInteger(value.generation) || value.generation < 0 || !Array.isArray(value.fields)) return undefined;
    return { event_id: value.event_id, generation: value.generation,
      fields: [...new Set(value.fields.filter(field => allowedFields.includes(field)))] };
  }

  function prepareCreateInput(input = {}, live) {
    if (!input || typeof input !== 'object') return null;
    const name = String(input.name ?? '').trim();
    const quantityInput = input.quantity ?? input.quantity_value;
    const quantityText = typeof quantityInput === 'string' ? quantityInput.trim() : quantityInput;
    const quantity = quantityText === '' || quantityText === null || quantityText === undefined
      ? null
      : Number(quantityText);
    const unit = normalizeQuantityUnit(input.unit ?? input.quantity_unit) || '';
    const freeQuantity = String(input.quantity_text ?? '').trim();
    const note = String(input.note ?? '').trim();
    if (freeQuantity.length > 500 || note.length > 2000 || (freeQuantity && quantity !== null)) return null;
    const sectionValue = input.sectionId ?? input.section_id ?? null;
    const sectionInput = sectionValue === '' ? null : sectionValue;
    const suppliedStoreIds = input.store_ids;
    if (!name || name.length > 500) return null;
    if (quantity !== null && (!Number.isFinite(quantity) || quantity < 0)) return null;
    if (unit.length > 40) return null;
    if (suppliedStoreIds !== undefined && (!Array.isArray(suppliedStoreIds) || suppliedStoreIds.length > 50)) return null;
    const requestedStores = suppliedStoreIds !== undefined ? suppliedStoreIds : input.storeId == null || input.storeId === '' ? [] : [input.storeId];
    const section = sectionInput == null ? null : resolve(live?.sections || [], sectionInput);
    if (sectionInput != null && !section) return null;
    const stores = requestedStores.map(id => resolve(storesFor(live), id));
    if (stores.some(store => !canUseCreateStore(store, live))) return null;
    const clientMutationId = input.client_mutation_id;
    if (clientMutationId != null && (typeof clientMutationId !== 'string'
      || !clientMutationId.trim() || clientMutationId.length > 120)) return null;
    return {
      name, quantity, unit, freeQuantity, note,
      sectionIdentity: entityIdentity(section, getActorId()),
      storeIdentities: [...new Set(stores.map(store => entityIdentity(store, getActorId())))],
      ...(input.routing_feedback ? { routingFeedback: routingFeedback(input.routing_feedback) } : {}),
      ...(clientMutationId != null ? { clientMutationId } : {}),
      ...(input.braindump_route ? { brainDumpRoute: clone(input.braindump_route) } : {}),
    };
  }

  function buildCreateRecord(latest, input, tempId, sortOrder) {
    const section = input.sectionIdentity == null ? null : resolve(latest?.sections || [], input.sectionIdentity);
    if (input.sectionIdentity != null && !section) return null;
    const stores = input.storeIdentities.map(identity => resolve(storesFor(latest), identity));
    if (stores.some(store => !canUseCreateStore(store, latest))) return null;
    const itemData = {
      name: input.name,
      section_id: section?.id ?? null,
      quantity_value: input.quantity,
      quantity_unit: input.unit || null,
      ...(input.freeQuantity ? { quantity_text: input.freeQuantity } : {}),
      ...(input.note ? { note: input.note } : {}),
      store_ids: stores.map(store => store.id),
      sort_order: sortOrder,
      client_mutation_id: input.clientMutationId || tempId,
    };
    return {
      item: {
        id: tempId,
        shopping_list_id: latest.id,
        created_by_user_id: getActorId(),
        ...clone(itemData),
        stores: stores.map(clone),
        completed: false,
        quantity_display_mode: 'exact',
        is_pending: true,
      },
      mutation: {
        action: 'CREATE_SHOPPING_ITEM',
        data: {
          shopping_list_id: latest.id, temp_id: tempId, client_mutation_id: itemData.client_mutation_id,
          item: { ...itemData, ...(input.brainDumpRoute ? { braindump_route: clone(input.brainDumpRoute) } : {}),
            ...(input.routingFeedback ? { routing_feedback: clone(input.routingFeedback) } : {}) },
        },
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
    const stableListIdentity = entityIdentity(live, getActorId());
    const actorId = getActorId();
    const submissionKey = `${single ? 'create' : 'create-many'}\u0000${String(stableListIdentity)}\u0000${JSON.stringify(inputs)}`;
    if (pending.has(submissionKey)) return pending.get(submissionKey);
    const suppliedMutations = inputs.map(input => input.clientMutationId).filter(value => value != null);
    if (new Set(suppliedMutations).size !== suppliedMutations.length) return Promise.resolve(null);
    const tempIds = inputs.map(input => input.clientMutationId?.startsWith('temp-') ? input.clientMutationId : createTempId());
    if (new Set(tempIds).size !== tempIds.length) return Promise.resolve(null);
    const operation = runListMutation(stableListIdentity, async () => {
      const mutation = await commitMutation(() => {
        const latest = listByIdentity(stableListIdentity);
        if (latest?.can_edit !== true || !isCurrent()) return null;
        const firstOrder = (latest.items || []).reduce((maximum, item) => {
          const candidate = Number(item.sort_order);
          return Number.isFinite(candidate) ? Math.max(maximum, candidate) : maximum;
        }, -1) + 1;
        const records = inputs.map((input, index) => {
          const existing = input.clientMutationId && (latest.items || []).find(item => (
            sameId(item.client_mutation_id, input.clientMutationId)
          ));
          return existing ? { item: clone(existing), mutation: null }
            : buildCreateRecord(latest, input, tempIds[index], firstOrder + index);
        });
        if (records.some(record => !record)) return null;
        const additions = records.filter(record => record.mutation);
        const list = { ...clone(latest), items: [...(latest.items || []).map(clone), ...additions.map(record => record.item)] };
        if (single && records[0].mutation) return { list, ...records[0].mutation, result: records[0].item };
        return { list, mutations: additions.map(record => record.mutation), result: single ? records[0].item : records.map(record => record.item) };
      });
      if (mutation) for (const item of Array.isArray(mutation.result) ? mutation.result : [mutation.result]) {
        rememberItemAlias(live, item, actorId);
      }
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

  function createBatch(live, inputs, { isCurrent = () => true, submissionScope = null } = {}) {
    if (live?.can_edit !== true || !Array.isArray(inputs) || inputs.length === 0 || inputs.length > 50) return Promise.resolve(null);
    const prepared = inputs.map(input => prepareCreateInput(input, live));
    if (prepared.some(input => !input)) return Promise.resolve(null);
    return submitCreates(live, prepared, { isCurrent, submissionScope });
  }

  function createMany(inputs, { listId = getActiveListId(), ...options } = {}) {
    return createBatch(currentList(listId), inputs, options);
  }

  function createManyForList({ listId, items, isCurrent = () => true, submissionScope = null } = {}) {
    return createBatch(listByIdentity(listId), items, { isCurrent, submissionScope });
  }

  function update(listId, itemId, input = {}) {
    const live = currentList(listId);
    const initialItem = itemByIdentity(live, itemId);
    if (live?.can_edit !== true || !initialItem) return Promise.resolve(null);
    const name = String(input.name ?? '').trim();
    const quantityInput = Object.hasOwn(input, 'quantity') ? input.quantity
      : Object.hasOwn(input, 'quantity_value') ? input.quantity_value : initialItem.quantity_value;
    const quantityText = typeof quantityInput === 'string' ? quantityInput.trim() : quantityInput;
    const quantity = quantityText === '' || quantityText === null || quantityText === undefined
      ? null
      : Number(quantityText);
    const unit = normalizeQuantityUnit(Object.hasOwn(input, 'unit') ? input.unit
      : Object.hasOwn(input, 'quantity_unit') ? input.quantity_unit : initialItem.quantity_unit) || '';
    const freeQuantity = Object.hasOwn(input, 'quantity_text') ? String(input.quantity_text ?? '').trim() : quantity === null ? initialItem.quantity_text || '' : '';
    const note = Object.hasOwn(input, 'note') ? String(input.note ?? '').trim() : initialItem.note || '';
    const quantityChanged = quantity !== (initialItem.quantity_value == null ? null : Number(initialItem.quantity_value))
      || unit !== (normalizeQuantityUnit(initialItem.quantity_unit) || '')
      || freeQuantity !== (initialItem.quantity_text || '');
    if (freeQuantity.length > 500 || note.length > 2000 || (freeQuantity && quantity !== null)) return Promise.resolve(null);
    const sectionValue = input.sectionId ?? input.section_id ?? null;
    const sectionInput = sectionValue === '' ? null : sectionValue;
    const suppliedStoreIds = input.store_ids;
    if (!name || name.length > 500) return Promise.resolve(null);
    if (quantity !== null && (!Number.isFinite(quantity) || quantity < 0)) return Promise.resolve(null);
    if (unit.length > 40) return Promise.resolve(null);
    if (suppliedStoreIds !== undefined && (!Array.isArray(suppliedStoreIds) || suppliedStoreIds.length > 50)) return Promise.resolve(null);
    const requestedStores = suppliedStoreIds !== undefined ? suppliedStoreIds : input.storeId == null || input.storeId === '' ? [] : [input.storeId];
    const initialSection = sectionInput == null ? null : resolve(live?.sections || [], sectionInput);
    if (sectionInput != null && !initialSection) return Promise.resolve(null);
    const initialStores = requestedStores.map(id => resolve(storesFor(live), id));
    if (initialStores.some((store, index) => !canUseCreateStore(store, live) && !((initialItem.store_ids || []).some(id => sameId(id, requestedStores[index]))
      && (!store || sameId(store.shopping_list_id, live.id))))) return Promise.resolve(null);
    const stableItemIdentity = entityIdentity(initialItem, getActorId());
    const stableSectionIdentity = entityIdentity(initialSection, getActorId());
    const stableStoreIdentities = [...new Set(initialStores.map((store, index) => entityIdentity(store, getActorId()) ?? requestedStores[index]))];
    const stableListIdentity = entityIdentity(live, getActorId());
    const submissionKey = `update\u0000${String(stableListIdentity)}\u0000${String(stableItemIdentity)}`;
    if (inFlight.has(submissionKey)) return inFlight.get(submissionKey);
    const operation = runListMutation(stableListIdentity, async () => {
      const mutation = await commitMutation(() => {
        const latest = listByIdentity(stableListIdentity);
        if (latest?.can_edit !== true) return null;
        const item = itemByIdentity(latest, stableItemIdentity);
        if (!item) return null;
        const section = stableSectionIdentity == null
          ? null
          : resolve(latest?.sections || [], stableSectionIdentity);
        if (stableSectionIdentity != null && !section) return null;
        const stores = stableStoreIdentities.map(identity => resolve(storesFor(latest), identity));
        if (stores.some((store, index) => !canUseCreateStore(store, latest) && !((item.store_ids || []).some(id => sameId(id, stableStoreIdentities[index]))
          && (!store || sameId(store.shopping_list_id, latest.id))))) return null;
        const enumerableStores = getStores();
        const retainedHiddenStoreIds = (item.store_ids || []).filter(storeId => !resolve(enumerableStores.filter(candidate => sameId(candidate.shopping_list_id, latest.id)), storeId));
        const storeIds = [...retainedHiddenStoreIds, ...stores.map((store, index) => store?.id ?? stableStoreIdentities[index])]
          .filter((storeId, index, values) => values.findIndex(candidate => sameId(candidate, storeId)) === index);
        if (storeIds.length > 50) return null;
        const changedFields = [];
        if (!sameId(item.section_id, section?.id) && !(item.section_id == null && section == null)) changedFields.push('section');
        if (JSON.stringify([...(item.store_ids || [])].map(String).sort()) !== JSON.stringify([...storeIds].map(String).sort())) changedFields.push('stores');
        const feedback = routingFeedback(input.routing_feedback, changedFields);
        const changes = {
          name,
          section_id: section?.id ?? null,
          ...(quantityChanged ? { quantity_value: quantity, quantity_unit: unit || null,
            ...(Object.hasOwn(input, 'quantity_text') || initialItem.quantity_text ? { quantity_text: freeQuantity || null } : {}) } : {}),
          ...(Object.hasOwn(input, 'note') ? { note } : {}),
          store_ids: storeIds,
        };
        const updated = {
          ...clone(item),
          ...clone(changes),
          ...(quantityChanged ? { quantity_display_mode: 'exact' } : {}),
          stores: stores.filter(Boolean).map(clone),
          is_pending: true,
        };
        return {
          list: {
            ...clone(latest),
            items: latest.items.map(candidate => sameId(candidate.id, item.id) ? updated : clone(candidate)),
          },
          action: 'UPDATE_SHOPPING_ITEM',
          data: { shopping_list_id: latest.id, item_id: item.id, changes: { ...changes, ...(feedback ? { routing_feedback: feedback } : {}) } },
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
    const initialItem = itemByIdentity(live, itemId);
    if (live?.can_edit !== true || !initialItem) return Promise.resolve(null);
    const stableListIdentity = entityIdentity(live, getActorId());
    const stableItemIdentity = entityIdentity(initialItem, getActorId());
    const submissionKey = `delete\u0000${String(stableListIdentity)}\u0000${String(stableItemIdentity)}`;
    if (inFlight.has(submissionKey)) return inFlight.get(submissionKey);
    const operation = runListMutation(stableListIdentity, async () => {
      const mutation = await commitMutation(() => {
        const latest = listByIdentity(stableListIdentity);
        if (latest?.can_edit !== true) return null;
        const item = itemByIdentity(latest, stableItemIdentity);
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
    const initialItem = itemByIdentity(live, itemId);
    if (live?.can_edit !== true || !initialItem) return Promise.resolve(null);
    const stableListIdentity = entityIdentity(live, getActorId());
    const stableIdentity = entityIdentity(initialItem, getActorId());
    const key = `${String(stableListIdentity)}\u0000${String(stableIdentity)}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const operation = runListMutation(stableListIdentity, async () => {
      const mutation = await commitMutation(() => {
        const latest = listByIdentity(stableListIdentity);
        if (latest?.can_edit !== true) return null;
        const item = itemByIdentity(latest, stableIdentity);
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
    const initialItem = itemByIdentity(live, itemId);
    const initialSection = sectionId == null
      ? null
      : resolve(live?.sections || [], sectionId);
    if (live?.can_edit !== true || !initialItem || (sectionId != null && !initialSection)) return Promise.resolve(null);
    const stableListIdentity = entityIdentity(live, getActorId());
    const stableItemIdentity = entityIdentity(initialItem, getActorId());
    const stableSectionIdentity = entityIdentity(initialSection, getActorId());
    const submissionKey = `move-section\u0000${String(stableListIdentity)}\u0000${String(stableItemIdentity)}`;
    if (inFlight.has(submissionKey)) return inFlight.get(submissionKey);
    const feedback = routingFeedback(routingMemory?.feedback?.(['section']), ['section']);
    const operation = runListMutation(stableListIdentity, async () => {
      const mutation = await commitMutation(() => {
        const latest = listByIdentity(stableListIdentity);
        if (latest?.can_edit !== true) return null;
        const item = itemByIdentity(latest, stableItemIdentity);
        if (!item) return null;
        const section = stableSectionIdentity == null
          ? null
          : resolve(latest?.sections || [], stableSectionIdentity);
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
          data: { shopping_list_id: latest.id, item_id: item.id, changes: { section_id: nextSectionId, ...(feedback ? { routing_feedback: feedback } : {}) } },
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
      return resolve(live?.sections || [], rawId)?.id ?? rawId;
    },
    moveToSection: (itemId, sectionId) => moveToSection(getActiveListId(), itemId, sectionId),
    focusItem(itemId) {
      const live = currentList(getActiveListId());
      const item = itemByIdentity(live, itemId);
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
    resolveItem: (listId, identity) => itemByIdentity(listByIdentity(listId), identity),
    create,
    createMany,
    createManyForList,
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
      createdItemAliases.clear();
    },
  };
}
