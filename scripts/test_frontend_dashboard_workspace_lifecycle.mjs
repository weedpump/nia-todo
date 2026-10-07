#!/usr/bin/env node
import assert from 'node:assert/strict';

console.log('🧭 Running dashboard workspace lifecycle regression test...');

const storage = new Map([
  ['nia-current-workspace', '999'],
  ['nia-dashboard-preferences-v3', JSON.stringify({ compactDisplay: true })],
]);
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key),
};
globalThis.window = {
  location: { search: '' },
  history: { state: null },
};
globalThis.document = {
  getElementById: () => null,
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { language: 'en', languages: ['en'] },
});

const { loadDashboardPreferences } = await import('../web/static/js/features/dashboard-preferences.js');
const { createAppLifecycle } = await import('../web/static/js/features/app-lifecycle.js');

let workspaces = [];
let currentWorkspaceId = null;
const workspaceAssignments = [];
const lifecycle = createAppLifecycle({
  authApi: {},
  initTheme() {},
  checkAuth: async () => false,
  hideLoginOverlay() {},
  showLoginOverlay() {},
  renderUserInfo() {},
  initServiceWorker: async () => {},
  openDB: async () => {},
  dbGetAll: async store => store === 'workspaces' ? [{ id: 1, is_default: true }] : [],
  setTodos() {},
  setProjects() {},
  setSections() {},
  setWorkspaces: next => { workspaces = next; },
  setCurrentFilter() {},
  setCurrentProjectId() {},
  setCurrentWorkspaceId: next => {
    currentWorkspaceId = next;
    workspaceAssignments.push(next);
    loadDashboardPreferences(localStorage, next);
  },
  ensureCurrentWorkspace: () => {
    const currentIsValid = workspaces.some(workspace => String(workspace.id) === String(currentWorkspaceId));
    if (!currentIsValid) {
      currentWorkspaceId = workspaces[0]?.id ?? null;
      workspaceAssignments.push(currentWorkspaceId);
      loadDashboardPreferences(localStorage, currentWorkspaceId);
    }
  },
  setAppInitialized() {},
  connectWebSocket() {},
  getWsState: () => 'disconnected',
  isAuthenticated: () => false,
  isOnlineForSync: () => false,
  syncWithServer: async () => {},
  refreshFromServer: async () => {},
  updateConnectionStatus() {},
  renderVersionInfo() {},
  renderProjects() {},
  renderStats() {},
  renderTodos() {},
  renderWorkspaces() {},
  updateToggleDoneButton() {},
  updateSortButton() {},
});

await lifecycle.loadFromLocalDB();

assert.deepEqual(workspaceAssignments, [1], 'startup must validate the saved workspace before dashboard preferences can migrate');
assert.equal(storage.has('nia-dashboard-preferences-v3:workspace:999'), false, 'an invalid saved workspace must never consume global dashboard migration state');
assert.equal(storage.has('nia-dashboard-preferences-v3:workspace:1'), true, 'the first valid concrete workspace must consume global dashboard migration state');
assert.equal(storage.has('nia-dashboard-preferences-v3'), false, 'global dashboard preferences must be removed after valid migration');

console.log('✅ Dashboard workspace lifecycle regression test passed');
