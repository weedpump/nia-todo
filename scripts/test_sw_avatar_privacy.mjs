#!/usr/bin/env node
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const listeners = new Map();
const cacheOperations = [];
const fetches = [];

const context = vm.createContext({
  URL,
  Request,
  Response,
  console,
  setTimeout,
  clearTimeout,
  self: {
    addEventListener(type, handler) { listeners.set(type, handler); },
    clients: { claim: async () => {} },
    registration: { showNotification: async () => {} },
  },
  clients: { openWindow: async () => {} },
  caches: {
    async keys() { return []; },
    async match(request) { cacheOperations.push(['match', String(request?.url || request)]); return null; },
    async open(name) {
      cacheOperations.push(['open', name]);
      return {
        async put(request) { cacheOperations.push(['put', String(request?.url || request)]); },
        async addAll() {},
        async keys() { return []; },
        async delete() {},
      };
    },
    async delete() {},
  },
  fetch: async request => {
    fetches.push(request);
    return new Response('avatar', { status: 200, headers: { 'Content-Type': 'image/webp' } });
  },
});

vm.runInContext(readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8'), context);
const handler = listeners.get('fetch');
assert.equal(typeof handler, 'function');

let responsePromise = null;
handler({
  request: new Request('https://todo.example/api/avatars/user-7.webp?v=1'),
  respondWith(promise) { responsePromise = Promise.resolve(promise); },
});
await responsePromise;

assert.equal(fetches.length, 1, 'avatar requests go directly to the network');
assert.equal(fetches[0].cache, 'no-store', 'avatar responses bypass browser HTTP caching');
assert.deepEqual(cacheOperations, [], 'the service worker never reads or writes avatar CacheStorage entries');

console.log('✅ Service worker never caches authenticated avatars');
