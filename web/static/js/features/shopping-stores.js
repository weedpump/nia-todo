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
  setStores = () => {},
  commitMutation,
  isOnlineForSync = () => false,
  syncWithServer = async () => {},
  onError = console.error,
  createTempId = () => `temp-shopping-store-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
} = {}) {
  const pendingCreates = new Map();

  function activeDuplicate(name, shoppingListId) {
    const normalized = String(name || '').trim().toLocaleLowerCase();
    return getStores().find(store => (
      store?.active !== false
      && sameId(store.shopping_list_id, shoppingListId)
      && String(store.name || '').trim().toLocaleLowerCase() === normalized
    )) || null;
  }

  function create(value, { authorize = () => true, shoppingListId = null } = {}) {
    const name = validShoppingStoreName(value);
    if (!name || shoppingListId == null) return Promise.resolve(null);
    const duplicate = activeDuplicate(name, shoppingListId);
    if (duplicate) return Promise.resolve(duplicate);
    const key = `${shoppingListId}\u0000${name.toLocaleLowerCase()}`;
    if (pendingCreates.has(key)) return pendingCreates.get(key);

    const operation = (async () => {
      const tempId = createTempId();
      const mutation = await commitMutation(() => {
        if (!authorize()) return null;
        if (activeDuplicate(name, shoppingListId)) return null;
        const store = {
          id: tempId,
          shopping_list_id: shoppingListId,
          name,
          active: true,
          sort_order: nextSortOrder(getStores().filter(candidate => sameId(candidate.shopping_list_id, shoppingListId))),
          client_mutation_id: tempId,
          is_pending: true,
        };
        return {
          store,
          action: 'CREATE_SHOPPING_STORE',
          data: {
            temp_id: tempId,
            store: clone(store),
            shopping_list_id: shoppingListId,
            name,
            sort_order: store.sort_order,
            client_mutation_id: tempId,
          },
          result: store,
        };
      });
      const store = mutation?.result || mutation?.store || activeDuplicate(name, shoppingListId);
      if (!store) return null;
      if (mutation?.store) {
        setStores([...getStores().filter(candidate => !sameId(candidate.id, store.id)), store]);
        if (isOnlineForSync()) Promise.resolve(syncWithServer()).catch(onError);
      }
      return store;
    })();

    pendingCreates.set(key, operation);
    operation.finally(() => {
      if (pendingCreates.get(key) === operation) pendingCreates.delete(key);
    }).catch(() => {});
    return operation;
  }

  return { create };
}
