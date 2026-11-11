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

  function commitTodoUpdatesWithQueue(updates) {
    return indexedDb.commitTodoUpdatesWithQueue(updates);
  }

  function commitTaskParentReplay(replay) {
    return indexedDb.commitTaskParentReplay(replay);
  }

  function commitShoppingMutation(mutation) {
    return indexedDb.commitShoppingMutation(mutation);
  }

  function commitShoppingReplay(replay) {
    return indexedDb.commitShoppingReplay(replay);
  }

  function commitCreationTombstoneReplay(replay) {
    return indexedDb.commitCreationTombstoneReplay(replay);
  }

  function evictPendingShoppingEntities(listIds, options) {
    return indexedDb.evictPendingShoppingEntities(listIds, options);
  }

  function evictPendingProjectEntities(projectIds, options) {
    return indexedDb.evictPendingProjectEntities(projectIds, options);
  }

  const commitCookbookMutation = mutation => indexedDb.commitCookbookMutation(mutation);
  const commitCookbookReplay = replay => indexedDb.commitCookbookReplay(replay);
  const markCookbookMutationAttempt = id => indexedDb.markCookbookMutationAttempt(id);
  const evictPendingCookbookEntities = (ids, options) => indexedDb.evictPendingCookbookEntities(ids, options);

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
    commitTodoUpdatesWithQueue,
    commitTaskParentReplay,
    commitShoppingMutation,
    commitShoppingReplay,
    commitCreationTombstoneReplay,
    evictPendingShoppingEntities,
    evictPendingProjectEntities,
    commitRecipeShoppingTransfer: indexedDb.commitRecipeShoppingTransfer,
    markRecipeShoppingTransferAttempt: indexedDb.markRecipeShoppingTransferAttempt,
    commitRecipeMutation: indexedDb.commitRecipeMutation,
    commitRecipeReplay: indexedDb.commitRecipeReplay,
    markRecipeMutationAttempt: indexedDb.markRecipeMutationAttempt,
    getDatabaseGeneration: indexedDb.getDatabaseGeneration,
    getEntityImageIfReady: indexedDb.getEntityImageIfReady,
    getEntityImageWhenReady: indexedDb.getEntityImageWhenReady,
    putEntityImageWhenReady: indexedDb.putEntityImageWhenReady,
    removeEntityImageWhenReady: indexedDb.removeEntityImageWhenReady,
    commitCookbookMutation,
    commitCookbookReplay,
    markCookbookMutationAttempt,
    evictPendingCookbookEntities,
  };
}
