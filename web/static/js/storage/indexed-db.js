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

function requestPromise(request, fallbackMessage) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(fallbackMessage));
  });
}

export function transactionStrict(storeNames, mode, operation) {
  return new Promise((resolve, reject) => {
    if (!db) { reject(new Error('IndexedDB is not open')); return; }
    const names = [...new Set(Array.isArray(storeNames) ? storeNames : [storeNames])];
    let tx;
    try {
      tx = db.transaction(names, mode);
    } catch (error) {
      reject(error);
      return;
    }
    let operationDone = false;
    let transactionDone = false;
    let operationResult;
    let settled = false;
    let keepaliveActive = true;
    const activeRequestQueue = [];
    const keepaliveStore = tx.objectStore(names[0]);
    const keepalive = () => {
      if (!keepaliveActive || settled) return;
      while (activeRequestQueue.length) activeRequestQueue.shift()();
      let request;
      try {
        request = keepaliveStore.get(-Infinity);
      } catch (error) {
        if (!operationDone) fail(error);
        return;
      }
      request.onsuccess = keepalive;
      request.onerror = () => fail(request.error || tx.error || new Error('IndexedDB transaction keepalive failed'));
    };
    const fail = error => {
      if (settled) return;
      keepaliveActive = false;
      settled = true;
      reject(error || tx.error || new Error('IndexedDB transaction failed'));
    };
    const enqueueRequest = (factory, fallbackMessage, transform = value => value) => new Promise((resolveRequest, rejectRequest) => {
      activeRequestQueue.push(() => {
        let request;
        try {
          request = factory();
        } catch (error) {
          rejectRequest(error);
          return;
        }
        request.onsuccess = () => resolveRequest(transform(request.result));
        request.onerror = () => rejectRequest(request.error || tx.error || new Error(fallbackMessage));
      });
    });
    const finish = () => {
      if (settled || !operationDone || !transactionDone) return;
      settled = true;
      resolve(operationResult);
    };
    const api = {
      get: (storeName, id) => enqueueRequest(() => tx.objectStore(storeName).get(id), `Failed to read ${storeName}`, result => result ?? null),
      getAll: storeName => enqueueRequest(() => tx.objectStore(storeName).getAll(), `Failed to read ${storeName}`, result => result || []),
      put: (storeName, item) => enqueueRequest(() => tx.objectStore(storeName).put(item), `Failed to write ${storeName}`, () => item),
      delete: (storeName, id) => enqueueRequest(() => tx.objectStore(storeName).delete(id), `Failed to delete from ${storeName}`),
      clear: storeName => enqueueRequest(() => tx.objectStore(storeName).clear(), `Failed to clear ${storeName}`),
    };
    tx.oncomplete = () => { transactionDone = true; finish(); };
    tx.onerror = () => fail(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => fail(tx.error || new Error('IndexedDB transaction aborted'));
    keepalive();
    let result;
    try {
      result = operation(api);
    } catch (error) {
      try { tx.abort(); } catch (_abortError) {}
      fail(error);
      return;
    }
    Promise.resolve(result).then((value) => {
      operationResult = value;
      operationDone = true;
      keepaliveActive = false;
      finish();
    }, (error) => {
      keepaliveActive = false;
      try { tx.abort(); } catch (_abortError) {}
      fail(error);
    });
  });
}

export async function closeAndDeleteDatabase() {
  return new Promise((resolve, reject) => {
    dbGeneration += 1;
    dbReady = false;
    cancelPendingAvatarOperations();
    if (db) {
      db.close();
      db = null;
    }
    const deleteRequest = indexedDB.deleteDatabase(DB_NAME);
    deleteRequest.onsuccess = () => { console.log('IndexedDB deleted'); resolve(); };
    deleteRequest.onerror = () => {
      console.log('IndexedDB delete error');
      reject(deleteRequest.error || new Error('IndexedDB delete error'));
    };
    deleteRequest.onblocked = () => {
      console.log('IndexedDB delete blocked');
      reject(new Error('IndexedDB delete blocked'));
    };
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
      if (!db.objectStoreNames.contains('attachmentBlobs')) {
        db.createObjectStore('attachmentBlobs', { keyPath: 'id' });
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

export function getAllStrict(storeName) {
  return new Promise((resolve, reject) => {
    if (!db) { reject(new Error('IndexedDB is not open')); return; }
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || tx.error || new Error(`Failed to read ${storeName}`));
    tx.onabort = () => reject(tx.error || new Error(`Failed to read ${storeName}`));
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

export function putStrict(storeName, item) {
  return new Promise((resolve, reject) => {
    if (!db) { reject(new Error('IndexedDB is not open')); return; }
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(item);
    tx.oncomplete = () => resolve(item);
    tx.onerror = () => reject(tx.error || new Error(`Failed to write ${storeName}`));
    tx.onabort = () => reject(tx.error || new Error(`Failed to write ${storeName}`));
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

export function clearStrict(storeName) {
  return new Promise((resolve, reject) => {
    if (!db) { reject(new Error('IndexedDB is not open')); return; }
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error(`Failed to clear ${storeName}`));
    tx.onabort = () => reject(tx.error || new Error(`Failed to clear ${storeName}`));
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

export function getStrict(storeName, id) {
  return new Promise((resolve, reject) => {
    if (!db) { reject(new Error('IndexedDB is not open')); return; }
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || tx.error || new Error(`Failed to read ${storeName}`));
    tx.onabort = () => reject(tx.error || new Error(`Failed to read ${storeName}`));
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

export function removeStrict(storeName, id) {
  return new Promise((resolve, reject) => {
    if (!db) { reject(new Error('IndexedDB is not open')); return; }
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error(`Failed to delete from ${storeName}`));
    tx.onabort = () => reject(tx.error || new Error(`Failed to delete from ${storeName}`));
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
