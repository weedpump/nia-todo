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
assert.match(shoppingDialogsSource, /data-shopping-item-editor-action="delete"/);

const fixtureSource = `
  import { initI18n, translatePage } from '/static/js/i18n/index.js';
  import { SHOPPING_DIALOGS_HTML } from '/static/js/modules/shopping-dialogs.js';
  import { createShoppingItemsController } from '/static/js/features/shopping-items.js';
  import { createShoppingItemEditorFeature } from '/static/js/features/shopping-item-editor.js';
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
  let editor = null;
  const commits = [];
  let confirmations = 0;
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
    onEdit: (listId, itemId, triggerElement) => editor?.showEdit?.(listId, itemId, triggerElement),
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
  editor = createShoppingItemEditorFeature({
    document,
    eventTarget: window,
    getLists: () => lists,
    getActiveListId: () => activeListId,
    getStores: () => stores,
    setStores: next => { stores = next; },
    commitMutation,
    itemController,
    confirmDanger: async () => { confirmations += 1; return true; },
    createStoreTempId: () => 'temp-shopping-store-browser',
  });
  editor.bind();
  document.body.insertAdjacentHTML('beforeend', SHOPPING_DIALOGS_HTML);
  translatePage(document);
  window.test = {
    setActive: id => { activeListId = id; navigation.selectList(id, { updateNavigation: false }); editor.reconcile(); },
    deferNextCommit: () => {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      deferredCommit = { promise, release };
    },
    releaseCommit: () => {
      deferredCommit?.release();
      deferredCommit = null;
    },
    remapCreatedItem: () => {
      lists = lists.map(list => list.id !== 1 ? list : {
        ...list,
        items: list.items.map(item => item.id !== 'temp-shopping-item-browser' ? item : {
          ...item,
          id: 42,
          client_mutation_id: 'temp-shopping-item-browser',
        }),
      });
      navigation.replaceLists(lists);
      navigation.render();
      editor.reconcile();
    },
    lists: () => lists,
    stores: () => stores,
    commits: () => commits,
    confirmations: () => confirmations,
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

  await page.locator('.shopping-item-edit-trigger').click();
  await modal.waitFor({ state: 'visible' });
  assert.equal((await page.locator('#shopping-item-modal-title').textContent()).trim(), 'Artikel bearbeiten');
  assert.equal(await page.locator('#shopping-item-detail-menu-toggle').isVisible(), true);
  assert.equal(await page.locator('#shopping-item-name').inputValue(), 'Tomaten');
  assert.equal(await page.locator('#shopping-item-quantity').inputValue(), '0');
  assert.equal(await page.locator('#shopping-item-unit').inputValue(), 'Stück');
  assert.equal(await page.locator('#shopping-item-section').inputValue(), 'produce');
  assert.equal(await page.locator('#shopping-item-store').inputValue(), 'temp-shopping-store-browser');
  await page.evaluate(() => window.test.remapCreatedItem());
  await page.locator('#shopping-item-name').fill('Kirschtomaten');
  await page.locator('#shopping-item-quantity').fill('2');
  await page.locator('#shopping-item-save-btn').click();
  await page.waitForFunction(() => document.querySelector('#shopping-item-modal')?.getAttribute('aria-hidden') === 'true');
  assert.equal(await page.evaluate(() => window.test.commits().at(-1).action), 'UPDATE_SHOPPING_ITEM');
  assert.equal(await page.evaluate(() => window.test.commits().at(-1).data.item_id), 42, 'an open editor must follow the item Temp-ID to its server ID');
  assert.deepEqual(await page.locator('.shopping-item-title').allTextContents(), ['Kirschtomaten']);
  assert.deepEqual(await page.locator('.shopping-item-quantity').allTextContents(), ['2 Stück']);
  assert.equal(await page.locator('.shopping-item-edit-trigger').evaluate(element => document.activeElement === element), true, 'saving a remapped edit restores focus to the live item');

  await page.setViewportSize({ width: 320, height: 700 });
  await page.locator('.shopping-item-edit-trigger').click();
  await page.locator('#shopping-item-name').fill('Mobile Tomaten');
  const mobileEditHeader = await page.locator('#shopping-item-modal .ui-detail-modal-header').evaluate(header => {
    const selectors = ['#shopping-item-save-btn', '#shopping-item-detail-menu-toggle', '.modal-close-x'];
    const boxes = selectors.map(selector => {
      const rect = header.querySelector(selector).getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    });
    return {
      fits: document.documentElement.scrollWidth <= innerWidth,
      boxes,
      viewportWidth: innerWidth,
    };
  });
  assert.equal(mobileEditHeader.fits, true);
  assert(mobileEditHeader.boxes.every(box => box.width > 0 && box.left >= 0 && box.right <= mobileEditHeader.viewportWidth));
  assert(mobileEditHeader.boxes[0].right <= mobileEditHeader.boxes[1].left, 'mobile Save and overflow controls must not overlap');
  assert(mobileEditHeader.boxes[1].right <= mobileEditHeader.boxes[2].left, 'mobile overflow and Close controls must not overlap');
  await page.locator('#shopping-item-save-btn').click();
  await page.waitForFunction(() => document.querySelector('#shopping-item-modal')?.getAttribute('aria-hidden') === 'true');
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.locator('.shopping-item-edit-trigger').click();
  await page.locator('#shopping-item-detail-menu-toggle summary').click();
  await page.locator('[data-shopping-item-editor-action="delete"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.shopping-item-card').length === 0);
  assert.equal(await page.evaluate(() => window.test.confirmations()), 1);
  assert.equal(await page.evaluate(() => window.test.commits().at(-1).action), 'DELETE_SHOPPING_ITEM');
  assert.equal(await modal.getAttribute('aria-hidden'), 'true');
  assert.equal(await trigger.evaluate(element => document.activeElement === element), true, 'deleting an item falls back to the shared FAB');

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

console.log('✅ Shopping item create/edit/delete modal, section/store selection and shared FAB passed');
