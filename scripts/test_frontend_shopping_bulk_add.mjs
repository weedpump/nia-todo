#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const english = JSON.parse(readFileSync(new URL('../web/static/i18n/en.json', import.meta.url), 'utf8'));
const fixtureSource = `
  import { initI18n, translatePage, setLanguagePreference } from '/static/js/i18n/index.js';
  import { SHOPPING_DIALOGS_HTML } from '/static/js/modules/shopping-dialogs.js';
  import { shoppingModule } from '/static/js/modules/shopping.js';
  import { createShoppingItemEditorFeature } from '/static/js/features/shopping-item-editor.js';
  import { createShoppingStoresController } from '/static/js/features/shopping-stores.js';
  import { createShoppingItemsController, renderShoppingItem } from '/static/js/features/shopping-items.js';
  import { commitShoppingMutation } from '/static/js/storage/indexed-db.js';
  import { createUiShell } from '/static/js/features/ui-shell.js';
  localStorage.setItem('nia-todo-language', 'de');
  await initI18n();
  let lists = [
    { id: 'list-a', can_edit: true, can_manage: false, name: 'Einkauf', sections: [
      { id: 'temp-cold', client_mutation_id: 'temp-cold', name: 'Kühlung', sort_order: 0 },
      { id: 'temp-produce', client_mutation_id: 'temp-produce', name: 'Obst', sort_order: 1 },
    ], items: [] },
    { id: 'list-b', can_edit: true, can_manage: true, name: 'Andere Liste', sections: [], items: [] },
  ];
  let stores = [
    { id: 'temp-rewe', client_mutation_id: 'temp-rewe', shopping_list_id: 'list-a', name: 'REWE', active: true },
    { id: 'temp-aldi', client_mutation_id: 'temp-aldi', shopping_list_id: 'list-a', name: 'ALDI', active: true },
  ];
  let active = 'list-a';
  let sequence = 0;
  let failSecondQueueWrite = false;
  let commitGate = null;
  let durableGate = null;
  let builtCalls = 0;
  let commitCalls = 0;
  let submitCalls = 0;
  let aborted = Promise.resolve();
  const commits = [];
  const errors = [];
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('shopping-bulk-' + Date.now() + '-' + Math.random(), 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('shoppingLists', { keyPath: 'id' });
      db.createObjectStore('shoppingStores', { keyPath: 'id' });
      db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const faultyDatabase = {
    transaction(names, mode) {
      const tx = database.transaction(names, mode);
      const objectStore = tx.objectStore.bind(tx);
      let written = 0;
      aborted = new Promise(resolve => tx.addEventListener('abort', resolve, { once: true }));
      tx.objectStore = name => {
        const store = objectStore(name);
        if (name !== 'syncQueue') return store;
        return { put(value) {
          if (++written === 2) throw new Error('simulated second queue write failure');
          return store.put(value);
        } };
      };
      return tx;
    },
  };
  const lateMount = new URL(location.href).searchParams.get('mount') === 'late';
  if (!lateMount) {
    document.body.innerHTML = '<button type="button" data-shopping-item-action="open-create">+</button><div id="items"></div>' + SHOPPING_DIALOGS_HTML;
    translatePage(document);
  }
  document.addEventListener('submit', event => { if (event.target.id === 'shopping-item-form') submitCalls++; }, true);
  let editor;
  const render = () => {
    document.getElementById('items').innerHTML = (lists.find(list => list.id === active)?.items || [])
      .map(item => renderShoppingItem({ item, canEdit: true, locale: 'de-DE' })).join('');
  };
  const persist = async build => {
    commitCalls += 1;
    if (commitGate) await commitGate.promise;
    const mutation = build();
    if (!mutation) return null;
    builtCalls++;
    if (durableGate) await durableGate.promise;
    await commitShoppingMutation({ ...mutation, database: failSecondQueueWrite ? faultyDatabase : database });
    commits.push(structuredClone(mutation));
    return mutation;
  };
  const storeController = createShoppingStoresController({
    getStores: () => stores,
    setStores: next => { stores = next; },
    resolveListId: identity => lists.find(list => String(list.id) === String(identity) || String(list.client_mutation_id) === String(identity))?.id,
    createTempId: () => 'temp-bulk-store-' + (++sequence),
    commitMutation: persist,
  });
  const controller = createShoppingItemsController({
    getLists: () => lists,
    setLists: next => { lists = next; editor?.reconcile(); },
    getActiveListId: () => active,
    getStores: () => stores,
    createTempId: () => 'temp-bulk-item-' + (++sequence),
    commitMutation: persist,
    render,
    onError: error => errors.push(error.message),
  });
  editor = createShoppingItemEditorFeature({
    getLists: () => lists,
    getActiveListId: () => active,
    getStores: () => stores,
    itemController: controller,
    storeController,
    onError: error => errors.push(error.message),
  });
  const batchOperations = [];
  const createMany = controller.createMany;
  controller.createMany = (...args) => {
    const operation = createMany(...args);
    batchOperations.push(operation);
    return operation;
  };
  // Bind the actual shell first, as in the app; it alone closes X/overlay.
  createUiShell({}).bindModalCloseControls();
  editor.bind();
  if (lateMount) {
    const slots = Object.fromEntries(['sidebar', 'topbar', 'main', 'floating', 'userMenu', 'shortcuts', 'settingsNav', 'settings', 'desktopHotkeys'].map(key => [key, document.createElement('div')]));
    shoppingModule.mount({ slots });
    const items = document.createElement('div');
    items.id = 'items';
    document.body.replaceChildren(...Object.values(slots), items);
    translatePage(document);
  }
  window.test = {
    close: () => editor.close(),
    settled: () => Promise.all(batchOperations),
    setLanguagePreference,
    lists: () => lists, commits: () => commits, errors: () => errors,
    commitCalls: () => commitCalls,
    submitCalls: () => submitCalls,
    builtCalls: () => builtCalls,
    deferDurable: () => {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      durableGate = { promise, resolve };
    },
    releaseDurable: () => { const gate = durableGate; durableGate = null; gate?.resolve(); },
    failStorage: value => { failSecondQueueWrite = value; },
    aborted: () => aborted,
    deferCommit: () => {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      commitGate = { promise, resolve };
    },
    releaseCommit: () => { const gate = commitGate; commitGate = null; gate?.resolve(); },
    setActive: (id, reconcile = true) => { active = id; if (reconcile) editor.reconcile(); render(); },
    revoke: () => { lists[0] = { ...lists[0], can_edit: false }; editor.reconcile(); },
    remap: () => {
      lists[0] = { ...lists[0], id: 42, client_mutation_id: 'list-a', sections: lists[0].sections.map((section, index) => ({ ...section, id: 100 + index })) };
      stores = stores.map((store, index) => ({ ...store, id: 200 + index, shopping_list_id: 42 }));
      active = 42;
      editor.reconcile();
    },
    readStorage: async () => {
      await aborted;
      return new Promise((resolve, reject) => {
        const tx = database.transaction(['shoppingLists', 'syncQueue'], 'readonly');
        const result = {};
        const a = tx.objectStore('shoppingLists').getAll();
        const b = tx.objectStore('syncQueue').getAll();
        a.onsuccess = () => { result.lists = a.result; };
        b.onsuccess = () => { result.queue = b.result; };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
      });
    },
  };
`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('http://shopping-bulk.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/static/style.css"></head><body><script type="module" src="/fixture.js"></script></body></html>' });
    if (pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: fixtureSource });
    if (pathname.startsWith('/static/')) {
      try {
        return route.fulfill({ contentType: pathname.endsWith('.json') ? 'application/json' : pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: readFileSync(new URL('../web' + pathname, import.meta.url)) });
      } catch { return route.fulfill({ status: 404, body: 'Missing fixture asset: ' + pathname }); }
    }
    return route.fulfill({ status: 404, body: 'Unexpected request: ' + pathname });
  });
  const load = async (query = '') => {
    await page.goto('http://shopping-bulk.test/' + query);
    await page.waitForFunction(() => Boolean(window.test), null, { timeout: 10000 }).catch(error => { throw new Error(pageErrors.join('\n') || error.message); });
    await page.locator('[data-shopping-item-action="open-create"]').click();
  };
  const modal = page.locator('#shopping-item-modal');
  const mode = modal.locator('[data-multi-add-mode="multi"]');
  for (const shortcut of [
    { ctrlKey: true, isComposing: true },
    { metaKey: true, isComposing: true },
    { ctrlKey: true, keyCode: 229 },
    { metaKey: true, keyCode: 229 },
    { ctrlKey: true, handled: true },
    { metaKey: true, handled: true },
    { ctrlKey: true },
    { metaKey: true },
  ]) {
    await load();
    await mode.click();
    await modal.locator('.ui-multi-add-input').fill('Milch');
    const count = await page.evaluate(shortcut => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...shortcut });
      if (shortcut.handled) event.preventDefault();
      const target = document.querySelector(shortcut.handled ? '#shopping-item-save-btn' : '.ui-multi-add-input');
      target.dispatchEvent(event);
      return window.test.submitCalls();
    }, shortcut);
    const blocked = shortcut.isComposing || shortcut.keyCode === 229 || shortcut.handled;
    assert.equal(count, blocked ? 0 : 1, `production editor submits exactly once only for an unhandled ordinary shortcut: ${JSON.stringify(shortcut)}`);
    if (blocked) {
      assert.equal(await page.evaluate(() => window.test.commitCalls()), 0);
      assert.deepEqual(await page.evaluate(() => window.test.readStorage()), { lists: [], queue: [] });
    } else {
      await page.waitForFunction(() => document.getElementById('shopping-item-modal').getAttribute('aria-hidden') === 'true');
      assert.equal((await page.evaluate(() => window.test.readStorage())).queue.length, 1);
    }
  }
  for (const close of ['Escape', 'X', 'overlay', 'public', 'navigation', 'selection', 'Back']) {
    await load();
    await mode.click();
    await modal.locator('.ui-multi-add-input').fill('Milch');
    await page.evaluate(() => {
      window.test.deferCommit();
      document.getElementById('shopping-item-form').requestSubmit();
    });
    await page.waitForFunction(() => window.test.commitCalls() === 1);
    if (close === 'Back') {
      // Back is invalidated on its actual history event, not its async request.
      await page.evaluate(() => new Promise(resolve => {
        window.addEventListener('popstate', resolve, { once: true });
        history.back();
      }));
    }
    await page.evaluate(close => {
      if (close === 'Escape') document.querySelector('.ui-multi-add-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      else if (close === 'public') window.test.close();
      else if (close === 'navigation') window.test.setActive('list-b');
      else if (close === 'selection') window.test.setActive('list-b', false);
      else if (close !== 'Back') document.querySelector('#shopping-item-modal ' + (close === 'X' ? '.modal-close-x span' : '.modal-overlay')).click();
      // Release in the same JS turn, before asynchronous History Back hides DOM.
      window.test.releaseCommit();
    }, close);
    await page.evaluate(() => window.test.settled());
    assert.deepEqual(await page.evaluate(() => window.test.readStorage()), { lists: [], queue: [] }, `${close}: close request invalidates before the durable builder`);
    assert.equal(await page.evaluate(() => window.test.commits().length), 0, close);
    if (close === 'selection') await page.evaluate(() => window.test.close());
    await page.waitForFunction(() => document.getElementById('shopping-item-modal').getAttribute('aria-hidden') === 'true');
    assert.deepEqual(await page.evaluate(() => history.state.niaTodoUi.layers), [], `${close}: shell/history closes exactly one layer`);
  }
  await load();
  await mode.click();
  await modal.locator('.ui-multi-add-input').fill('Milch');
  await page.evaluate(() => { window.test.deferDurable(); document.getElementById('shopping-item-form').requestSubmit(); });
  await page.waitForFunction(() => window.test.builtCalls() === 1);
  await page.evaluate(() => { window.test.close(); window.test.releaseDurable(); });
  await page.evaluate(() => window.test.settled());
  assert.equal((await page.evaluate(() => window.test.readStorage())).queue.length, 1, 'closing after the durable builder starts does not roll back an admitted transaction');

  await load();
  await mode.click();
  const focusEnds = await modal.evaluate(root => Array.from(root.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])'))
    .filter(element => !element.closest('[hidden]') && element.offsetParent !== null)
    .map((element, index) => { element.dataset.focusTest = String(index); return String(index); }));
  const firstFocus = modal.locator(`[data-focus-test="${focusEnds[0]}"]`);
  const lastFocus = modal.locator(`[data-focus-test="${focusEnds.at(-1)}"]`);
  await lastFocus.focus();
  await page.keyboard.press('Tab');
  assert.equal(await firstFocus.evaluate(element => document.activeElement === element), true, 'Tab still wraps in the editor');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await lastFocus.evaluate(element => document.activeElement === element), true, 'Shift+Tab still wraps backwards');
  await load();
  const singleSectionGeometry = await modal.evaluate(root => {
    const tabs = root.querySelector('.ui-multi-add-mode-switch').getBoundingClientRect();
    const title = root.querySelector('.ui-detail-title-section');
    const style = getComputedStyle(title);
    return { gap: title.getBoundingClientRect().top - tabs.bottom, margin: style.marginTop, padding: style.paddingTop, border: style.borderTopWidth };
  });
  assert.deepEqual(singleSectionGeometry, { gap: 24, margin: '0px', padding: '0px', border: '0px' }, 'the shared title section must not add a second divider gap after capture tabs');
  assert.equal(await mode.count(), 1, 'Shopping create must use the neutral single/multiple mode control');
  await mode.click();
  const captureGeometry = await modal.evaluate(root => {
    const mode = root.querySelector('.ui-multi-add-mode-switch').getBoundingClientRect();
    const panel = root.querySelector('.ui-multi-add-panel').getBoundingClientRect();
    return { modeBottom: mode.bottom, panelTop: panel.top };
  });
  assert(captureGeometry.panelTop - captureGeometry.modeBottom >= 24, `Shopping capture tabs need at least 24px separation before the capture heading: ${JSON.stringify(captureGeometry)}`);
  assert.equal(await modal.locator('.ui-multi-add-defaults-grid').evaluate(grid => getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length), 2, 'Shopping defaults fill two columns without reserving a third Tasks-only field');
  assert.equal(await modal.locator('.ui-multi-add-intro-heading p').isVisible(), true, 'the shared keyboard/paste instructions must remain visible inside the Shopping detail shell');
  assert.equal(await modal.locator('.ui-multi-add-defaults-head p').isVisible(), true, 'default precedence instructions must match the canonical Tasks surface');
  const rows = modal.locator('.ui-multi-add-input');
  await rows.first().fill('500g Emmentaler');
  await rows.first().press('Enter');
  await rows.nth(1).fill('3x Äpfel /Obst');
  await rows.nth(1).press('Enter');
  await rows.nth(2).fill('2 l Milch @ALDI');
  await page.locator('#shopping-item-multi-store').selectOption('temp-rewe');
  await page.locator('#shopping-item-multi-section').selectOption('temp-cold');
  await page.waitForFunction(() => {
    const row = document.querySelector('#shopping-item-multi-add-rows .ui-multi-add-row');
    return row?._multiParsed?.fields.storeId === 'temp-rewe' && row?._multiParsed?.fields.sectionId === 'temp-cold';
  });
  assert.deepEqual(await modal.locator('.ui-multi-add-row').evaluateAll(rows => rows.map(row => Array.from(row.querySelectorAll('.quick-add-chip')).map(chip => chip.className.replace('quick-add-chip', '').trim()))), [
    ['quantity', 'unit'], ['quantity', 'section'], ['quantity', 'unit', 'store'],
  ], 'only explicit Quick Add matches become badges; shared Store/Section defaults must not be repeated per row');
  await rows.first().fill('Emmentaler');
  await page.waitForFunction(() => document.querySelector('#shopping-item-multi-add-rows .ui-multi-add-row')?._multiParsed?.fields.quantity === '');
  assert.equal(await modal.locator('.ui-multi-add-row').first().locator('.quick-add-chip').count(), 0, 'plain article text has no badges even when shared defaults are selected');
  await rows.first().fill('500g Emmentaler');
  await page.waitForFunction(() => document.querySelector('#shopping-item-multi-add-rows .ui-multi-add-row')?._multiParsed?.fields.quantity === 500);
  await page.locator('#shopping-item-save-btn').click();
  await page.waitForFunction(() => document.querySelector('#shopping-item-modal').getAttribute('aria-hidden') === 'true');
  const saved = await page.evaluate(() => window.test.readStorage());
  assert.equal(saved.queue.length, 3);
  assert.equal(saved.lists.length, 1);
  assert.deepEqual(saved.lists[0].items.map(item => [item.name, item.quantity_value, item.quantity_unit, item.section_id, item.store_ids]), [
    ['Emmentaler', 500, 'g', 'temp-cold', ['temp-rewe']],
    ['Äpfel', 3, null, 'temp-produce', ['temp-rewe']],
    ['Milch', 2, 'l', 'temp-cold', ['temp-aldi']],
  ], 'per-line syntax overrides the shared defaults in the real durable projection');
  assert.equal(await page.evaluate(() => window.test.commits().length), 1);

  await load();
  await mode.click();
  await rows.first().fill('Milch');
  await rows.first().press('Enter');
  await rows.nth(1).fill('Milch');
  await page.evaluate(() => window.test.failStorage(true));
  await page.locator('#shopping-item-save-btn').click();
  await page.waitForFunction(() => window.test.errors().length === 1);
  const failedStorage = await page.evaluate(() => window.test.readStorage());
  assert.deepEqual(failedStorage, { lists: [], queue: [] }, 'failure on the second queue write rolls back the first row and the whole list projection');
  assert.equal(await modal.getAttribute('aria-hidden'), 'false');
  assert.equal(await rows.count(), 2);
  assert.equal(await page.evaluate(() => window.test.lists()[0].items.length), 0);
  await page.evaluate(() => window.test.failStorage(false));
  await page.locator('#shopping-item-save-btn').click();
  await page.waitForFunction(() => document.querySelector('#shopping-item-modal').getAttribute('aria-hidden') === 'true');
  const retry = await page.evaluate(() => window.test.readStorage());
  assert.equal(retry.queue.length, 2);
  assert.equal(new Set(retry.queue.map(entry => entry.data.client_mutation_id)).size, 2, 'duplicate lines remain distinct create identities after retry');

  await load();
  await mode.click();
  await rows.first().fill('Brot');
  await modal.locator('[data-select-id="shopping-item-multi-store"] .ui-select-trigger').click();
  await page.locator('.ui-select-action').click();
  await page.locator('#shopping-item-multi-new-store-name').fill('Neuer Markt');
  await modal.locator('[data-shopping-store-creator="shopping-item-multi"][data-shopping-store-creator-action="save"]').click();
  await page.waitForFunction(() => document.querySelector('#shopping-item-multi-store').value.startsWith('temp-bulk-store-'));
  await page.locator('#shopping-item-save-btn').click();
  await page.waitForFunction(() => document.querySelector('#shopping-item-modal').getAttribute('aria-hidden') === 'true');
  const createdStore = await page.evaluate(() => window.test.readStorage());
  assert.deepEqual(createdStore.queue.map(entry => entry.action), ['CREATE_SHOPPING_STORE', 'CREATE_SHOPPING_ITEM']);
  assert.deepEqual(createdStore.queue[1].data.item.store_ids, [createdStore.queue[0].data.temp_id]);

  await load();
  await page.locator('#shopping-item-name').fill('Einzelartikel');
  await mode.click();
  await rows.first().fill('500g Emmentaler');
  await modal.locator('[data-multi-add-mode="single"]').click();
  assert.equal(await page.locator('#shopping-item-name').inputValue(), 'Einzelartikel');
  assert.equal(await page.locator('#shopping-item-name').evaluate(element => element.required && !element.disabled), true);
  await mode.click();
  assert.equal(await rows.first().inputValue(), '500g Emmentaler', 'switching modes preserves each draft independently');
  assert.equal(await page.locator('#shopping-item-name').evaluate(element => element.required || !element.disabled), false);
  await rows.first().evaluate(input => {
    input.value = '500g ';
    input.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, inputType: 'insertCompositionText' }));
    input.value = '500g emmenta';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, inputType: 'insertCompositionText' }));
  });
  await page.waitForFunction(() => document.querySelector('#shopping-item-multi-add-rows .ui-multi-add-input').getAttribute('aria-invalid') === 'false'
    && document.querySelectorAll('#shopping-item-multi-add-rows .quick-add-chip').length === 2);
  assert.equal(await rows.first().inputValue(), '500g emmenta');
  assert.equal(await rows.first().evaluate(input => input.selectionStart), '500g emmenta'.length);

  await load();
  await mode.click();
  await rows.first().fill('Milch');
  await rows.first().press('Enter');
  await rows.nth(1).fill('Brot');
  await page.evaluate(() => window.test.deferCommit());
  await page.locator('#shopping-item-save-btn').click();
  await page.waitForFunction(() => window.test.commitCalls() === 1);
  assert.equal(await modal.getAttribute('aria-busy'), 'true');
  assert.equal(await page.evaluate(() => window.test.lists()[0].items.length), 0);
  await page.locator('#shopping-item-form').evaluate(form => {
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(await page.evaluate(() => window.test.commitCalls()), 1, 'duplicate form submits share one durable batch');
  await page.evaluate(() => window.test.releaseCommit());
  await page.waitForFunction(() => document.querySelector('#shopping-item-modal').getAttribute('aria-hidden') === 'true');
  assert.equal((await page.evaluate(() => window.test.readStorage())).queue.length, 2);

  await load();
  await mode.click();
  await rows.first().fill('Milch');
  await page.evaluate(() => window.test.deferCommit());
  await page.locator('#shopping-item-save-btn').click();
  await page.waitForFunction(() => window.test.commitCalls() === 1);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#shopping-item-modal').getAttribute('aria-hidden') === 'true');
  await page.locator('[data-shopping-item-action="open-create"]').click();
  await page.locator('#shopping-item-name').fill('Neuer Entwurf');
  await page.evaluate(() => window.test.releaseCommit());
  assert.deepEqual(await page.evaluate(() => window.test.readStorage()), { lists: [], queue: [] }, 'closing the old session aborts its queued batch');
  assert.equal(await modal.getAttribute('aria-hidden'), 'false', 'old save completion cannot close a freshly opened editor');
  assert.equal(await page.locator('#shopping-item-name').inputValue(), 'Neuer Entwurf');
  assert.equal(await modal.locator('[data-multi-add-mode="single"]').getAttribute('aria-pressed'), 'true');
  // Reopen with exactly the same normalized rows while the abandoned write waits.
  await load();
  await mode.click();
  await rows.first().fill('Milch');
  await page.evaluate(() => { window.test.deferCommit(); document.getElementById('shopping-item-form').requestSubmit(); });
  await page.waitForFunction(() => window.test.commitCalls() === 1);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('shopping-item-modal').getAttribute('aria-hidden') === 'true');
  await page.locator('[data-shopping-item-action="open-create"]').click();
  await mode.click();
  await rows.first().fill('Milch');
  await page.evaluate(() => document.getElementById('shopping-item-form').requestSubmit());
  await page.waitForFunction(() => document.getElementById('shopping-item-modal').getAttribute('aria-busy') === 'true');
  await page.evaluate(() => window.test.releaseCommit());
  await page.evaluate(() => window.test.settled());
  const reopenedStorage = await page.evaluate(() => window.test.readStorage());
  assert.equal(reopenedStorage.queue.length, 1, 'identical fresh draft must persist once instead of inheriting the cancelled Promise');
  assert.equal(await page.evaluate(() => window.test.commits().length), 1);
  await page.waitForFunction(() => document.getElementById('shopping-item-modal').getAttribute('aria-hidden') === 'true');

  for (const boundary of ['before', 'during']) {
    await load();
    await mode.click();
    await rows.first().fill('2 l Milch');
    await page.locator('#shopping-item-multi-store').selectOption('temp-rewe');
    await page.locator('#shopping-item-multi-section').selectOption('temp-cold');
    if (boundary === 'before') await page.evaluate(() => window.test.remap());
    else await page.evaluate(() => window.test.deferCommit());
    await page.locator('#shopping-item-save-btn').click();
    assert.equal(await page.evaluate(() => window.test.commitCalls()), 1, `${boundary}: remapping must preserve the list's stable batch identity`);
    if (boundary === 'during') await page.evaluate(() => { window.test.remap(); window.test.releaseCommit(); });
    await page.waitForFunction(() => document.querySelector('#shopping-item-modal').getAttribute('aria-hidden') === 'true');
    const remapped = await page.evaluate(() => window.test.readStorage());
    assert.equal(remapped.lists[0].id, 42);
    assert.equal(remapped.queue[0].data.shopping_list_id, 42);
    assert.equal(remapped.queue[0].data.item.section_id, 100);
    assert.deepEqual(remapped.queue[0].data.item.store_ids, [200]);
  }
  await load();
  await mode.click();
  await rows.first().fill('2 l Milk');
  await page.evaluate(() => window.test.setLanguagePreference('en'));
  assert.equal(await page.locator('#shopping-item-modal-title').textContent(), english['shopping.multiAdd.title'], 'runtime translation must preserve the current capture mode');
  assert.equal(await page.locator('#shopping-item-modal-subtitle').textContent(), english['shopping.multiAdd.subtitle']);
  assert.equal(await mode.textContent(), english['shopping.multiAdd.modeMultiple']);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await load();
    await mode.click();
    await rows.first().fill('Milk');
    for (const language of ['cs', 'de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'zh-CN']) {
      await page.evaluate(language => window.test.setLanguagePreference(language), language);
      const geometry = await modal.evaluate(root => {
        const rectangle = selector => {
          const bounds = root.querySelector(selector).getBoundingClientRect();
          return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
        };
        return {
          title: rectangle('#shopping-item-modal-title'),
          save: rectangle('#shopping-item-save-btn'),
          close: rectangle('.modal-close-x'),
          row: rectangle('.ui-multi-add-row'),
          panel: rectangle('.ui-multi-add-panel'),
          switcher: rectangle('.ui-multi-add-mode-switch'),
          columns: getComputedStyle(root.querySelector('.ui-multi-add-defaults-grid')).gridTemplateColumns.split(/\s+/).length,
        };
      });
      assert(geometry.title.right <= geometry.save.left + 1, `${width}/${language}: title cannot overlap Save`);
      assert(geometry.save.right <= geometry.close.left + 1, `${width}/${language}: Save cannot overlap Close`);
      assert(geometry.row.left >= 0 && geometry.row.right <= width, `${width}/${language}: bulk rows remain inside the viewport`);
      assert(geometry.panel.top - geometry.switcher.bottom >= 24, `${width}/${language}: capture tabs keep their24px separation`);
      assert.equal(geometry.columns, width <= 768 ? 1 : 2, `${width}/${language}: defaults use the shared responsive grid`);
      await modal.locator('[data-multi-add-mode="single"]').click();
      const singleGap = await modal.evaluate(root => {
        const tabs = root.querySelector('.ui-multi-add-mode-switch').getBoundingClientRect();
        return root.querySelector('.ui-detail-title-section').getBoundingClientRect().top - tabs.bottom;
      });
      assert.equal(singleGap, 24, `${width}/${language}: single capture must not add another section margin`);
      await mode.click();
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await load('?mount=late');
  assert.equal(await modal.locator('[data-multi-add-mode="single"]').getAttribute('aria-pressed'), 'true');
  await mode.click();
  assert.equal(await mode.getAttribute('aria-pressed'), 'true', 'the real Shopping module mounted after editor.bind must have a working bulk tab');
  assert.equal(await modal.locator('.ui-multi-add-panel').isVisible(), true);
  await rows.first().fill('2 l Milch');
  await rows.first().press('Enter');
  assert.equal(await rows.count(), 2, 'late mount must also bind row keyboard controls');
  await rows.nth(1).fill('Brot');
  await modal.locator('[data-multi-add-mode="single"]').click();
  assert.equal(await page.locator('#shopping-item-name').isVisible(), true);
  await mode.click();
  assert.equal(await rows.first().inputValue(), '2 l Milch');
  await page.locator('#shopping-item-save-btn').click();
  await page.waitForFunction(() => document.getElementById('shopping-item-modal').getAttribute('aria-hidden') === 'true');
  assert.equal((await page.evaluate(() => window.test.readStorage())).queue.length, 2);
  await page.locator('[data-shopping-item-action="open-create"]').click();
  await mode.click();
  await rows.first().fill('Neu');
  await rows.first().press('Enter');
  assert.equal(await rows.count(), 2, 'reopening must not bind duplicate row listeners');
  assert.deepEqual(pageErrors, []);
} finally {
  await browser.close();
}
console.log('✅ Shopping shared bulk capture, defaults, real IndexedDB rollback and retry passed');
