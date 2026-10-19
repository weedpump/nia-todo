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
let reminderClearAttempts = 0;
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
  clearNativeReminders: async () => { reminderClearAttempts += 1; },
  initApp: async () => {},
  refreshFromServer: async () => {},
  renderUserInfo: () => {},
});

await assert.rejects(feature.login('new-user', 'password'), /IndexedDB cleanup failed/);
assert.equal(clearAttempts, 1, 'cross-user login must attempt strict local cleanup before activation');
assert.equal(reminderClearAttempts, 1, 'cross-user login must clear native reminders before activating the new identity');
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
assert.equal(reminderClearAttempts, 2, 'logout must clear native reminders before removing the identity boundary');
assert.equal(localStorage.getItem('jwt_token'), 'old-token', 'failed logout cleanup must retain the active token');
assert.equal(localStorage.getItem('last_user_id'), '1', 'failed logout cleanup must retain the old identity marker');
assert.equal(currentUser.id, 1, 'failed logout cleanup must retain the active in-memory identity');
await assert.rejects(feature.login('new-user', 'password'), /IndexedDB cleanup failed/, 'a later login must still detect and block the cross-user cleanup boundary');
assert.equal(localStorage.getItem('jwt_token'), 'old-token');
assert.equal(localStorage.getItem('last_user_id'), '1');
assert.equal(currentUser.id, 1);

let failClosedUser = { id: 1, username: 'old-user', token: 'old-token' };
let failClosedCacheClears = 0;
const reminderFailureFeature = createAuthSessionFeature({
  authApi: { login: async () => ({ access_token: 'new-token', user: { id: 2, username: 'new-user' } }) },
  getAppInitialized: () => true,
  setCurrentUser: user => { failClosedUser = user; },
  clearCache: async () => { failClosedCacheClears += 1; },
  clearNativeReminders: async () => { throw new Error('native reminder cleanup failed'); },
  initApp: async () => {}, refreshFromServer: async () => {}, renderUserInfo: () => {},
});
await assert.rejects(reminderFailureFeature.login('new-user', 'password'), /native reminder cleanup failed/);
assert.equal(failClosedCacheClears, 0, 'native reminder cleanup failure must stop before deleting old local data');
assert.equal(localStorage.getItem('jwt_token'), 'old-token');
assert.equal(failClosedUser.id, 1);

values.set('jwt_token', 'old-token');
values.set('csrf_token', 'old-csrf');
values.set('last_user_id', '1');
let resolveRuntimeDrain;
const runtimeDrain = new Promise(resolve => { resolveRuntimeDrain = resolve; });
const boundaryEvents = [];
const drainedFeature = createAuthSessionFeature({
  authApi: { login: async () => ({ access_token: 'new-token', user: { id: 2, username: 'new-user' } }) },
  getAppInitialized: () => true,
  setCurrentUser: () => { boundaryEvents.push('activate:new-user'); },
  disconnectRealtime: async () => { boundaryEvents.push('drain:start'); await runtimeDrain; boundaryEvents.push('drain:done'); },
  resumeRealtime: async () => { boundaryEvents.push('resume:runtime'); },
  clearNativeReminders: async () => { boundaryEvents.push('clear:reminders'); },
  resumeNativeReminders: () => { boundaryEvents.push('resume:reminders'); },
  clearCache: async () => { boundaryEvents.push('clear:indexeddb'); },
  initApp: async () => {}, refreshFromServer: async () => {}, renderUserInfo: () => {},
});
const drainedLogin = drainedFeature.login('new-user', 'password');
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(boundaryEvents, ['drain:start'], 'cross-user cleanup must drain the old authenticated runtime before deleting old data');
resolveRuntimeDrain();
await drainedLogin;
assert.deepEqual(boundaryEvents, ['drain:start', 'drain:done', 'clear:reminders', 'clear:indexeddb', 'activate:new-user', 'resume:reminders', 'resume:runtime']);

values.set('last_user_id', '1');
const sameUserEvents = [];
const sameUserFeature = createAuthSessionFeature({
  authApi: { login: async () => ({ access_token: 'same-token', user: { id: 1, username: 'old-user' } }) },
  getAppInitialized: () => true,
  setCurrentUser: () => { sameUserEvents.push('activate'); },
  resumeNativeReminders: () => { sameUserEvents.push('resume:reminders'); },
  resumeRealtime: async () => { sameUserEvents.push('resume:runtime'); },
  clearNativeReminders: async () => { sameUserEvents.push('unexpected:clear'); },
  clearCache: async () => { sameUserEvents.push('unexpected:cache-clear'); },
  initApp: async () => {}, refreshFromServer: async () => {}, renderUserInfo: () => {},
});
await sameUserFeature.login('old-user', 'password');
assert.deepEqual(sameUserEvents, ['activate', 'resume:reminders', 'resume:runtime'], 'successful login must reactivate a runtime intentionally closed by cached-session rejection');

console.log('✅ Cross-user login fails closed before activating the new identity');
