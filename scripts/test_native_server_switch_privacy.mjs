#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../web/static/js/app.js', import.meta.url), 'utf8');
assert.match(appSource, /createDesktopIntegration\(\{[\s\S]*disconnectRealtime:\s*\(\)\s*=>\s*disconnectAuthenticatedRuntime\(\)/, 'production server-switch wiring must drain the authenticated runtime');
assert.match(appSource, /authenticatedRuntimeDraining/, 'production runtime must close against new old-identity operations while draining');
assert.match(appSource, /disconnectAuthenticatedRuntime\(\{ triggeringSideEffectTokens = null \} = \{\}\)[\s\S]*brainDumpLiveFeature\.resetForIdentityBoundary\(\)/, 'authenticated runtime drain must reset BrainDump identity state');
assert.match(appSource, /resumeAuthenticatedRuntime\(\)[\s\S]*brainDumpLiveFeature\.init\(\)/, 'identity resume must recheck BrainDump access for the active user');

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
let failNativePersistence = false;
globalThis.setTimeout = callback => { callback(); return 0; };
window.__TAURI_INTERNALS__ = {
  invoke: async (command, args = {}) => {
    if (command === 'desktop_set_server_url') {
      if (failNativePersistence) {
        events.push('persist:failed');
        throw new Error('native persistence failed');
      }
      events.push(`persist:${args.serverUrl}`);
      return { serverUrl: args.serverUrl };
    }
    if (command === 'desktop_clear_server_url') {
      if (failNativePersistence) {
        events.push('persist:reset-failed');
        throw new Error('native persistence failed');
      }
      events.push('persist:reset');
      return null;
    }
    if (command === 'desktop_schedule_reminders') {
      events.push(`schedule:${JSON.stringify(args.reminders || [])}`);
      return (args.reminders || []).length;
    }
    if (command === 'desktop_get_settings') return {};
    return null;
  },
};

const { createDesktopIntegration } = await import('../web/static/js/features/desktop-integration.js');
const { createAppStorage } = await import('../web/static/js/storage/app-storage.js');

function createFeature({ failClear = false, observeResume = false } = {}) {
  return createDesktopIntegration({
    showToast: () => {},
    onHotkeyNewTodo: () => {},
    onHotkeySearch: () => {},
    getCurrentUser: () => null,
    disconnectRealtime: async () => { events.push('drain:runtime'); },
    resumeRealtime: async () => { if (observeResume) events.push('resume:runtime'); },
    beginServerBoundary: () => { if (observeResume) events.push('boundary:begin'); },
    resumeServerBoundary: () => { if (observeResume) events.push('boundary:resume'); },
    clearNativeReminders: async () => { events.push('clear:reminders'); },
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
    'drain:runtime',
    'clear:reminders',
    'clear:browser',
    'clear:indexeddb',
    'clear:auth',
    'persist:https://new.example',
    'reload',
  ], 'native server updates must clear browser auth and application data before persisting the new server');

  events.length = 0;
  const resetFeature = createFeature();
  await resetFeature.resetServerUrl();
  assert.deepEqual(events, [
    'drain:runtime',
    'clear:reminders',
    'clear:browser',
    'clear:indexeddb',
    'clear:auth',
    'persist:reset',
    'reload',
  ], 'native server reset must clear browser auth and application data before removing the configured server');

  events.length = 0;
  await createFeature({ failClear: true }).updateServerUrl('https://blocked.example');
  assert.deepEqual(events, [
    'drain:runtime',
    'clear:reminders',
    'clear:browser',
    'clear:indexeddb',
  ], 'a failed durable cache clear must prevent the server switch without clearing the old identity');

  events.length = 0;
  const reversibleFailure = createFeature({ failClear: true, observeResume: true });
  assert.equal(await reversibleFailure.updateServerUrl('https://reversible-failure.example'), false);
  assert.deepEqual(events, [
    'boundary:begin', 'drain:runtime', 'clear:reminders', 'clear:browser', 'clear:indexeddb', 'boundary:resume', 'resume:runtime',
  ], 'pre-commit cleanup failure must reactivate the old runtime and release the server boundary');
  events.length = 0;
  assert.equal(await reversibleFailure.updateServerUrl('https://reversible-retry.example'), false);
  assert.equal(events[0], 'boundary:begin', 'pre-commit failure must release the transition lock for retry');

  events.length = 0;
  let irreversibleReload = null;
  globalThis.setTimeout = callback => { irreversibleReload = callback; return 88; };
  failNativePersistence = true;
  const irreversibleFailure = createFeature({ observeResume: true });
  assert.equal(await irreversibleFailure.updateServerUrl('https://persist-fails.example'), false);
  assert.deepEqual(events, [
    'boundary:begin', 'drain:runtime', 'clear:reminders', 'clear:browser', 'clear:indexeddb', 'clear:auth', 'persist:failed',
  ], 'post-cleanup persistence failure must not reactivate the cleared runtime or release the old-document boundary');
  assert.equal(typeof irreversibleReload, 'function', 'post-cleanup persistence failure must request a safe reload/server selection');
  assert.equal(await irreversibleFailure.resetServerUrl(), false, 'irreversible failure must retain the transition lock in the old document');
  events.length = 0;
  const irreversibleResetFailure = createFeature({ observeResume: true });
  assert.equal(await irreversibleResetFailure.resetServerUrl(), false);
  assert.deepEqual(events, [
    'boundary:begin', 'drain:runtime', 'clear:reminders', 'clear:browser', 'clear:indexeddb', 'clear:auth', 'persist:reset-failed',
  ], 'post-cleanup reset persistence failure must also remain closed without resuming the old runtime');
  assert.equal(await irreversibleResetFailure.updateServerUrl('https://must-stay-locked.example'), false);
  failNativePersistence = false;
  irreversibleReload();
  globalThis.setTimeout = callback => { callback(); return 0; };

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
    disconnectRealtime: async () => { events.push('drain:runtime'); },
    clearNativeReminders: async () => { events.push('clear:reminders'); },
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
    'drain:runtime', 'clear:reminders', 'clear:browser', 'clear:indexeddb',
    'drain:runtime', 'clear:reminders', 'clear:browser', 'clear:indexeddb',
  ], 'real IndexedDB deletion failures must prevent native persistence and reload for update and reset');

  events.length = 0;
  const reminderFailureFeature = createDesktopIntegration({
    showToast: () => {}, onHotkeyNewTodo: () => {}, onHotkeySearch: () => {}, getCurrentUser: () => null,
    disconnectRealtime: async () => { events.push('drain:runtime'); },
    clearNativeReminders: async () => { events.push('clear:reminders'); throw new Error('native reminder cleanup failed'); },
    clearLocalAuthState: () => { events.push('clear:auth'); },
    clearBrowserAuthCaches: async () => { events.push('clear:browser'); },
    clearCache: async () => { events.push('clear:indexeddb'); },
  });
  await reminderFailureFeature.updateServerUrl('https://reminder-blocked.example');
  assert.deepEqual(events, ['drain:runtime', 'clear:reminders'], 'native reminder cleanup failures must fail closed before changing server or identity state');

  events.length = 0;
  let releaseConcurrentDrain;
  const concurrentDrain = new Promise(resolve => { releaseConcurrentDrain = resolve; });
  const concurrentFeature = createDesktopIntegration({
    showToast: () => {}, onHotkeyNewTodo: () => {}, onHotkeySearch: () => {}, getCurrentUser: () => null,
    disconnectRealtime: async () => { events.push('drain:runtime'); await concurrentDrain; },
    clearNativeReminders: async () => { events.push('clear:reminders'); },
    clearLocalAuthState: () => { events.push('clear:auth'); },
    clearBrowserAuthCaches: async () => { events.push('clear:browser'); },
    clearCache: async () => { events.push('clear:indexeddb'); },
  });
  const concurrentUpdate = concurrentFeature.updateServerUrl('https://serialized.example');
  await Promise.resolve();
  const concurrentReset = await concurrentFeature.resetServerUrl();
  assert.equal(concurrentReset, false, 'a reset must not overlap an active server update');
  assert.deepEqual(events, ['drain:runtime']);
  releaseConcurrentDrain();
  await concurrentUpdate;
  assert.equal(events.includes('persist:reset'), false, 'the rejected concurrent reset must not persist');
  assert.equal(events.filter(event => event === 'clear:indexeddb').length, 1, 'a concurrent switch must run cleanup exactly once');

  events.length = 0;
  let reloadCallback = null;
  globalThis.setTimeout = callback => { reloadCallback = callback; return 77; };
  const lockedUntilUnloadFeature = createFeature();
  assert.equal(await lockedUntilUnloadFeature.updateServerUrl('https://locked.example'), true);
  assert.equal(await lockedUntilUnloadFeature.resetServerUrl(), false, 'server reset must remain blocked before the reload callback');
  reloadCallback();
  assert.equal(await lockedUntilUnloadFeature.resetServerUrl(), false, 'server reset must remain blocked after location.reload returns in the same document');
  assert.equal(events.filter(event => event === 'drain:runtime').length, 1, 'the successful server switch must remain single-shot until document unload');

  events.length = 0;
  let delayedReminderCallback = null;
  globalThis.setTimeout = callback => { delayedReminderCallback = callback; return 42; };
  const privacyFeature = createDesktopIntegration({
    showToast: () => {}, onHotkeyNewTodo: () => {}, onHotkeySearch: () => {},
    getCurrentUser: () => ({ id: 1 }),
  });
  await privacyFeature.loadSettings();
  privacyFeature.syncLocalReminders([{ id: 1, title: 'OLD USER SECRET', status: 'open', remind_at: new Date(Date.now() + 60000).toISOString() }]);
  assert.equal(typeof delayedReminderCallback, 'function');
  await privacyFeature.clearNativeRemindersForPrivacy();
  delayedReminderCallback();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(events.some(event => event.includes('OLD USER SECRET')), false, 'privacy cleanup must invalidate delayed old-identity reminder scheduling');
  assert.equal(events.at(-1), 'schedule:[]', 'privacy cleanup must leave the native reminder scheduler empty');

  console.log('✅ Native server switches clear scoped browser data before persistence');
} finally {
  globalThis.setTimeout = originalSetTimeout;
}
