import { isRecipeShoppingTransfer, rewriteRecipeShoppingTransfer } from './recipe-shopping-pending.js';
import { createMetadataCollection } from './entity-metadata.js';

const metadata = createMetadataCollection({ storeName: 'shoppingLists', createAction: 'CREATE_SHOPPING_LIST', updateAction: 'UPDATE_SHOPPING_LIST', deleteAction: 'DELETE_SHOPPING_LIST', fields: ['name', 'color', 'icon', 'sort_order'] });

function sameId(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null && String(left) === String(right);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function queueItemReferencesShoppingList(item, listId, stores = [], { orphanedStoreMatches = false } = {}) {
  const data = item?.data || {};
  if (['CREATE_SHOPPING_LIST', 'UPDATE_SHOPPING_LIST', 'DELETE_SHOPPING_LIST'].includes(item?.action)) {
    return metadata.references(item, listId);
  }
  if (['UPDATE_SHOPPING_STORE', 'DELETE_SHOPPING_STORE'].includes(item?.action)) {
    if (data.shopping_list_id != null) return sameId(data.shopping_list_id, listId);
    const store = stores.find(candidate => sameId(candidate.id, data.store_id));
    return store ? sameId(store.shopping_list_id, listId) : orphanedStoreMatches;
  }
  return sameId(data.shopping_list_id, listId);
}

export function hasPendingShoppingChanges(queue = [], listId) {
  return queue.some(item => queueItemReferencesShoppingList(item, listId));
}

export function hasPendingShoppingListCreate(queue = [], listId) {
  return metadata.hasPendingCreate(queue, listId);
}

function shoppingListIdForQueueItem(item, stores = []) {
  const data = item?.data || {};
  if (['CREATE_SHOPPING_LIST', 'UPDATE_SHOPPING_LIST', 'DELETE_SHOPPING_LIST'].includes(item?.action)) {
    return data.id ?? data.temp_id ?? null;
  }
  if (['UPDATE_SHOPPING_STORE', 'DELETE_SHOPPING_STORE'].includes(item?.action)) {
    if (data.shopping_list_id != null) return data.shopping_list_id;
    return stores.find(store => sameId(store.id, data.store_id))?.shopping_list_id ?? null;
  }
  return data.shopping_list_id ?? null;
}

export function collectRevokedShoppingListIds(serverLists = [], localLists = [], queue = [], stores = []) {
  return metadata.collectRevokedIds(serverLists, localLists, queue, {
    resolveQueueId: item => shoppingListIdForQueueItem(item, stores),
  });
}

export function backfillShoppingStoreQueueListIds(queue = [], stores = []) {
  return queue.map((entry) => {
    if (!['UPDATE_SHOPPING_STORE', 'DELETE_SHOPPING_STORE'].includes(entry?.action)) return entry;
    const data = entry.data || {};
    if (data.shopping_list_id != null) return entry;
    const store = stores.find(candidate => sameId(candidate.id, data.store_id));
    if (store?.shopping_list_id == null) return entry;
    return { ...entry, data: { ...data, shopping_list_id: store.shopping_list_id } };
  });
}

export function reconcileShoppingStoreQueueSnapshot(queue = [], {
  localStores = [], shoppingLists, shoppingStores,
} = {}) {
  const complete = Array.isArray(shoppingLists) && Array.isArray(shoppingStores);
  const authorizedListIds = new Set((Array.isArray(shoppingLists) ? shoppingLists : []).map(list => String(list.id)));
  const authorizedStores = complete
    ? shoppingStores.filter(store => authorizedListIds.has(String(store.shopping_list_id))) : [];
  const backfilled = backfillShoppingStoreQueueListIds(queue, [...authorizedStores, ...localStores]);
  const queueDeleteIds = [];
  const queueRecords = [];
  const reconciledQueue = backfilled.filter((entry, index) => {
    const unresolvedLegacyStore = ['UPDATE_SHOPPING_STORE', 'DELETE_SHOPPING_STORE'].includes(entry?.action)
      && entry.data?.shopping_list_id == null;
    // A complete recipient-specific snapshot closes the old list-less store
    // exception even if no cached list remains to trigger normal revocation.
    if (complete && unresolvedLegacyStore) {
      queueDeleteIds.push(entry.id);
      return false;
    }
    if (entry !== queue[index]) queueRecords.push(entry);
    return true;
  });
  return { queue: reconciledQueue, queueRecords, queueDeleteIds };
}

export function projectShoppingSnapshot(serverLists = [], localLists = [], queue = []) {
  return metadata.projectSnapshot(serverLists, localLists, queue, {
    project: projectPendingShoppingChanges,
    rewrite: (records, from, to) => rewriteShoppingQueueReferences(records, { listIdFrom: from, listIdTo: to }),
  });
}

export function projectPendingShoppingStores(serverStores = [], queue = []) {
  let projected = clone(serverStores) || [];
  for (const entry of queue) {
    const data = entry?.data || {};
    const changes = data.changes || {};
    switch (entry?.action) {
      case 'CREATE_SHOPPING_STORE': {
        const store = {
          active: true,
          ...clone(data.store || {}),
          id: data.temp_id,
          shopping_list_id: data.shopping_list_id ?? data.store?.shopping_list_id,
          is_pending: true,
        };
        projected = [...projected.filter(candidate => !sameId(candidate.id, store.id)), store];
        break;
      }
      case 'UPDATE_SHOPPING_STORE':
        projected = projected.map(store => sameId(store.id, data.store_id)
          ? { ...store, ...clone(changes), is_pending: true }
          : store);
        break;
      case 'DELETE_SHOPPING_STORE':
        projected = projected.filter(store => !sameId(store.id, data.store_id));
        break;
      default:
        break;
    }
  }
  return projected;
}

export function projectShoppingStoresSnapshot(serverStores = [], localStores = [], queue = []) {
  const projected = projectPendingShoppingStores(serverStores, queue);
  const projectedIds = new Set(projected.map(store => String(store.id)));
  for (const localStore of localStores || []) {
    const pendingCreate = queue.some(entry => entry?.action === 'CREATE_SHOPPING_STORE'
      && sameId(entry.data?.temp_id, localStore.id));
    if (!projectedIds.has(String(localStore.id)) && pendingCreate) projected.push(clone(localStore));
  }
  return projected;
}

export function projectPendingShoppingChanges(serverList, queue = []) {
  let projected = clone(serverList);
  const listId = projected?.id;
  if (listId === undefined || listId === null) return projected;

  for (const entry of queue) {
    if (!queueItemReferencesShoppingList(entry, listId)) continue;
    const data = entry.data || {};
    const changes = data.changes || {};
    switch (entry.action) {
      case 'UPDATE_SHOPPING_LIST':
        projected = { ...projected, ...clone(changes) };
        break;
      case 'DELETE_SHOPPING_LIST':
        return null;
      case 'CREATE_SHOPPING_SECTION': {
        const section = {
          ...clone(data.section || {}),
          id: data.temp_id,
          shopping_list_id: projected.id,
          is_pending: true,
        };
        projected.sections = [...(projected.sections || []).filter(item => !sameId(item.id, section.id)), section];
        break;
      }
      case 'UPDATE_SHOPPING_SECTION':
        projected.sections = (projected.sections || []).map(section => sameId(section.id, data.section_id) ? { ...section, ...clone(changes), is_pending: true } : section);
        break;
      case 'DELETE_SHOPPING_SECTION':
        projected.sections = (projected.sections || []).filter(section => !sameId(section.id, data.section_id));
        projected.items = (projected.items || []).map(item => sameId(item.section_id, data.section_id) ? { ...item, section_id: null } : item);
        break;
      case 'CREATE_SHOPPING_ITEM': {
        const item = {
          completed: false,
          store_ids: [],
          stores: [],
          ...clone(data.item || {}),
          id: data.temp_id,
          shopping_list_id: projected.id,
          is_pending: true,
        };
        projected.items = [...(projected.items || []).filter(candidate => !sameId(candidate.id, item.id)), item];
        break;
      }
      case 'UPDATE_SHOPPING_ITEM':
        projected.items = (projected.items || []).map(item => sameId(item.id, data.item_id) ? {
          ...item, ...clone(changes),
          ...(['quantity_value', 'quantity_unit', 'quantity_text'].some(key => Object.hasOwn(changes, key)) ? { quantity_display_mode: 'exact' } : {}),
          is_pending: true,
        } : item);
        break;
      case 'DELETE_SHOPPING_ITEM':
        projected.items = (projected.items || []).filter(item => !sameId(item.id, data.item_id));
        break;
      case 'DELETE_COMPLETED_SHOPPING_ITEMS':
        projected.items = (projected.items || []).filter(item => !item.completed);
        break;
      case 'UPDATE_SHOPPING_PREFERENCES':
        if (Object.prototype.hasOwnProperty.call(changes, 'hide_empty_sections')) {
          projected.preferences = {
            ...(projected.preferences || {}),
            hide_empty_sections: changes.hide_empty_sections === true,
          };
        }
        break;
      default:
        break;
    }
  }
  return projected;
}

export function rewriteShoppingQueueReferences(queue = [], {
  listIdFrom,
  listIdTo,
  sectionIdFrom,
  sectionIdTo,
  itemIdFrom,
  itemIdTo,
  storeIdFrom,
  storeIdTo,
} = {}) {
  return queue.map((entry) => {
    if (isRecipeShoppingTransfer(entry)) return rewriteRecipeShoppingTransfer(entry, { listIdFrom, listIdTo, sectionIdFrom, sectionIdTo, storeIdFrom, storeIdTo });
    const next = clone(entry);
    const data = next.data || {};
    const brainDumpRoute = data.item?.braindump_route;
    if (brainDumpRoute && typeof brainDumpRoute === 'object') {
      if (listIdFrom !== undefined && sameId(brainDumpRoute.original_shopping_list_id, listIdFrom)) {
        brainDumpRoute.original_shopping_list_id = listIdTo;
      }
      if (sectionIdFrom !== undefined && sameId(brainDumpRoute.original_shopping_section_id, sectionIdFrom)) {
        brainDumpRoute.original_shopping_section_id = sectionIdTo;
      }
      if (storeIdFrom !== undefined && Array.isArray(brainDumpRoute.original_shopping_store_ids)) {
        brainDumpRoute.original_shopping_store_ids = brainDumpRoute.original_shopping_store_ids
          .map(id => sameId(id, storeIdFrom) ? storeIdTo : id);
      }
    }
    if (listIdFrom !== undefined) {
      if (sameId(data.id, listIdFrom)) data.id = listIdTo;
      if (sameId(data.temp_id, listIdFrom) && next.action === 'CREATE_SHOPPING_LIST') data.temp_id = listIdTo;
      if (sameId(data.shopping_list_id, listIdFrom)) data.shopping_list_id = listIdTo;
      if (data.list && sameId(data.list.id, listIdFrom)) data.list.id = listIdTo;
      if (data.store && sameId(data.store.shopping_list_id, listIdFrom)) data.store.shopping_list_id = listIdTo;
    }
    if (sectionIdFrom !== undefined) {
      if (sameId(data.section_id, sectionIdFrom)) data.section_id = sectionIdTo;
      if (sameId(data.temp_id, sectionIdFrom) && next.action === 'CREATE_SHOPPING_SECTION') data.temp_id = sectionIdTo;
      if (data.section && sameId(data.section.id, sectionIdFrom)) data.section.id = sectionIdTo;
      if (data.item && sameId(data.item.section_id, sectionIdFrom)) data.item.section_id = sectionIdTo;
      if (data.changes && sameId(data.changes.section_id, sectionIdFrom)) data.changes.section_id = sectionIdTo;
    }
    if (itemIdFrom !== undefined) {
      if (sameId(data.item_id, itemIdFrom)) data.item_id = itemIdTo;
      if (sameId(data.temp_id, itemIdFrom) && next.action === 'CREATE_SHOPPING_ITEM') data.temp_id = itemIdTo;
      if (data.item && sameId(data.item.id, itemIdFrom)) data.item.id = itemIdTo;
    }
    if (storeIdFrom !== undefined) {
      if (sameId(data.store_id, storeIdFrom)) data.store_id = storeIdTo;
      if (sameId(data.temp_id, storeIdFrom) && next.action === 'CREATE_SHOPPING_STORE') data.temp_id = storeIdTo;
      if (data.store && sameId(data.store.id, storeIdFrom)) data.store.id = storeIdTo;
      if (Array.isArray(data.item?.store_ids)) {
        data.item.store_ids = data.item.store_ids.map(id => sameId(id, storeIdFrom) ? storeIdTo : id);
      }
      if (Array.isArray(data.changes?.store_ids)) {
        data.changes.store_ids = data.changes.store_ids.map(id => sameId(id, storeIdFrom) ? storeIdTo : id);
      }
    }
    return next;
  });
}
