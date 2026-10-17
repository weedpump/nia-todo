#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAppLifecycle } from '../web/static/js/features/app-lifecycle.js';

const appSource = readFileSync(new URL('../web/static/js/app.js', import.meta.url), 'utf8');
assert.match(appSource, /checkAuth:\s*\(options\)\s*=>\s*checkAuth\(options\)/, 'production lifecycle wiring must forward cached-start auth options');
assert.match(appSource, /disconnectRealtime:\s*\(\)\s*=>\s*disconnectAuthenticatedRuntime\(\)/, 'production lifecycle wiring must tear down authenticated runtime state after cached-session rejection');

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalSetInterval = globalThis.setInterval;

try {
  const elements = new Map();
  const makeElement = () => ({
    classList: { add() {}, remove() {} },
    setAttribute() {},
    removeAttribute() {},
    style: {},
    inert: false,
  });
  globalThis.window = {
    addEventListener() {},
    history: { state: null },
    location: { search: '', href: '/' },
  };
  globalThis.document = {
    readyState: 'complete',
    visibilityState: 'visible',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
    addEventListener() {},
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });
  globalThis.setInterval = () => 1;

  async function runCachedScenario({ mfaRequired, validationResult, setupComplete = true }) {
    let resolveAuth;
    let resolveSetup;
    let localAppInitializations = 0;
    let loginOverlayShows = 0;
    let settingsOpens = 0;
    let disconnects = 0;
    let authenticated = true;
    const appInitializedValues = [];
    const authOptions = [];
    window.location.href = '/';
    const lifecycle = createAppLifecycle({
      authApi: { setupStatus: () => new Promise(resolve => { resolveSetup = resolve; }) },
      initTheme() {},
      checkAuth: (options = {}) => {
        authOptions.push(options);
        if (options.preferCached) return Promise.resolve(true);
        return new Promise(resolve => { resolveAuth = resolve; });
      },
      hideLoginOverlay() {},
      showLoginOverlay() { loginOverlayShows += 1; },
      renderUserInfo() {},
      openSettingsModal: async () => { settingsOpens += 1; },
      isMfaEnrollmentRequired: () => mfaRequired,
      initServiceWorker: async () => {},
      openDB: async () => {},
      dbGetAll: async () => [],
      setTodos() {}, setProjects() {}, setSections() {}, setWorkspaces() {},
      setCurrentFilter() {}, setCurrentProjectId() {}, setCurrentWorkspaceId() {},
      ensureCurrentWorkspace() {},
      setAppInitialized(value) { appInitializedValues.push(value); },
      connectWebSocket() { localAppInitializations += 1; },
      disconnectRealtime: async () => { disconnects += 1; },
      getWsState: () => 'disconnected',
      isAuthenticated: () => authenticated,
      isOnlineForSync: () => false,
      syncWithServer: async () => ({ failCount: 0 }),
      refreshFromServer: async () => {},
      updateConnectionStatus() {}, renderVersionInfo() {}, renderProjects() {}, renderStats() {}, renderTodos() {}, renderWorkspaces() {},
      updateToggleDoneButton() {}, updateSortButton() {},
    });

    lifecycle.bindDomReady();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(authOptions, [{ preferCached: true }, { authoritative: true }], 'cached startup must render from cache then start uncapped authoritative validation');
    assert.equal(typeof resolveSetup, 'function', 'setup validation must continue in the background');
    assert.equal(typeof resolveAuth, 'function', 'auth validation must continue in the background');

    if (validationResult === false) authenticated = false;
    resolveAuth(validationResult);
    resolveSetup({ setup_complete: setupComplete });
    await Promise.resolve();
    await Promise.resolve();
    return { localAppInitializations, loginOverlayShows, settingsOpens, disconnects, appInitializedValues, locationHref: window.location.href };
  }

  const normal = await runCachedScenario({ mfaRequired: false, validationResult: false });
  assert.equal(normal.localAppInitializations, 1, 'normal cached startup must initialize local app state immediately');
  assert.equal(normal.loginOverlayShows, 1, 'rejected background validation must return the visible app to login');
  assert.equal(normal.disconnects, 1, 'rejected background validation must disconnect authenticated realtime state');
  assert.equal(normal.appInitializedValues.at(-1), false, 'rejected background validation must force a clean next login initialization');

  const mfa = await runCachedScenario({ mfaRequired: true, validationResult: true });
  assert.equal(mfa.localAppInitializations, 0, 'cached MFA enrollment requirements must not start unrestricted app services');
  assert.equal(mfa.settingsOpens, 1, 'cached MFA enrollment requirements must open the mandatory settings flow immediately');

  const resetServer = await runCachedScenario({ mfaRequired: false, validationResult: true, setupComplete: false });
  assert.equal(resetServer.locationHref, '/setup', 'cached startup must redirect when background setup validation finds an unconfigured server');

  console.log('✅ Non-blocking cached startup regression passed');
} finally {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else delete globalThis.localStorage;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
  globalThis.setInterval = originalSetInterval;
}
