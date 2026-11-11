#!/usr/bin/env node
import assert from 'node:assert/strict';

globalThis.location = { origin: 'http://localhost', pathname: '/', search: '' };
const saved = new Map();
globalThis.localStorage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, String(value)) };
const routes = [];
globalThis.history = {
  state: {},
  replaceState(state) { this.state = state; routes.push(['replace', state.filter]); },
  pushState(state) { this.state = state; routes.push(['push', state.filter]); },
};
const nodes = { 'todo-list': { innerHTML: '' }, 'project-list': { innerHTML: '' }, 'search-input': { value: '' } };
globalThis.document = {
  getElementById: id => nodes[id] || null, querySelectorAll: () => [],
  createElement: () => ({ textContent: '', get innerHTML() { return this.textContent; } }),
};
const { createNavigationFeature } = await import('../web/static/js/features/navigation.js');
const { createSyncFeature } = await import('../web/static/js/features/sync.js');
const { createAppRenderingFeature } = await import('../web/static/js/features/app-rendering.js');
const { commitTaskParentReplay, evictPendingProjectEntities } = await import('../web/static/js/storage/indexed-db.js');

function createDatabase(values) {
  return {
    transaction() {
      let reads = 0;
      const request = read => {
        reads++;
        const result = {};
        queueMicrotask(() => {
          result.result = structuredClone(read());
          result.onsuccess?.();
          if (--reads === 0) queueMicrotask(() => tx.oncomplete?.());
        });
        return result;
      };
      const tx = {
        objectStore: name => ({
          get: id => request(() => values[name].find(row => row.id === id)),
          getAll: () => request(() => values[name]),
          put: value => { values[name] = [...values[name].filter(row => row.id !== value.id), structuredClone(value)]; },
          delete: id => { values[name] = values[name].filter(row => row.id !== id); },
        }),
        abort() { queueMicrotask(() => tx.onabort?.()); },
      };
      queueMicrotask(() => { if (reads === 0) tx.oncomplete?.(); });
      return tx;
    },
  };
}

const projectId = 'temp-project-parent';
const sectionId = 'temp-section-parent';
const stores = {
  projects: [
    { id: projectId, name: 'Pending project', workspace_id: 1, is_owner: true },
    { id: 'temp-project-child', parent_id: projectId, name: 'Pending child', workspace_id: 1, is_owner: true },
    { id: 7, name: 'Unrelated', workspace_id: 1, is_owner: true },
    { id: 'temp-project-other', name: 'Another workspace', workspace_id: 2, is_owner: true },
  ],
  sections: [{ id: sectionId, project_id: projectId, name: 'Pending section' }],
  todos: [
    { id: 'temp-todo-child', project_id: projectId, section_id: sectionId, title: 'Keep local child', status: 'pending' },
    { id: 'temp-todo-unrelated', project_id: 7, title: 'Other work', status: 'pending' },
    { id: 'temp-todo-other', project_id: 'temp-project-other', title: 'Other workspace', status: 'pending' },
  ],
  workspaces: [],
  syncQueue: [
    { id: 1, action: 'CREATE_PROJECT', data: { _tempId: projectId, name: 'Pending project', workspace_id: 1 } },
    { id: 2, action: 'CREATE_PROJECT', data: { _tempId: 'temp-project-child', parent_id: projectId, name: 'Pending child', workspace_id: 1 } },
    { id: 3, action: 'CREATE_SECTION', data: { _tempId: sectionId, project_id: projectId, name: 'Pending section' } },
    { id: 4, action: 'CREATE_TODO', data: { _tempId: 'temp-todo-child', project_id: projectId, section_id: sectionId, title: 'Keep local child' } },
    { id: 5, action: 'UPDATE_TODO', data: { id: 'temp-todo-child', project_id: projectId, project_boundary_ids: [projectId], changes: { title: 'Edited local child' } } },
    { id: 6, action: 'CREATE_TODO', data: { _tempId: 'temp-todo-unrelated', project_id: 7, title: 'Other work' } },
    { id: 7, action: 'UPDATE_SECTION', data: { id: sectionId, project_id: projectId, project_boundary_ids: [projectId], changes: { name: 'Edited section' } } },
  ],
};
let currentProjectId = null;
let currentFilter = 'all';
let sections = [];
const syncRef = { value: false, privacyGeneration: 0 };
const dbGetAll = async store => structuredClone(stores[store]);
const dbPut = async (store, value) => { stores[store] = [...stores[store].filter(row => String(row.id) !== String(value.id)), structuredClone(value)]; };
const deleteFromDB = async (store, id) => { stores[store] = stores[store].filter(row => String(row.id) !== String(id)); };
const renderer = createAppRenderingFeature({
  appVersion: 'test', escapeHtml: String, escapeHtmlAttr: String,
  getTodos: () => stores.todos, getProjects: () => stores.projects, getSections: () => sections,
  getCurrentFilter: () => currentFilter, getCurrentProjectId: () => currentProjectId, getCurrentWorkspaceId: () => 1,
  getHideDone: () => false, getTodayFocus: () => false, getShowProjectWidget: () => false,
  getDashboardPreferences: () => ({}), getMinimalTodos: () => false, getCurrentUser: () => ({}),
  getFocusFilters: () => ({}), sortTodoList: value => value,
  renderTodoItem: todo => `<article>${todo.title}</article>`, getInvites: () => [],
});
let sectionLoads = 0;
const navigation = createNavigationFeature({
  sectionsApi: { listByProject: async id => { sectionLoads++; assert.equal(typeof id, 'number'); return { sections: [] }; } },
  getProjects: () => stores.projects, getCurrentProjectId: () => currentProjectId, getCurrentFilter: () => currentFilter,
  setCurrentProjectId: id => { currentProjectId = id; }, setCurrentFilter: filter => { currentFilter = filter; },
  setSections: value => { sections = value; }, isOnlineForSync: () => true,
  dbGetAll, dbPut, deleteFromDB, closeSidebar: () => false,
  renderProjects: renderer.renderProjects, renderStats() {}, renderTodos: renderer.renderTodos,
  syncInProgressRef: syncRef,
});
await navigation.setFilter(projectId);
assert.equal(currentProjectId, projectId, 'optimistic sidebar selection must retain the opaque project identity');
assert.equal(sectionLoads, 0, 'an unsynchronized project must load local sections without an invalid API request');
assert.equal(sections[0].id, sectionId);
assert.match(nodes['todo-list'].innerHTML, /add-section-row/);
assert.match(nodes['todo-list'].innerHTML, /Keep local child/);
assert.doesNotMatch(nodes['todo-list'].innerHTML, /Other workspace|Other work/);
assert.match(nodes['project-list'].innerHTML, /class="[^"]*active[^"]*"[^>]*data-entity-id="temp-project-parent"/);

let projectAttempts = 0;
let sectionAttempts = 0;
let sectionUpdateAttempts = 0;
const remaps = [];
const calls = [];
const feature = createSyncFeature({
  commitTaskParentReplay: receipt => commitTaskParentReplay(receipt, { database: createDatabase(stores) }),
  getDb: () => ({}), dbGetAll, dbPut, deleteFromDB, dbClear: async store => { stores[store] = []; },
  getFromDB: async (store, id) => structuredClone(stores[store].find(row => String(row.id) === String(id)) || null),
  getTodos: () => stores.todos, setTodos: value => { stores.todos = value; },
  getProjects: () => stores.projects, setProjects: value => { stores.projects = value; },
  getSections: () => sections, setSections: value => { sections = value; },
  getWorkspaces: () => [], setWorkspaces() {}, workspacesApi: {},
  projectsApi: { create: async data => {
    calls.push(['project', data.parent_id ?? null]);
    if (data._tempId === projectId && ++projectAttempts <= 4) throw Object.assign(new Error('temporary project failure'), { status: [401, 408, 429, 503][projectAttempts - 1] });
    assert.ok(data.parent_id == null || data.parent_id === 101);
    return { id: data._tempId === projectId ? 101 : 102, name: data.name, parent_id: data.parent_id ?? null, workspace_id: 1, is_owner: true };
  } },
  sectionsApi: {
    create: async (id, data) => {
      calls.push(['section', id]); assert.equal(id, 101);
      if (++sectionAttempts === 1) throw Object.assign(new Error('temporary section failure'), { status: 503 });
      return { id: 201, project_id: id, name: data.name };
    },
    update: async (id, changes) => {
      calls.push(['section-update', id]); assert.equal(id, 201);
      if (++sectionUpdateAttempts === 1) throw Object.assign(new Error('temporary section update failure'), { status: 503 });
      return { id, ...changes };
    },
  },
  todosApi: {
    create: async data => {
      calls.push(['todo', data.project_id, data.section_id]);
      assert.ok([7, 101].includes(data.project_id));
      if (data.project_id === 101) assert.equal(data.section_id, 201);
      return { ...data, id: data.project_id === 7 ? 501 : 301, status: 'pending', comments: [], subtasks: [] };
    },
    update: async (id, changes) => { calls.push(['todo-update', id]); assert.equal(id, 301); return { id, project_id: 101, section_id: 201, ...changes }; },
  },
  onProjectIdRemap: (from, to) => { assert.equal(syncRef.commitLocked, false, 'selection callbacks must run after the commit lock releases'); remaps.push(['project', from, to]); navigation.remapProjectId(from, to); },
  onSectionIdRemap: (from, to) => { assert.equal(syncRef.commitLocked, false); remaps.push(['section', from, to]); },
  renderStats() {}, renderTodos: renderer.renderTodos,
});
const replay = () => feature.syncWithServer({ wsState: 'connected', syncInProgressRef: syncRef });
await replay();
assert.deepEqual(calls.map(call => call[0]), ['project', 'todo'], 'a failed project must defer its children while unrelated projects continue');
assert.deepEqual(stores.syncQueue.map(row => row.id), [1, 2, 3, 4, 5, 7]);
for (const status of [408, 429, 503]) {
  await replay();
  assert.deepEqual(stores.syncQueue.map(row => row.id), [1, 2, 3, 4, 5, 7], `${status}: transient/reauth parent failures must retain the parent and all dependents`);
}
await replay();
assert.equal(currentProjectId, 101);
assert.equal(currentFilter, '101');
assert.equal(saved.get('nia-last-filter'), '101');
assert.equal(history.state.filter, '101');
assert.equal(routes.at(-1)[0], 'replace', 'identity confirmation must replace the current route instead of adding history');
assert.match(nodes['project-list'].innerHTML, /class="[^"]*active[^"]*"[^>]*data-entity-id="101"/);
assert.match(nodes['todo-list'].innerHTML, /add-section-row/);
assert.deepEqual(stores.syncQueue.map(row => row.id), [3, 4, 5, 7]);
assert.equal(stores.syncQueue.find(row => row.id === 5).data.project_boundary_ids[0], 101);
assert.equal(stores.projects.find(project => project.id === 102).parent_id, 101);
assert.equal(stores.sections[0].project_id, 101);
assert.equal(stores.todos.find(todo => todo.id === 'temp-todo-child').project_id, 101);
assert.equal(calls.filter(call => call[0] === 'todo').length, 1, 'a failed section must defer its Todo child');
await replay();
assert.deepEqual(stores.syncQueue.map(entry => entry.id), [7]);
assert.equal(stores.sections.find(section => section.id === 201).name, 'Edited section', 'the atomic receipt must preserve a pending rename even if its update remains offline');
assert.equal(sections.find(section => section.id === 201).name, 'Edited section', 'the published section must retain its newer queued fields');
await replay();
assert.equal(stores.syncQueue.length, 0);
assert.equal(stores.todos.find(todo => todo.id === 301).section_id, 201);
assert.equal(stores.todos.find(todo => todo.id === 301).title, 'Edited local child');
assert.equal(sections.find(section => section.id === 201).project_id, 101);
assert.deepEqual(remaps, [['project', projectId, 101], ['project', 'temp-project-child', 102], ['section', sectionId, 201]]);
await navigation.setFilter('done');
assert.equal(currentProjectId, null, 'aggregate filters retain their established semantics');
assert.equal(currentFilter, 'done');
assert.equal(navigation.remapProjectId(projectId, 103), false, 'confirmation must not hijack a later selection');

// Receipt and click ordering are independent: an old DOM node may be clicked
// after canonical memory was published, on either side of the receipt callback.
stores.projects.push({ id: 901, name: 'Confirmed before click', workspace_id: 1, is_owner: true });
assert.equal(navigation.remapProjectId('temp-project-before-click', 901), false);
await navigation.setFilter('temp-project-before-click');
assert.equal(currentProjectId, 901, 'a receipt received before a stale DOM click must resolve that click to the known canonical project');
assert.equal(currentFilter, '901');
assert.equal(saved.get('nia-last-filter'), '901');
assert.equal(history.state.filter, '901');
assert.match(nodes['project-list'].innerHTML, /class="[^"]*active[^"]*"[^>]*data-entity-id="901"/);
assert.match(nodes['todo-list'].innerHTML, /add-section-row/);
stores.projects.push({ id: 902, name: 'Confirmed after click', workspace_id: 1, is_owner: true });
await navigation.setFilter('temp-project-after-click');
assert.equal(currentProjectId, null, 'the intermediate stale click has no known temporary catalog row');
assert.equal(navigation.remapProjectId('temp-project-after-click', 902), true);
assert.equal(currentProjectId, 902, 'a receipt must repair a matching current filter even when the stale click could not set a project ID');
assert.equal(currentFilter, '902');
assert.equal(history.state.filter, '902');
assert.match(nodes['project-list'].innerHTML, /class="[^"]*active[^"]*"[^>]*data-entity-id="902"/);
await navigation.setFilter('pending');
assert.equal(navigation.remapProjectId('temp-project-unrelated', 901), false, 'receipts must not replace a newer aggregate selection');
assert.equal(currentProjectId, null);
assert.equal(currentFilter, 'pending');
stores.projects = stores.projects.filter(project => project.id !== 901);
const requestsBeforeRevokedAlias = sectionLoads;
await navigation.setFilter('temp-project-before-click');
assert.equal(currentFilter, 'all', 'a retained alias cannot restore a canonical project omitted from the current accessible catalog');
assert.equal(currentProjectId, null);
assert.equal(sectionLoads, requestsBeforeRevokedAlias, 'a revoked alias cannot trigger a direct-ID sections request');

const rejected = {
  projects: [{ id: 'temp-project-rejected' }, { id: 'temp-project-dependent', parent_id: 'temp-project-rejected' }, { id: 77 }],
  sections: [{ id: 'temp-section-rejected', project_id: 'temp-project-rejected' }],
  todos: [{ id: 'temp-rejected-todo', project_id: 'temp-project-rejected', section_id: 'temp-section-rejected' }, { id: 88, project_id: 77 }],
  syncQueue: [
    { id: 1, action: 'CREATE_PROJECT', data: { _tempId: 'temp-project-rejected', name: 'Rejected' } },
    { id: 2, action: 'CREATE_PROJECT', data: { _tempId: 'temp-project-dependent', parent_id: 'temp-project-rejected' } },
    { id: 3, action: 'CREATE_SECTION', data: { _tempId: 'temp-section-rejected', project_id: 'temp-project-rejected' } },
    { id: 4, action: 'CREATE_TODO', data: { _tempId: 'temp-rejected-todo', project_id: 'temp-project-rejected', section_id: 'temp-section-rejected' } },
  ], workspaces: [],
};
const rejectedDatabase = createDatabase(rejected);
let rejectedCallbacks = 0;
const rejectedRef = { value: false, privacyGeneration: 0 };
const rejectionOptions = {
  getDb: () => ({}), dbGetAll: async store => structuredClone(rejected[store]),
  getFromDB: async (store, id) => rejected[store].find(row => row.id === id),
  dbPut: async () => {}, dbClear: async () => {},
  deleteFromDB: async (store, id) => { rejected[store] = rejected[store].filter(row => row.id !== id); },
  getTodos: () => rejected.todos, setTodos: value => { rejected.todos = value; },
  getProjects: () => rejected.projects, setProjects: value => { rejected.projects = value; },
  getSections: () => rejected.sections, setSections: value => { rejected.sections = value; },
  getWorkspaces: () => [], setWorkspaces() {}, todosApi: {}, sectionsApi: {}, workspacesApi: {},
  projectsApi: { create: async () => { throw Object.assign(new Error('definitively rejected parent'), { status: 422 }); } },
  evictPendingProjectEntities: (ids, options) => evictPendingProjectEntities(ids, { ...options, database: rejectedDatabase }),
  onProjectIdRemap: () => { rejectedCallbacks++; }, renderStats() {}, renderTodos() {},
};
await createSyncFeature(rejectionOptions).syncWithServer({ wsState: 'connected', syncInProgressRef: rejectedRef });
assert.deepEqual(rejected.projects.map(row => row.id), [77], 'permanent parent rejection must remove its dependent local project subtree');
assert.deepEqual(rejected.todos.map(row => row.id), [88]);
assert.deepEqual(rejected.sections, []);
assert.deepEqual(rejected.syncQueue, [], 'permanent cleanup must not leave child payloads permanently waiting on an impossible parent');
assert.equal(rejectedCallbacks, 0);

let rejectStale;
let requestStarted;
const staleStarted = new Promise(resolve => { requestStarted = resolve; });
const staleRequest = new Promise((_resolve, reject) => { rejectStale = reject; });
rejected.projects = [{ id: 'temp-project-stale' }];
rejected.syncQueue = [{ id: 11, action: 'CREATE_PROJECT', data: { _tempId: 'temp-project-stale' } }];
const staleReplay = createSyncFeature({ ...rejectionOptions, projectsApi: { create: () => { requestStarted(); return staleRequest; } } })
  .syncWithServer({ wsState: 'connected', syncInProgressRef: rejectedRef });
await staleStarted;
rejectedRef.privacyGeneration++;
rejected.projects = [{ id: 77, name: 'New accessible projection' }];
rejected.syncQueue = [];
rejectStale(Object.assign(new Error('obsolete parent denial'), { status: 403 }));
await staleReplay;
assert.deepEqual(rejected.projects, [{ id: 77, name: 'New accessible projection' }], 'stale permanent errors must respect the same access-generation and queue-presence fences');
console.log('✅ Pending project navigation, rendered sections and canonical dependent replay passed');
