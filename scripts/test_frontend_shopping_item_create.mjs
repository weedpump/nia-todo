#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const shoppingModuleSource = readFileSync(new URL('../web/static/js/modules/shopping.js', import.meta.url), 'utf8');
const shoppingDialogsSource = readFileSync(new URL('../web/static/js/modules/shopping-dialogs.js', import.meta.url), 'utf8');
assert.match(shoppingModuleSource, /renderModulePrimaryAction/);
assert.match(shoppingModuleSource, /data-shopping-item-action/);
assert.match(shoppingDialogsSource, /id="shopping-item-modal"/);
assert.match(shoppingDialogsSource, /icon:\s*'shopping-cart'/, 'the item modal must use a bundled shopping icon');
assert.doesNotMatch(shoppingDialogsSource, /icon:\s*'shopping-basket'/, 'unknown icon names fall back to the placeholder circle');
assert.match(shoppingDialogsSource, /id="shopping-item-section"[^>]*data-ui-select/);
assert.match(shoppingDialogsSource, /id="shopping-item-store"[^>]*data-ui-select/);

const fixtureSource = `
  import { initI18n, translatePage } from '/static/js/i18n/index.js';
  import { SHOPPING_DIALOGS_HTML } from '/static/js/modules/shopping-dialogs.js';
  import { createShoppingItemsController } from '/static/js/features/shopping-items.js';
  import { createShoppingItemCreateFeature } from '/static/js/features/shopping-item-create.js';
  import { createShoppingNavigationFeature } from '/static/js/features/shopping-navigation.js';

  localStorage.setItem('nia-todo-language', 'de');
  await initI18n();
  let activeListId = 2;
  let lists = [
    { id: 1, name: 'Einkauf', can_edit: true, can_manage: false, sections: [{ id: 'produce', name: 'Obst & Gemüse', sort_order: 0 }], items: [] },
    { id: 2, name: 'Nur lesen', can_edit: 'true', can_manage: true, sections: [], items: [] },
  ];
  let stores = [];
  let navigation = null;
  const commits = [];
  let deferredCommit = null;
  const commitMutation = async build => {
    if (deferredCommit) await deferredCommit.promise;
    const mutation = typeof build === 'function' ? build() : build;
    if (!mutation) return null;
    commits.push(structuredClone(mutation));
    return mutation;
  };
  document.body.innerHTML = \`
    <button type="button" class="ui-module-primary-action" data-shopping-item-action="open-create">+</button>
    <div id="shopping-list-sidebar"></div>
    <div id="shopping-navigation-main"></div>
  \`;
  const itemController = createShoppingItemsController({
    getLists: () => lists,
    setLists: next => { lists = next; navigation?.replaceLists(next); },
    getActiveListId: () => activeListId,
    getStores: () => stores,
    commitMutation,
    render: () => navigation?.render(),
    createTempId: () => 'temp-shopping-item-browser',
  });
  navigation = createShoppingNavigationFeature({
    getLists: () => lists,
    itemController,
    closeSidebar: () => {},
    onAdd: () => {},
    onDetail: () => {},
  });
  navigation.bind();
  navigation.replaceLists(lists);
  navigation.selectList(activeListId, { updateNavigation: false });
  const feature = createShoppingItemCreateFeature({
    document,
    eventTarget: window,
    getLists: () => lists,
    getActiveListId: () => activeListId,
    getStores: () => stores,
    setStores: next => { stores = next; },
    commitMutation,
    itemController,
    createStoreTempId: () => 'temp-shopping-store-browser',
  });
  feature.bind();
  document.body.insertAdjacentHTML('beforeend', SHOPPING_DIALOGS_HTML);
  translatePage(document);
  window.test = {
    setActive: id => { activeListId = id; navigation.selectList(id, { updateNavigation: false }); feature.reconcile(); },
    deferNextCommit: () => {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      deferredCommit = { promise, release };
    },
    releaseCommit: () => {
      deferredCommit?.release();
      deferredCommit = null;
    },
    lists: () => lists,
    stores: () => stores,
    commits: () => commits,
  };
`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error?.stack || error)));
  await page.route('http://shopping-create.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/static/style.css"></head><body><script type="module" src="/fixture.js"></script></body></html>' });
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: fixtureSource });
    if (url.pathname.startsWith('/static/')) {
      try {
        const body = readFileSync(new URL(`../web${url.pathname}`, import.meta.url), 'utf8');
        const contentType = url.pathname.endsWith('.json') ? 'application/json' : (url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
        return route.fulfill({ contentType, body });
      } catch {
        return route.fulfill({ status: 404, contentType: 'text/plain', body: `Missing fixture asset: ${url.pathname}` });
      }
    }
    return route.fulfill({ status: 404, body: `Unexpected request: ${url.pathname}` });
  });

  await page.goto('http://shopping-create.test/');
  await page.waitForFunction(() => Boolean(window.test));
  const trigger = page.locator('[data-shopping-item-action="open-create"]');
  await trigger.click();
  assert.equal(await page.locator('#shopping-item-modal').getAttribute('aria-hidden'), 'true', 'non-boolean can_edit must fail closed');

  await page.evaluate(() => window.test.setActive(1));
  await trigger.click();
  const modal = page.locator('#shopping-item-modal');
  await modal.waitFor({ state: 'visible' });
  assert.equal(await modal.getAttribute('role'), 'dialog');
  assert.equal(await modal.getAttribute('aria-modal'), 'true');
  assert.equal(await page.locator('#shopping-item-name').evaluate(element => document.activeElement === element), true, 'item name receives initial focus');
  assert.deepEqual(await page.locator('#shopping-item-section option').allTextContents(), ['Ohne Abschnitt', 'Obst & Gemüse']);
  assert.deepEqual(await page.locator('#shopping-item-store option').allTextContents(), ['Kein Supermarkt']);

  const storeTrigger = page.locator('[data-select-id="shopping-item-store"] .ui-select-trigger');
  await storeTrigger.click();
  await storeTrigger.press('Escape');
  assert.equal(await modal.getAttribute('aria-hidden'), 'false', 'the first Escape closes only the open dropdown');
  await page.locator('#shopping-item-name').press('Escape');
  await page.waitForFunction(() => document.querySelector('#shopping-item-modal')?.getAttribute('aria-hidden') === 'true');
  assert.equal(await trigger.evaluate(element => document.activeElement === element), true, 'Escape from the modal restores focus to the shared FAB');
  await trigger.click();

  await storeTrigger.click();
  const addStoreAction = page.locator('.ui-select-action');
  await addStoreAction.waitFor({ state: 'visible' });
  assert.match((await addStoreAction.textContent()).trim(), /Supermarkt hinzufügen/);
  await addStoreAction.click();
  const storeName = page.locator('#shopping-item-new-store-name');
  assert.equal(await storeName.isVisible(), true);
  assert.equal(await storeName.evaluate(element => document.activeElement === element), true, 'store action moves focus into the inline store form');
  await storeName.fill('REWE');
  await page.locator('[data-shopping-item-create-action="save-store"]').click();
  assert.equal(await page.locator('#shopping-item-store').inputValue(), 'temp-shopping-store-browser');
  assert.deepEqual(await page.evaluate(() => window.test.stores().map(store => [store.id, store.name, store.is_pending])), [['temp-shopping-store-browser', 'REWE', true]]);
  assert.equal(await page.evaluate(() => window.test.commits()[0].action), 'CREATE_SHOPPING_STORE');

  await page.locator('#shopping-item-name').fill('Tomaten');
  await page.locator('#shopping-item-quantity').fill('0');
  await page.locator('#shopping-item-unit').fill('Stück');
  await page.locator('#shopping-item-section').selectOption('produce');
  await page.locator('#shopping-item-unit').press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('#shopping-item-modal')?.getAttribute('aria-hidden') === 'true');
  const created = await page.evaluate(() => window.test.lists()[0].items[0]);
  assert.deepEqual(
    { name: created.name, quantity: created.quantity_value, unit: created.quantity_unit, section: created.section_id, stores: created.store_ids },
    { name: 'Tomaten', quantity: 0, unit: 'Stück', section: 'produce', stores: ['temp-shopping-store-browser'] },
  );
  assert.equal(await page.evaluate(() => window.test.commits()[1].action), 'CREATE_SHOPPING_ITEM');
  assert.deepEqual(await page.locator('.shopping-item-title').allTextContents(), ['Tomaten'], 'the production shopping renderer must show the durable item immediately');
  assert.equal(await trigger.evaluate(element => document.activeElement === element), true, 'closing restores focus to the shared FAB');

  await trigger.click();
  await page.locator('[data-select-id="shopping-item-store"] .ui-select-trigger').click();
  await addStoreAction.click();
  await storeName.fill('Aldi');
  await page.evaluate(() => window.test.deferNextCommit());
  await page.locator('[data-shopping-item-create-action="save-store"]').click();
  await page.evaluate(() => window.test.setActive(2));
  await page.evaluate(() => window.test.releaseCommit());
  await page.waitForTimeout(0);
  assert.deepEqual(await page.evaluate(() => window.test.stores().map(store => store.name)), ['REWE'], 'permission loss while waiting for durable store commit must cancel creation');
  await page.evaluate(() => window.test.setActive(1));

  await page.setViewportSize({ width: 320, height: 700 });
  await trigger.click();
  const mobile = await modal.evaluate(element => ({
    fits: document.documentElement.scrollWidth <= innerWidth,
    width: element.getBoundingClientRect().width,
    saveVisible: Boolean(element.querySelector('#shopping-item-save-btn')),
    closeVisible: Boolean(element.querySelector('.modal-close-x')),
  }));
  assert.equal(mobile.fits, true);
  assert(mobile.width <= 320);
  assert.equal(mobile.saveVisible, true);
  assert.equal(mobile.closeVisible, true);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}

console.log('✅ Shopping item create modal, section/store selection and shared FAB passed');
