#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const authSessionSource = readFileSync(new URL('../web/static/js/features/auth-session.js', import.meta.url), 'utf8');
const moduleShellSource = readFileSync(new URL('../web/static/js/features/module-shell.js', import.meta.url), 'utf8');
const moduleSwitcherSource = readFileSync(new URL('../web/static/js/features/module-switcher.js', import.meta.url), 'utf8');
const moduleSwitcherCss = readFileSync(new URL('../web/static/css/09-module-switcher.css', import.meta.url), 'utf8');
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

const html = `<!doctype html><html><head><style>${moduleSwitcherCss}</style></head><body>
  <div id="app"></div>
  <div id="workspace-switcher"></div>
  <div class="module-switcher" id="module-switcher">
    <button class="module-switcher-button" id="module-switcher-button" data-module-action="toggle" aria-haspopup="menu" aria-expanded="false" aria-label="moduleSwitcher.toggle" data-i18n-aria-label-key="moduleSwitcher.toggle">
      <span id="module-switcher-current-icon"></span>
      <strong id="module-switcher-current-name"></strong>
      <svg class="module-switcher-chevron" hidden></svg>
    </button>
    <div id="module-switcher-menu"></div>
  </div>
  <input id="search-input"><button id="search-toggle-btn"></button>
  ${slotIds.map(id => `<div id="${id}"></div>`).join('')}
  <script type="module">
    import { createAuthSessionFeature } from '/static/js/features/auth-session.js';
    import { createModuleShell } from '/static/js/features/module-shell.js';
    import { createModuleSwitcher } from '/static/js/features/module-switcher.js';
    import { translatePage } from '/static/js/i18n/index.js';

    localStorage.setItem('jwt_token', 'cached-token');
    localStorage.setItem('nia-active-module', 'shopping');
    localStorage.setItem('cached_user', JSON.stringify({
      id: 1,
      username: 'tester',
      disabled_modules: ['shopping'],
    }));

    let currentUser = null;
    let switcher = null;
    const shell = createModuleShell({
      getUser: () => currentUser,
      onActiveModuleChange: moduleId => switcher?.syncActiveModule(moduleId),
    });
    switcher = createModuleSwitcher({
      getModules: () => shell.getEnabledModules(),
      onModuleChange: moduleId => shell.navigateToModule(moduleId),
    });
    window.moduleShell = shell;
    shell.bind();
    switcher.bind();
    window.addEventListener('nia-language-change', () => translatePage(document));

    const auth = createAuthSessionFeature({
      authApi: { me: async () => { throw new Error('cached path expected'); } },
      getAppInitialized: () => false,
      setCurrentUser: next => { currentUser = next; },
      onCurrentUserChange: () => {
        shell.applyModulePreferences();
        switcher.render();
      },
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
    window.applySingleModulePreference = () => {
      currentUser = { ...currentUser, disabled_modules: ['shopping', 'recipes'] };
      shell.applyModulePreferences();
      switcher.render();
    };
    window.applyMultipleModulePreference = () => {
      currentUser = { ...currentUser, disabled_modules: ['shopping'] };
      shell.applyModulePreferences();
      switcher.render();
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
      '/static/js/features/module-switcher.js': moduleSwitcherSource,
      '/static/js/modules/visibility.js': visibilitySource,
      '/static/js/modules/registry.js': `
        export const MODULES = [
          { id: 'tasks', labelKey: 'module.tasks.label', descriptionKey: 'module.tasks.description', icon: 'tasks', capabilities: { workspaces: true }, render() {} },
          { id: 'shopping', labelKey: 'module.shopping.label', descriptionKey: 'module.shopping.description', icon: 'shopping', capabilities: {}, render() {} },
          { id: 'recipes', labelKey: 'module.recipes.label', descriptionKey: 'module.recipes.description', icon: 'recipes', capabilities: {}, render() {} },
        ];
        export const getModule = id => MODULES.find(module => module.id === id) || MODULES[0];
        export const isModuleId = id => MODULES.some(module => module.id === id);
        export const persistModule = id => localStorage.setItem('nia-active-module', id);
        export const readStoredModule = () => localStorage.getItem('nia-active-module') || 'tasks';
      `,
      '/static/js/api/http.js': "export const getAuthToken=()=>localStorage.getItem('jwt_token'); export const getCsrfToken=()=>null; export const getAuthHeaders=()=>({}); export const getJsonHeaders=()=>({});",
      '/static/js/core/config.js': "export const API=''; export const RUNTIME_CAPABILITIES={ native:false };",
      '/static/js/features/native-bridge.js': "export const createNativeBridge=()=>({});",
      '/static/js/icons/nia-product-icons.js': "export const niaIconSvg=name=>'<svg data-module-icon=\"'+name+'\"></svg>';",
      '/static/js/i18n/index.js': "export const t=key=>key; export const translatePage=scope=>scope.querySelectorAll('[data-i18n-aria-label-key]').forEach(element=>element.setAttribute('aria-label',element.dataset.i18nAriaLabelKey));",
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

  const multiModuleState = await page.evaluate(() => {
    const button = document.getElementById('module-switcher-button');
    button.click();
    return {
      buttonDisabled: button.disabled,
      hasPopup: button.getAttribute('aria-haspopup'),
      expanded: button.getAttribute('aria-expanded'),
      chevronHidden: document.querySelector('.module-switcher-chevron').hasAttribute('hidden'),
      chevronDisplay: getComputedStyle(document.querySelector('.module-switcher-chevron')).display,
      menuHidden: document.getElementById('module-switcher-menu').hidden,
      menuOpen: document.getElementById('module-switcher-menu').classList.contains('open'),
    };
  });
  assert.deepEqual(multiModuleState, {
    buttonDisabled: false,
    hasPopup: 'menu',
    expanded: 'true',
    chevronHidden: false,
    chevronDisplay: 'block',
    menuHidden: false,
    menuOpen: true,
  }, 'multiple enabled modules must retain the interactive module menu');
  await page.evaluate(() => document.body.click());

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

  await page.evaluate(() => window.applySingleModulePreference());
  await page.evaluate(() => window.dispatchEvent(new Event('nia-language-change')));
  const singleModuleState = await page.evaluate(() => {
    const root = document.getElementById('module-switcher');
    const button = document.getElementById('module-switcher-button');
    const menu = document.getElementById('module-switcher-menu');
    const chevron = document.querySelector('.module-switcher-chevron');
    button.click();
    return {
      rootHidden: root.hidden,
      switchingAvailable: root.dataset.switchingAvailable,
      buttonDisabled: button.disabled,
      hasPopup: button.hasAttribute('aria-haspopup'),
      hasToggleLabel: button.hasAttribute('aria-label'),
      expanded: button.getAttribute('aria-expanded'),
      chevronHidden: chevron.hasAttribute('hidden'),
      menuHidden: menu.hidden,
      menuOpen: menu.classList.contains('open'),
      name: document.getElementById('module-switcher-current-name').textContent,
      icon: document.getElementById('module-switcher-current-icon').innerHTML,
      chevronDisplay: getComputedStyle(chevron).display,
      buttonPointerEvents: getComputedStyle(button).pointerEvents,
      buttonTransform: getComputedStyle(button).transform,
    };
  });
  assert.deepEqual(singleModuleState, {
    rootHidden: false,
    switchingAvailable: 'false',
    buttonDisabled: true,
    hasPopup: false,
    hasToggleLabel: false,
    expanded: 'false',
    chevronHidden: true,
    menuHidden: true,
    menuOpen: false,
    name: 'module.tasks.label',
    icon: '<svg data-module-icon="tasks"></svg>',
    chevronDisplay: 'none',
    buttonPointerEvents: 'none',
    buttonTransform: 'none',
  }, 'one enabled module must retain static module branding without switcher interaction');

  await page.evaluate(() => window.applyMultipleModulePreference());
  const restoredSwitcherState = await page.evaluate(() => {
    const button = document.getElementById('module-switcher-button');
    button.click();
    return {
      buttonDisabled: button.disabled,
      hasPopup: button.getAttribute('aria-haspopup'),
      hasToggleLabel: button.hasAttribute('aria-label'),
      expanded: button.getAttribute('aria-expanded'),
      menuOpen: document.getElementById('module-switcher-menu').classList.contains('open'),
      chevronDisplay: getComputedStyle(document.querySelector('.module-switcher-chevron')).display,
    };
  });
  assert.deepEqual(restoredSwitcherState, {
    buttonDisabled: false,
    hasPopup: 'menu',
    hasToggleLabel: true,
    expanded: 'true',
    menuOpen: true,
    chevronDisplay: 'block',
  }, 're-enabling another module must restore the interactive switcher');
} finally {
  await browser.close();
}

console.log('✅ Authentication hydration reapplies account module preferences');
