#!/usr/bin/env node
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.window = {};
globalThis.isTauri = true;
globalThis.location = { origin: 'http://tauri.localhost', search: '' };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux', maxTouchPoints: 0 },
});
globalThis.localStorage = {
  getItem(key) { return storage.get(key) ?? null; },
};

const requests = [];
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, options });
  return { ok: true, blob: async () => new Blob(['avatar']) };
};
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
URL.createObjectURL = () => 'blob:native-avatar';
URL.revokeObjectURL = () => {};

try {
  const { loadAuthenticatedImage } = await import('../web/static/js/core/authenticated-image.js');
  storage.set('auth_token', 'opaque-session-token');
  const image = {};

  assert.equal(
    await loadAuthenticatedImage(image, 'https://todo.example/api/avatars/user-1.webp'),
    true,
    'authenticated images must load with persisted opaque sessions',
  );
  assert.equal(requests.length, 1, 'authenticated image loading must issue one request');
  assert.equal(requests[0].options.headers['X-Session-Token'], 'opaque-session-token');
  assert.match(requests[0].options.headers['X-Nia-Client'], /app=nia-todo;mode=native;platform=linux;version=v/);
  assert.equal(requests[0].options.credentials, 'include');
  assert.equal(image.src, 'blob:native-avatar');

  storage.clear();
  requests.length = 0;
  storage.set('jwt_token', 'header.payload.signature');
  const jwtImage = {};

  assert.equal(
    await loadAuthenticatedImage(jwtImage, 'https://todo.example/api/avatars/user-1.webp'),
    true,
    'authenticated images must continue to load with JWT sessions',
  );
  assert.equal(requests[0].options.headers.Authorization, 'Bearer header.payload.signature');

  globalThis.fetch = async () => { throw new TypeError('network unavailable'); };
  const offlineImage = {};
  assert.equal(
    await loadAuthenticatedImage(offlineImage, 'https://todo.example/api/avatars/user-1.webp'),
    false,
    'authenticated image loading must fail closed when the network request rejects',
  );
  assert.equal(offlineImage.src, undefined);

  console.log('✅ Authenticated image loading uses shared session headers');
} finally {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
}
