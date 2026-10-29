#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createWebSocketClient } from '../web/static/js/features/websocket-client.js';

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

console.log('✅ Shopping realtime snapshot and invalidation contracts passed');
