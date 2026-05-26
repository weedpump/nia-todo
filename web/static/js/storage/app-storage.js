import * as indexedDb from './indexed-db.js';
import * as syncQueue from '../sync/queue.js';

export function createAppStorage({ setDb }) {
  async function openDB() {
    const db = await indexedDb.openDatabase();
    setDb(db);
    return db;
  }

  async function clearIndexedDB() {
    await indexedDb.closeAndDeleteDatabase();
    setDb(null);
  }

  function dbGetAll(storeName) {
    return indexedDb.getAll(storeName);
  }

  function dbPut(storeName, item) {
    return indexedDb.put(storeName, item);
  }

  function dbClear(storeName) {
    return indexedDb.clear(storeName);
  }

  function getFromDB(storeName, id) {
    return indexedDb.get(storeName, id);
  }

  function deleteFromDB(storeName, id) {
    return indexedDb.remove(storeName, id);
  }

  async function clearSyncQueue() {
    await syncQueue.clearQueue();
  }

  function addToSyncQueue(action, data) {
    return syncQueue.enqueue(action, data);
  }

  return {
    openDB,
    clearIndexedDB,
    dbGetAll,
    dbPut,
    dbClear,
    getFromDB,
    deleteFromDB,
    clearSyncQueue,
    addToSyncQueue,
  };
}
