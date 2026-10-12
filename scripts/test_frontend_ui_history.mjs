#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createUiHistory } from '../web/static/js/features/ui-history.js';

console.log('↩️ Running in-app back navigation contract test...');

function createHarness({
  pathname = '/',
  search = '',
  hash = '#stale-settings-section',
  initialState = null,
  document = null,
} = {}) {
  const listeners = new Map();
  const location = { pathname, search, hash };
  const window = {
    addEventListener(type, handler) {
      const handlers = listeners.get(type) || [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
  };
  const stack = [{ state: structuredClone(initialState), url: `${pathname}${search}${hash}` }];
  let index = 0;
  const dispatchPopState = () => {
    const event = { state: stack[index].state };
    for (const handler of listeners.get('popstate') || []) handler(event);
  };
  const history = {
    get state() { return stack[index].state; },
    replaceState(state, _title, url) {
      stack[index] = { state: structuredClone(state), url };
    },
    pushState(state, _title, url) {
      stack.splice(index + 1);
      stack.push({ state: structuredClone(state), url });
      index += 1;
    },
    back() {
      if (index === 0) return;
      index -= 1;
      dispatchPopState();
    },
    forward() {
      if (index >= stack.length - 1) return;
      index += 1;
      dispatchPopState();
    },
  };
  const dispatch = (type, event = {}) => {
    for (const handler of listeners.get(type) || []) handler(event);
  };
  return { window, history, location, document, stack, dispatch, get index() { return index; } };
}

{
  const harness = createHarness();
  const closed = [];
  const uiHistory = createUiHistory(harness);
  uiHistory.registerLayer('settings-modal', payload => closed.push(['settings-modal', payload]));
  uiHistory.bind();

  assert.equal(harness.stack[0].url, '/', 'binding app history must remove stale URL fragments');
  uiHistory.openLayer('settings-modal');
  assert.equal(harness.stack.length, 2);
  assert.equal(harness.stack[1].url, '/', 'opening a modal must keep the visible URL clean');
  assert.deepEqual(harness.history.state.niaTodoUi.layers, ['settings-modal']);

  assert.equal(uiHistory.requestCloseLayer('settings-modal', { reason: 'close-button' }), true);
  assert.deepEqual(closed, [['settings-modal', { reason: 'close-button' }]], 'closing through UI must consume the modal history entry');
  assert.equal(harness.index, 0);
}

{
  const harness = createHarness({ pathname: '/app', search: '?view=focus&project=42' });
  const uiHistory = createUiHistory(harness);
  uiHistory.bind();
  assert.equal(harness.stack[0].url, '/app?view=focus&project=42', 'hash cleanup must preserve query deep links');
  uiHistory.openLayer('todo-modal');
  assert.equal(harness.stack[1].url, '/app?view=focus&project=42', 'layer history must preserve query deep links');
}

{
  const closedModal = { id: 'todo-modal', classList: { contains: () => false } };
  const document = {
    getElementById(id) { return id === 'todo-modal' ? closedModal : null; },
  };
  const harness = createHarness({
    initialState: { niaTodoUi: { layers: ['todo-modal'] } },
    document,
  });
  const uiHistory = createUiHistory(harness);
  uiHistory.bind();
  assert.deepEqual(uiHistory.getLayers(), [], 'reload must discard persisted layers that are closed in the DOM');
  assert.deepEqual(harness.history.state.niaTodoUi.layers, []);

  harness.history.replaceState({ niaTodoUi: { layers: ['todo-modal'] } }, '', '/');
  harness.dispatch('pageshow', { persisted: true });
  assert.deepEqual(uiHistory.getLayers(), [], 'BFCache restore must not revive closed DOM layers from history state');
  assert.deepEqual(harness.history.state.niaTodoUi.layers, []);
}

{
  const harness = createHarness();
  const uiHistory = createUiHistory(harness);
  uiHistory.registerLayer('protected-modal', () => uiHistory.openLayer('protected-modal'));
  uiHistory.bind();
  uiHistory.openLayer('protected-modal');
  harness.history.back();
  assert.deepEqual(uiHistory.getLayers(), ['protected-modal'], 'a protected modal must be able to restore its history guard during Back');
  assert.deepEqual(harness.history.state.niaTodoUi.layers, ['protected-modal']);
}

{
  const harness = createHarness();
  const closed = [];
  const uiHistory = createUiHistory(harness);
  uiHistory.registerLayer('todo-modal', payload => closed.push(['todo-modal', payload]));
  uiHistory.registerLayer('attachment-preview-modal', payload => closed.push(['attachment-preview-modal', payload]));
  uiHistory.bind();
  uiHistory.openLayer('todo-modal');
  uiHistory.openLayer('attachment-preview-modal');

  harness.history.back();
  assert.deepEqual(closed, [['attachment-preview-modal', { reason: 'history' }]], 'Back must close only the topmost nested layer');
  assert.deepEqual(harness.history.state.niaTodoUi.layers, ['todo-modal']);

  harness.history.back();
  assert.deepEqual(closed, [
    ['attachment-preview-modal', { reason: 'history' }],
    ['todo-modal', { reason: 'history' }],
  ]);
}

{
  const harness = createHarness();
  const closed = [];
  const uiHistory = createUiHistory(harness);
  uiHistory.registerLayer('settings-modal', payload => closed.push(['settings-modal', payload]));
  uiHistory.bind();
  uiHistory.openLayer('user-menu');
  assert.equal(uiHistory.replaceLayer('user-menu', 'settings-modal'), true);
  assert.deepEqual(harness.history.state.niaTodoUi.layers, ['settings-modal'], 'opening an action from the user menu must replace the menu history entry');

  harness.history.back();
  assert.deepEqual(closed, [['settings-modal', { reason: 'history' }]], 'Back after a user-menu action must close the action without restoring a ghost menu');
  assert.deepEqual(harness.history.state.niaTodoUi.layers, []);
}

const indexHtml = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const userSettingsSource = readFileSync(new URL('../web/static/js/features/user-settings.js', import.meta.url), 'utf8');
const navigationSource = readFileSync(new URL('../web/static/js/features/navigation.js', import.meta.url), 'utf8');
const userMenuSource = readFileSync(new URL('../web/static/js/features/user-menu.js', import.meta.url), 'utf8');
const dashboardPreferencesSource = readFileSync(new URL('../web/static/js/features/dashboard-preferences-dialog.js', import.meta.url), 'utf8');
const appDownloadsSource = readFileSync(new URL('../web/static/js/features/app-downloads.js', import.meta.url), 'utf8');
const uiShellSource = readFileSync(new URL('../web/static/js/features/ui-shell.js', import.meta.url), 'utf8');
const navigationModuleSource = readFileSync(new URL('../web/static/js/features/navigation.js', import.meta.url), 'utf8');
const settingsNav = indexHtml.slice(indexHtml.indexOf('<nav class="settings-nav"'), indexHtml.indexOf('</nav>', indexHtml.indexOf('<nav class="settings-nav"')));

assert.doesNotMatch(settingsNav, /href="#settings-section-/, 'settings navigation must not write section fragments into the URL');
assert.match(settingsNav, /data-settings-section="settings-section-profile"/, 'settings navigation needs explicit in-modal section targets');
assert.match(userSettingsSource, /scrollIntoView\(/, 'settings section controls must still scroll inside the modal');
assert.doesNotMatch(navigationSource, /location\.hash/, 'app history entries must not preserve stale section fragments');
assert.match(userMenuSource, /openUiLayer\('user-menu'\)/, 'the user action menu must create a history entry');
assert.match(userMenuSource, /registerUiLayer\('user-menu'/, 'the user action menu must close through in-app history');
assert.match(dashboardPreferencesSource, /replaceUiLayer\('user-menu', 'dashboard-preferences-modal'\)/, 'dashboard settings must replace the user-menu history entry');
assert.match(uiShellSource, /mfa-enrollment-locked[\s\S]*openUiLayer\('settings-modal'\)/, 'MFA-locked settings must restore their history guard');
assert.match(appDownloadsSource, /native-update-required[\s\S]*openUiLayer\('native-app-update-modal'\)/, 'required native updates must restore their history guard');

const uiHistorySource = readFileSync(new URL('../web/static/js/features/ui-history.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('http://nia.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/static/js/features/ui-history.js') {
      await route.fulfill({ contentType: 'text/javascript', body: uiHistorySource });
      return;
    }
    if (url.pathname === '/static/js/features/ui-shell.js') {
      await route.fulfill({ contentType: 'text/javascript', body: uiShellSource });
      return;
    }
    if (url.pathname === '/static/js/features/navigation.js') {
      await route.fulfill({ contentType: 'text/javascript', body: navigationModuleSource });
      return;
    }
    if (url.pathname === '/static/js/features/app-downloads.js') {
      await route.fulfill({ contentType: 'text/javascript', body: appDownloadsSource });
      return;
    }
    if (url.pathname === '/static/js/core/config.js') {
      await route.fulfill({ contentType: 'text/javascript', body: `
        export const API = '';
        export const RUNTIME_CAPABILITIES = { native: false, nativeAppVersion: false, appDownloads: false };
        export const RUNTIME_PLATFORM = 'web';
        export async function verifyInstance() { return {}; }
      ` });
      return;
    }
    if (url.pathname === '/static/js/i18n/index.js') {
      await route.fulfill({ contentType: 'text/javascript', body: 'export function t(key) { return key; }' });
      return;
    }
    if (url.pathname === '/static/js/icons/lucide-icons.js') {
      await route.fulfill({ contentType: 'text/javascript', body: 'export function iconSvg() { return ""; }' });
      return;
    }
    if (url.pathname === '/static/js/features/native-bridge.js') {
      await route.fulfill({ contentType: 'text/javascript', body: 'export function createNativeBridge() { return {}; }' });
      return;
    }
    if (url.pathname === '/static/js/features/auto-scrollbars.js') {
      await route.fulfill({ contentType: 'text/javascript', body: 'export function hideAutoScrollbars() {}' });
      return;
    }
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body>
        <div id="sidebar"></div>
        <div id="sidebar-overlay"></div>
        <button class="nav-btn" data-filter="all"></button>
        <button class="nav-btn" data-filter="focus"></button>
        <div id="todo-modal" class="modal"></div>
        <div id="attachment-preview-modal" class="modal"></div>
        <div id="settings-modal" class="modal"></div>
        <div id="native-app-update-modal" class="modal"></div>
        <script type="module">
          import { bindUiHistory, closeUiLayerNow, openUiLayer, registerUiLayer } from '/static/js/features/ui-history.js';
          import { createUiShell } from '/static/js/features/ui-shell.js';
          import { createNavigationFeature } from '/static/js/features/navigation.js';
          import { createAppDownloadsFeature } from '/static/js/features/app-downloads.js';
          const close = id => document.getElementById(id).classList.remove('active');
          registerUiLayer('todo-modal', () => close('todo-modal'));
          registerUiLayer('attachment-preview-modal', () => close('attachment-preview-modal'));
          bindUiHistory();
          const shell = createUiShell({ renderMarkdown: value => value, showTodoModal() {} });
          createAppDownloadsFeature();
          window.openLayer = id => {
            document.getElementById(id).classList.add('active');
            openUiLayer(id);
          };
          window.runSidebarNavigation = async () => {
            let currentFilter = 'all';
            const navigation = createNavigationFeature({
              sectionsApi: { listByProject: async () => ({ sections: [] }) },
              getCurrentProjectId: () => null,
              getCurrentFilter: () => currentFilter,
              setCurrentProjectId() {},
              setCurrentFilter: value => { currentFilter = value; },
              setSections() {},
              isOnlineForSync: () => false,
              dbGetAll: async () => [],
              dbPut: async () => {},
              deleteFromDB: async () => {},
              closeSidebar: options => shell.closeSidebar(options),
              renderProjects() {}, renderStats() {}, renderTodos() {},
            });
            navigation.bindNavigationHistory();
            window.getSidebarNavigationFilter = () => currentFilter;
            shell.openSidebar();
            await navigation.setFilter('focus');
            return {
              filter: currentFilter,
              sidebarOpen: document.getElementById('sidebar').classList.contains('open'),
              layers: history.state.niaTodoUi.layers,
            };
          };
          window.runMfaSettingsBackGuard = async () => {
            const modal = document.getElementById('settings-modal');
            modal.classList.add('active', 'mfa-enrollment-locked');
            openUiLayer('settings-modal');
            history.back();
            await new Promise(resolve => setTimeout(resolve, 0));
            return {
              active: modal.classList.contains('active'),
              layers: history.state.niaTodoUi.layers,
            };
          };
          window.runRequiredNativeUpdateBackGuard = async () => {
            const modal = document.getElementById('native-app-update-modal');
            modal.classList.add('active', 'native-update-required');
            openUiLayer('native-app-update-modal');
            history.back();
            await new Promise(resolve => setTimeout(resolve, 0));
            const result = {
              active: modal.classList.contains('active'),
              layers: history.state.niaTodoUi.layers,
            };
            modal.classList.remove('native-update-required', 'active');
            closeUiLayerNow('native-app-update-modal');
            return result;
          };
          window.historyReady = true;
        </script>
      </body></html>`,
    });
  });
  await page.goto('http://nia.test/history-test#stale');
  await page.waitForFunction(() => window.historyReady === true);
  assert.equal(page.url(), 'http://nia.test/history-test', 'binding must clean an existing fragment in a real browser');

  await page.evaluate(() => window.openLayer('todo-modal'));
  await page.evaluate(() => window.openLayer('attachment-preview-modal'));
  await page.evaluate(() => history.back());
  await page.waitForFunction(() => !document.getElementById('attachment-preview-modal').classList.contains('active'));
  assert.equal(await page.locator('#todo-modal').evaluate(element => element.classList.contains('active')), true, 'browser Back must preserve the underlying modal');
  assert.equal(page.url(), 'http://nia.test/history-test');

  await page.evaluate(() => history.back());
  await page.waitForFunction(() => !document.getElementById('todo-modal').classList.contains('active'));
  assert.equal(page.url(), 'http://nia.test/history-test');

  await page.evaluate(() => history.forward());
  await page.waitForFunction(() => (history.state?.niaTodoUi?.layers || []).length === 0);
  assert.equal(await page.locator('#todo-modal').evaluate(element => element.classList.contains('active')), false, 'Forward must not revive a dialog that Back already closed');
  assert.deepEqual(await page.evaluate(() => history.state?.niaTodoUi?.layers || []), [], 'Forward must normalize stale modal layers instead of creating a ghost state');

  const sidebarNavigationResult = await page.evaluate(() => window.runSidebarNavigation());
  assert.deepEqual(sidebarNavigationResult, {
    filter: 'focus',
    sidebarOpen: false,
    layers: [],
  }, 'navigation from an open sidebar must close it without rolling back the selected filter or leaving a ghost entry');
  await page.evaluate(() => history.back());
  await page.waitForFunction(() => window.getSidebarNavigationFilter() === 'all');
  assert.deepEqual(await page.evaluate(() => ({
    sidebarOpen: document.getElementById('sidebar').classList.contains('open'),
    layers: history.state.niaTodoUi.layers,
  })), { sidebarOpen: false, layers: [] }, 'Back after sidebar navigation must restore the prior filter without reviving the sidebar');

  assert.deepEqual(await page.evaluate(() => window.runRequiredNativeUpdateBackGuard()), {
    active: true,
    layers: ['native-app-update-modal'],
  }, 'Back must not close a required native update and must restore its history guard');

  assert.deepEqual(await page.evaluate(() => window.runMfaSettingsBackGuard()), {
    active: true,
    layers: ['settings-modal'],
  }, 'Back must not close MFA-locked settings and must restore its history guard');
} finally {
  await browser.close();
}

console.log('✅ In-app back navigation contract test passed');
