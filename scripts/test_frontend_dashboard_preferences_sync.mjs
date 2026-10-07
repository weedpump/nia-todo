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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const raceStorageMap = new Map([['nia-dashboard-preferences-sync-enabled:user:1', 'true']]);
const raceStorage = {
  getItem: key => raceStorageMap.get(key) ?? null,
  setItem: (key, value) => raceStorageMap.set(key, String(value)),
  removeItem: key => raceStorageMap.delete(key),
};
const firstWrite = deferred();
const raceWrites = [];
let raceCall = 0;
const raceSync = createDashboardPreferencesSync({
  api: {
    async getDashboardPreferences() { return { enabled: true, preferences: {} }; },
    async updateDashboardPreferences(payload) {
      raceWrites.push(payload);
      raceCall += 1;
      if (raceCall === 1) return firstWrite.promise;
      if (raceCall === 2) throw new Error('offline after the first write');
      return payload.enabled ? { enabled: true, preferences: payload.preferences || {} } : { enabled: false, preferences: {} };
    },
  },
  storage: raceStorage,
  getUserId: () => 1,
  getWorkspaces: () => [{ id: 10 }, { id: 20 }],
  getPreferences: workspaceId => ({ version: 3, workspaceId }),
  setPreferences() {},
});
await raceSync.initialize();
const saveA = raceSync.saveWorkspace(10, { version: 3, marker: 'A' });
await Promise.resolve();
const saveB = raceSync.saveWorkspace(20, { version: 3, marker: 'B' });
firstWrite.resolve({ enabled: true, preferences: { '10': { version: 3, marker: 'A' } } });
await Promise.all([saveA, saveB]);
const queuedAfterRace = JSON.parse(raceStorage.getItem('nia-dashboard-preferences-sync-pending:user:1'));
assert.equal(queuedAfterRace.preferences['20'].marker, 'B', 'a failed later write must remain queued after an earlier request succeeds');

const staleStorageMap = new Map([['nia-dashboard-preferences-sync-enabled:user:1', 'true']]);
const staleStorage = {
  getItem: key => staleStorageMap.get(key) ?? null,
  setItem: (key, value) => staleStorageMap.set(key, String(value)),
  removeItem: key => staleStorageMap.delete(key),
};
const staleSave = deferred();
const staleWrites = [];
const staleSync = createDashboardPreferencesSync({
  api: {
    async getDashboardPreferences() { return { enabled: true, preferences: {} }; },
    async updateDashboardPreferences(payload) {
      staleWrites.push(payload);
      if (staleWrites.length === 1) return staleSave.promise;
      return payload.enabled ? { enabled: true, preferences: payload.preferences || {} } : { enabled: false, preferences: {} };
    },
  },
  storage: staleStorage,
  getUserId: () => 1,
  getWorkspaces: () => [{ id: 10 }],
  getPreferences: () => ({ version: 3 }),
  setPreferences() {},
});
await staleSync.initialize();
const delayedSave = staleSync.saveWorkspace(10, { version: 3, marker: 'late-save' });
await Promise.resolve();
const disable = staleSync.setEnabled(false);
staleSave.resolve({ enabled: true, preferences: { '10': { version: 3, marker: 'late-save' } } });
await Promise.all([delayedSave, disable]);
assert.equal(staleSync.isEnabled(), false, 'an older save response must not reactivate sync after disable');
assert.deepEqual(staleWrites.at(-1), { enabled: false }, 'disable must be the final serialized write');

let reconnectOnline = false;
const reconnectSync = createDashboardPreferencesSync({
  api: {
    async getDashboardPreferences() {
      if (!reconnectOnline) throw new Error('offline');
      return { enabled: true, preferences: { '10': { version: 3, marker: 'server' } } };
    },
    async updateDashboardPreferences(payload) { return payload; },
  },
  storage: { getItem: () => null, setItem() {}, removeItem() {} },
  getUserId: () => 1,
  getWorkspaces: () => [{ id: 10 }],
  getPreferences: () => ({ version: 3 }),
  setPreferences() {},
});
await reconnectSync.initialize();
assert.equal(reconnectSync.isEnabled(), false, 'offline startup must retain the local fallback state');
reconnectOnline = true;
await reconnectSync.refresh();
assert.equal(reconnectSync.isEnabled(), true, 'reconnect must reload the authoritative server state');

const disableStorageMap = new Map([['nia-dashboard-preferences-sync-enabled:user:1', 'true']]);
const disableStorage = {
  getItem: key => disableStorageMap.get(key) ?? null,
  setItem: (key, value) => disableStorageMap.set(key, String(value)),
  removeItem: key => disableStorageMap.delete(key),
};
let disableOnline = true;
const disableSync = createDashboardPreferencesSync({
  api: {
    async getDashboardPreferences() { return { enabled: true, preferences: {} }; },
    async updateDashboardPreferences(payload) {
      if (!disableOnline) throw new Error('offline');
      return payload;
    },
  },
  storage: disableStorage,
  getUserId: () => 1,
  getWorkspaces: () => [{ id: 10 }],
  getPreferences: () => ({ version: 3 }),
  setPreferences() {},
});
await disableSync.initialize();
disableOnline = false;
await disableSync.setEnabled(false);
disableSync.applyRemote({ enabled: true, preferences: { '10': { version: 3, marker: 'stale-websocket' } } });
assert.equal(disableSync.isEnabled(), false, 'a pending local disable must outrank stale realtime updates');
assert.deepEqual(
  JSON.parse(disableStorage.getItem('nia-dashboard-preferences-sync-pending:user:1')),
  { enabled: false },
  'a stale realtime update must not replace the pending disable intent',
);
await disableSync.saveWorkspace(10, { version: 3, marker: 'must-not-reactivate' });
assert.deepEqual(
  JSON.parse(disableStorage.getItem('nia-dashboard-preferences-sync-pending:user:1')),
  { enabled: false },
  'dashboard saves after a stale realtime event must not reactivate sync',
);

const terminalStorageMap = new Map([
  ['nia-dashboard-preferences-sync-enabled:user:1', 'true'],
  ['nia-dashboard-preferences-sync-pending:user:1', JSON.stringify({ enabled: true, preferences: { '99': { version: 3 } } })],
]);
const terminalStorage = {
  getItem: key => terminalStorageMap.get(key) ?? null,
  setItem: (key, value) => terminalStorageMap.set(key, String(value)),
  removeItem: key => terminalStorageMap.delete(key),
};
let terminalGets = 0;
const terminalSync = createDashboardPreferencesSync({
  api: {
    async getDashboardPreferences() {
      terminalGets += 1;
      return { enabled: true, preferences: { '10': { version: 3, marker: 'authoritative' } } };
    },
    async updateDashboardPreferences() {
      const error = new Error('workspace no longer exists');
      error.status = 404;
      throw error;
    },
  },
  storage: terminalStorage,
  getUserId: () => 1,
  getWorkspaces: () => [{ id: 10 }],
  getPreferences: () => ({ version: 3 }),
  setPreferences() {},
});
await terminalSync.initialize();
assert.equal(terminalStorage.getItem('nia-dashboard-preferences-sync-pending:user:1'), null, 'terminal validation failures must discard the unrecoverable pending payload');
assert.equal(terminalGets, 1, 'terminal validation failures must continue with an authoritative server reload');
assert.equal(terminalSync.isEnabled(), true, 'the authoritative server state must remain usable after dropping an invalid payload');

const staleGetStorageMap = new Map([['nia-dashboard-preferences-sync-enabled:user:1', 'true']]);
const staleGetStorage = {
  getItem: key => staleGetStorageMap.get(key) ?? null,
  setItem: (key, value) => staleGetStorageMap.set(key, String(value)),
  removeItem: key => staleGetStorageMap.delete(key),
};
const staleGet = deferred();
let staleGetCalls = 0;
const staleGetWrites = [];
const staleGetSync = createDashboardPreferencesSync({
  api: {
    async getDashboardPreferences() {
      staleGetCalls += 1;
      if (staleGetCalls === 1) return { enabled: true, preferences: {} };
      return staleGet.promise;
    },
    async updateDashboardPreferences(payload) {
      staleGetWrites.push(payload);
      return payload.enabled ? { enabled: true, preferences: payload.preferences || {} } : { enabled: false, preferences: {} };
    },
  },
  storage: staleGetStorage,
  getUserId: () => 1,
  getWorkspaces: () => [{ id: 10 }],
  getPreferences: () => ({ version: 3, compactDisplay: true }),
  setPreferences() {},
});
await staleGetSync.initialize();
const oldRefresh = staleGetSync.refresh();
while (staleGetCalls < 2) await Promise.resolve();
await staleGetSync.setEnabled(false);
staleGet.resolve({ enabled: true, preferences: { '10': { version: 3, marker: 'stale-get' } } });
await oldRefresh;
assert.equal(staleGetSync.isEnabled(), false, 'a GET started before a newer disable intent must not reactivate sync');
assert.equal(staleGetStorage.getItem('nia-dashboard-preferences-sync-enabled:user:1'), null, 'a stale GET must not restore the local enabled key');
await staleGetSync.saveWorkspace(10, { version: 3, marker: 'must-stay-disabled' });
assert.deepEqual(staleGetWrites, [{ enabled: false }], 'a stale GET must not cause later dashboard saves to reactivate the server copy');

console.log('✅ Dashboard preference account sync tests passed');
