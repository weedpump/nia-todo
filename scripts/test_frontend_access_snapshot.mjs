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
  shopping_invites: [{ id: 13, shopping_list_id: 9, status: 'pending' }],
});

assert.deepEqual(accessSnapshot, {
  household: { id: 3, name: 'Home', members: [] },
  householdInvites: [{ id: 11, household_id: 4, status: 'pending' }],
  projectInvites: [{ id: 12, project_id: 8, status: 'pending' }],
  shoppingInvites: [{ id: 13, shopping_list_id: 9, status: 'pending' }],
});
assert.deepEqual(stores.projects[0].members, [{ id: 13, user_id: 2, status: 'pending' }]);
assert.deepEqual(modulePreferences, { disabled_modules: ['shopping'] });

await client.handleWsMessage({
  type: 'sync_response',
  todos: [], projects: [], sections: [], workspaces: [],
  household: null, household_invites: [], project_invites: [],
});
assert.equal(Object.prototype.hasOwnProperty.call(accessSnapshot, 'shoppingInvites'), false, 'an older sync payload must not authoritatively clear shopping invitations');

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
  shopping_invites: [],
});

assert.deepEqual(accessSnapshot, {
  household: null,
  householdInvites: [],
  projectInvites: [],
  shoppingInvites: [],
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
let socketCreations = 0;
class FakeWebSocket {
  static OPEN = 1;
  constructor() {
    socketCreations++;
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
let reconnectToken = 'test-token';
const reconnectClient = createWebSocketClient({
  wsUrl: 'ws://test.invalid',
  getAuthToken: () => reconnectToken,
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
  household: null, household_invites: [], project_invites: [], shopping_invites: [],
});
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(sentMessages.filter(message => message.type === 'sync_request').length, 1);
settlementPending = false;
releaseSettlement();
await staleResponse;
assert.deepEqual(sentMessages.at(-1), { type: 'sync_request' });
assert.equal(sentMessages.filter(message => message.type === 'sync_request').length, 2);
await reconnectClient.disconnectWebSocket();
reconnectClient.connectWebSocket();
reconnectClient.scheduleReconnect();
assert.equal(socketCreations, 1, 'an intentional session shutdown must block direct and automatic reconnection');
reconnectToken = null;
assert.equal(reconnectClient.resumeWebSocket(), false, 'an unauthenticated runtime cannot resume a closed session');
reconnectClient.connectWebSocket();
assert.equal(socketCreations, 1);
reconnectToken = 'replacement-session-token';
assert.equal(reconnectClient.resumeWebSocket(), true);
assert.equal(socketCreations, 1, 'explicit runtime resume permits connection without starting it before local data loading completes');
reconnectClient.connectWebSocket();
assert.equal(socketCreations, 2, 'an authenticated replacement runtime must reconnect after its explicit resume');
await fakeSocket.onopen();
assert.deepEqual(sentMessages.at(-1), { type: 'auth', token: 'replacement-session-token' }, 'the resumed socket must authenticate with the replacement session');
await reconnectClient.handleWsMessage({ type: 'auth_ok', user_id: 2 });
assert.deepEqual(sentMessages.at(-1), { type: 'sync_request' });
await reconnectClient.disconnectWebSocket();
globalThis.WebSocket = originalWebSocket;

// Exercise the production sharing controller and durable eviction primitive,
// rather than substituting a cache filter for accepted-grant revocation.
globalThis.location = { origin: 'http://localhost' };
const { createProjectSharingFeature } = await import('../web/static/js/features/project-sharing.js');
const { commitShoppingReplay, evictPendingProjectEntities, evictPendingShoppingEntities } = await import('../web/static/js/storage/indexed-db.js');
const { runEntityPrivacyEviction } = await import('../web/static/js/features/entity-access-privacy.js');
const { acquireSyncCommitLock } = await import('../web/static/js/features/todo-pending.js');
const privateTodo = { id: 700, title: 'Offline private edit', project_id: 9, attachments: [{ id: 1, filename: 'private.txt' }] };
const authorizedTodo = { id: 800, title: 'Keep independently authorized edit', project_id: 8, section_id: 80 };
const fixture = {
  projects: [
    { id: 7, name: 'Revoked accepted grant', member_status: 'accepted', workspace_id: 1 },
    { id: 8, parent_id: 7, name: 'Independent child grant', workspace_id: 2 },
    { id: 81, parent_id: 7, name: 'Inherited-only child', workspace_id: 1 },
    { id: 9, name: 'Other workspace', workspace_id: 2 },
    { id: 'temp-root', name: 'Pending personal project' },
    { id: 'temp-child', parent_id: 8, name: 'Pending authorized descendant' },
  ],
  sections: [{ id: 70, project_id: 7 }, { id: 80, project_id: 8 }, { id: 81, project_id: 81 }, { id: 90, project_id: 7 }],
  todos: [privateTodo, authorizedTodo, { id: 810, title: 'Inherited private edit', project_id: 81, section_id: 81 },
    { id: 900, title: 'Edit before server move', project_id: 7 }],
  workspaces: [{ id: 1 }, { id: 2 }],
  syncQueue: [
    { id: 1, action: 'UPDATE_TODO', data: { id: 700, project_id: 7, project_boundary_ids: [7], changes: { title: privateTodo.title, project_id: 9 } } },
    { id: 2, action: 'CREATE_COMMENT', data: { todo_id: 700, project_id: 7, project_boundary_ids: [7], body: 'Private comment' } },
    { id: 3, action: 'CREATE_SUBTASK', data: { todo_id: 700, project_id: 7, project_boundary_ids: [7], subtask: { title: 'Private subtask' } } },
    { id: 4, action: 'UPDATE_TODO', data: { id: 800, project_id: 8, project_boundary_ids: [8, 7], changes: { title: authorizedTodo.title } } },
    { id: 5, action: 'UPDATE_TODO', data: { id: 810, project_id: 81, project_boundary_ids: [81, 7], changes: { title: 'Inherited private edit' } } },
    { id: 6, action: 'CREATE_PROJECT', data: { _tempId: 'temp-root', project_id: 'temp-root', project_boundary_ids: ['temp-root'], name: 'Pending personal project' } },
    { id: 7, action: 'CREATE_PROJECT', data: { _tempId: 'temp-child', parent_id: 8, project_id: 'temp-child', project_boundary_ids: ['temp-child', 8, 7], name: 'Pending authorized descendant' } },
    { id: 8, action: 'UPDATE_TODO', data: { id: 900, project_id: 7, project_boundary_ids: [7], changes: { title: 'Keep edit after server move' } } },
    { id: 9, action: 'UPDATE_SECTION', data: { id: 90, project_id: 7, project_boundary_ids: [7], changes: { name: 'Keep section after server move' } } },
    { id: 10, action: 'CREATE_COMMENT', data: { todo_id: 900, project_id: 7, project_boundary_ids: [7], body: 'Keep authorized comment' } },
    { id: 11, action: 'CREATE_SUBTASK', data: { todo_id: 900, project_id: 7, project_boundary_ids: [7], subtask: { title: 'Keep authorized subtask' } } },
  ],
};
const projection = structuredClone(fixture);
const privacyRef = { value: false, privacyGeneration: 0 };
const evictions = [];
const scheduledIds = [];
let evictionLockGate = null;
const fixtureDatabase = {
  transaction(names) {
    let completedReads = 0;
    const tx = {
      objectStore: name => ({
        delete: id => { fixture[name] = fixture[name].filter(entry => entry.id !== id); },
        getAll() {
          const request = {};
          queueMicrotask(() => {
            request.result = structuredClone(fixture[name]);
            request.onsuccess?.();
            if (++completedReads === names.length) queueMicrotask(() => tx.oncomplete?.());
          });
          return request;
        },
      }),
      abort() { queueMicrotask(() => tx.onabort?.()); },
    };
    return tx;
  },
};
const sharing = createProjectSharingFeature({
  getProjects: () => projection.projects, setProjects: value => { projection.projects = value; },
  renderProjects() {}, renderStats() {}, renderTodos() {}, showToast() {}, confirmDanger: async () => true,
  projectsApi: {},
  removePendingEntities: (ids, { signal, getAccessibleEntities }) => {
    scheduledIds.push(...ids);
    const work = runEntityPrivacyEviction({
      syncInProgressRef: privacyRef,
      acquireCommitLock: async ref => {
        if (evictionLockGate) await evictionLockGate;
        return acquireSyncCommitLock(ref);
      }, signal,
      evict: () => evictPendingProjectEntities(ids, { database: fixtureDatabase, signal, ...getAccessibleEntities(),
        projects: projection.projects, sections: projection.sections, todos: projection.todos }),
      publish: result => {
        for (const [store, key] of [['projects', 'projectIds'], ['sections', 'sectionIds'], ['todos', 'todoIds']]) {
          const blocked = new Set(result[key].map(String));
          projection[store] = projection[store].filter(entry => !blocked.has(String(entry.id)));
        }
      },
    });
    evictions.push(work);
    return work;
  },
});
const accessClient = createWebSocketClient({
  wsUrl: 'ws://test.invalid', getAuthToken: () => 'test', syncWithServer: async () => {}, syncInProgressRef: privacyRef,
  renderConnectionStatus() {}, renderWorkspaces() {}, renderProjects() {}, renderStats() {}, renderTodos() {},
  dbGetAll: async store => structuredClone(fixture[store]),
  dbPut: async (store, value) => {
    fixture[store] = [...fixture[store].filter(entry => String(entry.id) !== String(value.id)), structuredClone(value)];
  },
  getFromDB: async (store, id) => fixture[store].find(entry => String(entry.id) === String(id)),
  deleteFromDB: async (store, id) => { fixture[store] = fixture[store].filter(entry => String(entry.id) !== String(id)); },
  getTodos: () => projection.todos, setTodos: value => { projection.todos = value; },
  getProjects: () => projection.projects, setProjects: value => { projection.projects = value; },
  getSections: () => projection.sections, setSections: value => { projection.sections = value; },
  getWorkspaces: () => projection.workspaces, setWorkspaces: value => { projection.workspaces = value; },
  onEntitySnapshotsCommitted: snapshot => sharing.commitAuthoritativeSnapshot(snapshot.projects, snapshot.revokedProjectIds, snapshot.taskAccessSnapshot),
  onAccessSnapshot: snapshot => sharing.setInvites(snapshot.projectInvites),
});
await accessClient.handleWsMessage({ type: 'workspace_update', payload: { id: 2, name: 'Selected workspace' } });
await accessClient.handleWsMessage({ type: 'project_update', payload: { id: 9, workspace_id: 2, name: 'Workspace move' } });
assert.deepEqual(scheduledIds, [], 'workspace selection/placement and individual project events cannot revoke omitted projects');
sharing.commitAuthoritativeSnapshot([{ id: 9 }]);
assert.deepEqual(scheduledIds, [], 'a workspace-scoped projection without explicit revocation metadata cannot evict pending data');
await accessClient.handleWsMessage({
  type: 'sync_response',
  projects: [{ id: 8, parent_id: 7, workspace_id: 2 }, { id: 9, workspace_id: 2 }],
  todos: [{ id: 800, project_id: 8, title: 'Server title' }, { id: 900, project_id: 9, title: 'Server-moved title' }],
  sections: [{ id: 80, project_id: 8 }, { id: 90, project_id: 9 }],
  workspaces: [{ id: 1 }, { id: 2 }], project_invites: [], household: null, household_invites: [],
});
await Promise.all(evictions);
assert.deepEqual(new Set(scheduledIds), new Set([7, 81]), 'the full access snapshot must evict revoked accepted grants without a pending invitation');
assert.deepEqual(fixture.todos.map(todo => todo.id), [800, 900], 'private moved Todo, attachments and inherited child cache must be removed durably');
assert.deepEqual(projection.todos.map(todo => todo.id), [800, 900], 'the published cache must drop inaccessible pending Todos');
assert.equal(fixture.todos[0].title, authorizedTodo.title, 'an independent child grant must preserve the pending edit');
assert.equal(fixture.todos.find(todo => todo.id === 900).title, 'Keep edit after server move',
  'a server-confirmed move to an accessible project must preserve pending edits with the old source boundary');
assert.ok(fixture.sections.some(section => section.id === 90), 'server-confirmed accessible sections must survive stale source metadata');
assert.deepEqual(fixture.syncQueue.map(entry => entry.id), [4, 6, 7, 8, 9, 10, 11], 'remove only revoked Todo/comment/subtask queues; preserve authorized writes and local project creates');
assert.deepEqual(new Set(fixture.projects.map(project => project.id)), new Set([8, 9, 'temp-root', 'temp-child']),
  'another workspace, independently accessible descendant and pending locally-created projects must survive');
assert.deepEqual(new Set(projection.projects.map(project => project.id)), new Set([8, 9, 'temp-root', 'temp-child']));

// An older ancestor eviction may wait behind another writer while a newer
// snapshot grants the child or confirms a server-side Todo move. Protection
// must be read after that eviction acquires the commit lock.
let releaseEvictionLock;
evictionLockGate = new Promise(resolve => { releaseEvictionLock = resolve; });
evictions.length = 0;
scheduledIds.length = 0;
Object.assign(fixture, {
  projects: [{ id: 7 }, { id: 8, parent_id: 7 }, { id: 9 }], sections: [],
  todos: [{ id: 701, project_id: 7, title: 'Must evict' }, { id: 800, project_id: 8, title: 'New child grant' },
    { id: 900, project_id: 7, title: 'Moved on server' }],
  syncQueue: [
    { id: 21, action: 'UPDATE_TODO', data: { id: 701, project_id: 7, project_boundary_ids: [7], changes: { title: 'Private' } } },
    { id: 22, action: 'UPDATE_TODO', data: { id: 800, project_id: 8, project_boundary_ids: [8, 7], changes: { title: 'Keep child' } } },
    { id: 23, action: 'UPDATE_TODO', data: { id: 900, project_id: 7, project_boundary_ids: [7], changes: { title: 'Keep moved' } } },
  ],
});
Object.assign(projection, structuredClone(fixture));
await accessClient.handleWsMessage({ type: 'sync_response', projects: [{ id: 9 }], todos: [], sections: [], workspaces: [],
  project_invites: [], household: null, household_invites: [] });
assert.ok(scheduledIds.includes(7), 'the older authoritative snapshot must schedule the actual ancestor revocation');
assert.ok(fixture.todos.some(todo => todo.id === 701), 'durable eviction must still be waiting for the controlled lock');
await accessClient.handleWsMessage({ type: 'sync_response', projects: [{ id: 8, parent_id: 7 }, { id: 9 }],
  todos: [{ id: 800, project_id: 8, title: 'Server child' }, { id: 900, project_id: 9, title: 'Server move' }],
  sections: [], workspaces: [], project_invites: [], household: null, household_invites: [] });
releaseEvictionLock();
const raceResults = await Promise.allSettled(evictions);
assert.ok(raceResults.every(result => result.status === 'fulfilled' || result.reason?.name === 'AbortError'));
evictionLockGate = null;
assert.deepEqual(fixture.todos.map(todo => todo.id), [800, 900], 'a waiting ancestor eviction must protect child grants and server moves from the latest committed snapshot');
assert.deepEqual(projection.todos.map(todo => todo.id), [800, 900]);
assert.deepEqual(fixture.syncQueue.map(entry => entry.id), [22, 23], 'necessary ancestor revocation must still remove its private pending write selectively');
assert.deepEqual(new Set(fixture.projects.map(project => project.id)), new Set([8, 9]));

for (const snapshotKind of ['full-empty', 'full-authorized', 'lists-only', 'stores-only', 'partial-known-revocation']) {
  const legacyRows = [
    { id: 41, action: 'UPDATE_SHOPPING_STORE', data: { store_id: 91, changes: { name: 'Keep authorized edit' } } },
    { id: 42, action: 'DELETE_SHOPPING_STORE', data: { store_id: 92 } },
    { id: 43, action: 'UPDATE_SHOPPING_STORE', data: { store_id: 93, shopping_list_id: 7, changes: { name: 'Already scoped' } } },
    { id: 44, action: 'UPDATE_TODO', data: { id: 700, changes: { title: 'Tasks untouched' } } },
  ];
  const shoppingCache = { shoppingLists: [], shoppingStores: [], syncQueue: structuredClone(legacyRows) };
  const shoppingMemory = { shoppingLists: [], shoppingStores: [] };
  const commits = [];
  const shoppingEvictions = [];
  const shoppingSyncRef = {};
  if (snapshotKind === 'partial-known-revocation') {
    shoppingCache.shoppingLists = [{ id: 77, name: 'Revoked known list' }];
    shoppingMemory.shoppingLists = structuredClone(shoppingCache.shoppingLists);
  }
  const shoppingDatabase = {
    transaction(names, mode) {
      commits.push({ names, mode });
      let reads = 0;
      const tx = { objectStore: name => ({
        put: value => { shoppingCache[name] = [...shoppingCache[name].filter(entry => entry.id !== value.id), structuredClone(value)]; },
        delete: id => { shoppingCache[name] = shoppingCache[name].filter(entry => entry.id !== id); },
        getAll() {
          reads += 1;
          const request = {};
          queueMicrotask(() => {
            request.result = structuredClone(shoppingCache[name]);
            request.onsuccess?.();
            if (--reads === 0) queueMicrotask(() => tx.oncomplete?.());
          });
          return request;
        },
      }) };
      queueMicrotask(() => { if (reads === 0) tx.oncomplete?.(); });
      return tx;
    },
  };
  const shoppingClient = createWebSocketClient({
    wsUrl: 'ws://test.invalid', getAuthToken: () => 'test', syncWithServer: async () => {}, syncInProgressRef: shoppingSyncRef,
    renderConnectionStatus() {}, renderWorkspaces() {}, renderProjects() {}, renderStats() {}, renderTodos() {},
    dbGetAll: async store => structuredClone(shoppingCache[store] || []),
    dbPut: async (store, value) => {
      shoppingCache[store] = [...shoppingCache[store].filter(entry => entry.id !== value.id), structuredClone(value)];
    },
    deleteFromDB: async (store, id) => { shoppingCache[store] = shoppingCache[store].filter(entry => entry.id !== id); },
    getFromDB: async () => null,
    commitShoppingReplay: changes => commitShoppingReplay({ ...changes, database: shoppingDatabase }),
    getTodos: () => [], setTodos() {}, getProjects: () => [], setProjects() {}, getSections: () => [], setSections() {},
    getWorkspaces: () => [], setWorkspaces() {},
    getShoppingLists: () => shoppingMemory.shoppingLists,
    setShoppingLists: value => { shoppingMemory.shoppingLists = value; },
    getShoppingStores: () => shoppingMemory.shoppingStores,
    setShoppingStores: value => { shoppingMemory.shoppingStores = value; },
    onEntitySnapshotsCommitted: snapshot => {
      if (snapshotKind !== 'partial-known-revocation' || !snapshot.revokedShoppingListIds.length) return;
      const work = runEntityPrivacyEviction({
        syncInProgressRef: shoppingSyncRef, acquireCommitLock: acquireSyncCommitLock,
        evict: () => evictPendingShoppingEntities(snapshot.revokedShoppingListIds, { database: shoppingDatabase }),
      });
      shoppingEvictions.push(work);
    },
  });
  const payload = { type: 'sync_response' };
  if (snapshotKind !== 'stores-only') payload.shopping_lists = snapshotKind === 'full-authorized' ? [{ id: 7, sections: [], items: [] }] : [];
  if (!['lists-only', 'partial-known-revocation'].includes(snapshotKind)) payload.shopping_stores = snapshotKind === 'full-authorized'
    ? [{ id: 91, shopping_list_id: 7, name: 'Server store' }, { id: 92, shopping_list_id: 7, name: 'Delete target' }] : [];
  await shoppingClient.handleWsMessage(payload);
  await Promise.all(shoppingEvictions);
  if (snapshotKind === 'full-empty') {
    assert.deepEqual(shoppingCache.syncQueue, legacyRows.slice(2), 'cold-cache orphan rows must be removed durably even without a known revoked list');
    assert.equal(commits.length, 1, 'orphan removal must use one actual Shopping replay transaction');
  } else if (snapshotKind === 'full-authorized') {
    assert.deepEqual(shoppingCache.syncQueue.slice().sort((a, b) => a.id - b.id), legacyRows.map(entry => entry.id < 43
      ? { ...entry, data: { ...entry.data, shopping_list_id: 7 } } : entry),
    'authorized server store metadata must backfill and preserve cold-cache legacy updates/deletes');
    assert.equal(commits.length, 1);
    assert.equal(shoppingMemory.shoppingStores.find(store => store.id === 91).name, 'Keep authorized edit');
  } else if (snapshotKind === 'partial-known-revocation') {
    assert.deepEqual(shoppingCache.syncQueue.map(entry => entry.id), [41, 42, 44],
      'partial known-list revocation must remove attributable writes but preserve unrelated recoverable legacy orphans');
    assert.equal(shoppingCache.shoppingLists.length, 0);
    await shoppingClient.handleWsMessage({ type: 'sync_response', shopping_lists: [{ id: 7, sections: [], items: [] }],
      shopping_stores: [{ id: 91, shopping_list_id: 7, name: 'Authorized store' }] });
    await Promise.all(shoppingEvictions);
    assert.deepEqual(shoppingCache.syncQueue.map(entry => entry.id).sort((a, b) => a - b), [41, 44],
      'the next full snapshot must preserve the recoverable legacy update and remove the still-unassignable orphan');
    assert.equal(shoppingCache.syncQueue.find(entry => entry.id === 41).data.shopping_list_id, 7);
  } else {
    assert.deepEqual(shoppingCache.syncQueue, legacyRows, `${snapshotKind}: partial snapshots cannot infer orphan revocation`);
    assert.equal(commits.length, 0);
  }
}
console.log('✅ WebSocket access snapshots are applied authoritatively');
