#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.location = { origin: 'http://localhost' };

const {
  hasPendingShoppingChanges,
  projectShoppingSnapshot,
  projectPendingShoppingChanges,
  queueItemReferencesShoppingList,
  rewriteShoppingQueueReferences,
} = await import('../web/static/js/features/shopping-pending.js');
const {
  commitShoppingMutation,
  commitShoppingReplay,
  evictPendingShoppingEntities,
} = await import('../web/static/js/storage/indexed-db.js');
const { DB_VERSION } = await import('../web/static/js/core/config.js');

const serverList = {
  id: 7,
  name: 'Weekly',
  updated_at: '2026-10-28T16:00:00Z',
  preferences: { hide_empty_sections: false },
  sections: [{ id: 10, shopping_list_id: 7, name: 'Produce', sort_order: 0 }],
  items: [{ id: 20, shopping_list_id: 7, section_id: 10, name: 'Milk', completed: false, stores: [] }],
};

const queue = [
  { id: 1, action: 'UPDATE_SHOPPING_ITEM', data: { shopping_list_id: 7, item_id: 20, changes: { completed: true } } },
  { id: 2, action: 'CREATE_SHOPPING_SECTION', data: { shopping_list_id: 7, temp_id: 'temp-section-1', section: { name: 'Bakery', sort_order: 1 } } },
  { id: 5, action: 'UPDATE_SHOPPING_SECTION', data: { shopping_list_id: 7, section_id: 'temp-section-1', changes: { name: 'Bread' } } },
  { id: 3, action: 'CREATE_SHOPPING_ITEM', data: { shopping_list_id: 7, temp_id: 'temp-item-1', item: { name: 'Bread', section_id: 'temp-section-1', store_ids: [2] } } },
  { id: 4, action: 'UPDATE_SHOPPING_PREFERENCES', data: { shopping_list_id: 7, changes: { hide_empty_sections: true } } },
];

const projected = projectPendingShoppingChanges(serverList, queue);
assert.equal(projected.items.find(item => item.id === 20).completed, true);
assert.equal(projected.sections.find(section => section.id === 'temp-section-1').name, 'Bread');
assert.equal(projected.items.find(item => item.id === 'temp-item-1').section_id, 'temp-section-1');
assert.equal(projected.preferences.hide_empty_sections, true);
assert.equal(hasPendingShoppingChanges(queue, 7), true);
assert.equal(queueItemReferencesShoppingList(queue[2], 7), true);
assert.equal(projectPendingShoppingChanges(serverList, [{ action: 'DELETE_SHOPPING_LIST', data: { id: 7 } }]), null);

const temporaryList = {
  id: 'temp-list-1',
  name: 'Offline list',
  sections: [],
  items: [],
  preferences: {},
};
const snapshot = projectShoppingSnapshot([serverList], [temporaryList], [
  ...queue,
  { id: 5, action: 'CREATE_SHOPPING_LIST', data: { temp_id: 'temp-list-1', list: temporaryList } },
]);
assert.equal(snapshot.some(list => list.id === 'temp-list-1'), true, 'pending offline lists survive authoritative snapshots');
assert.equal(snapshot.find(list => list.id === 7).items.find(item => item.id === 20).completed, true);
assert.equal(
  projectShoppingSnapshot([], [serverList], queue).some(list => list.id === 7),
  false,
  'a revoked server list must not survive an authoritative snapshot merely because it has pending mutations',
);

const rewritten = rewriteShoppingQueueReferences(queue, {
  listIdFrom: 7,
  listIdTo: 70,
  sectionIdFrom: 'temp-section-1',
  sectionIdTo: 100,
  itemIdFrom: 'temp-item-1',
  itemIdTo: 200,
});
const rewrittenItemCreate = rewritten.find(entry => entry.action === 'CREATE_SHOPPING_ITEM');
const rewrittenSectionUpdate = rewritten.find(entry => entry.action === 'UPDATE_SHOPPING_SECTION');
assert.equal(rewritten.every(entry => entry.data.shopping_list_id === 70), true);
assert.equal(rewrittenSectionUpdate.data.section_id, 100);
assert.equal(rewrittenItemCreate.data.item.section_id, 100);
assert.equal(rewrittenItemCreate.data.temp_id, 200);

function createFakeDatabase() {
  const calls = [];
  const stores = {
    shoppingLists: {
      put(value) { calls.push(['shoppingLists.put', structuredClone(value)]); },
      delete(value) { calls.push(['shoppingLists.delete', value]); },
    },
    shoppingStores: {
      put(value) { calls.push(['shoppingStores.put', structuredClone(value)]); },
      delete(value) { calls.push(['shoppingStores.delete', value]); },
    },
    syncQueue: {
      put(value) { calls.push(['syncQueue.put', structuredClone(value)]); return { result: 99 }; },
      delete(value) { calls.push(['syncQueue.delete', value]); },
    },
  };
  const database = {
    transaction(names, mode) {
      calls.push(['transaction', [...names], mode]);
      const tx = {
        objectStore(name) { return stores[name]; },
        abort() { calls.push(['abort']); },
      };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  };
  return { database, calls };
}

const mutationDb = createFakeDatabase();
await commitShoppingMutation({
  database: mutationDb.database,
  list: projected,
  action: 'UPDATE_SHOPPING_ITEM',
  data: { shopping_list_id: 7, item_id: 20, changes: { completed: true } },
  timestamp: 123,
  localUpdatedAt: '2026-10-28T17:00:00Z',
});
assert.deepEqual(mutationDb.calls[0], ['transaction', ['shoppingLists', 'shoppingStores', 'syncQueue'], 'readwrite']);
assert.equal(mutationDb.calls.some(([name]) => name === 'shoppingLists.put'), true);
assert.equal(mutationDb.calls.some(([name]) => name === 'syncQueue.put'), true);

const batchMutationDb = createFakeDatabase();
await commitShoppingMutation({
  database: batchMutationDb.database,
  lists: [{ id: 1, sort_order: 0 }, { id: 2, sort_order: 1 }],
  mutations: [
    { action: 'UPDATE_SHOPPING_LIST', data: { shopping_list_id: 1, changes: { sort_order: 0 } } },
    { action: 'UPDATE_SHOPPING_LIST', data: { shopping_list_id: 2, changes: { sort_order: 1 } } },
  ],
  timestamp: 124,
  localUpdatedAt: '2026-10-28T17:01:00Z',
});
assert.equal(batchMutationDb.calls.filter(([name]) => name === 'shoppingLists.put').length, 2);
assert.equal(batchMutationDb.calls.filter(([name]) => name === 'syncQueue.put').length, 2, 'one durable queue record is written for every atomic reorder mutation');

const replayDb = createFakeDatabase();
await commitShoppingReplay({
  database: replayDb.database,
  list: { ...projected, id: 70 },
  removeListIds: [7],
  queueDeleteId: 1,
  queueRecords: rewritten.slice(1),
});
assert.equal(replayDb.calls.some(([name, id]) => name === 'shoppingLists.delete' && id === 7), true);
assert.equal(replayDb.calls.some(([name, id]) => name === 'syncQueue.delete' && id === 1), true);
assert.equal(replayDb.calls.filter(([name]) => name === 'syncQueue.put').length, rewritten.length - 1);

function createEvictionDatabase({ fail = false } = {}) {
  const calls = [];
  const values = {
    shoppingStores: [
      { id: 30, shopping_list_id: 7, name: 'Private store' },
      { id: 31, shopping_list_id: 8, name: 'Other store' },
    ],
    syncQueue: [
      { id: 40, action: 'UPDATE_SHOPPING_ITEM', data: { shopping_list_id: 7, item_id: 1 } },
      { id: 41, action: 'UPDATE_SHOPPING_ITEM', data: { shopping_list_id: 8, item_id: 2 } },
      { id: 42, action: 'UPDATE_SHOPPING_STORE', data: { store_id: 30, changes: { name: 'Private renamed store' } } },
      { id: 43, action: 'DELETE_SHOPPING_STORE', data: { store_id: 30 } },
    ],
  };
  const database = {
    transaction(names, mode) {
      calls.push(['transaction', [...names], mode]);
      let reads = 0;
      const tx = {
        objectStore(name) {
          return {
            delete(id) { calls.push([`${name}.delete`, id]); },
            getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = structuredClone(values[name]);
                request.onsuccess?.();
                reads += 1;
                if (reads === 2) queueMicrotask(() => fail ? tx.onerror?.() : tx.oncomplete?.());
              });
              return request;
            },
          };
        },
        abort() { calls.push(['abort']); },
        error: fail ? new Error('eviction failed') : null,
      };
      return tx;
    },
  };
  return { database, calls };
}

const evictionDb = createEvictionDatabase();
await evictPendingShoppingEntities(['7'], { database: evictionDb.database });
assert.deepEqual(evictionDb.calls[0], ['transaction', ['shoppingLists', 'shoppingStores', 'syncQueue'], 'readwrite']);
assert.equal(evictionDb.calls.some(([name, id]) => name === 'shoppingLists.delete' && id === 7), true);
assert.equal(evictionDb.calls.some(([name, id]) => name === 'shoppingStores.delete' && id === 30), true);
assert.equal(evictionDb.calls.some(([name, id]) => name === 'shoppingStores.delete' && id === 31), false);
assert.equal(evictionDb.calls.some(([name, id]) => name === 'syncQueue.delete' && id === 40), true);
assert.equal(evictionDb.calls.some(([name, id]) => name === 'syncQueue.delete' && id === 41), false);
assert.equal(evictionDb.calls.some(([name, id]) => name === 'syncQueue.delete' && id === 42), true);
assert.equal(evictionDb.calls.some(([name, id]) => name === 'syncQueue.delete' && id === 43), true);

const numericEvictionDb = createEvictionDatabase();
await evictPendingShoppingEntities([7], { database: numericEvictionDb.database });
assert.equal(
  numericEvictionDb.calls.some(([name, id]) => name === 'shoppingLists.delete' && id === '7'),
  true,
  'integer shopping IDs must also delete the digit-only string IndexedDB key',
);
assert.equal(
  numericEvictionDb.calls.some(([name, id]) => name === 'shoppingLists.delete' && id === 7),
  true,
  'integer shopping IDs must keep deleting the numeric IndexedDB key',
);
assert.equal(
  queueItemReferencesShoppingList(
    { action: 'UPDATE_SHOPPING_STORE', data: { store_id: 999, changes: { name: 'Orphaned private store' } } },
    7,
    [],
    { orphanedStoreMatches: true },
  ),
  true,
  'privacy eviction must fail closed for legacy store-only mutations after the store snapshot was removed',
);


const appStorageSource = readFileSync(new URL('../web/static/js/storage/app-storage.js', import.meta.url), 'utf8');
assert.match(appStorageSource, /evictPendingShoppingEntities\(listIds, options\)/);
assert.match(appStorageSource, /indexedDb\.evictPendingShoppingEntities\(listIds, options\)/);

const failedEvictionDb = createEvictionDatabase({ fail: true });
await assert.rejects(
  evictPendingShoppingEntities([7], { database: failedEvictionDb.database }),
  /eviction failed/,
  'pending privacy eviction must reject instead of reporting false success',
);

let abortedEvictionTransaction = false;
const abortableEvictionDb = {
  transaction() {
    const tx = {
      objectStore() {
        return {
          delete() {},
          getAll() { return {}; },
        };
      },
      abort() {
        abortedEvictionTransaction = true;
        queueMicrotask(() => tx.onabort?.());
      },
      error: null,
    };
    return tx;
  },
};
const evictionController = new AbortController();
const abortedEviction = evictPendingShoppingEntities([9], {
  database: abortableEvictionDb,
  signal: evictionController.signal,
});
evictionController.abort();
await assert.rejects(abortedEviction, error => error?.name === 'AbortError');
assert.equal(abortedEvictionTransaction, true, 'accept projection must abort the durable eviction transaction');

assert.equal(DB_VERSION, 8, 'list-scoped shopping stores require IndexedDB schema version 8');

const { createSyncFeature } = await import('../web/static/js/features/sync.js');
let queueState = [
  { id: 11, action: 'CREATE_SHOPPING_LIST', data: { temp_id: 'temp-list-2', name: 'Queued', color: '#6366f1', icon: 'shopping-cart', sort_order: 0, client_mutation_id: 'temp-list-2' } },
  { id: 12, action: 'CREATE_SHOPPING_STORE', data: { shopping_list_id: 'temp-list-2', temp_id: 'temp-store-list-remap', store: { id: 'temp-store-list-remap', shopping_list_id: 'temp-list-2', name: 'Market', active: true }, name: 'Market', sort_order: 0, client_mutation_id: 'temp-store-list-remap' } },
  { id: 13, action: 'CREATE_SHOPPING_ITEM', data: { shopping_list_id: 'temp-list-2', temp_id: 'temp-item-2', item: { name: 'Eggs', section_id: null, store_ids: ['temp-store-list-remap'] }, client_mutation_id: 'temp-item-2' } },
];
let shoppingState = [{ id: 'temp-list-2', name: 'Queued', sections: [], items: [{ id: 'temp-item-2', name: 'Eggs', section_id: null, store_ids: ['temp-store-list-remap'], stores: [], completed: false }], preferences: {} }];
let shoppingStoreState = [{ id: 'temp-store-list-remap', shopping_list_id: 'temp-list-2', name: 'Market', active: true }];
let persistedShoppingStoreState = structuredClone(shoppingStoreState);
let serverItems = [];
const shoppingApi = {
  createList: async data => ({ id: 70, ...data }),
  createItem: async (listId, data) => {
    assert.equal(listId, 70, 'dependent item create uses the remapped server list id');
    assert.deepEqual(data.store_ids, [90], 'dependent item create uses the remapped store id');
    serverItems.push({ id: 200, shopping_list_id: 70, completed: false, ...data });
    return serverItems.at(-1);
  },
  createStore: async data => {
    assert.equal(data.shopping_list_id, 70, 'dependent store create uses the remapped server list id');
    return { id: 90, ...data, active: true };
  },
  getList: async id => ({ id, name: 'Queued', sections: [], items: structuredClone(serverItems), preferences: {} }),
  snapshot: async () => ({ shopping_lists: [] }),
};
const syncFeature = createSyncFeature({
  getDb: () => ({}),
  dbGetAll: async store => store === 'syncQueue' ? structuredClone(queueState) : [],
  dbPut: async () => {},
  dbClear: async () => {},
  getFromDB: async () => null,
  deleteFromDB: async (store, id) => {
    if (store === 'syncQueue') queueState = queueState.filter(entry => entry.id !== id);
  },
  getTodos: () => [], setTodos: () => {},
  getProjects: () => [], setProjects: () => {},
  getSections: () => [], setSections: () => {},
  getWorkspaces: () => [], setWorkspaces: () => {},
  getShoppingLists: () => shoppingState,
  setShoppingLists: next => { shoppingState = structuredClone(next); },
  getShoppingStores: () => shoppingStoreState,
  setShoppingStores: next => { shoppingStoreState = structuredClone(next); },
  todosApi: {}, projectsApi: {}, sectionsApi: {}, workspacesApi: {},
  shoppingApi,
  commitShoppingReplay: async ({ list, removeListIds = [], store, stores = [], removeStoreIds = [], queueDeleteId, queueDeleteIds = [], queueRecords = [] }) => {
    const remove = new Set(removeListIds.map(String));
    shoppingState = shoppingState.filter(entry => !remove.has(String(entry.id)));
    if (list) {
      const exists = shoppingState.some(entry => String(entry.id) === String(list.id));
      shoppingState = exists ? shoppingState.map(entry => String(entry.id) === String(list.id) ? structuredClone(list) : entry) : [...shoppingState, structuredClone(list)];
    }
    const removeStores = new Set(removeStoreIds.map(String));
    shoppingStoreState = shoppingStoreState.filter(entry => !removeStores.has(String(entry.id)));
    if (store) {
      const exists = shoppingStoreState.some(entry => String(entry.id) === String(store.id));
      shoppingStoreState = exists ? shoppingStoreState.map(entry => String(entry.id) === String(store.id) ? structuredClone(store) : entry) : [...shoppingStoreState, structuredClone(store)];
    }
    for (const replayStore of stores) {
      const exists = shoppingStoreState.some(entry => String(entry.id) === String(replayStore.id));
      shoppingStoreState = exists ? shoppingStoreState.map(entry => String(entry.id) === String(replayStore.id) ? structuredClone(replayStore) : entry) : [...shoppingStoreState, structuredClone(replayStore)];
    }
    persistedShoppingStoreState = structuredClone(shoppingStoreState);
    const deletes = new Set([...queueDeleteIds, queueDeleteId].filter(id => id != null).map(String));
    const records = new Map(queueRecords.map(entry => [String(entry.id), structuredClone(entry)]));
    queueState = queueState.filter(entry => !deletes.has(String(entry.id))).map(entry => records.get(String(entry.id)) || entry);
  },
  renderStats: () => {}, renderTodos: () => {}, renderShopping: () => {},
});
const syncResult = await syncFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false, requested: false } });
assert.deepEqual(syncResult, { successCount: 3, failCount: 0, skipped: false });
assert.equal(queueState.length, 0);
assert.equal(shoppingState.length, 1);
assert.equal(shoppingState[0].id, 70);
assert.equal(shoppingState[0].items[0].id, 200);
assert.deepEqual(shoppingStoreState.map(store => [store.id, store.shopping_list_id]), [[90, 70]]);

queueState = [
  { id: 21, action: 'CREATE_SHOPPING_STORE', data: { shopping_list_id: 70, temp_id: 'temp-store-1', name: 'REWE', sort_order: 0, client_mutation_id: 'temp-store-1' } },
  { id: 22, action: 'UPDATE_SHOPPING_STORE', data: { store_id: 'temp-store-1', changes: { name: 'REWE Center' } } },
  { id: 23, action: 'CREATE_SHOPPING_ITEM', data: { shopping_list_id: 70, temp_id: 'temp-item-3', item: { name: 'Water', section_id: null, store_ids: ['temp-store-1'] }, client_mutation_id: 'temp-item-3' } },
];
shoppingStoreState = [{ id: 'temp-store-1', shopping_list_id: 70, name: 'REWE Center', active: true, client_mutation_id: 'temp-store-1' }];
shoppingApi.createStore = async data => ({ id: 90, ...data, active: true });
shoppingApi.updateStore = async (storeId, changes) => {
  assert.equal(storeId, 90, 'dependent store update uses the remapped server store id');
  return { id: 90, shopping_list_id: 70, name: changes.name, active: true };
};
shoppingApi.createItem = async (listId, data) => {
  assert.equal(listId, 70);
  assert.deepEqual(data.store_ids, [90], 'dependent item create uses the remapped server store id');
  const item = { id: 201, shopping_list_id: 70, completed: false, stores: [{ id: 90, name: 'REWE Center' }], ...data };
  serverItems.push(item);
  return item;
};
const storeReplayResult = await syncFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false, requested: false } });
assert.deepEqual(storeReplayResult, { successCount: 3, failCount: 0, skipped: false });
assert.equal(queueState.length, 0);
assert.deepEqual(shoppingStoreState.map(store => [store.id, store.name]), [[90, 'REWE Center']]);
assert.deepEqual(shoppingState[0].items.find(item => item.id === 201).store_ids, [90]);

queueState = [
  { id: 29, action: 'CREATE_SHOPPING_STORE', data: { shopping_list_id: 70, temp_id: 'temp-store-pending-delete', name: 'NETTO', sort_order: 1, client_mutation_id: 'temp-store-pending-delete' } },
  { id: 30, action: 'DELETE_SHOPPING_STORE', data: { store_id: 'temp-store-pending-delete' } },
];
shoppingStoreState = [{ id: 'temp-store-pending-delete', shopping_list_id: 70, name: 'NETTO', active: false, client_mutation_id: 'temp-store-pending-delete', is_pending: true }];
persistedShoppingStoreState = structuredClone(shoppingStoreState);
shoppingApi.createStore = async data => ({ id: 92, ...data, active: true });
shoppingApi.deleteStore = async () => { const error = new Error('temporarily unavailable'); error.status = 503; throw error; };
const pendingStoreDeleteResult = await syncFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false, requested: false } });
assert.deepEqual(pendingStoreDeleteResult, { successCount: 1, failCount: 1, skipped: false });
assert.deepEqual(queueState.map(entry => [entry.action, entry.data.store_id]), [['DELETE_SHOPPING_STORE', 92]], 'pending delete must be rewritten to the created server store ID');
assert.deepEqual(shoppingStoreState, [], 'a pending delete must remain absent from the persisted offline projection after create sync');
assert.deepEqual(persistedShoppingStoreState, [], 'IndexedDB must not persist the newly created active store while its rewritten delete remains queued');

queueState = [
  { id: 27, action: 'CREATE_SHOPPING_STORE', data: { shopping_list_id: 70, temp_id: 'temp-store-delete', name: 'ALDI', sort_order: 1, client_mutation_id: 'temp-store-delete' } },
  { id: 28, action: 'DELETE_SHOPPING_STORE', data: { store_id: 'temp-store-delete' } },
];
shoppingStoreState = [{ id: 'temp-store-delete', shopping_list_id: 70, name: 'ALDI', active: false, client_mutation_id: 'temp-store-delete', is_pending: true }];
shoppingApi.createStore = async data => ({ id: 91, ...data, active: true });
shoppingApi.deleteStore = async storeId => {
  assert.equal(storeId, 91, 'deleting an offline-created store uses its remapped server ID');
  return { id: 91, shopping_list_id: 70, name: 'ALDI', active: false };
};
const createDeleteStoreReplayResult = await syncFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false, requested: false } });
assert.deepEqual(createDeleteStoreReplayResult, { successCount: 2, failCount: 0, skipped: false });
assert.equal(queueState.length, 0);
assert.deepEqual(shoppingStoreState.map(store => [store.id, store.active]), [[91, false]]);

queueState = [{ id: 24, action: 'UPDATE_SHOPPING_STORE', data: { store_id: 90, changes: { name: '' } } }];
shoppingStoreState = [{ id: 90, shopping_list_id: 70, name: '', active: true }];
shoppingApi.updateStore = async () => { const error = new Error('invalid store'); error.status = 422; throw error; };
shoppingApi.listStores = async () => ({ shopping_stores: [{ id: 90, shopping_list_id: 70, name: 'REWE Center', active: true }] });
const storeRecoveryResult = await syncFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false, requested: false } });
assert.deepEqual(storeRecoveryResult, { successCount: 1, failCount: 0, skipped: false });
assert.equal(queueState.length, 0);
assert.deepEqual(shoppingStoreState.map(store => [store.id, store.name]), [[90, 'REWE Center']]);
assert.equal(shoppingState[0].id, 70, 'store recovery must not delete a shopping list with the same numeric id');

queueState = [{ id: 25, action: 'DELETE_SHOPPING_STORE', data: { store_id: 90 } }];
shoppingStoreState = [{ id: 90, shopping_list_id: 70, name: 'REWE Center', active: false, is_pending: true }];
shoppingApi.deleteStore = async storeId => {
  assert.equal(storeId, 90);
  return { id: 90, shopping_list_id: 70, name: 'REWE Center', active: false };
};
const storeDeleteResult = await syncFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false, requested: false } });
assert.deepEqual(storeDeleteResult, { successCount: 1, failCount: 0, skipped: false });
assert.equal(queueState.length, 0);
assert.deepEqual(shoppingStoreState.map(store => [store.id, store.active]), [[90, false]], 'store deletion keeps the authoritative inactive projection');

queueState = [{ id: 26, action: 'DELETE_SHOPPING_STORE', data: { store_id: 90 } }];
shoppingStoreState = [{ id: 90, shopping_list_id: 70, name: 'REWE Center', active: false, is_pending: true }];
shoppingApi.deleteStore = async () => { const error = new Error('store cannot be deleted'); error.status = 422; throw error; };
shoppingApi.listStores = async () => ({ shopping_stores: [{ id: 90, shopping_list_id: 70, name: 'REWE Center', active: true }] });
const storeDeleteRecoveryResult = await syncFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false, requested: false } });
assert.deepEqual(storeDeleteRecoveryResult, { successCount: 1, failCount: 0, skipped: false });
assert.equal(queueState.length, 0);
assert.deepEqual(shoppingStoreState.map(store => [store.id, store.active]), [[90, true]], 'rejected store deletion restores the authoritative active store');

let createdSectionPayload = null;
let updatedSectionId = null;
let createdItemSectionId = null;
let replaySections = [];
serverItems = [];
queueState = [
  { id: 40, action: 'CREATE_SHOPPING_SECTION', data: { shopping_list_id: 70, temp_id: 'temp-section-replay', section: { name: 'Bakery', sort_order: 0 }, client_mutation_id: 'temp-section-replay' } },
  { id: 41, action: 'UPDATE_SHOPPING_SECTION', data: { shopping_list_id: 70, section_id: 'temp-section-replay', changes: { name: 'Bread' } } },
  { id: 42, action: 'CREATE_SHOPPING_ITEM', data: { shopping_list_id: 70, temp_id: 'temp-item-section-replay', item: { name: 'Rolls', section_id: 'temp-section-replay', store_ids: [] }, client_mutation_id: 'temp-item-section-replay' } },
];
shoppingState = [{ id: 70, name: 'Queued', sections: [{ id: 'temp-section-replay', name: 'Bread', sort_order: 0 }], items: [{ id: 'temp-item-section-replay', name: 'Rolls', section_id: 'temp-section-replay', store_ids: [] }], preferences: {} }];
shoppingApi.createSection = async (listId, data) => {
  assert.equal(listId, 70);
  createdSectionPayload = structuredClone(data);
  replaySections = [{ id: 300, shopping_list_id: 70, ...data }];
  return replaySections[0];
};
shoppingApi.updateSection = async (sectionId, changes) => {
  updatedSectionId = sectionId;
  replaySections = replaySections.map(section => section.id === sectionId ? { ...section, ...changes } : section);
  return replaySections[0];
};
shoppingApi.createItem = async (listId, data) => {
  assert.equal(listId, 70);
  createdItemSectionId = data.section_id;
  serverItems = [{ id: 202, shopping_list_id: 70, completed: false, ...data }];
  return serverItems[0];
};
shoppingApi.getList = async id => ({ id, name: 'Queued', sections: structuredClone(replaySections), items: structuredClone(serverItems), preferences: {} });
const sectionReplayResult = await syncFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false, requested: false } });
assert.deepEqual(sectionReplayResult, { successCount: 3, failCount: 0, skipped: false });
assert.equal(createdSectionPayload.client_mutation_id, 'temp-section-replay', 'section replay preserves the stable mutation identity in the API body');
assert.equal(updatedSectionId, 300, 'dependent section updates use the remapped server ID');
assert.equal(createdItemSectionId, 300, 'dependent item creates use the remapped section ID');
assert.equal(queueState.length, 0);

let deletedSectionId = null;
queueState = [{ id: 14, action: 'DELETE_SHOPPING_SECTION', data: { shopping_list_id: 70, section_id: 300 } }];
shoppingState = [{ id: 70, name: 'Queued', sections: [{ id: 300, name: 'Bakery' }], items: [{ id: 200, name: 'Eggs', section_id: 300 }], preferences: {} }];
shoppingApi.deleteSection = async sectionId => { deletedSectionId = sectionId; return { deleted: sectionId }; };
shoppingApi.getList = async id => ({ id, name: 'Queued', sections: [], items: [{ id: 200, name: 'Eggs', section_id: null }], preferences: {} });
const sectionDeleteResult = await syncFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false, requested: false } });
assert.deepEqual(sectionDeleteResult, { successCount: 1, failCount: 0, skipped: false });
assert.equal(deletedSectionId, 300);
assert.equal(queueState.length, 0);
assert.equal(shoppingState[0].sections.length, 0);
assert.equal(shoppingState[0].items[0].section_id, null);

queueState = [{ id: 13, action: 'UPDATE_SHOPPING_PREFERENCES', data: { shopping_list_id: 70, changes: { hide_empty_sections: true } } }];
shoppingState = [{ id: 70, name: 'Queued', sections: [], items: structuredClone(serverItems), preferences: { hide_empty_sections: true } }];
shoppingApi.updatePreferences = async () => { const error = new Error('invalid preference'); error.status = 422; throw error; };
shoppingApi.getList = async id => ({ id, name: 'Queued', sections: [], items: structuredClone(serverItems), preferences: { hide_empty_sections: false } });
const recoveryResult = await syncFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false, requested: false } });
assert.deepEqual(recoveryResult, { successCount: 1, failCount: 0, skipped: false });
assert.equal(queueState.length, 0, 'permanently invalid mutation is removed from the queue');
assert.equal(shoppingState.length, 1, 'validation recovery keeps the still-accessible list');
assert.equal(shoppingState[0].preferences.hide_empty_sections, false, 'validation recovery restores authoritative preferences');

let completedDeleteCalls = 0;
queueState = [{ id: 27, action: 'DELETE_COMPLETED_SHOPPING_ITEMS', data: { shopping_list_id: 70 } }];
shoppingState = [{ id: 70, name: 'Queued', sections: [], items: [{ id: 301, name: 'Done', completed: true }, { id: 302, name: 'Open', completed: false }], preferences: {} }];
shoppingApi.deleteCompletedItems = async listId => { assert.equal(listId, 70); completedDeleteCalls += 1; return { shopping_list_id: listId, deleted_ids: [301] }; };
shoppingApi.getList = async id => ({ id, name: 'Queued', sections: [], items: [{ id: 302, name: 'Open', completed: false }], preferences: {} });
const completedDeleteResult = await syncFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false, requested: false } });
assert.deepEqual(completedDeleteResult, { successCount: 1, failCount: 0, skipped: false });
assert.equal(completedDeleteCalls, 1, 'completed items are deleted exactly once during replay');
assert.deepEqual(shoppingState[0].items.map(item => item.id), [302]);

let itemDeleteCalls = 0;
queueState = [{ id: 28, action: 'DELETE_SHOPPING_ITEM', data: { shopping_list_id: 70, item_id: 302 } }];
shoppingApi.deleteItem = async itemId => { assert.equal(itemId, 302); itemDeleteCalls += 1; return { id: itemId, deleted: true }; };
shoppingApi.getList = async id => ({ id, name: 'Queued', sections: [], items: [], preferences: {} });
const itemDeleteResult = await syncFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false, requested: false } });
assert.deepEqual(itemDeleteResult, { successCount: 1, failCount: 0, skipped: false });
assert.equal(itemDeleteCalls, 1);
assert.equal(shoppingState[0].items.length, 0);

let updatedListPayload = null;
queueState = [{ id: 25, action: 'UPDATE_SHOPPING_LIST', data: { id: 70, changes: { name: 'Weekly groceries', color: '#10b981', icon: 'package', sort_order: 4 } } }];
shoppingState = [{ id: 70, name: 'Weekly groceries', color: '#10b981', icon: 'package', sort_order: 4, sections: [], items: [], preferences: {} }];
shoppingApi.updateList = async (listId, changes) => {
  assert.equal(listId, 70);
  updatedListPayload = changes;
  return { id: listId, ...changes };
};
shoppingApi.getList = async id => ({ id, name: 'Weekly groceries', color: '#10b981', icon: 'package', sort_order: 4, sections: [], items: [], preferences: {} });
const listUpdateResult = await syncFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false, requested: false } });
assert.deepEqual(listUpdateResult, { successCount: 1, failCount: 0, skipped: false });
assert.deepEqual(updatedListPayload, { name: 'Weekly groceries', color: '#10b981', icon: 'package', sort_order: 4 });
assert.equal(queueState.length, 0);
assert.equal(shoppingState[0].name, 'Weekly groceries');

let deletedListId = null;
queueState = [{ id: 26, action: 'DELETE_SHOPPING_LIST', data: { id: 70 } }];
shoppingApi.deleteList = async listId => { deletedListId = listId; return { id: listId, deleted: true }; };
const listDeleteResult = await syncFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false, requested: false } });
assert.deepEqual(listDeleteResult, { successCount: 1, failCount: 0, skipped: false });
assert.equal(deletedListId, 70);
assert.equal(queueState.length, 0);
assert.equal(shoppingState.length, 0);

let createThenDeleteServerId = null;
let createThenDeleteCalls = 0;
queueState = [
  { id: 31, action: 'CREATE_SHOPPING_LIST', data: { temp_id: 'temp-list-delete', name: 'Delete before replay', color: '#6366f1', icon: 'shopping-cart', sort_order: 0, client_mutation_id: 'temp-list-delete' } },
  { id: 32, action: 'DELETE_SHOPPING_LIST', data: { id: 'temp-list-delete' } },
];
shoppingState = [];
shoppingApi.createList = async data => ({ id: 71, ...data });
shoppingApi.deleteList = async listId => {
  createThenDeleteServerId = listId;
  createThenDeleteCalls += 1;
  return { id: listId, deleted: true };
};
const createThenDeleteResult = await syncFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false, requested: false } });
assert.deepEqual(createThenDeleteResult, { successCount: 2, failCount: 0, skipped: false });
assert.equal(createThenDeleteServerId, 71, 'offline create then delete must replay the remapped server ID');
assert.equal(createThenDeleteCalls, 1, 'offline create then delete must issue exactly one server delete');
assert.equal(queueState.length, 0);
assert.equal(shoppingState.length, 0, 'offline create then delete must not resurrect the list projection');

let resolveStaleShoppingResponse;
let signalStaleShoppingRequest;
const staleShoppingGate = new Promise(resolve => { resolveStaleShoppingResponse = resolve; });
const staleShoppingStarted = new Promise(resolve => { signalStaleShoppingRequest = resolve; });
let staleShoppingQueue = [{ id: 90, action: 'UPDATE_SHOPPING_LIST', data: { id: 90, changes: { name: 'Private edit' } } }];
let staleShoppingLists = [{ id: 90, name: 'Private old', sections: [], items: [], preferences: {} }];
let staleShoppingCommits = 0;
const staleShoppingFeature = createSyncFeature({
  getDb: () => ({}),
  dbGetAll: async store => store === 'syncQueue' ? structuredClone(staleShoppingQueue) : [],
  dbPut: async () => {}, dbClear: async () => {}, getFromDB: async () => null, deleteFromDB: async () => {},
  getTodos: () => [], setTodos: () => {}, getProjects: () => [], setProjects: () => {},
  getSections: () => [], setSections: () => {}, getWorkspaces: () => [], setWorkspaces: () => {},
  getShoppingLists: () => staleShoppingLists,
  setShoppingLists: next => { staleShoppingLists = structuredClone(next); },
  getShoppingStores: () => [], setShoppingStores: () => {},
  todosApi: {}, projectsApi: {}, sectionsApi: {}, workspacesApi: {},
  shoppingApi: {
    updateList: async () => {},
    getList: async () => {
      signalStaleShoppingRequest();
      await staleShoppingGate;
      return { id: 90, name: 'Stale private response', sections: [], items: [], preferences: {} };
    },
    snapshot: async () => ({ shopping_lists: [] }),
  },
  commitShoppingReplay: async () => { staleShoppingCommits += 1; },
  renderStats: () => {}, renderTodos: () => {}, renderShopping: () => {},
});
const staleShoppingRef = { value: false, requested: false, privacyGeneration: 0 };
const staleShoppingReplay = staleShoppingFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: staleShoppingRef });
await staleShoppingStarted;
staleShoppingQueue = [];
staleShoppingLists = [];
staleShoppingRef.privacyGeneration += 1;
resolveStaleShoppingResponse();
await staleShoppingReplay;
assert.equal(staleShoppingCommits, 0, 'a shopping response must not persist after privacy eviction removed its queue entry');
assert.deepEqual(staleShoppingLists, [], 'a stale shopping response must not republish an evicted list');

console.log('✅ Offline shopping projection and atomic IndexedDB contracts passed');
