import assert from 'node:assert/strict';

const originalGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  caches: Object.getOwnPropertyDescriptor(globalThis, 'caches'),
  MessageChannel: globalThis.MessageChannel,
  location: Object.getOwnPropertyDescriptor(globalThis, 'location'),
};

try {
  const buttons = [
    { disabled: false, title: 'Reload', attrs: new Map([['aria-disabled', 'false']]), getAttribute(name) { return this.attrs.get(name) ?? null; } },
  ];
  const replacements = [];
  const replacedHistoryUrls = [];

  const location = {
    href: 'https://todo.example.test/?hardReload=old-value&filter=today',
    origin: 'https://todo.example.test',
    search: '?hardReload=old-value&filter=today',
    replace(url) { replacements.push(url); },
  };

  globalThis.window = {
    location,
    history: {
      state: { view: 'today' },
      replaceState(state, title, url) {
        replacedHistoryUrls.push({ state, title, url });
        location.href = new URL(url, location.href).toString();
        location.search = new URL(location.href).search;
      },
    },
    addEventListener() {},
  };
  globalThis.location = location;
  globalThis.document = {
    querySelectorAll() { return buttons; },
    querySelector() { return null; },
    getElementById() { return null; },
    addEventListener() {},
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      onLine: true,
      userAgent: 'Mozilla/5.0',
      platform: 'Linux',
      maxTouchPoints: 0,
      serviceWorker: {
        controller: { postMessage() {} },
        getRegistrations: async () => [{ active: { scriptURL: 'https://todo.example.test/sw.js', postMessage() {} } }],
        register: async () => ({ active: {}, update: async () => {} }),
        ready: Promise.resolve({ active: {} }),
      },
    },
  });
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { keys: async () => [], delete: async () => true },
  });
  globalThis.MessageChannel = class {
    constructor() {
      this.port1 = {};
      this.port2 = {};
    }
  };

  const { createServiceWorkerUpdatesFeature } = await import('../web/static/js/features/service-worker-updates.js');
  const feature = createServiceWorkerUpdatesFeature();

  assert.equal(replacedHistoryUrls.length, 1, 'startup must remove a stale hardReload marker from the visible URL');
  assert.equal(new URL(location.href).searchParams.has('hardReload'), false, 'the cleanup must remove hardReload');
  assert.equal(new URL(location.href).searchParams.get('filter'), 'today', 'the cleanup must preserve unrelated URL state');

  const firstReload = feature.forceReloadApp();
  const secondReload = feature.forceReloadApp();
  await Promise.all([firstReload, secondReload]);

  assert.equal(replacements.length, 1, 'repeated clicks in the old document must start exactly one navigation');
  assert.equal(new URL(replacements[0]).searchParams.has('hardReload'), true, 'hard reload navigation must still bypass stale caches');
  assert.equal(buttons[0].disabled, true, 'reload controls must remain disabled while the old document is alive');

  await feature.forceReloadApp();
  assert.equal(replacements.length, 1, 'the transition lock must remain closed after location.replace returns');

  console.log('Frontend hard reload regression tests passed.');
} finally {
  globalThis.window = originalGlobals.window;
  globalThis.document = originalGlobals.document;
  if (originalGlobals.navigator) Object.defineProperty(globalThis, 'navigator', originalGlobals.navigator);
  else delete globalThis.navigator;
  if (originalGlobals.caches) Object.defineProperty(globalThis, 'caches', originalGlobals.caches);
  else delete globalThis.caches;
  globalThis.MessageChannel = originalGlobals.MessageChannel;
  if (originalGlobals.location) Object.defineProperty(globalThis, 'location', originalGlobals.location);
  else delete globalThis.location;
}
