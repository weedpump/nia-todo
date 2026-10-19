#!/usr/bin/env node
import assert from 'node:assert/strict';

const events = [];
const values = new Map([['last_user_id', '1'], ['cached_user', JSON.stringify({ id: 1 })]]);
globalThis.localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => { events.push(`set:${key}`); values.set(key, String(value)); },
  removeItem: key => { events.push(`remove:${key}`); values.delete(key); },
};
globalThis.sessionStorage = { setItem() {} };
globalThis.location = { replace(url) { events.push(`redirect:${url}`); } };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: ['en'], serviceWorker: { getRegistrations: async () => [] } } });
globalThis.caches = { keys: async () => ['nia-todo-api-old'], delete: async name => { events.push(`cache:${name}`); return true; } };
globalThis.indexedDB = {
  deleteDatabase() {
    events.push('indexeddb:delete');
    const request = {};
    queueMicrotask(() => request.onsuccess?.());
    return request;
  },
};
globalThis.document = {
  documentElement: {},
  getElementById(id) {
    if (id === 'oidc-completion-data') return { dataset: {
      kind: 'user',
      redirectTo: '/',
      payload: JSON.stringify({ access_token: 'new', csrf_token: 'csrf', user: { id: 2, username: 'new' } }),
    } };
    return { textContent: '' };
  },
};

await import('../web/static/js/pages/oidc-completion.js');
for (let attempt = 0; attempt < 10 && !events.some(event => event.startsWith('redirect:')); attempt += 1) await new Promise(resolve => setImmediate(resolve));

assert(events.indexOf('indexeddb:delete') >= 0, 'cross-user browser OIDC must delete the old IndexedDB before activation');
assert(events.indexOf('indexeddb:delete') < events.indexOf('set:jwt_token'), 'OIDC must clean old private data before storing the new token');
assert(events.indexOf('cache:nia-todo-api-old') < events.indexOf('set:jwt_token'), 'OIDC must clear old authenticated browser caches before activation');
assert.equal(values.get('last_user_id'), '2');
assert.equal(events.at(-1), 'redirect:/');

console.log('✅ Browser OIDC clears old identity data before activation');