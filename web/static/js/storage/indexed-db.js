import { DB_NAME, DB_VERSION } from '../core/config.js';

let db = null;

export function getDb() {
  return db;
}

export async function closeAndDeleteDatabase() {
  return new Promise((resolve) => {
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
    };

    request.onsuccess = (event) => {
      db = event.target.result;
      console.log('IndexedDB opened');
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

export function hasDb() {
  return Boolean(db);
}
