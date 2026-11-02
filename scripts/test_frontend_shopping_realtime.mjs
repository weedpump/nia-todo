#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWebSocketClient } from '../web/static/js/features/websocket-client.js';
import { createShoppingNavigationFeature } from '../web/static/js/features/shopping-navigation.js';

const stores = {
  todos: [], projects: [], sections: [], workspaces: [],
  shoppingLists: [{ id: 'temp-list-1', name: 'Offline', sections: [], items: [], preferences: {} }],
  syncQueue: [{ id: 1, action: 'CREATE_SHOPPING_LIST', data: { temp_id: 'temp-list-1', list: { id: 'temp-list-1', name: 'Offline' } } }],
};
let shoppingState = structuredClone(stores.shoppingLists);
let refreshCalls = 0;
const client = createWebSocketClient({
  wsUrl: 'ws://unused.invalid',
  getAuthToken: () => null,
  syncWithServer: async () => {},
  syncInProgressRef: { value: false, requested: false },
  refreshFromServer: async () => { refreshCalls += 1; },
  renderConnectionStatus: () => {},
  dbGetAll: async store => structuredClone(stores[store] || []),
  dbPut: async (store, value) => {
    const list = stores[store];
    const index = list.findIndex(entry => String(entry.id) === String(value.id));
    if (index >= 0) list[index] = structuredClone(value);
    else list.push(structuredClone(value));
  },
  getFromDB: async (store, id) => (stores[store] || []).find(entry => String(entry.id) === String(id)) || null,
  deleteFromDB: async (store, id) => { stores[store] = (stores[store] || []).filter(entry => String(entry.id) !== String(id)); },
  getTodos: () => [], setTodos: () => {},
  getProjects: () => [], setProjects: () => {},
  getSections: () => [], setSections: () => {},
  getWorkspaces: () => [], setWorkspaces: () => {},
  getShoppingLists: () => shoppingState,
  setShoppingLists: next => { shoppingState = structuredClone(next); },
  renderWorkspaces: () => {}, renderProjects: () => {}, renderStats: () => {}, renderTodos: () => {}, renderShopping: () => {},
});

await client.handleWsMessage({
  type: 'sync_response',
  todos: [], projects: [], sections: [], workspaces: [],
  shopping_lists: [{ id: 7, name: 'Server', sections: [], items: [], preferences: {} }],
});
assert.deepEqual(shoppingState.map(list => list.id), [7, 'temp-list-1']);
assert.deepEqual(stores.shoppingLists.map(list => list.id), ['temp-list-1', 7]);

await client.handleWsMessage({ type: 'shopping_item_update', payload: { id: 20, shopping_list_id: 7 } });
assert.equal(refreshCalls, 1, 'shopping realtime deltas trigger an authoritative queue-aware refresh');

await client.handleWsMessage({ type: 'shopping_list_delete', payload: { id: 7, deleted: true } });
assert.equal(refreshCalls, 2, 'shopping list deletion triggers the same authoritative queue-aware refresh');
assert.deepEqual(shoppingState.map(list => list.id), [7, 'temp-list-1'], 'the realtime handler must not bypass pending-aware reconciliation');

let acceptedLists = [];
let releasePendingEviction;
const invitationRoot = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
const acceptedNavigation = createShoppingNavigationFeature({
  root: invitationRoot,
  getElementById: () => null,
  storage: { getItem: () => null, setItem() {}, removeItem() {} },
  historyTarget: null,
  locationTarget: { search: '', pathname: '/', hash: '' },
  eventTarget: { addEventListener() {}, removeEventListener() {} },
  getLists: () => acceptedLists,
  getStores: () => [],
  setLists: next => { acceptedLists = structuredClone(next); },
  removePendingEntities: (ids, { signal } = {}) => new Promise(resolve => {
    releasePendingEviction = () => {
      if (!signal?.aborted) {
        const blocked = new Set(ids.map(String));
        acceptedLists = acceptedLists.filter(list => !blocked.has(String(list.id)));
      }
      resolve();
    };
  }),
});
acceptedNavigation.setInvites([{ id: 91, entity_id: 44, entity_name: 'Accepted over realtime' }]);

const acceptedStores = {
  todos: [], projects: [], sections: [], workspaces: [], shoppingLists: [], shoppingStores: [], syncQueue: [],
};
const acceptedClient = createWebSocketClient({
  wsUrl: 'ws://unused.invalid',
  getAuthToken: () => null,
  syncWithServer: async () => {},
  syncInProgressRef: { value: false, requested: false },
  refreshFromServer: async () => {},
  renderConnectionStatus: () => {},
  dbGetAll: async store => structuredClone(acceptedStores[store] || []),
  dbPut: async (store, value) => {
    const records = acceptedStores[store];
    const index = records.findIndex(record => String(record.id) === String(value.id));
    if (index >= 0) records[index] = structuredClone(value);
    else records.push(structuredClone(value));
  },
  getFromDB: async (store, id) => (acceptedStores[store] || []).find(record => String(record.id) === String(id)) || null,
  deleteFromDB: async (store, id) => { acceptedStores[store] = (acceptedStores[store] || []).filter(record => String(record.id) !== String(id)); },
  getTodos: () => [], setTodos: () => {},
  getProjects: () => [], setProjects: () => {},
  getSections: () => [], setSections: () => {},
  getWorkspaces: () => [], setWorkspaces: () => {},
  getShoppingLists: () => acceptedLists,
  setShoppingLists: next => {
    acceptedLists = structuredClone(next);
    acceptedNavigation.replaceLists(next);
  },
  getShoppingStores: () => [], setShoppingStores: () => {},
  renderWorkspaces: () => {}, renderProjects: () => {}, renderStats: () => {}, renderTodos: () => {}, renderShopping: () => {},
  onEntitySnapshotsCommitted: snapshots => acceptedNavigation.commitAuthoritativeSnapshot(snapshots.shoppingLists),
  onAccessSnapshot: snapshot => acceptedNavigation.setInvites(snapshot.shoppingInvites || []),
});
await acceptedClient.handleWsMessage({
  type: 'sync_response',
  todos: [], projects: [], sections: [], workspaces: [], shopping_stores: [],
  shopping_lists: [{ id: 44, name: 'Accepted over realtime', sections: [], items: [], preferences: {}, can_edit: true }],
  household: null, household_invites: [], project_invites: [], shopping_invites: [],
});
assert.deepEqual(acceptedLists.map(list => list.id), [44], 'the accepted list must appear from the authoritative realtime snapshot');
releasePendingEviction();
await Promise.resolve();
assert.deepEqual(
  acceptedLists.map(list => list.id),
  [44],
  'the authoritative realtime snapshot must prevent the older pending-invitation eviction from removing the accepted list',
);

let revokedLists = [{ id: 77, name: 'Revoked private list', can_edit: true, sections: [], items: [{ id: 78, name: 'Secret' }], preferences: {} }];
const revokedStores = {
  todos: [], projects: [], sections: [], workspaces: [], shoppingStores: [],
  shoppingLists: structuredClone(revokedLists),
  syncQueue: [{ id: 79, action: 'UPDATE_SHOPPING_ITEM', data: { shopping_list_id: 77, item_id: 78, changes: { completed: true } } }],
};
const revokedIds = [];
const revokedClient = createWebSocketClient({
  wsUrl: 'ws://unused.invalid',
  getAuthToken: () => null,
  syncWithServer: async () => {},
  syncInProgressRef: { value: false, requested: false },
  refreshFromServer: async () => {},
  renderConnectionStatus: () => {},
  dbGetAll: async store => structuredClone(revokedStores[store] || []),
  dbPut: async (store, value) => {
    const records = revokedStores[store];
    const index = records.findIndex(record => String(record.id) === String(value.id));
    if (index >= 0) records[index] = structuredClone(value);
    else records.push(structuredClone(value));
  },
  getFromDB: async (store, id) => (revokedStores[store] || []).find(record => String(record.id) === String(id)) || null,
  deleteFromDB: async (store, id) => { revokedStores[store] = (revokedStores[store] || []).filter(record => String(record.id) !== String(id)); },
  getTodos: () => [], setTodos: () => {},
  getProjects: () => [], setProjects: () => {},
  getSections: () => [], setSections: () => {},
  getWorkspaces: () => [], setWorkspaces: () => {},
  getShoppingLists: () => revokedLists,
  setShoppingLists: next => { revokedLists = structuredClone(next); },
  getShoppingStores: () => [], setShoppingStores: () => {},
  renderWorkspaces: () => {}, renderProjects: () => {}, renderStats: () => {}, renderTodos: () => {}, renderShopping: () => {},
  onEntitySnapshotsCommitted: snapshots => revokedIds.push(...(snapshots.revokedShoppingListIds || [])),
});
await revokedClient.handleWsMessage({
  type: 'sync_response',
  todos: [], projects: [], sections: [], workspaces: [], shopping_stores: [], shopping_lists: [],
});
assert.deepEqual(revokedLists, [], 'a revoked server list must disappear from the live projection immediately');
assert.deepEqual(revokedStores.shoppingLists, [], 'a revoked server list must disappear from IndexedDB immediately');
assert.deepEqual(revokedIds, [77], 'the privacy controller must receive every revoked server-list identity so it can remove queued mutations');
const appSource = readFileSync(new URL('../web/static/js/app.js', import.meta.url), 'utf8');
assert.match(
  appSource,
  /onEntitySnapshotsCommitted:\s*snapshots\s*=>/,
  'the production composition root must forward authoritative realtime entity snapshots to access privacy controllers',
);

console.log('✅ Shopping realtime snapshot and invalidation contracts passed');
