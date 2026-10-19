#!/usr/bin/env node
import assert from 'node:assert/strict';

const values = new Map([
  ['jwt_token', 'old-token'],
  ['csrf_token', 'old-csrf'],
  ['last_user_id', '1'],
  ['cached_user', JSON.stringify({ id: 1, username: 'old-user', display_name: 'Old User' })],
]);
globalThis.localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key),
};
globalThis.sessionStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};
globalThis.location = { origin: 'https://todo.example', search: '', pathname: '/', hash: '', reload() {} };
globalThis.history = { replaceState() {} };
globalThis.window = {
  PublicKeyCredential: null,
};
globalThis.caches = {
  keys: async () => [],
  delete: async () => true,
};
globalThis.document = { getElementById: () => null, querySelector: () => null };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'Mozilla/5.0', platform: 'Linux', maxTouchPoints: 0 },
});

const { createAuthSessionFeature } = await import('../web/static/js/features/auth-session.js');

let currentUser = { id: 1, username: 'old-user', token: 'old-token' };
let clearAttempts = 0;
const feature = createAuthSessionFeature({
  authApi: {
    login: async () => ({
      access_token: 'new-token',
      csrf_token: 'new-csrf',
      user: { id: 2, username: 'new-user', display_name: 'New User' },
      mfa_enrollment_required: false,
    }),
  },
  getAppInitialized: () => true,
  setCurrentUser: user => { currentUser = user; },
  clearCache: async () => { clearAttempts += 1; throw new Error('IndexedDB cleanup failed'); },
  initApp: async () => {},
  refreshFromServer: async () => {},
  renderUserInfo: () => {},
});

await assert.rejects(feature.login('new-user', 'password'), /IndexedDB cleanup failed/);
assert.equal(clearAttempts, 1, 'cross-user login must attempt strict local cleanup before activation');
assert.equal(localStorage.getItem('jwt_token'), 'old-token', 'cleanup failure must not activate the new JWT');
assert.equal(localStorage.getItem('csrf_token'), 'old-csrf', 'cleanup failure must not mix the new CSRF token into the old session');
assert.equal(localStorage.getItem('last_user_id'), '1');
assert.deepEqual(JSON.parse(localStorage.getItem('cached_user')), { id: 1, username: 'old-user', display_name: 'Old User' });
assert.equal(currentUser.id, 1, 'cleanup failure must not activate the new currentUser');
assert.equal(currentUser.token, 'old-token');

values.set('jwt_token', 'old-token');
values.set('csrf_token', 'old-csrf');
values.set('last_user_id', '1');
values.set('cached_user', JSON.stringify({ id: 1, username: 'old-user', display_name: 'Old User' }));
currentUser = { id: 1, username: 'old-user', token: 'old-token' };
await assert.rejects(feature.logout(), /IndexedDB cleanup failed/);
assert.equal(localStorage.getItem('jwt_token'), 'old-token', 'failed logout cleanup must retain the active token');
assert.equal(localStorage.getItem('last_user_id'), '1', 'failed logout cleanup must retain the old identity marker');
assert.equal(currentUser.id, 1, 'failed logout cleanup must retain the active in-memory identity');
await assert.rejects(feature.login('new-user', 'password'), /IndexedDB cleanup failed/, 'a later login must still detect and block the cross-user cleanup boundary');
assert.equal(localStorage.getItem('jwt_token'), 'old-token');
assert.equal(localStorage.getItem('last_user_id'), '1');
assert.equal(currentUser.id, 1);

console.log('✅ Cross-user login fails closed before activating the new identity');
