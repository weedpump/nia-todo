#!/usr/bin/env node
import assert from 'node:assert/strict';

const events = [];
globalThis.location = { origin: 'https://old.example', search: '?nativeApp=tauri', reload() { events.push('reload'); } };
globalThis.document = {
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
};
globalThis.window = globalThis;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux', maxTouchPoints: 0 },
});
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = callback => { callback(); return 0; };
window.__TAURI_INTERNALS__ = {
  invoke: async (command, args = {}) => {
    if (command === 'desktop_set_server_url') {
      events.push(`persist:${args.serverUrl}`);
      return { serverUrl: args.serverUrl };
    }
    if (command === 'desktop_clear_server_url') {
      events.push('persist:reset');
      return null;
    }
    return null;
  },
};

const { createDesktopIntegration } = await import('../web/static/js/features/desktop-integration.js');
const { createAppStorage } = await import('../web/static/js/storage/app-storage.js');

function createFeature({ failClear = false } = {}) {
  return createDesktopIntegration({
    showToast: () => {},
    onHotkeyNewTodo: () => {},
    onHotkeySearch: () => {},
    getCurrentUser: () => null,
    clearLocalAuthState: () => { events.push('clear:auth'); },
    clearBrowserAuthCaches: async () => { events.push('clear:browser'); },
    clearCache: async () => {
      events.push('clear:indexeddb');
      if (failClear) throw new Error('cache clear failed');
    },
  });
}

try {
  const feature = createFeature();
  await feature.updateServerUrl('https://new.example/');
  assert.deepEqual(events, [
    'clear:browser',
    'clear:indexeddb',
    'clear:auth',
    'persist:https://new.example',
    'reload',
  ], 'native server updates must clear browser auth and application data before persisting the new server');

  events.length = 0;
  await feature.resetServerUrl();
  assert.deepEqual(events, [
    'clear:browser',
    'clear:indexeddb',
    'clear:auth',
    'persist:reset',
    'reload',
  ], 'native server reset must clear browser auth and application data before removing the configured server');

  events.length = 0;
  await createFeature({ failClear: true }).updateServerUrl('https://blocked.example');
  assert.deepEqual(events, [
    'clear:browser',
    'clear:indexeddb',
  ], 'a failed durable cache clear must prevent the server switch without clearing the old identity');

  events.length = 0;
  globalThis.indexedDB = {
    deleteDatabase() {
      const request = { error: new Error('real IndexedDB delete failed') };
      queueMicrotask(() => request.onerror?.());
      return request;
    },
  };
  const realStorage = createAppStorage({ setDb: () => {} });
  const realWrapperFeature = createDesktopIntegration({
    showToast: () => {},
    onHotkeyNewTodo: () => {},
    onHotkeySearch: () => {},
    getCurrentUser: () => null,
    clearLocalAuthState: () => { events.push('clear:auth'); },
    clearBrowserAuthCaches: async () => { events.push('clear:browser'); },
    clearCache: async () => {
      events.push('clear:indexeddb');
      await realStorage.clearIndexedDB();
    },
  });
  await realWrapperFeature.updateServerUrl('https://real-wrapper-blocked.example');
  await realWrapperFeature.resetServerUrl();
  assert.deepEqual(events, [
    'clear:browser', 'clear:indexeddb',
    'clear:browser', 'clear:indexeddb',
  ], 'real IndexedDB deletion failures must prevent native persistence and reload for update and reset');

  console.log('✅ Native server switches clear scoped browser data before persistence');
} finally {
  globalThis.setTimeout = originalSetTimeout;
}
