import { resolveEntityIdentity, entityIdentity } from '../core/entity-identity.js';
function sameId(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null && String(left) === String(right);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function nextSortOrder(records = []) {
  return records.reduce((maximum, record) => {
    const value = Number(record?.sort_order);
    return Number.isFinite(value) ? Math.max(maximum, value) : maximum;
  }, -1) + 1;
}

export function validShoppingStoreName(value) {
  const name = String(value || '').trim();
  return name && name.length <= 120 ? name : null;
}

export function createShoppingStoresController({
  getStores = () => [],
  getActorId = () => null,
  setStores = () => {},
  commitMutation,
  enqueueListMutation = null,
  resolveListIdentity = identity => identity,
  resolveListId = identity => identity,
  isOnlineForSync = () => false,
  syncWithServer = async () => {},
  onError = console.error,
  createTempId = () => `temp-shopping-store-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
} = {}) {
  const resolve = (records, identity, parentId) => resolveEntityIdentity(records, identity, { actorId: getActorId(), ...(parentId === undefined ? {} : { parentId, parentField: 'shopping_list_id' }) });
  const pendingCreates = new Map();
  const listQueues = new Map();

  function enqueueLocallyForList(identity, task) {
    const key = String(identity);
    const previous = listQueues.get(key);
    const operation = (previous ? previous.catch(() => null) : Promise.resolve()).then(task);
    listQueues.set(key, operation);
    operation.finally(() => {
      if (listQueues.get(key) === operation) listQueues.delete(key);
    }).catch(() => {});
    return operation;
  }
  const runListMutation = enqueueListMutation || enqueueLocallyForList;

  function activeDuplicate(name, shoppingListId, excludeId = null) {
    const normalized = String(name || '').trim().toLocaleLowerCase();
    return getStores().find(store => (
      store?.active !== false
      && sameId(store.shopping_list_id, shoppingListId)
      && !sameId(store.id, excludeId)
      && String(store.name || '').trim().toLocaleLowerCase() === normalized
    )) || null;
  }

  function create(value, { authorize = () => true, shoppingListId = null } = {}) {
    const name = validShoppingStoreName(value);
    if (!name || shoppingListId == null) return Promise.resolve(null);
    const stableListIdentity = resolveListIdentity(shoppingListId);
    const initialListId = resolveListId(stableListIdentity);
    if (initialListId == null) return Promise.resolve(null);
    const duplicate = activeDuplicate(name, initialListId);
    if (duplicate) return Promise.resolve(duplicate);
    const key = `${stableListIdentity}\u0000${name.toLocaleLowerCase()}`;
    if (pendingCreates.has(key)) return pendingCreates.get(key);

    const operation = runListMutation(stableListIdentity, async () => {
      const tempId = createTempId();
      let duplicateAfterWait = null;
      const mutation = await commitMutation(() => {
        const latestListId = resolveListId(stableListIdentity);
        if (latestListId == null || !authorize()) return null;
        duplicateAfterWait = activeDuplicate(name, latestListId);
        if (duplicateAfterWait) return null;
        const store = {
          id: tempId,
          shopping_list_id: latestListId,
          name,
          active: true,
          sort_order: nextSortOrder(getStores().filter(candidate => sameId(candidate.shopping_list_id, latestListId))),
          client_mutation_id: tempId,
          created_by_user_id: getActorId(),
          is_pending: true,
        };
        return {
          store,
          action: 'CREATE_SHOPPING_STORE',
          data: {
            temp_id: tempId,
            store: clone(store),
            shopping_list_id: latestListId,
            name,
            sort_order: store.sort_order,
            client_mutation_id: tempId,
          },
          result: store,
        };
      });
      const store = mutation?.result || mutation?.store || duplicateAfterWait;
      if (!store) return null;
      if (mutation?.store) {
        setStores([...getStores().filter(candidate => !sameId(candidate.id, store.id)), store]);
        if (isOnlineForSync()) Promise.resolve(syncWithServer()).catch(onError);
      }
      return store;
    });

    pendingCreates.set(key, operation);
    operation.finally(() => {
      if (pendingCreates.get(key) === operation) pendingCreates.delete(key);
    }).catch(() => {});
    return operation;
  }

  async function update(storeId, value, { authorize = () => true } = {}) {
    const name = validShoppingStoreName(value);
    if (!name) return null;
    const current = resolve(getStores(), storeId);
    if (!current || current.active === false || activeDuplicate(name, current.shopping_list_id, current.id)) return null;
    const listIdentity = resolveListIdentity(current.shopping_list_id);
    return runListMutation(listIdentity, async () => {
      const mutation = await commitMutation(() => {
        const parentId = resolveListId(listIdentity);
        const latest = parentId == null ? null : resolve(getStores(), entityIdentity(current, getActorId()), parentId);
        if (!latest || latest.active === false || !authorize(latest)) return null;
        if (activeDuplicate(name, latest.shopping_list_id, latest.id)) return null;
        const store = { ...latest, name, is_pending: true };
        return {
          store,
          action: 'UPDATE_SHOPPING_STORE',
          data: { shopping_list_id: latest.shopping_list_id, store_id: latest.id, changes: { name } },
          result: store,
        };
      });
      const store = mutation?.result || mutation?.store || null;
      if (!store) return null;
      if (mutation?.store) {
        setStores(getStores().map(candidate => sameId(candidate.id, store.id) ? store : candidate));
        if (isOnlineForSync()) Promise.resolve(syncWithServer()).catch(onError);
      }
      return store;
    });
  }

  async function remove(storeId, { authorize = () => true } = {}) {
    const current = resolve(getStores(), storeId);
    if (!current || current.active === false) return null;
    const listIdentity = resolveListIdentity(current.shopping_list_id);
    return runListMutation(listIdentity, async () => {
      const mutation = await commitMutation(() => {
        const parentId = resolveListId(listIdentity);
        const latest = parentId == null ? null : resolve(getStores(), entityIdentity(current, getActorId()), parentId);
        if (!latest || latest.active === false || !authorize(latest)) return null;
        const store = { ...latest, active: false, is_pending: true };
        return {
          store,
          action: 'DELETE_SHOPPING_STORE',
          data: { shopping_list_id: latest.shopping_list_id, store_id: latest.id },
          result: store,
        };
      });
      const store = mutation?.result || mutation?.store || null;
      if (!store) return null;
      if (mutation?.store) {
        setStores(getStores().map(candidate => sameId(candidate.id, store.id) ? store : candidate));
        if (isOnlineForSync()) Promise.resolve(syncWithServer()).catch(onError);
      }
      return store;
    });
  }

  return { create, update, remove };
}
