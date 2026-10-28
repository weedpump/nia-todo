#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createWebSocketClient } from '../web/static/js/features/websocket-client.js';

const stores = {
  todos: [],
  projects: [],
  sections: [],
  workspaces: [],
  syncQueue: [],
};
let todos = [];
let projects = [];
let sections = [];
let workspaces = [];
let accessSnapshot = null;
let modulePreferences = null;
const syncInProgressRef = { value: false };

const client = createWebSocketClient({
  wsUrl: 'ws://invalid.test',
  getAuthToken: () => 'test-token',
  syncWithServer: async () => {},
  syncInProgressRef,
  renderConnectionStatus: () => {},
  dbGetAll: async store => [...stores[store]],
  dbPut: async (store, value) => {
    const index = stores[store].findIndex(entry => String(entry.id) === String(value.id));
    if (index >= 0) stores[store][index] = structuredClone(value);
    else stores[store].push(structuredClone(value));
  },
  getFromDB: async (store, id) => stores[store].find(entry => String(entry.id) === String(id)) || null,
  deleteFromDB: async (store, id) => {
    stores[store] = stores[store].filter(entry => String(entry.id) !== String(id));
  },
  getTodos: () => todos,
  setTodos: value => { todos = value; },
  getProjects: () => projects,
  setProjects: value => { projects = value; },
  getSections: () => sections,
  setSections: value => { sections = value; },
  getWorkspaces: () => workspaces,
  setWorkspaces: value => { workspaces = value; },
  renderWorkspaces: () => {},
  renderProjects: () => {},
  renderStats: () => {},
  renderTodos: () => {},
  onAccessSnapshot: snapshot => { accessSnapshot = snapshot; },
  onModulePreferencesUpdate: payload => { modulePreferences = payload; },
});

await client.handleWsMessage({
  type: 'sync_response',
  todos: [],
  projects: [{
    id: 7,
    name: 'Shared',
    updated_at: '2030-01-01T00:00:00Z',
    members: [{ id: 13, user_id: 2, status: 'pending' }],
  }],
  sections: [],
  workspaces: [],
  module_preferences: { disabled_modules: ['shopping'] },
  household: { id: 3, name: 'Home', members: [] },
  household_invites: [{ id: 11, household_id: 4, status: 'pending' }],
  project_invites: [{ id: 12, project_id: 8, status: 'pending' }],
});

assert.deepEqual(accessSnapshot, {
  household: { id: 3, name: 'Home', members: [] },
  householdInvites: [{ id: 11, household_id: 4, status: 'pending' }],
  projectInvites: [{ id: 12, project_id: 8, status: 'pending' }],
});
assert.deepEqual(stores.projects[0].members, [{ id: 13, user_id: 2, status: 'pending' }]);
assert.deepEqual(modulePreferences, { disabled_modules: ['shopping'] });

await client.handleWsMessage({
  type: 'module_preferences_update',
  payload: { disabled_modules: ['recipes'] },
});
assert.deepEqual(modulePreferences, { disabled_modules: ['recipes'] });

await client.handleWsMessage({
  type: 'sync_response',
  todos: [],
  projects: [{ id: 7, name: 'Shared', updated_at: '2030-01-02T00:00:00Z', members: [] }],
  sections: [],
  workspaces: [],
  household: null,
  household_invites: [],
  project_invites: [],
});

assert.deepEqual(accessSnapshot, {
  household: null,
  householdInvites: [],
  projectInvites: [],
});
assert.deepEqual(stores.projects[0].members, []);

stores.todos.push({ id: 31, title: 'Committed todo' });
stores.projects.push({ id: 32, name: 'Committed project' });
stores.sections.push({ id: 33, name: 'Committed section' });
todos = [...stores.todos];
projects = [...stores.projects];
sections = [...stores.sections];
syncInProgressRef.value = true;
const deferredSnapshot = client.handleWsMessage({
  type: 'sync_response',
  todos: [],
  projects: [],
  sections: [],
  workspaces: [],
  household: { id: 9, name: 'Deferred', members: [] },
  household_invites: [{ id: 21, household_id: 9, status: 'pending' }],
  project_invites: [],
});
await new Promise(resolve => setTimeout(resolve, 25));
assert.equal(accessSnapshot.household, null);
syncInProgressRef.value = false;
await deferredSnapshot;
assert.equal(accessSnapshot.household, null);
assert.ok(stores.todos.some(todo => todo.id === 31));
assert.ok(stores.projects.some(project => project.id === 32));
assert.ok(stores.sections.some(section => section.id === 33));

const originalWebSocket = globalThis.WebSocket;
const sentMessages = [];
let fakeSocket = null;
class FakeWebSocket {
  static OPEN = 1;
  constructor() {
    this.readyState = FakeWebSocket.OPEN;
    fakeSocket = this;
  }
  send(data) {
    sentMessages.push(JSON.parse(data));
  }
  close() {}
}
globalThis.WebSocket = FakeWebSocket;
let releaseInitialSync;
const initialSync = new Promise(resolve => { releaseInitialSync = resolve; });
const reconnectSyncRef = { value: false };
let settlementPromise = Promise.resolve();
let settlementPending = false;
const reconnectClient = createWebSocketClient({
  wsUrl: 'ws://test.invalid',
  getAuthToken: () => 'test-token',
  syncWithServer: async () => initialSync,
  syncInProgressRef: reconnectSyncRef,
  hasUnsettledSync: () => settlementPending,
  waitForSyncSettlement: () => settlementPromise,
  renderConnectionStatus: () => {},
  dbGetAll: async () => [],
  dbPut: async () => {},
  getFromDB: async () => null,
  deleteFromDB: async () => {},
  getTodos: () => [], setTodos: () => {},
  getProjects: () => [], setProjects: () => {},
  getSections: () => [], setSections: () => {},
  getWorkspaces: () => [], setWorkspaces: () => {},
  renderWorkspaces: () => {}, renderProjects: () => {},
  renderStats: () => {}, renderTodos: () => {},
});
reconnectClient.connectWebSocket();
const openHandler = fakeSocket.onopen();
const authHandler = reconnectClient.handleWsMessage({ type: 'auth_ok', user_id: 1 });
await new Promise(resolve => setTimeout(resolve, 10));
assert.deepEqual(sentMessages, [{ type: 'auth', token: 'test-token' }]);
releaseInitialSync();
await Promise.all([openHandler, authHandler]);
assert.deepEqual(sentMessages, [
  { type: 'auth', token: 'test-token' },
  { type: 'sync_request' },
]);
let releaseSettlement;
settlementPromise = new Promise(resolve => { releaseSettlement = resolve; });
settlementPending = true;
reconnectSyncRef.value = false;
const staleResponse = reconnectClient.handleWsMessage({
  type: 'sync_response',
  todos: [], projects: [], sections: [], workspaces: [],
  household: null, household_invites: [], project_invites: [],
});
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(sentMessages.filter(message => message.type === 'sync_request').length, 1);
settlementPending = false;
releaseSettlement();
await staleResponse;
assert.deepEqual(sentMessages.at(-1), { type: 'sync_request' });
assert.equal(sentMessages.filter(message => message.type === 'sync_request').length, 2);
await reconnectClient.disconnectWebSocket();
globalThis.WebSocket = originalWebSocket;
console.log('✅ WebSocket access snapshots are applied authoritatively');
