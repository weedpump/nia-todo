#!/usr/bin/env node
import assert from 'node:assert/strict';

console.log('☁️ Running dashboard preference account sync tests...');

const storageMap = new Map();
const storage = {
  getItem: key => storageMap.get(key) ?? null,
  setItem: (key, value) => storageMap.set(key, String(value)),
  removeItem: key => storageMap.delete(key),
};
const localPreferences = new Map([
  ['10', { version: 3, compactDisplay: true }],
  ['20', { version: 3, compactDisplay: false }],
]);
const writes = [];
let online = true;
let remote = { enabled: false, preferences: {} };
const api = {
  async getDashboardPreferences() { return remote; },
  async updateDashboardPreferences(payload) {
    writes.push(payload);
    if (!online) throw new Error('offline');
    remote = payload.enabled
      ? { enabled: true, preferences: { ...remote.preferences, ...(payload.preferences || {}) } }
      : { enabled: false, preferences: {} };
    return remote;
  },
};

const { createDashboardPreferencesSync } = await import('../web/static/js/features/dashboard-preferences-sync.js');
const applied = [];
let renders = 0;
const sync = createDashboardPreferencesSync({
  api,
  storage,
  getUserId: () => 1,
  getWorkspaces: () => [{ id: 10 }, { id: 20 }],
  getPreferences: workspaceId => localPreferences.get(String(workspaceId)),
  setPreferences: (workspaceId, preferences) => {
    localPreferences.set(String(workspaceId), preferences);
    applied.push([String(workspaceId), preferences]);
  },
  renderDashboard: () => { renders += 1; },
});

await sync.initialize();
assert.equal(sync.isEnabled(), false, 'sync must default to disabled');

await sync.setEnabled(true);
assert.equal(sync.isEnabled(), true, 'enabling must update local state');
assert.deepEqual(Object.keys(writes.at(-1).preferences).sort(), ['10', '20'], 'first activation must upload every workspace preference');

online = false;
await sync.saveWorkspace(10, { version: 3, compactDisplay: false });
assert.ok(storage.getItem('nia-dashboard-preferences-sync-pending:user:1'), 'offline saves must remain queued');

online = true;
await sync.flushPending();
assert.equal(storage.getItem('nia-dashboard-preferences-sync-pending:user:1'), null, 'successful reconnect must clear the pending write');
assert.equal(remote.preferences['10'].compactDisplay, false, 'pending local changes must reach the server');

sync.applyRemote({
  enabled: true,
  preferences: { '20': { version: 3, compactDisplay: true, groupByStatus: false } },
});
assert.equal(localPreferences.get('20').groupByStatus, false, 'realtime server updates must replace the local workspace cache');
assert.ok(renders > 0, 'remote updates must rerender the dashboard');

await sync.setEnabled(false);
assert.equal(sync.isEnabled(), false, 'disabling must update local state');
assert.deepEqual(writes.at(-1), { enabled: false }, 'disabling must delete the server copy without uploading preferences');
assert.equal(localPreferences.get('10').compactDisplay, false, 'disabling must retain local preferences');

console.log('✅ Dashboard preference account sync tests passed');
