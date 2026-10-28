#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const authSessionSource = readFileSync(new URL('../web/static/js/features/auth-session.js', import.meta.url), 'utf8');
const moduleShellSource = readFileSync(new URL('../web/static/js/features/module-shell.js', import.meta.url), 'utf8');
const visibilitySource = readFileSync(new URL('../web/static/js/modules/visibility.js', import.meta.url), 'utf8');

const slotIds = [
  'module-sidebar-slot',
  'module-topbar-slot',
  'module-main-slot',
  'module-floating-slot',
  'module-user-menu-slot',
  'module-shortcuts-slot',
  'module-settings-nav-slot',
  'module-settings-slot',
  'module-desktop-hotkeys-slot',
];

const html = `<!doctype html><html><body>
  <div id="app"></div>
  <div id="workspace-switcher"></div>
  <div id="module-switcher"></div>
  <input id="search-input"><button id="search-toggle-btn"></button>
  ${slotIds.map(id => `<div id="${id}"></div>`).join('')}
  <script type="module">
    import { createAuthSessionFeature } from '/static/js/features/auth-session.js';
    import { createModuleShell } from '/static/js/features/module-shell.js';

    localStorage.setItem('jwt_token', 'cached-token');
    localStorage.setItem('nia-active-module', 'shopping');
    localStorage.setItem('cached_user', JSON.stringify({
      id: 1,
      username: 'tester',
      disabled_modules: ['shopping'],
    }));

    let currentUser = null;
    const shell = createModuleShell({ getUser: () => currentUser });
    window.moduleShell = shell;
    shell.bind();

    const auth = createAuthSessionFeature({
      authApi: { me: async () => { throw new Error('cached path expected'); } },
      getAppInitialized: () => false,
      setCurrentUser: next => { currentUser = next; },
      onCurrentUserChange: () => shell.applyModulePreferences(),
      clearCache: async () => {},
      initApp: async () => {},
      refreshFromServer: async () => {},
      renderUserInfo: () => {},
    });

    await auth.checkAuth({ preferCached: true });
    window.authModuleHydrationState = {
      activeModule: shell.getActiveModule(),
      pathname: location.pathname,
      shoppingMainHidden: document.querySelector('[data-module-panel="shopping"][data-module-slot="main"]').hidden,
      tasksMainHidden: document.querySelector('[data-module-panel="tasks"][data-module-slot="main"]').hidden,
    };
  </script>
</body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('http://nia.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const stubs = {
      '/static/js/features/auth-session.js': authSessionSource,
      '/static/js/features/module-shell.js': moduleShellSource,
      '/static/js/modules/visibility.js': visibilitySource,
      '/static/js/modules/registry.js': `
        export const MODULES = [
          { id: 'tasks', capabilities: { workspaces: true }, render() {} },
          { id: 'shopping', capabilities: {}, render() {} },
          { id: 'recipes', capabilities: {}, render() {} },
        ];
        export const getModule = id => MODULES.find(module => module.id === id) || MODULES[0];
        export const isModuleId = id => MODULES.some(module => module.id === id);
        export const persistModule = id => localStorage.setItem('nia-active-module', id);
        export const readStoredModule = () => localStorage.getItem('nia-active-module') || 'tasks';
      `,
      '/static/js/api/http.js': "export const getAuthToken=()=>localStorage.getItem('jwt_token'); export const getCsrfToken=()=>null; export const getAuthHeaders=()=>({}); export const getJsonHeaders=()=>({});",
      '/static/js/core/config.js': "export const API=''; export const RUNTIME_CAPABILITIES={ native:false };",
      '/static/js/features/native-bridge.js': "export const createNativeBridge=()=>({});",
      '/static/js/i18n/index.js': "export const t=key=>key; export const translatePage=()=>{};",
    };
    if (Object.hasOwn(stubs, pathname)) {
      await route.fulfill({ contentType: 'text/javascript', body: stubs[pathname] });
      return;
    }
    await route.fulfill({ contentType: 'text/html', body: html });
  });

  await page.goto('http://nia.test/shopping');
  await page.waitForFunction(() => Boolean(window.authModuleHydrationState));
  const state = await page.evaluate(() => window.authModuleHydrationState);
  assert.deepEqual(state, {
    activeModule: 'tasks',
    pathname: '/',
    shoppingMainHidden: true,
    tasksMainHidden: false,
  });

  await page.evaluate(() => window.moduleShell.navigateToModule('recipes'));
  assert.deepEqual(await page.evaluate(() => ({
    pathname: location.pathname,
    moduleId: history.state?.moduleId,
    activeModule: window.moduleShell.getActiveModule(),
  })), {
    pathname: '/',
    moduleId: 'recipes',
    activeModule: 'recipes',
  });

  await page.evaluate(() => window.moduleShell.navigateToModule('tasks'));
  await page.evaluate(() => history.back());
  await page.waitForFunction(() => window.moduleShell.getActiveModule() === 'recipes');
  assert.equal(new URL(page.url()).pathname, '/', 'Back must keep the visible base URL');
  assert.equal(await page.evaluate(() => history.state?.moduleId), 'recipes');

  await page.evaluate(() => history.forward());
  await page.waitForFunction(() => window.moduleShell.getActiveModule() === 'tasks');
  assert.equal(new URL(page.url()).pathname, '/', 'Forward must keep the visible base URL');
  assert.equal(await page.evaluate(() => history.state?.moduleId), 'tasks');
} finally {
  await browser.close();
}

console.log('✅ Authentication hydration reapplies account module preferences');
