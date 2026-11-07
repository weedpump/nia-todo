#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const source = readFileSync(new URL('../web/static/js/features/module-switcher.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://module-switcher.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/static/js/features/module-switcher.js') return route.fulfill({ contentType: 'text/javascript', body: source });
    if (path === '/static/js/icons/nia-product-icons.js') return route.fulfill({ contentType: 'text/javascript', body: 'export const niaIconSvg = () => "";' });
    if (path === '/static/js/i18n/index.js') return route.fulfill({ contentType: 'text/javascript', body: 'export const t = key => (window.testLanguage || "en") + ":" + key;' });
    if (path === '/static/js/modules/registry.js') return route.fulfill({ contentType: 'text/javascript', body: `
      export const MODULES = ['tasks', 'shopping', 'recipes'].map(id => ({ id, icon: id, labelKey: id + '.label', descriptionKey: id + '.description' }));
      export const getModule = id => MODULES.find(module => module.id === id) || MODULES[0];
      export const isModuleId = id => MODULES.some(module => module.id === id);
      export const readStoredModule = () => localStorage.getItem('nia-active-module') || 'tasks';
      export const persistModule = id => localStorage.setItem('nia-active-module', id);
    ` });
    if (path !== '/') return route.fulfill({ status: 404, body: 'Unknown fixture asset' });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>
      #module-switcher-menu:not(.open) { display: none; }
    </style></head><body><div id="app"><div id="module-switcher">
      <button id="module-switcher-button" data-module-action="toggle"><span id="module-switcher-current-icon"></span><span id="module-switcher-current-name"></span><span class="module-switcher-chevron"></span></button>
      <div id="module-switcher-menu"></div>
    </div></div><script type="module">
      import { createModuleSwitcher } from '/static/js/features/module-switcher.js';
      import { MODULES } from '/static/js/modules/registry.js';
      let available = MODULES;
      const feature = createModuleSwitcher({ getModules: () => available, onModuleChange: id => feature.syncActiveModule(id) });
      feature.bind();
      window.test = { feature, setModules: ids => { available = MODULES.filter(module => ids.includes(module.id)); feature.render(); } };
    </script></body></html>` });
  });
  await page.goto('http://module-switcher.test/');
  await page.waitForFunction(() => Boolean(window.test));
  const trigger = page.locator('#module-switcher-button');
  const menu = page.locator('#module-switcher-menu');
  const option = id => page.locator(`[data-module-action="select"][data-module-id="${id}"]`);

  await trigger.click();
  await option('shopping').focus();
  await page.evaluate(() => {
    window.focusedBeforeRefresh = document.activeElement;
    for (let index = 0; index < 3; index++) {
      window.test.feature.render();
      window.test.feature.syncActiveModule('tasks');
    }
  });
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true', 'same-state access/workspace refresh must preserve an open menu');
  assert.equal(await page.evaluate(() => document.activeElement === window.focusedBeforeRefresh && window.focusedBeforeRefresh.isConnected), true,
    'same-state refresh must retain the actual focused option node');
  await option('shopping').click();
  assert.equal(await page.locator('#app').getAttribute('data-active-module'), 'shopping', 'the focused option remains actionable after background refresh');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'a genuine user module change closes the menu');

  await trigger.click();
  await option('recipes').focus();
  await page.evaluate(() => {
    window.testLanguage = 'de';
    window.dispatchEvent(new CustomEvent('nia-language-change'));
  });
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true', 'translation refresh preserves an open menu');
  assert.equal(await option('recipes').evaluate(element => element === document.activeElement), true, 'translation refresh restores focus to the corresponding option');
  assert.equal(await option('recipes').locator('strong').textContent(), 'de:recipes.label');
  await page.evaluate(() => window.test.feature.syncActiveModule('tasks'));
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'an authoritative active-module change closes the menu');

  await trigger.click();
  await page.evaluate(() => window.test.setModules(['tasks', 'shopping']));
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'disabling a module closes the menu even when the active module remains enabled');
  assert.equal(await option('recipes').count(), 0);
  await trigger.click();
  await page.evaluate(() => window.test.setModules(['tasks']));
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(await trigger.isDisabled(), true, 'one remaining module disables switching');
  assert.equal(await menu.isHidden(), true);
  assert.equal(await menu.locator('[data-module-action="select"]').count(), 0);
  assert.deepEqual(errors, [], 'refreshing the real switcher must not throw browser exceptions');
} finally {
  await browser.close();
}

console.log('✅ Module switcher preserves open menu/focus during unchanged background refresh');
