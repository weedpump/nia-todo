#!/usr/bin/env node
import assert from 'node:assert/strict';

const createdStores = [];
let openedVersion = null;
let closed = false;
let deleted = false;
let openRequest = null;
let upgradeInProgress = false;
const avatarRecords = new Map();

const database = {
  objectStoreNames: { contains(name) { return createdStores.includes(name); } },
  createObjectStore(name, options) {
    createdStores.push(name);
    return { name, options };
  },
  close() { closed = true; },
  transaction(storeName) {
    if (upgradeInProgress) throw new DOMException('Upgrade transaction active', 'InvalidStateError');
    assert.equal(storeName, 'avatars');
    const tx = {};
    tx.objectStore = () => ({
      put(record) { avatarRecords.set(record.id, record); },
      get(id) {
        const request = {};
        queueMicrotask(() => {
          request.result = avatarRecords.get(id) || null;
          request.onsuccess?.();
        });
        return request;
      },
      delete(id) { avatarRecords.delete(id); },
    });
    queueMicrotask(() => tx.oncomplete?.());
    return tx;
  },
};

globalThis.indexedDB = {
  open(_name, version) {
    openedVersion = version;
    openRequest = {};
    return openRequest;
  },
  deleteDatabase() {
    const request = {};
    queueMicrotask(() => {
      avatarRecords.clear();
      deleted = true;
      request.onsuccess?.();
    });
    return request;
  },
};

globalThis.window = {};
globalThis.isTauri = false;
globalThis.location = { origin: 'https://todo.example', search: '' };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'Mozilla/5.0', platform: 'Linux', maxTouchPoints: 0 },
});

const { DB_VERSION } = await import('../web/static/js/core/config.js');
const {
  openDatabase,
  closeAndDeleteDatabase,
  getAvatarWhenReady,
  putAvatarWhenReady,
} = await import('../web/static/js/storage/indexed-db.js');
const { loadAuthenticatedImage, releaseAuthenticatedImage } = await import('../web/static/js/core/authenticated-image.js');

const storage = new Map([['jwt_token', 'header.payload.signature']]);
globalThis.localStorage = { getItem(key) { return storage.get(key) ?? null; } };
globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob(['early-avatar']) });
const originalCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = () => 'blob:early-avatar';

const earlyImage = {};
const earlyLoad = loadAuthenticatedImage(
  earlyImage,
  'https://todo.example/api/avatars/user-7.webp?v=early',
  { userId: 7, version: 'early' },
);
assert.equal(await earlyLoad, true, 'network response renders before IndexedDB opens');
assert.equal(avatarRecords.size, 0, 'persistence waits while IndexedDB is unavailable');

const offlineId = 'https://todo.example|9';
avatarRecords.set(offlineId, { id: offlineId, version: 'offline', blob: new Blob(['offline-avatar']) });
globalThis.fetch = async () => { throw new TypeError('offline'); };
const offlineImage = {};
let offlineSettled = false;
const offlineLoad = loadAuthenticatedImage(
  offlineImage,
  'https://todo.example/api/avatars/user-9.webp?v=offline',
  { userId: 9, version: 'offline' },
).finally(() => { offlineSettled = true; });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(offlineSettled, false, 'offline cache read remains pending until IndexedDB is ready');

const opening = openDatabase();
upgradeInProgress = true;
openRequest.onupgradeneeded?.({ target: { result: database } });
globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob(['upgrade-avatar']) });
const duringUpgradeImage = {};
const duringUpgradeLoad = loadAuthenticatedImage(
  duringUpgradeImage,
  'https://todo.example/api/avatars/user-8.webp?v=during-upgrade',
  { userId: 8, version: 'during-upgrade' },
);
assert.equal(await duringUpgradeLoad, true, 'network response renders while the database upgrade is still active');
assert.equal(avatarRecords.size, 1, 'avatar persistence waits for upgrade completion');
upgradeInProgress = false;
openRequest.onsuccess?.({ target: { result: database } });
await opening;
assert.equal(await offlineLoad, true, 'offline avatar renders after IndexedDB becomes ready without a lifecycle rerender');
assert.equal(DB_VERSION, 7, 'stable shopping stores require the next database schema version');
assert.equal(openedVersion, DB_VERSION);
assert.ok(createdStores.includes('avatars'), 'migration preserves the avatars object store');
assert.ok(createdStores.includes('shoppingStores'), 'migration creates the stable shopping-store object store');
assert.ok(createdStores.includes('shoppingLists'), 'migration creates the shopping-lists object store');
assert.equal(avatarRecords.size, 3, 'avatars fetched before DB readiness persist after open');

await closeAndDeleteDatabase();
assert.equal(closed, true, 'logout closes the database before deletion');
assert.equal(deleted, true, 'logout/user switch deletion naturally removes the avatar store');

const staleId = 'https://todo.example|stale-user';
await putAvatarWhenReady({ id: staleId, version: 'stale', blob: new Blob(['stale-avatar']) });
const staleRead = getAvatarWhenReady(staleId);
await closeAndDeleteDatabase();
assert.equal(await staleRead, null, 'deletion settles queued private avatar reads safely');

const reopening = openDatabase();
openRequest.onsuccess?.({ target: { result: database } });
await reopening;
assert.equal(avatarRecords.has(staleId), false, 'avatar writes queued before deletion never enter a reopened database');

const lifecycleRaceId = 'https://todo.example|lifecycle-user';
let resolveLifecycleFetch;
globalThis.fetch = async () => new Promise((resolve) => {
  resolveLifecycleFetch = resolve;
});
const lifecycleImage = {};
const lifecycleLoad = loadAuthenticatedImage(
  lifecycleImage,
  'https://todo.example/api/avatars/lifecycle-user.webp?v=lifecycle',
  { userId: 'lifecycle-user', version: 'lifecycle' },
);
await new Promise(resolve => setTimeout(resolve, 0));
await closeAndDeleteDatabase();
resolveLifecycleFetch({ ok: true, blob: async () => new Blob(['lifecycle-avatar']) });
assert.equal(await lifecycleLoad, true, 'the current image can still render after its fetch outlives database deletion');
assert.equal(lifecycleImage.src, 'blob:early-avatar');

const reopenedAfterFetch = openDatabase();
openRequest.onsuccess?.({ target: { result: database } });
await reopenedAfterFetch;
assert.equal(avatarRecords.has(lifecycleRaceId), false, 'a fetch started in the deleted database lifecycle never persists into the reopened database');

await closeAndDeleteDatabase();
const unavailableRaceId = 'https://todo.example|unavailable-user';
let resolveUnavailableFetch;
globalThis.fetch = async () => new Promise((resolve) => {
  resolveUnavailableFetch = resolve;
});
const unavailableImage = {};
const unavailableLoad = loadAuthenticatedImage(
  unavailableImage,
  'https://todo.example/api/avatars/unavailable-user.webp?v=unavailable',
  { userId: 'unavailable-user', version: 'unavailable' },
);
await new Promise(resolve => setTimeout(resolve, 0));
await closeAndDeleteDatabase();
releaseAuthenticatedImage(unavailableImage);
resolveUnavailableFetch({ ok: true, blob: async () => new Blob(['unavailable-avatar']) });
assert.equal(await unavailableLoad, false, 'a detached image does not render after its database lifecycle is deleted');
assert.equal(unavailableImage.src, undefined);

const reopenedAfterUnavailableFetch = openDatabase();
openRequest.onsuccess?.({ target: { result: database } });
await reopenedAfterUnavailableFetch;
assert.equal(avatarRecords.has(unavailableRaceId), false, 'a fetch begun before database readiness cannot persist after lifecycle deletion');

URL.createObjectURL = originalCreateObjectURL;

console.log('✅ IndexedDB migrates and deletes the avatar store');
