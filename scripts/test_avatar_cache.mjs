#!/usr/bin/env node
import assert from 'node:assert/strict';

const storage = new Map([['jwt_token', 'header.payload.signature']]);
globalThis.window = {};
globalThis.isTauri = true;
globalThis.location = { origin: 'http://tauri.localhost', search: '' };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'Mozilla/5.0 (Linux; Android 15)', platform: 'Linux', maxTouchPoints: 5 },
});
globalThis.localStorage = { getItem(key) { return storage.get(key) ?? null; } };

const records = new Map();
const cache = {
  async get(key) { return records.get(key) || null; },
  async put(record) { records.set(record.id, record); },
  async remove(key) { records.delete(key); },
};

const requests = [];
let networkBlob = new Blob(['avatar-v1'], { type: 'image/webp' });
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, options });
  return { ok: true, blob: async () => networkBlob };
};

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
let objectUrlSequence = 0;
const revoked = [];
URL.createObjectURL = () => `blob:avatar-${++objectUrlSequence}`;
URL.revokeObjectURL = url => revoked.push(url);

try {
  const {
    loadAuthenticatedImage,
    releaseAuthenticatedImage,
    removeCachedAvatar,
  } = await import('../web/static/js/core/authenticated-image.js');
  const identity = { userId: 7, version: '2026-10-17T10:00:00Z', cache };
  const url = 'https://todo.example/api/avatars/user-7.webp?v=2026-10-17T10%3A00%3A00Z';

  const first = {};
  assert.equal(await loadAuthenticatedImage(first, url, identity), true);
  assert.equal(requests.length, 1, 'first render fetches the avatar');
  assert.equal(records.size, 1, 'first render persists the avatar blob');
  assert.equal(first.src, 'blob:avatar-1');

  globalThis.fetch = async () => { throw new TypeError('offline'); };
  const afterRestart = {};
  assert.equal(await loadAuthenticatedImage(afterRestart, url, identity), true, 'matching IndexedDB data renders after an offline restart');
  assert.equal(afterRestart.src, 'blob:avatar-2');
  assert.equal(requests.length, 1, 'matching versions never refetch during navigation');

  networkBlob = new Blob(['avatar-v2'], { type: 'image/webp' });
  globalThis.fetch = async (requestUrl, options = {}) => {
    requests.push({ url: requestUrl, options });
    await new Promise(resolve => setTimeout(resolve, 5));
    return { ok: true, blob: async () => networkBlob };
  };
  const changedIdentity = { ...identity, version: '2026-10-17T11:00:00Z' };
  const changedUrl = 'https://todo.example/api/avatars/user-7.webp?v=2026-10-17T11%3A00%3A00Z';
  const changedA = {};
  const changedB = {};
  assert.deepEqual(
    await Promise.all([
      loadAuthenticatedImage(changedA, changedUrl, changedIdentity),
      loadAuthenticatedImage(changedB, changedUrl, changedIdentity),
    ]),
    [true, true],
  );
  assert.equal(requests.length, 2, 'a changed version is fetched once even for concurrent consumers');
  assert.equal(records.values().next().value.version, changedIdentity.version);

  releaseAuthenticatedImage(changedA);
  assert.ok(revoked.includes(changedA.src), 'released consumers revoke their object URL');

  await removeCachedAvatar(changedUrl, { userId: 7, cache });
  assert.equal(records.size, 0, 'deletion removes the persisted avatar');

  const deferredResponses = new Map();
  globalThis.fetch = async (requestUrl) => new Promise((resolve) => {
    deferredResponses.set(requestUrl, resolve);
  });
  const raceRecords = new Map();
  const raceCache = {
    async get(key) { return raceRecords.get(key) || null; },
    async put(record) { raceRecords.set(record.id, record); },
    async remove(key) { raceRecords.delete(key); },
  };
  const oldUrl = 'https://todo.example/api/avatars/user-8.webp?v=old';
  const newUrl = 'https://todo.example/api/avatars/user-8.webp?v=new';
  const oldImage = {};
  const newImage = {};
  const oldLoad = loadAuthenticatedImage(oldImage, oldUrl, { userId: 8, version: 'old', cache: raceCache });
  await new Promise(resolve => setTimeout(resolve, 0));
  const newLoad = loadAuthenticatedImage(newImage, newUrl, { userId: 8, version: 'new', cache: raceCache });
  await new Promise(resolve => setTimeout(resolve, 0));
  deferredResponses.get(newUrl)({ ok: true, blob: async () => new Blob(['new-avatar']) });
  assert.equal(await newLoad, true);
  deferredResponses.get(oldUrl)({ ok: true, blob: async () => new Blob(['old-avatar']) });
  assert.equal(await oldLoad, false, 'an obsolete version cannot commit after the newer request');
  assert.equal(raceRecords.values().next().value.version, 'new', 'newer avatar remains persisted');

  const deleteUrl = 'https://todo.example/api/avatars/user-9.webp?v=pending';
  const deleteImage = {};
  const pendingLoad = loadAuthenticatedImage(deleteImage, deleteUrl, { userId: 9, version: 'pending', cache: raceCache });
  await new Promise(resolve => setTimeout(resolve, 0));
  await removeCachedAvatar(deleteUrl, { userId: 9, cache: raceCache });
  deferredResponses.get(deleteUrl)({ ok: true, blob: async () => new Blob(['deleted-avatar']) });
  assert.equal(await pendingLoad, false, 'delete invalidates an earlier pending request');
  assert.equal([...raceRecords.values()].some(record => record.id.endsWith('|9')), false, 'delete leaves no cached private blob');
  assert.equal(deleteImage.src, undefined, 'delete prevents the pending private blob from rendering');

  console.log('✅ Avatar blobs persist offline and reject stale fetch/delete races');
} finally {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
}
