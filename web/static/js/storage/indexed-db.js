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
