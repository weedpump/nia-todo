#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const tasksSource = readFileSync(new URL('../web/static/js/modules/tasks.js', import.meta.url), 'utf8');
const shoppingSource = readFileSync(new URL('../web/static/js/modules/shopping.js', import.meta.url), 'utf8');
const userMenuSource = readFileSync(new URL('../web/static/js/features/user-menu.js', import.meta.url), 'utf8');
const iconsSource = readFileSync(new URL('../web/static/js/icons/lucide-generated.js', import.meta.url), 'utf8');
assert.match(tasksSource, /renderTopbarToggle/);
assert.match(shoppingSource, /renderTopbarToggle/);
assert.match(shoppingSource, /searchEnabled:\s*true/);
assert.match(shoppingSource, /icon:\s*'layers-minus'/);
assert.match(iconsSource, /"layers-minus"/);
assert.doesNotMatch(iconsSource, /"eye-off"/);
assert.doesNotMatch(tasksSource, /class="today-focus-btn"|class="minimal-todos-btn"/);
assert.doesNotMatch(tasksSource, /id="toggle-done-btn"[\s\S]*data-user-menu-action="toggle-done"/, 'completed visibility must leave the Tasks user menu');
assert.doesNotMatch(userMenuSource, /toggle-done|toggleHideDone/, 'the retired user-menu action must not remain as a second completed-visibility controller');
assert.match(tasksSource, /id:\s*'tasks-completed-visibility-btn'[\s\S]*data-completed-visibility-toggle/, 'Tasks must render the shared completed visibility toggle as its third topbar action');
assert.match(shoppingSource, /id:\s*'shopping-completed-visibility-btn'[\s\S]*data-completed-visibility-toggle/, 'Shopping must render the same shared completed visibility toggle');

const fixtureSource = `
  import { initI18n } from '/static/js/i18n/index.js';
  import { createModuleShell } from '/static/js/features/module-shell.js';
  import { createCompletedVisibilityFeature } from '/static/js/features/completed-visibility.js';
  import { openUiLayer } from '/static/js/features/ui-history.js';
  localStorage.setItem('nia-todo-language', 'de');
  localStorage.setItem('nia-active-module', 'tasks');
  await initI18n();
  document.body.innerHTML = \`
    <div id="app">
      <div id="search-box" class="search-box">
        <button id="search-toggle-btn" class="search-toggle-btn" type="button">Search</button>
        <input id="search-input" type="search">
      </div>
      <div id="workspace-switcher" class="workspace-switcher topbar-workspace-switcher">
        <button id="workspace-current-btn" aria-expanded="false">Workspace</button>
        <div id="workspace-menu"></div>
      </div>
      <div id="module-switcher"></div>
      <div id="module-sidebar-slot"></div>
      <div id="module-topbar-slot"></div>
      <div id="module-main-slot"></div>
      <div id="module-floating-slot"></div>
      <div id="module-user-menu-slot"></div>
      <div id="module-shortcuts-slot"></div>
      <div id="module-settings-nav-slot"></div>
      <div id="module-settings-slot"></div>
      <div id="module-desktop-hotkeys-slot"></div>
    </div>
  \`;
  const shell = createModuleShell({ getUser: () => ({ disabled_modules: ['recipes'] }) });
  shell.bind();
  let hideDone = true;
  const completedVisibility = createCompletedVisibilityFeature({
    getHidden: () => hideDone,
    setHidden: value => { hideDone = value; },
    root: document,
    storage: localStorage,
    translate: key => key,
  });
  completedVisibility.bind();
  completedVisibility.updateButtons();
  window.test = {
    navigate: id => shell.navigateToModule(id),
    active: () => shell.getActiveModule(),
    openSearchLayer: () => openUiLayer('mobile-search'),
    search: value => shell.handleSearch(value),
  };
`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error?.stack || error)));
try {
  await page.route('http://nia.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/static/style.css"></head><body><script type="module" src="/fixture.js"></script></body></html>' });
      return;
    }
    if (url.pathname === '/fixture.js') {
      await route.fulfill({ contentType: 'text/javascript', body: fixtureSource });
      return;
    }
    if (url.pathname.startsWith('/static/')) {
      try {
        const body = readFileSync(new URL(`../web${url.pathname}`, import.meta.url), 'utf8');
        const contentType = url.pathname.endsWith('.json') ? 'application/json' : (url.pathname.endsWith('.css') ? 'text/css' : (url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript'));
        await route.fulfill({ contentType, body });
      } catch {
        await route.fulfill({ status: 404, contentType: 'text/plain', body: `Missing fixture asset: ${url.pathname}` });
      }
      return;
    }
    await route.fulfill({ status: 404, contentType: 'text/plain', body: `Unexpected fixture request: ${url.pathname}` });
  });

  await page.goto('http://nia.test/');
  await page.waitForFunction(() => Boolean(window.test));
  assert.equal(await page.evaluate(() => document.documentElement.clientWidth), 390, 'the mobile fixture must use the physical viewport rather than a scaled desktop layout viewport');
  assert.equal(await page.evaluate(() => window.test.active()), 'tasks');
  assert.equal(await page.locator('#today-focus-btn.ui-topbar-toggle').count(), 1);
  assert.equal(await page.locator('#minimal-todos-btn.ui-topbar-toggle').count(), 1);
  assert.equal(await page.locator('#tasks-completed-visibility-btn.ui-topbar-toggle').count(), 1);
  assert.deepEqual(await page.locator('[data-module-panel="tasks"][data-module-slot="topbar"] .ui-topbar-toggle').evaluateAll(elements => elements.map(element => element.id)), [
    'today-focus-btn',
    'minimal-todos-btn',
    'tasks-completed-visibility-btn',
  ]);
  assert.equal(await page.locator('[data-module-panel="tasks"][data-module-slot="userMenu"] [data-completed-visibility-toggle]').count(), 0);
  assert.equal(await page.locator('#tasks-completed-visibility-btn').getAttribute('aria-pressed'), 'false');
  await page.locator('#tasks-completed-visibility-btn').click();
  assert.equal(await page.locator('#tasks-completed-visibility-btn').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => localStorage.getItem('nia-hide-done')), 'false');
  assert.equal(await page.locator('#workspace-switcher').evaluate(element => getComputedStyle(element).display !== 'none'), true);
  assert.equal(await page.locator('#search-box').evaluate(element => getComputedStyle(element).display !== 'none'), true);

  await page.evaluate(() => {
    const box = document.getElementById('search-box');
    const input = document.getElementById('search-input');
    const workspaceMenu = document.getElementById('workspace-menu');
    box.classList.add('open');
    window.test.openSearchLayer();
    input.value = 'remember this task query';
    input.focus();
    workspaceMenu.classList.add('open');
    document.getElementById('workspace-current-btn').setAttribute('aria-expanded', 'true');
    window.test.navigate('shopping');
  });

  assert.equal(await page.locator('#shopping-hide-empty-sections-btn.ui-topbar-toggle').count(), 1);
  assert.equal(await page.locator('#shopping-completed-visibility-btn.ui-topbar-toggle').count(), 1);
  assert.deepEqual(await page.locator('[data-module-panel="shopping"][data-module-slot="topbar"] .ui-topbar-toggle').evaluateAll(elements => elements.map(element => element.id)), [
    'shopping-hide-empty-sections-btn',
    'shopping-completed-visibility-btn',
  ]);
  assert.equal(await page.locator('#shopping-completed-visibility-btn').getAttribute('aria-pressed'), 'true', 'the Shopping entrypoint must hydrate the state changed from Tasks');
  assert.equal(await page.locator('#search-box').getAttribute('hidden'), null);
  assert.notEqual(await page.locator('#search-box').evaluate(element => getComputedStyle(element).display), 'none');
  assert.equal(await page.locator('#workspace-switcher').getAttribute('hidden'), '');
  assert.equal(await page.locator('#workspace-switcher').evaluate(element => getComputedStyle(element).display), 'none');
  assert.equal(await page.locator('#search-box').evaluate(element => element.classList.contains('open')), true);
  assert.equal(await page.locator('#search-input').inputValue(), '');
  assert.equal(await page.locator('#search-input').evaluate(element => document.activeElement === element), true);
  assert.equal(await page.locator('#workspace-menu').evaluate(element => element.classList.contains('open')), false);
  assert.equal(await page.locator('#workspace-current-btn').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(await page.evaluate(() => history.state?.niaTodoUi?.layers || []), ['mobile-search'], 'switching between searchable modules must keep the active search layer');
  await page.locator('#shopping-completed-visibility-btn').click();
  assert.equal(await page.locator('#shopping-completed-visibility-btn').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => localStorage.getItem('nia-hide-done')), 'true');

  await page.locator('#search-input').fill('milk');
  await page.evaluate(() => window.test.search('milk'));

  await page.evaluate(() => window.test.navigate('tasks'));
  assert.equal(await page.locator('#search-box').evaluate(element => getComputedStyle(element).display !== 'none'), true);
  assert.equal(await page.locator('#tasks-completed-visibility-btn').getAttribute('aria-pressed'), 'false', 'the Tasks entrypoint must reflect the state changed from Shopping');
  assert.equal(await page.locator('#search-input').inputValue(), 'remember this task query');
  await page.evaluate(() => window.test.navigate('shopping'));
  assert.equal(await page.locator('#search-input').inputValue(), 'milk');
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
} finally {
  await browser.close();
}

console.log('✅ Module topbar parity and capability cleanup contracts passed');
