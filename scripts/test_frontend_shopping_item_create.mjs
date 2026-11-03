#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const shoppingModuleSource = readFileSync(new URL('../web/static/js/modules/shopping.js', import.meta.url), 'utf8');
const shoppingDialogsSource = readFileSync(new URL('../web/static/js/modules/shopping-dialogs.js', import.meta.url), 'utf8');
const shoppingItemEditorSource = readFileSync(new URL('../web/static/js/features/shopping-item-editor.js', import.meta.url), 'utf8');
const shoppingNavigationSource = readFileSync(new URL('../web/static/js/features/shopping-navigation.js', import.meta.url), 'utf8');
assert.match(shoppingModuleSource, /renderModulePrimaryAction/);
assert.match(shoppingModuleSource, /data-shopping-item-action/);
assert.match(shoppingDialogsSource, /id="shopping-item-modal"/);
assert.match(shoppingDialogsSource, /icon:\s*'shopping-cart'/, 'the item modal must use a bundled shopping icon');
assert.doesNotMatch(shoppingDialogsSource, /icon:\s*'shopping-basket'/, 'unknown icon names fall back to the placeholder circle');
assert.match(shoppingDialogsSource, /id="shopping-item-section"[^>]*data-ui-select/);
assert.match(shoppingDialogsSource, /id="shopping-item-store"[^>]*data-ui-select/);
assert.match(shoppingDialogsSource, /data-shopping-item-editor-action="delete"/);
assert.match(shoppingItemEditorSource, /shoppingStoreOptionAction/);
assert.match(shoppingNavigationSource, /shoppingStoreOptionAction/);

const fixtureSource = `
  import { initI18n, translatePage, setLanguagePreference } from '/static/js/i18n/index.js';
  import { SHOPPING_DIALOGS_HTML } from '/static/js/modules/shopping-dialogs.js';
  import { createShoppingItemsController } from '/static/js/features/shopping-items.js';
  import { createShoppingItemEditorFeature } from '/static/js/features/shopping-item-editor.js';
  import { createShoppingStoreEditorFeature } from '/static/js/features/shopping-store-editor.js';
  import { createShoppingNavigationFeature } from '/static/js/features/shopping-navigation.js';
  import { createShoppingStoresController } from '/static/js/features/shopping-stores.js';

  localStorage.setItem('nia-todo-language', 'de');
  await initI18n();
  let activeListId = 2;
  let lists = [
    { id: 1, name: 'Einkauf', can_edit: true, can_manage: false, sections: [{ id: 'produce', name: 'Obst & Gemüse', sort_order: 0 }], items: [] },
    { id: 2, name: 'Nur lesen', can_edit: 'true', can_manage: true, sections: [], items: [] },
  ];
  let stores = [{ id: 'other-list-store', shopping_list_id: 2, name: 'Other list market', active: true, sort_order: 0 }];
  let navigation = null;
  let editor = null;
  let storeEditor = null;
  const commits = [];
  let confirmations = 0;
  let itemSequence = 0;
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
    createTempId: () => itemSequence++ === 0 ? 'temp-shopping-item-browser' : 'temp-shopping-item-browser-' + itemSequence,
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
  const storeController = createShoppingStoresController({
    getStores: () => stores,
    setStores: next => { stores = next; editor?.reconcile?.(); },
    commitMutation,
    createTempId: () => 'temp-shopping-store-browser',
  });
  storeEditor = createShoppingStoreEditorFeature({
    document,
    getLists: () => lists,
    getStores: () => stores,
    storeController,
    confirmDanger: async () => { confirmations += 1; return true; },
  });
  storeEditor.bind();
  editor = createShoppingItemEditorFeature({
    document,
    eventTarget: window,
    getLists: () => lists,
    getActiveListId: () => activeListId,
    getStores: () => stores,
    storeController,
    itemController,
    confirmDanger: async () => { confirmations += 1; return true; },
    onStoreEdit: (listId, storeId, triggerElement) => storeEditor.showEdit(listId, storeId, triggerElement),
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
    setLanguage: language => setLanguagePreference(language),
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
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/static/style.css"></head><body><script type="module" src="/fixture.js"></script></body></html>' });
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
  assert.equal(await page.locator('#shopping-item-quick-add-preview').count(), 1, 'creation must mount the shared Quick Add preview');
  await page.locator('#shopping-item-name').fill('500g ');
  await page.waitForFunction(() => document.querySelector('#shopping-item-quick-add-preview .quick-add-error') !== null);
  await page.locator('#shopping-item-name').evaluate(input => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = '500g emmenta';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'emmenta' }));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: 'emmenta', isComposing: true }));
  });
  await page.waitForFunction(() => document.querySelector('#shopping-item-quick-add-preview .quantity strong')?.textContent === '500');
  assert.equal(await page.locator('#shopping-item-quick-add-preview .unit strong').textContent(), 'g');
  assert.equal(await page.locator('#shopping-item-quick-add-preview .quick-add-error').count(), 0, 'composing product text clears the previous missing-name error immediately');
  assert.equal(await page.locator('#shopping-item-name').inputValue(), '500g emmenta', 'live composition preview needs no trailing space or rewritten input');
  assert.equal(await page.locator('#shopping-item-name').evaluate(input => input.selectionStart === input.value.length && input.selectionEnd === input.value.length && document.activeElement === input), true, 'preview preserves caret and input focus');
  await page.locator('#shopping-item-name').evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'emmenta' })));
  await page.locator('#shopping-item-name').fill('2 l Milch /Obst & Gemüse');
  await page.waitForFunction(() => document.querySelectorAll('#shopping-item-quick-add-preview .quick-add-chip').length === 3);
  assert.deepEqual(await page.locator('#shopping-item-quick-add-preview strong').allTextContents(), ['2', 'l', 'Obst & Gemüse']);
  await page.locator('#shopping-item-quantity').fill('0');
  await page.waitForFunction(() => document.querySelector('#shopping-item-quick-add-preview strong')?.textContent === '0');
  await page.locator('#shopping-item-name').fill('');
  await page.locator('#shopping-item-quantity').fill('');

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
  await page.locator('[data-shopping-store-creator="shopping-item"][data-shopping-store-creator-action="save"]').click();
  assert.equal(await page.locator('#shopping-item-store').inputValue(), 'temp-shopping-store-browser');
  assert.equal(await storeTrigger.evaluate(element => document.activeElement === element), true, 'successful store creation restores focus to the item store select');
  assert.deepEqual(await page.evaluate(() => window.test.stores().map(store => [store.id, store.shopping_list_id, store.name, store.is_pending])), [
    ['other-list-store', 2, 'Other list market', undefined],
    ['temp-shopping-store-browser', 1, 'REWE', true],
  ]);
  assert.equal(await page.evaluate(() => window.test.commits()[0].action), 'CREATE_SHOPPING_STORE');
  assert.equal(await page.evaluate(() => window.test.commits()[0].data.shopping_list_id), 1);

  await storeTrigger.click();
  const itemStoreEditAction = page.locator('#shopping-item-store-ui-menu .ui-select-option-action');
  assert.equal(await itemStoreEditAction.count(), 1, 'every list content editor can edit concrete store options');
  assert.equal(await itemStoreEditAction.getAttribute('aria-label'), 'REWE bearbeiten');
  const itemStoreSearch = page.locator('#shopping-item-store-ui-menu .ui-select-search-input');
  await itemStoreSearch.fill('REWE');
  await itemStoreSearch.press('ArrowRight');
  assert.equal(await itemStoreEditAction.evaluate(element => document.activeElement === element), true, 'the searchable item-store dropdown reaches the shared edit action by keyboard');
  await itemStoreEditAction.press('Enter');
  const storeModal = page.locator('#shopping-store-modal');
  assert.equal(await storeModal.getAttribute('aria-hidden'), 'false');
  assert.equal(await modal.evaluate(element => element.classList.contains('active')), true, 'editing a store must keep the underlying item layer open');
  assert.equal(await modal.getAttribute('aria-hidden'), 'true', 'the underlying item modal must be hidden from assistive technology while the nested store editor is active');
  assert.equal(await modal.getAttribute('inert'), '', 'the underlying item modal must be inert while the nested store editor is active');
  assert.equal(await page.locator('#shopping-item-store').inputValue(), 'temp-shopping-store-browser', 'opening the store editor must not change the item store selection');
  await page.locator('#shopping-store-name').press('Escape');
  await page.waitForFunction(() => document.querySelector('#shopping-store-modal')?.getAttribute('aria-hidden') === 'true');
  assert.equal(await modal.getAttribute('aria-hidden'), 'false', 'Escape from the nested store editor must reveal only the underlying item modal');
  assert.equal(await modal.getAttribute('inert'), null);
  assert.equal(await storeTrigger.evaluate(element => document.activeElement === element), true);
  await storeTrigger.click();
  await page.locator('#shopping-item-store-ui-menu .ui-select-search-input').fill('REWE');
  await page.locator('#shopping-item-store-ui-menu .ui-select-search-input').press('ArrowRight');
  await page.locator('#shopping-item-store-ui-menu .ui-select-option-action').press('Enter');
  await page.locator('#shopping-store-name').fill('REWE Center');
  await page.locator('#shopping-store-save-btn').click();
  await page.waitForFunction(() => document.querySelector('#shopping-store-modal')?.getAttribute('aria-hidden') === 'true');
  assert.equal(await modal.getAttribute('aria-hidden'), 'false');
  assert.equal(await modal.getAttribute('inert'), null);
  assert.equal(await page.locator('#shopping-item-store').inputValue(), 'temp-shopping-store-browser', 'renaming a store must preserve the selected stable store ID');
  assert.deepEqual(await page.locator('#shopping-item-store option').allTextContents(), ['Kein Supermarkt', 'REWE Center']);
  assert.equal(await storeTrigger.evaluate(element => document.activeElement === element), true, 'closing the nested store editor restores focus to the item-modal store trigger');

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
  assert.equal(await page.evaluate(() => window.test.commits().find(commit => commit.action === 'CREATE_SHOPPING_ITEM')?.action), 'CREATE_SHOPPING_ITEM');
  assert.deepEqual(await page.locator('.shopping-item-title').allTextContents(), ['Tomaten'], 'the production shopping renderer must show the durable item immediately');
  assert.equal(await trigger.evaluate(element => document.activeElement === element), true, 'closing restores focus to the shared FAB');

  await page.locator('.shopping-item-edit-trigger').click();
  await modal.waitFor({ state: 'visible' });
  assert.equal((await page.locator('#shopping-item-modal-title').textContent()).trim(), 'Artikel bearbeiten');
  assert.equal(await page.locator('#shopping-item-detail-menu-toggle').isVisible(), true);
  await page.waitForTimeout(20);
  assert.equal(await page.locator('#shopping-item-name').evaluate(element => document.activeElement === element), false, 'editing an item must not automatically focus its title');
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
  await page.locator('#shopping-item-store-ui-menu .ui-select-option').filter({ hasText: 'REWE Center' }).click();
  assert.equal(await page.locator('#shopping-item-store').inputValue(), 'temp-shopping-store-browser');
  await page.locator('[data-select-id="shopping-item-store"] .ui-select-trigger').click();
  await page.locator('#shopping-item-store-ui-menu .ui-select-option-action').click();
  await page.locator('#shopping-store-detail-menu-trigger').click();
  await page.locator('[data-shopping-store-editor-action="delete"]').click();
  await page.waitForFunction(() => document.querySelector('#shopping-store-modal')?.getAttribute('aria-hidden') === 'true');
  assert.equal(await modal.getAttribute('aria-hidden'), 'false', 'deleting a store must return to the underlying item modal');
  assert.equal(await page.locator('#shopping-item-store').inputValue(), '', 'deleting the selected store must fall back to no store');
  assert.deepEqual(await page.locator('#shopping-item-store option').allTextContents(), ['Kein Supermarkt']);
  assert.equal(await storeTrigger.evaluate(element => document.activeElement === element), true, 'store deletion restores focus to the item-modal store trigger');
  await page.locator('[data-select-id="shopping-item-store"] .ui-select-trigger').click();
  await addStoreAction.click();
  await storeName.fill('Aldi');
  await page.evaluate(() => window.test.deferNextCommit());
  await page.locator('[data-shopping-store-creator="shopping-item"][data-shopping-store-creator-action="save"]').click();
  await page.evaluate(() => window.test.setActive(2));
  await page.evaluate(() => window.test.releaseCommit());
  await page.waitForTimeout(0);
  assert.deepEqual(await page.evaluate(() => window.test.stores().map(store => store.name)), ['Other list market', 'Aldi'], 'switching lists must not retarget or cancel a store mutation that remains authorized for its creator list');
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

  await page.locator('#shopping-item-name').fill('2 l Milch @Aldi /Obst & Gemüse');
  await page.waitForFunction(() => document.querySelectorAll('#shopping-item-quick-add-preview .quick-add-chip').length === 4);
  await page.locator('#shopping-item-quantity').fill('0');
  await page.locator('#shopping-item-unit').fill('Packungen');
  await page.waitForFunction(() => document.querySelector('#shopping-item-quick-add-preview .unit strong')?.textContent === 'Packungen');
  await page.locator('#shopping-item-save-btn').click();
  await page.waitForFunction(() => document.querySelector('#shopping-item-modal')?.getAttribute('aria-hidden') === 'true');
  const quickCreated = await page.evaluate(() => window.test.commits().at(-1).data.item);
  assert.deepEqual({ name: quickCreated.name, quantity: quickCreated.quantity_value, unit: quickCreated.quantity_unit, section: quickCreated.section_id, stores: quickCreated.store_ids }, {
    name: 'Milch', quantity: 0, unit: 'Packungen', section: 'produce', stores: ['temp-shopping-store-browser'],
  }, 'Quick Add must preserve explicit overrides and opaque offline associations in the durable payload');
  await page.locator('.shopping-item-edit-trigger').click();
  assert.equal(await page.locator('#shopping-item-quick-add-preview').isHidden(), true);
  assert.equal(await page.locator('#shopping-item-quick-add-hint').isHidden(), true);
  await page.locator('#shopping-item-name').fill('3x Milch @Aldi');
  await page.locator('#shopping-item-save-btn').click();
  await page.waitForFunction(() => document.querySelector('#shopping-item-modal')?.getAttribute('aria-hidden') === 'true');
  assert.equal(await page.evaluate(() => window.test.commits().at(-1).data.changes.name), '3x Milch @Aldi', 'edit mode must not reinterpret literal item names');

  await trigger.click();
  await page.locator('#shopping-item-name').fill('2x Milch menge:3');
  await page.waitForFunction(expected => document.querySelector('#shopping-item-quick-add-preview')?.textContent.includes(expected), JSON.parse(readFileSync(new URL('../web/static/i18n/de.json', import.meta.url), 'utf8'))['shopping.quickAdd.error.conflict']);
  const beforeInvalid = await page.evaluate(() => window.test.commits().length);
  await page.evaluate(() => document.querySelector('#shopping-item-form').requestSubmit());
  assert.equal(await page.evaluate(() => window.test.commits().length), beforeInvalid, 'conflicting syntax cannot persist or enqueue');
  await page.locator('#shopping-item-name').fill('1,5 l Milch');
  await page.waitForFunction(() => document.querySelector('#shopping-item-quick-add-preview .quantity strong')?.textContent === '1,5');
  await page.evaluate(() => window.test.setLanguage('en'));
  await page.locator('#shopping-item-name').fill('1.5 l Milk');
  await page.waitForFunction(() => document.querySelector('#shopping-item-quick-add-preview .quantity strong')?.textContent === '1.5');
  assert.equal(await page.locator('#shopping-item-quick-add-hint').textContent(), JSON.parse(readFileSync(new URL('../web/static/i18n/en.json', import.meta.url), 'utf8'))['shopping.quickAdd.hint']);
  await page.locator('#shopping-item-name').fill('Milk @Unknown');
  await page.waitForFunction(expected => document.querySelector('#shopping-item-quick-add-preview')?.textContent.includes(expected), JSON.parse(readFileSync(new URL('../web/static/i18n/en.json', import.meta.url), 'utf8'))['shopping.quickAdd.warning.unrecognized']);
  await page.locator('#shopping-item-save-btn').click();
  await page.waitForFunction(() => document.querySelector('#shopping-item-modal')?.getAttribute('aria-hidden') === 'true');
  assert.equal(await page.evaluate(() => window.test.commits().at(-1).data.item.name), 'Milk @Unknown', 'unresolved assignment must remain literal item text');
  await page.evaluate(() => window.test.setLanguage('de'));
  await trigger.click();
  await page.locator('#shopping-item-name').fill('2 l Milch');
  await page.locator('#shopping-item-name').press('Escape');
  await page.waitForFunction(() => document.querySelector('#shopping-item-modal')?.getAttribute('aria-hidden') === 'true');
  await trigger.click();
  assert.equal(await page.locator('#shopping-item-name').inputValue(), '');
  assert.equal(await page.locator('#shopping-item-quick-add-preview').isHidden(), true, 'reopen must not retain previous syntax or previews');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}

console.log('✅ Shopping item create/edit/delete modal, section/store selection and shared FAB passed');
