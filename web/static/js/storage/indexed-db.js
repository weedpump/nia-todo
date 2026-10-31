import { DB_NAME, DB_VERSION } from '../core/config.js';

let db = null;
let dbReady = false;
let dbGeneration = 0;
const pendingAvatarOperations = [];

function cancelPendingAvatarOperations() {
  const operations = pendingAvatarOperations.splice(0);
  for (const operation of operations) operation.cancel();
}

async function flushPendingAvatarOperations(generation) {
  while (dbReady && generation === dbGeneration && pendingAvatarOperations.length) {
    const operation = pendingAvatarOperations.shift();
    if (operation.generation !== dbGeneration) {
      operation.cancel();
      continue;
    }
    await operation.run();
  }
}

export function getDb() {
  return db;
}

export function getDatabaseGeneration() {
  return dbGeneration;
}

export function cleanupLegacyShoppingStoreFilterState(database = db) {
  if (!database?.objectStoreNames?.contains?.('syncQueue') || !database.objectStoreNames.contains('shoppingLists')) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = database.transaction(['syncQueue', 'shoppingLists'], 'readwrite');
      const queueCursor = tx.objectStore('syncQueue').openCursor();
      queueCursor.onsuccess = event => {
        const cursor = event.target.result;
        if (!cursor) return;
        const entry = cursor.value;
        const changes = entry?.data?.changes;
        if (entry?.action === 'UPDATE_SHOPPING_PREFERENCES' && changes && Object.prototype.hasOwnProperty.call(changes, 'selected_store_id')) {
          const { selected_store_id: _legacyStoreFilter, ...remainingChanges } = changes;
          if (Object.keys(remainingChanges).length === 0) cursor.delete();
          else cursor.update({ ...entry, data: { ...entry.data, changes: remainingChanges } });
        }
        cursor.continue();
      };
      const listCursor = tx.objectStore('shoppingLists').openCursor();
      listCursor.onsuccess = event => {
        const cursor = event.target.result;
        if (!cursor) return;
        const list = cursor.value;
        if (list?.preferences && Object.prototype.hasOwnProperty.call(list.preferences, 'selected_store_id')) {
          const { selected_store_id: _legacyStoreFilter, ...preferences } = list.preferences;
          cursor.update({ ...list, preferences });
        }
        cursor.continue();
      };
    } catch (error) {
      tx?.abort?.();
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to clean legacy shopping store filters'));
    tx.onabort = () => reject(tx.error || new Error('Legacy shopping store filter cleanup was aborted'));
  });
}

export async function closeAndDeleteDatabase() {
  return new Promise((resolve) => {
    dbGeneration += 1;
    dbReady = false;
    cancelPendingAvatarOperations();
    if (db) {
      db.close();
      db = null;
    }
    const deleteRequest = indexedDB.deleteDatabase(DB_NAME);
    deleteRequest.onsuccess = () => { console.log('IndexedDB deleted'); resolve(); };
    deleteRequest.onerror = () => { console.log('IndexedDB delete error'); resolve(); };
    deleteRequest.onblocked = () => { console.log('IndexedDB delete blocked'); resolve(); };
  });
}

export function openDatabase() {
  const generation = dbGeneration;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      db = event.target.result;
      if (!db.objectStoreNames.contains('todos')) {
        db.createObjectStore('todos', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('workspaces')) {
        db.createObjectStore('workspaces', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('sections')) {
        db.createObjectStore('sections', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('syncQueue')) {
        db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('avatars')) {
        db.createObjectStore('avatars', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('shoppingLists')) {
        db.createObjectStore('shoppingLists', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('shoppingStores')) {
        db.createObjectStore('shoppingStores', { keyPath: 'id' });
      }
    };

    request.onsuccess = async (event) => {
      if (generation !== dbGeneration) {
        event.target.result.close();
        resolve(null);
        return;
      }
      db = event.target.result;
      dbReady = true;
      console.log('IndexedDB opened');
      try {
        await cleanupLegacyShoppingStoreFilterState(db);
      } catch (error) {
        console.warn('Failed to clean legacy shopping store filters', error);
      }
      await flushPendingAvatarOperations(generation);
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

export function getAll(storeName) {
  return new Promise((resolve) => {
    if (!db) { resolve([]); return; }
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => resolve([]);
  });
}

export function put(storeName, item) {
  return new Promise((resolve) => {
    if (!db) { resolve(); return; }
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export function commitTodoUpdatesWithQueue(updates, {
  database = db,
  timestamp = Date.now(),
  localUpdatedAt = new Date().toISOString(),
} = {}) {
  if (!database) return Promise.reject(new Error('IndexedDB is not open'));
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = database.transaction(['todos', 'syncQueue'], 'readwrite');
      const todosStore = tx.objectStore('todos');
      const queueStore = tx.objectStore('syncQueue');
      for (const update of updates) {
        todosStore.put(update.todo);
        queueStore.put({
          action: 'UPDATE_TODO',
          data: { id: update.todo.id, changes: update.changes },
          timestamp,
          localUpdatedAt,
        });
      }
    } catch (error) {
      tx?.abort?.();
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to commit todo updates'));
    tx.onabort = () => reject(tx.error || new Error('Todo update transaction was aborted'));
  });
}

export function commitShoppingMutation({
  list,
  lists = [],
  deleteListId,
  store,
  deleteStoreId,
  action,
  data,
  mutations = [],
  database = db,
  timestamp = Date.now(),
  localUpdatedAt = new Date().toISOString(),
} = {}) {
  if (!database) return Promise.reject(new Error('IndexedDB is not open'));
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = database.transaction(['shoppingLists', 'shoppingStores', 'syncQueue'], 'readwrite');
      const listStore = tx.objectStore('shoppingLists');
      const storeStore = tx.objectStore('shoppingStores');
      const queueStore = tx.objectStore('syncQueue');
      if (deleteListId !== undefined && deleteListId !== null) listStore.delete(deleteListId);
      if (list) listStore.put(list);
      for (const shoppingList of lists) listStore.put(shoppingList);
      if (deleteStoreId !== undefined && deleteStoreId !== null) storeStore.delete(deleteStoreId);
      if (store) storeStore.put(store);
      const queueMutations = mutations.length ? mutations : [{ action, data }];
      for (const mutation of queueMutations) {
        queueStore.put({ action: mutation.action, data: mutation.data, timestamp, localUpdatedAt });
      }
    } catch (error) {
      tx?.abort?.();
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to commit shopping mutation'));
    tx.onabort = () => reject(tx.error || new Error('Shopping mutation transaction was aborted'));
  });
}

export function commitShoppingReplay({
  list,
  removeListIds = [],
  store,
  removeStoreIds = [],
  queueDeleteId,
  queueDeleteIds = [],
  queueRecords = [],
  database = db,
} = {}) {
  if (!database) return Promise.reject(new Error('IndexedDB is not open'));
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = database.transaction(['shoppingLists', 'shoppingStores', 'syncQueue'], 'readwrite');
      const listStore = tx.objectStore('shoppingLists');
      const storeStore = tx.objectStore('shoppingStores');
      const queueStore = tx.objectStore('syncQueue');
      for (const listId of removeListIds) listStore.delete(listId);
      if (list) listStore.put(list);
      for (const storeId of removeStoreIds) storeStore.delete(storeId);
      if (store) storeStore.put(store);
      for (const record of queueRecords) queueStore.put(record);
      for (const recordId of queueDeleteIds) queueStore.delete(recordId);
      if (queueDeleteId !== undefined && queueDeleteId !== null) queueStore.delete(queueDeleteId);
    } catch (error) {
      tx?.abort?.();
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to commit shopping replay'));
    tx.onabort = () => reject(tx.error || new Error('Shopping replay transaction was aborted'));
  });
}

export function clear(storeName) {
  return new Promise((resolve) => {
    if (!db) { resolve(); return; }
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export function get(storeName, id) {
  return new Promise((resolve) => {
    if (!db) { resolve(null); return; }
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
}

export function remove(storeName, id) {
  return new Promise((resolve) => {
    if (!db) { resolve(); return; }
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export function putAvatarWhenReady(item, isCurrent = () => true, expectedGeneration = dbGeneration) {
  const operation = () => (
    expectedGeneration === dbGeneration && isCurrent()
      ? put('avatars', item)
      : Promise.resolve()
  );
  if (expectedGeneration !== dbGeneration) return Promise.resolve();
  if (dbReady) return operation();
  pendingAvatarOperations.push({ generation: expectedGeneration, run: operation, cancel() {} });
  return Promise.resolve();
}

export function removeAvatarWhenReady(id) {
  const operation = () => remove('avatars', id);
  if (dbReady) return operation();
  pendingAvatarOperations.push({ generation: dbGeneration, run: operation, cancel() {} });
  return Promise.resolve();
}

export function getAvatarIfReady(id) {
  return dbReady ? get('avatars', id) : Promise.resolve(null);
}

export function getAvatarWhenReady(id) {
  if (dbReady) return get('avatars', id);
  return new Promise((resolve) => {
    pendingAvatarOperations.push({
      generation: dbGeneration,
      run: async () => resolve(await get('avatars', id)),
      cancel: () => resolve(null),
    });
  });
}

export function hasDb() {
  return Boolean(db);
}
