#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const moduleContentCss = readFileSync(new URL('../web/static/css/14-module-content.css', import.meta.url), 'utf8');
assert(!moduleContentCss.includes('.shopping-section-'), 'Shopping must not create a parallel section CSS authority');

const fixtureSource = `
  import { createShoppingNavigationFeature } from '/static/js/features/shopping-navigation.js';
  import { createShoppingItemsController } from '/static/js/features/shopping-items.js';
  import { createShoppingStoresController } from '/static/js/features/shopping-stores.js';
  import { initI18n, setLanguagePreference } from '/static/js/i18n/index.js';

  localStorage.setItem('nia-todo-language', 'de');
  await initI18n();
  let lists = [
    { id: 1, name: 'Wocheneinkauf', color: '#2563eb', icon: 'shopping-cart', sort_order: 0, can_manage: true, can_edit: true,
      preferences: { hide_empty_sections: true }, items: [], sections: [{ id: 'hidden-empty', name: 'Versteckt', sort_order: 0 }] },
    { id: 2, name: 'Gefüllte Liste', color: '#16a34a', icon: 'list-checks', sort_order: 1, can_manage: 'false', can_edit: 'true',
      preferences: { hide_empty_sections: true },
      items: [{ id: 10, name: 'Milch', quantity_value: 1.5, quantity_unit: 'l', completed: false, section_id: 'produce' }],
      sections: [{ id: 'produce', name: 'Obst & Gemüse', sort_order: 0 }, { id: 'empty', name: 'Leer', sort_order: 1 }] },
    { id: 3, name: 'Bearbeitbar', color: '#7c3aed', icon: 'shopping-basket', sort_order: 2, can_manage: false, can_edit: true,
      items: [
        { id: 'temp-shopping-item-3', name: 'Sehr langer responsiver Artikeltitel ohne horizontalen Überlauf', quantity_value: 0, quantity_unit: 'SehrLangeMengeneinheitOhneTrennzeichen', completed: false, section_id: null },
        { id: 31, name: 'Erledigt', quantity_value: 2, quantity_unit: 'kg', completed: true, section_id: null },
      ], sections: [] },
    { id: 4, name: 'Markteinkauf', color: '#ea580c', icon: 'store', sort_order: 3, can_manage: false, can_edit: true,
      preferences: { hide_empty_sections: true },
      items: [
        { id: 40, name: 'Überall', completed: false, section_id: 'market-section', store_ids: [] },
        { id: 41, name: 'Nur REWE', completed: false, section_id: 'market-section', store_ids: ['store-rewe'] },
        { id: 42, name: 'Nur ALDI', completed: false, section_id: 'aldi-only', store_ids: ['store-aldi'] },
      ], sections: [
        { id: 'market-section', name: 'Gemischt', sort_order: 0 },
        { id: 'aldi-only', name: 'ALDI', sort_order: 1 },
      ] },
    { id: 5, name: 'Markt ohne Treffer', color: '#0891b2', icon: 'store', sort_order: 4, can_manage: false, can_edit: false,
      preferences: { hide_empty_sections: true },
      items: [{ id: 50, name: 'Nur ALDI', completed: false, section_id: 'only-other', store_ids: [] }],
      sections: [{ id: 'only-other', name: 'Nur anderer Markt', sort_order: 0 }] },
  ];
  let stores = [
    { id: 'store-rewe', shopping_list_id: 4, name: 'REWE', sort_order: 0, active: true },
    { id: 'store-aldi', shopping_list_id: 4, name: 'ALDI', sort_order: 1, active: true },
    { id: 'store-lidl', shopping_list_id: 4, name: 'LIDL', sort_order: 2, active: true },
    { id: 'store-old', shopping_list_id: 4, name: 'Alter Markt', sort_order: 3, active: false },
    { id: 'store-lidl-list-5', shopping_list_id: 5, name: 'LIDL', sort_order: 0, active: true },
  ];
  document.body.innerHTML = \`
    <div id="shopping-list-sidebar" hidden></div>
    <button type="button" hidden data-entity-sidebar-action="add" data-entity-type="shopping-list">Liste hinzufügen</button>
    <div id="todo-card-reference" class="todo-item ui-item-card" style="position:absolute;left:-9999px"><span>Referenz</span></div>
    <div id="todo-pinned-reference" class="todo-item ui-item-card pinned" style="position:absolute;left:-9999px"><span>Gepinnt</span></div>
    <div id="todo-pinned-meta-reference" class="todo-item ui-item-card pinned" style="position:absolute;left:-9999px"><span class="todo-meta-row"><span class="todo-meta-chip ui-badge">Meta</span></span></div>
    <div id="shopping-card-reference" class="shopping-item-card ui-item-card" style="position:absolute;left:-9999px"><span>Referenz</span></div>
    <div class="todo-meta-row">
      <span id="todo-badge-reference" class="todo-meta-chip ui-badge">Referenz</span>
      <span id="todo-reminder-reference" class="todo-meta-chip ui-badge todo-reminder">Erinnerung</span>
    </div>
    <main id="shopping-navigation-main" class="module-page module-empty-page"></main>
  \`;
  let navigation;
  let mutationCommits = 0;
  let storeSequence = 0;
  let deferredStoreCommit = null;
  const mutations = [];
  const itemController = createShoppingItemsController({
    getLists: () => lists,
    setLists: next => { lists = next; },
    getActiveListId: () => navigation?.getActiveListId?.(),
    commitMutation: async build => {
      mutationCommits += 1;
      const mutation = build();
      if (mutation) mutations.push(structuredClone(mutation));
      return mutation;
    },
    render: () => navigation?.render?.(),
  });
  const storeController = createShoppingStoresController({
    getStores: () => stores,
    setStores: next => { stores = structuredClone(next); navigation?.render(); },
    commitMutation: async build => {
      if (deferredStoreCommit) await deferredStoreCommit.promise;
      mutationCommits += 1;
      const mutation = build();
      if (mutation) mutations.push(structuredClone(mutation));
      return mutation;
    },
    createTempId: () => 'temp-store-filter-created-' + (++storeSequence),
  });
  navigation = createShoppingNavigationFeature({
    getLists: () => lists, root: document,
    getStores: () => stores,
    getElementById: id => document.getElementById(id),
    storage: localStorage, historyTarget: history, locationTarget: location, eventTarget: window,
    closeSidebar: () => false, onAdd: () => {}, onDetail: () => {},
    itemController,
    storeController,
  });
  navigation.bind();
  navigation.render();
  window.test = {
    select: id => navigation.selectList(id),
    setName: name => {
      lists = lists.map(list => String(list.id) === String(navigation.getActiveListId()) ? { ...list, name } : list);
      navigation.replaceLists(lists);
    },
    setLanguage: async language => { await setLanguagePreference(language); },
    setSearch: value => navigation.setSearchQuery(value),
    setCanEdit: (id, canEdit) => {
      lists = lists.map(list => String(list.id) === String(id) ? { ...list, can_edit: canEdit } : list);
    },
    mutationCommits: () => mutationCommits,
    mutations: () => structuredClone(mutations),
    deferStoreCommit: () => {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      deferredStoreCommit = { promise, release };
    },
    releaseStoreCommit: () => {
      deferredStoreCommit?.release();
      deferredStoreCommit = null;
    },
    storeFilter: () => navigation.getStoreFilter(),
    setStores: next => { stores = structuredClone(next); navigation.render(); },
    stores: () => structuredClone(stores),
  };
`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error?.stack || error)));

try {
  await page.route('http://nia.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/static/style.css"></head><body><script type="module" src="/fixture.js"></script></body></html>' });
      return;
    }
    if (url.pathname === '/fixture.js') {
      await route.fulfill({ contentType: 'text/javascript', body: fixtureSource });
      return;
    }
    if (url.pathname.startsWith('/static/')) {
      try {
        const body = readFileSync(new URL(`../web${url.pathname}`, import.meta.url), 'utf8');
        await route.fulfill({ contentType: url.pathname.endsWith('.json') ? 'application/json' : (url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript'), body });
      } catch {
        await route.fulfill({ status: 404, contentType: 'text/plain', body: `Missing fixture asset: ${url.pathname}` });
      }
      return;
    }
    await route.fulfill({ status: 404, contentType: 'text/plain', body: `Unexpected fixture request: ${url.pathname}` });
  });

  await page.goto('http://nia.test/');
  await page.waitForFunction(() => Boolean(window.test));
  const main = page.locator('#shopping-navigation-main');
  const header = page.locator('.shopping-list-content-header');
  const empty = page.locator('.shopping-list-empty-state');
  const unsorted = page.locator('.section-header.section-unsorted');
  await empty.waitFor({ state: 'visible' });
  assert.equal(await main.getAttribute('data-shopping-content-state'), 'empty');
  assert.equal((await header.locator('h1').textContent()).trim(), 'Wocheneinkauf');
  assert.equal(await unsorted.count(), 0, 'a completely empty list must not render an empty fallback section');
  assert.equal(await page.locator('[data-section-action="show-add"]').count(), 1);
  const desktop = await main.evaluate(element => ({
    paddingLeft: getComputedStyle(element).paddingLeft,
    headerTop: element.querySelector('.shopping-list-content-header').getBoundingClientRect().top,
    emptyPaddingTop: getComputedStyle(element.querySelector('.shopping-list-empty-state')).paddingTop,
  }));
  assert.equal(desktop.paddingLeft, '24px');
  assert(desktop.headerTop < 100);
  assert.equal(desktop.emptyPaddingTop, '60px');

  await page.evaluate(() => window.test.select(2));
  assert.equal(await main.getAttribute('data-shopping-content-state'), 'populated');
  assert.equal(await page.locator('.shopping-list-empty-state').count(), 0, 'the accepted empty-state must disappear once sections or items are rendered');
  assert.equal(await page.locator('.section-header:not(.section-unsorted)').count(), 1, 'hide-empty must project only sections containing visible items');
  assert.equal(await page.locator('[data-section-action], .section-dropzone, .section-header[draggable="true"]').count(), 0, 'non-boolean management values must render read-only section UI');
  assert.deepEqual(await page.locator('.section-count').allTextContents(), ['1']);
  assert.equal((await page.locator('.shopping-item-title').textContent()).trim(), 'Milch');
  assert.equal((await page.locator('.shopping-item-quantity').textContent()).trim(), '1,5 l');
  assert.equal(await page.locator('.shopping-item-check').isDisabled(), true, 'non-boolean can_edit must fail closed');
  assert.equal(await page.locator('[data-shopping-item-action]').count(), 0, 'read-only items must not expose a mutating action');
  assert.equal(await page.locator('.shopping-item-card.todo-item, .shopping-item-card [data-todo-action], .shopping-item-card[data-id], .shopping-item-card[draggable]').count(), 0, 'shopping cards must remain isolated from todo gesture/action contracts');
  assert.equal(await page.locator('[data-section-action]').count(), 0);
  assert.equal(await page.locator('.section-dropzone').count(), 0);

  await page.evaluate(() => window.test.setSearch('MILCH'));
  assert.equal(await main.locator('.shopping-item-card').count(), 1, 'shopping search must match item names case-insensitively');
  assert.equal(await page.locator('.section-header:not(.section-unsorted)').count(), 1, 'search must retain a matching item section');
  await page.evaluate(() => window.test.setSearch('Brot'));
  assert.equal(await main.locator('.shopping-item-card').count(), 0);
  assert.equal(await page.locator('.section-header:not(.section-unsorted)').count(), 0, 'search must remove sections with no matching visible items');
  assert.equal((await page.locator('.shopping-search-empty-state h3').textContent()).trim(), 'Keine Artikel gefunden');
  assert.equal(await main.getAttribute('data-shopping-content-state'), 'search-empty');
  await page.evaluate(() => window.test.setSearch(''));
  assert.equal(await main.locator('.shopping-item-card').count(), 1, 'clearing shopping search must restore the complete current list');

  await page.evaluate(() => window.test.select(4));
  const marketSelect = page.locator('#shopping-store-filter');
  await marketSelect.waitFor({ state: 'attached' });
  assert.equal(await marketSelect.getAttribute('data-ui-select-hydrated'), 'true', 'the list filter must use the shipped select/dropdown primitive');
  assert.deepEqual(await marketSelect.locator('option').allTextContents(), ['Alle Supermärkte', 'REWE', 'ALDI', 'LIDL'], 'only active visible stores belong in the current-list filter');
  assert.deepEqual(await main.locator('.shopping-item-title').allTextContents(), ['Überall', 'Nur REWE', 'Nur ALDI']);
  const desktopHeader = await header.evaluate(element => ({
    titleTop: element.querySelector('h1').getBoundingClientRect().top,
    filterTop: element.querySelector('.shopping-list-store-filter').getBoundingClientRect().top,
  }));
  assert(Math.abs(desktopHeader.titleTop - desktopHeader.filterTop) < 12, 'a short list title and its current-list filter must share the desktop header row');
  const marketTrigger = page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger');
  await marketTrigger.click();
  await page.locator('#shopping-store-filter-ui-menu .ui-select-option').filter({ hasText: 'REWE' }).click();
  assert.deepEqual(await main.locator('.shopping-item-title').allTextContents(), ['Nur REWE'], 'a selected store must hide unassigned items and assignments for every other store');
  assert.equal(await page.locator('.section-header:not(.section-unsorted)').count(), 1, 'hide-empty must apply after the current-list market filter');
  assert.equal(await page.evaluate(() => window.test.storeFilter()), 'store-rewe');
  assert.equal(await page.evaluate(() => window.test.mutationCommits()), 0, 'a device-local store filter must not create an IndexedDB or sync-queue mutation');
  await page.evaluate(() => window.test.select(5));
  assert.equal(await page.evaluate(() => window.test.storeFilter()), null, 'each shopping list must retain an independent device-local filter');
  await page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').click();
  assert.equal(await page.locator('#shopping-store-filter-ui-menu .ui-select-action').count(), 0, 'read-only list members may filter but must not create stores');
  await page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').press('Escape');
  await page.evaluate(() => window.test.select(4));
  assert.equal(await page.evaluate(() => window.test.storeFilter()), 'store-rewe', 'returning to a list must restore its device-local filter');
  const availableStores = await page.evaluate(() => window.test.stores());
  await page.evaluate(() => window.test.setStores([]));
  assert.equal(await page.evaluate(() => localStorage.getItem('nia-shopping-store-filter:4')), 'store-rewe', 'rendering lists before stores load must not delete the persisted filter');
  await page.evaluate(stores => window.test.setStores(stores), availableStores);
  assert.equal(await page.evaluate(() => window.test.storeFilter()), 'store-rewe', 'the filter must resolve after the store projection arrives');
  await page.reload();
  await page.waitForFunction(() => Boolean(window.test));
  assert.equal(await page.evaluate(() => window.test.storeFilter()), 'store-rewe', 'the current-list filter must survive reload through localStorage');
  assert.equal(await page.evaluate(() => window.test.mutationCommits()), 0, 'restoring a local filter must not create a sync mutation');
  await page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').click();
  await page.locator('#shopping-store-filter-ui-menu .ui-select-option').filter({ hasText: 'LIDL' }).click();
  assert.equal(await main.locator('.shopping-item-card').count(), 0, 'a selected store with no assignments must not retain unassigned items');
  assert.equal(await page.evaluate(() => window.test.mutationCommits()), 0, 'changing the local filter repeatedly must remain outside the sync queue');
  await page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').click();
  await page.locator('#shopping-store-filter-ui-menu .ui-select-option').filter({ hasText: 'Alle Supermärkte' }).click();
  assert.equal(await main.locator('.shopping-item-card').count(), 3, 'the all-stores selection must restore the complete list');
  const commitsBeforeStoreCreate = await page.evaluate(() => window.test.mutationCommits());
  await page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').click();
  const addStoreAction = page.locator('#shopping-store-filter-ui-menu .ui-select-action');
  assert.equal((await addStoreAction.textContent()).trim(), 'Supermarkt hinzufügen');
  await addStoreAction.click();
  const filterStoreName = page.locator('#shopping-filter-store-new-store-name');
  assert.equal(await filterStoreName.isVisible(), true);
  assert.equal(await filterStoreName.evaluate(element => document.activeElement === element), true, 'the filter dropdown action must focus the shared inline store creator');
  await filterStoreName.fill('PENNY');
  await page.locator('[data-shopping-store-creator="shopping-filter-store"][data-shopping-store-creator-action="save"]').click();
  assert.equal(await page.evaluate(() => window.test.storeFilter()), 'temp-store-filter-created-1', 'a newly created store must become the active device-local filter');
  assert.equal(await page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').evaluate(element => document.activeElement === element), true, 'successful store creation restores focus to the current-list store select');
  assert.equal(await page.evaluate(() => window.test.mutationCommits()), commitsBeforeStoreCreate + 1, 'store creation must use exactly one durable mutation');
  assert.equal((await page.evaluate(() => window.test.mutations().at(-1).action)), 'CREATE_SHOPPING_STORE');
  assert.equal((await page.evaluate(() => window.test.mutations().at(-1).data.shopping_list_id)), 4);
  assert.equal(await main.getAttribute('data-shopping-content-state'), 'filter-empty');
  await page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').click();
  await page.locator('#shopping-store-filter-ui-menu .ui-select-option').filter({ hasText: 'Alle Supermärkte' }).click();
  await page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').click();
  await page.locator('#shopping-store-filter-ui-menu .ui-select-action').click();
  await page.locator('#shopping-filter-store-new-store-name').fill('NETTO');
  await page.evaluate(() => window.test.deferStoreCommit());
  await page.locator('[data-shopping-store-creator="shopping-filter-store"][data-shopping-store-creator-action="save"]').click();
  await page.evaluate(() => window.test.select(5));
  await page.evaluate(() => window.test.releaseStoreCommit());
  await page.waitForFunction(() => window.test.stores().some(store => store.name === 'NETTO'));
  assert.equal(await page.evaluate(() => localStorage.getItem('nia-shopping-store-filter:4')), 'temp-store-filter-created-2', 'a delayed create must retain the list that opened the creator');
  assert.equal(await page.evaluate(() => localStorage.getItem('nia-shopping-store-filter:5')), null, 'a delayed create must not overwrite the newly active list filter');
  assert.equal(await page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').evaluate(element => document.activeElement === element), true, 'a delayed create restores focus to the currently rendered store select');
  await page.evaluate(() => window.test.select(4));
  await page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').click();
  await page.locator('#shopping-store-filter-ui-menu .ui-select-option').filter({ hasText: 'Alle Supermärkte' }).click();
  await page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').click();
  await page.locator('#shopping-store-filter-ui-menu .ui-select-action').click();
  await page.locator('#shopping-filter-store-new-store-name').fill('EDEKA');
  await page.evaluate(() => window.test.deferStoreCommit());
  await page.locator('[data-shopping-store-creator="shopping-filter-store"][data-shopping-store-creator-action="save"]').click();
  await page.evaluate(() => { window.test.setCanEdit(4, false); window.test.select(3); });
  await page.evaluate(() => window.test.releaseStoreCommit());
  await page.waitForTimeout(0);
  assert.equal(await page.evaluate(() => window.test.stores().some(store => store.name === 'EDEKA')), false, 'permission loss on the creator list must cancel a delayed store mutation even when the active list remains editable');
  await page.evaluate(() => { window.test.setCanEdit(4, true); window.test.select(5); });
  await page.evaluate(() => window.test.setLanguage('en'));
  assert.equal((await page.locator('#shopping-store-filter option').first().textContent()).trim(), 'All stores', 'the current-list filter must follow the production language-change event');
  await page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').click();
  assert.equal(await page.locator('#shopping-store-filter-ui-menu .ui-select-action').count(), 0, 'language rerenders must not expose store creation to readers');
  await page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').press('Escape');
  await page.evaluate(() => window.test.select(4));
  await page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').click();
  assert.equal((await page.locator('#shopping-store-filter-ui-menu .ui-select-action').textContent()).trim(), 'Add store');
  await page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').press('Escape');
  await page.evaluate(() => window.test.setLanguage('de'));
  await page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').click();
  await page.locator('#shopping-store-filter-ui-menu .ui-select-option').filter({ hasText: 'Alle Supermärkte' }).click();
  await page.evaluate(() => window.test.select(5));
  await page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').click();
  await page.locator('#shopping-store-filter-ui-menu .ui-select-option').filter({ hasText: 'LIDL' }).click();
  assert.equal(await main.getAttribute('data-shopping-content-state'), 'filter-empty');
  assert.equal((await page.locator('.shopping-store-filter-empty-state h3').textContent()).trim(), 'Keine Artikel für diesen Supermarkt');
  assert.equal(await page.locator('.shopping-list-empty-state').count(), 0, 'a market-filter result must never claim that the underlying list is empty');
  await page.evaluate(() => window.test.select(2));

  const sectionDragFeedback = await page.locator('.section-header:not(.section-unsorted)').first().evaluate(element => {
    const dropzone = document.createElement('div');
    dropzone.className = 'section-dropzone';
    element.parentElement.insertBefore(dropzone, element);
    const restingDropzoneHeight = getComputedStyle(dropzone).height;

    element.classList.add('dragging');
    document.body.classList.add('section-dragging');
    const sourceStyle = getComputedStyle(element);
    const source = {
      borderStyle: sourceStyle.borderStyle,
      borderRadius: sourceStyle.borderRadius,
    };
    const expandedDropzoneHeight = getComputedStyle(dropzone).height;
    dropzone.classList.add('drag-over');
    const targetStyle = getComputedStyle(dropzone);
    const target = {
      borderStyle: targetStyle.borderStyle,
      borderRadius: targetStyle.borderRadius,
      boxShadow: targetStyle.boxShadow,
    };

    element.classList.add('native-drag-ghost');
    const ghostStyle = getComputedStyle(element);
    const ghost = {
      borderStyle: ghostStyle.borderStyle,
      borderRadius: ghostStyle.borderRadius,
      boxShadow: ghostStyle.boxShadow,
    };
    element.classList.remove('dragging', 'native-drag-ghost');
    document.body.classList.remove('section-dragging');
    dropzone.classList.remove('drag-over');

    document.body.classList.add('native-app');
    const nativeRestingDropzoneHeight = getComputedStyle(dropzone).height;
    document.body.classList.add('section-dragging');
    const nativeExpandedDropzoneHeight = getComputedStyle(dropzone).height;
    dropzone.classList.add('drag-over');
    const nativeActiveDropzoneHeight = getComputedStyle(dropzone).height;
    document.body.classList.remove('native-app', 'section-dragging');
    dropzone.remove();
    return {
      source,
      ghost,
      target,
      restingDropzoneHeight,
      expandedDropzoneHeight,
      nativeRestingDropzoneHeight,
      nativeExpandedDropzoneHeight,
      nativeActiveDropzoneHeight,
    };
  });
  assert.equal(sectionDragFeedback.source.borderStyle, 'solid');
  assert.equal(sectionDragFeedback.source.borderRadius, '999px');
  assert.equal(sectionDragFeedback.ghost.borderStyle, 'solid');
  assert.equal(sectionDragFeedback.ghost.borderRadius, '999px');
  assert(!sectionDragFeedback.ghost.boxShadow.includes('0px 0px 0px 2px'), 'section drag ghost must not retain a second solid accent rectangle');
  assert.equal(sectionDragFeedback.target.borderStyle, 'dashed');
  assert.equal(sectionDragFeedback.target.borderRadius, '999px');
  assert.equal(sectionDragFeedback.target.boxShadow, 'none');
  assert.equal(sectionDragFeedback.restingDropzoneHeight, '10px');
  assert.equal(sectionDragFeedback.expandedDropzoneHeight, '28px');
  assert.equal(sectionDragFeedback.nativeRestingDropzoneHeight, '22px');
  assert.equal(sectionDragFeedback.nativeExpandedDropzoneHeight, '28px');
  assert.equal(sectionDragFeedback.nativeActiveDropzoneHeight, '28px');

  await page.evaluate(() => window.test.select(3));
  const editableCard = page.locator('.shopping-item-card').filter({ hasText: 'Sehr langer responsiver' });
  const editableCheck = editableCard.locator('.shopping-item-check');
  assert.equal(await editableCheck.isEnabled(), true);
  assert.equal(await editableCheck.evaluate(element => getComputedStyle(element).borderRadius), '50%', 'shopping completion controls must be circular');
  assert.match(await editableCheck.getAttribute('aria-label'), /Sehr langer responsiver Artikeltitel/, 'the completion control must identify its item');
  assert.equal((await editableCard.locator('.shopping-item-quantity').textContent()).trim(), '0 SehrLangeMengeneinheitOhneTrennzeichen');
  await editableCheck.click();
  assert.equal(await editableCheck.getAttribute('aria-checked'), 'true');
  assert.equal(await editableCheck.evaluate(element => document.activeElement === element), true, 'completion rerender must restore focus to the live checkbox');
  assert.match(await editableCard.getAttribute('class'), /is-completed/);
  const completedStyle = await editableCard.evaluate(element => ({
    titleDecoration: getComputedStyle(element.querySelector('.shopping-item-title')).textDecorationLine,
    badgeDecoration: getComputedStyle(element.querySelector('.shopping-item-quantity')).textDecorationLine,
    checkVisible: element.querySelector('.shopping-item-check-icon svg') !== null,
  }));
  assert.match(completedStyle.titleDecoration, /line-through/);
  assert.match(completedStyle.badgeDecoration, /line-through/);
  assert.equal(completedStyle.checkVisible, true);
  await page.evaluate(() => document.activeElement?.blur?.());
  const badgeParity = await page.evaluate(() => {
    const todo = getComputedStyle(document.getElementById('todo-badge-reference'));
    const shopping = getComputedStyle(document.querySelector('.shopping-item-quantity'));
    const properties = ['display', 'paddingTop', 'paddingRight', 'borderRadius', 'fontSize', 'fontWeight', 'lineHeight'];
    return Object.fromEntries(properties.map(property => [property, [todo[property], shopping[property]]]));
  });
  for (const [property, values] of Object.entries(badgeParity)) assert.equal(values[0], values[1], `shared badge ${property} must match`);
  const desktopCardParity = await page.evaluate(() => {
    const todo = getComputedStyle(document.getElementById('todo-card-reference'));
    const shopping = getComputedStyle(document.getElementById('shopping-card-reference'));
    const properties = ['minHeight', 'gap', 'paddingTop', 'paddingLeft', 'borderRadius', 'borderColor', 'backgroundImage', 'boxShadow'];
    const parity = Object.fromEntries(properties.map(property => [property, [todo[property], shopping[property]]]));
    const reminder = getComputedStyle(document.getElementById('todo-reminder-reference'));
    const successProbe = document.createElement('span');
    successProbe.style.color = 'var(--success)';
    document.body.append(successProbe);
    const successColor = getComputedStyle(successProbe).color;
    successProbe.remove();
    return {
      parity,
      reminderColor: reminder.color,
      successColor,
      pinnedRadius: getComputedStyle(document.getElementById('todo-pinned-reference')).borderRadius,
      pinnedMetaRadius: getComputedStyle(document.getElementById('todo-pinned-meta-reference')).borderRadius,
    };
  });
  for (const [property, values] of Object.entries(desktopCardParity.parity)) assert.equal(values[0], values[1], `shared card ${property} must match`);
  assert.equal(desktopCardParity.parity.minHeight[0], '50px');
  assert.equal(desktopCardParity.parity.borderRadius[0], '999px');
  assert.equal(desktopCardParity.parity.borderColor[0], 'rgba(0, 0, 0, 0)');
  assert.equal(desktopCardParity.parity.boxShadow[0], 'none');
  assert.equal(desktopCardParity.reminderColor, desktopCardParity.successColor, 'todo reminder badges must retain their semantic success color');
  assert.equal(desktopCardParity.pinnedRadius, '999px', 'plain pinned todos must retain the desktop pill radius');
  assert.equal(desktopCardParity.pinnedMetaRadius, '26px', 'pinned todos with metadata must retain their expanded radius');

  await page.setViewportSize({ width: 320, height: 700 });
  await page.evaluate(() => { window.test.select(4); window.test.setName('Sehr langer Name einer Einkaufsliste, der auf kleinen Bildschirmen sauber umbrechen muss'); });
  const visibleSection = page.locator('.section-header:not(.section-unsorted)').first();
  await visibleSection.waitFor({ state: 'visible' });
  const mobile = await main.evaluate(element => ({
    paddingLeft: getComputedStyle(element).paddingLeft,
    bodyFits: document.documentElement.scrollWidth <= innerWidth,
    titleWidth: element.querySelector('h1').getBoundingClientRect().width,
    sectionWidth: element.querySelector('.section-header').getBoundingClientRect().width,
    titleBottom: element.querySelector('h1').getBoundingClientRect().bottom,
    filterTop: element.querySelector('.shopping-list-store-filter').getBoundingClientRect().top,
    filterWidth: element.querySelector('.shopping-list-store-filter').getBoundingClientRect().width,
  }));
  assert.equal(mobile.paddingLeft, '16px');
  assert.equal(mobile.bodyFits, true);
  assert(mobile.titleWidth > 100);
  assert(mobile.sectionWidth > 100);
  assert(mobile.filterTop >= mobile.titleBottom - 0.5, 'the current-list filter must wrap below a long title instead of crushing it');
  assert(mobile.filterWidth >= 160, 'the existing dropdown must retain a usable mobile width');
  await page.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').click();
  await page.locator('#shopping-store-filter-ui-menu .ui-select-action').click();
  const mobileCreator = await page.locator('#shopping-filter-store-new-store').evaluate(element => ({
    fitsViewport: document.documentElement.scrollWidth <= innerWidth,
    width: element.getBoundingClientRect().width,
    columns: getComputedStyle(element.querySelector('.shopping-store-creator-row')).gridTemplateColumns,
    buttonWidth: element.querySelector('button').getBoundingClientRect().width,
  }));
  assert.equal(mobileCreator.fitsViewport, true);
  assert(mobileCreator.width > 200);
  assert.equal(mobileCreator.columns.split(' ').length, 1, 'the shared store creator must stack on narrow screens');
  assert(mobileCreator.buttonWidth > 200, 'the shared store creator actions must remain easy to tap');
  await page.locator('[data-shopping-store-creator="shopping-filter-store"][data-shopping-store-creator-action="cancel"]').click();
  await page.evaluate(() => window.test.select(3));
  const itemMobile = await page.locator('#shopping-navigation-main .shopping-item-card').first().evaluate(element => ({
    fitsViewport: document.documentElement.scrollWidth <= innerWidth,
    cardWidth: element.getBoundingClientRect().width,
    titleWidth: element.querySelector('.shopping-item-title').getBoundingClientRect().width,
    titleRight: element.querySelector('.shopping-item-title').getBoundingClientRect().right,
    badgeLeft: element.querySelector('.shopping-item-quantity').getBoundingClientRect().left,
    badgeRight: element.querySelector('.shopping-item-quantity').getBoundingClientRect().right,
    cardRight: element.getBoundingClientRect().right,
    borderRadius: getComputedStyle(element).borderRadius,
  }));
  assert.equal(itemMobile.fitsViewport, true);
  assert(itemMobile.cardWidth > 200);
  assert(itemMobile.titleWidth > 0);
  assert(itemMobile.titleRight <= itemMobile.badgeLeft + 0.5, 'long title and long quantity unit must not overlap');
  assert(itemMobile.badgeRight <= itemMobile.cardRight + 0.5);
  assert.equal(itemMobile.borderRadius, '24px');
  const mobileTodoVariants = await page.evaluate(() => ({
    actionPaddingRight: getComputedStyle(document.getElementById('todo-card-reference')).paddingRight,
    pinnedRadius: getComputedStyle(document.getElementById('todo-pinned-reference')).borderRadius,
    pinnedMetaRadius: getComputedStyle(document.getElementById('todo-pinned-meta-reference')).borderRadius,
  }));
  assert.equal(mobileTodoVariants.actionPaddingRight, '52px', 'compact todo cards must retain room for the reveal action');
  assert.equal(mobileTodoVariants.pinnedRadius, '24px', 'plain pinned todos must retain the mobile radius');
  assert.equal(mobileTodoVariants.pinnedMetaRadius, '26px', 'pinned todos with metadata must retain their expanded mobile radius');

  for (const language of ['cs', 'de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'zh-CN']) {
    await page.evaluate(language => window.test.setLanguage(language), language);
    await page.waitForFunction(() => document.documentElement.lang.length > 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${language} must fit at 320px`);
    assert((await page.locator('.section-unsorted .section-name').textContent()).trim(), `${language} unsorted label must render`);
    assert.match(await page.locator('.shopping-item-check').first().getAttribute('aria-label'), /Sehr langer responsiver Artikeltitel/, `${language} completion label must interpolate the item name`);
  }

  const cleanedLegacyState = await page.evaluate(async () => {
    const indexedDb = await import('/static/js/storage/indexed-db.js');
    await indexedDb.closeAndDeleteDatabase();
    await new Promise((resolve, reject) => {
      const request = window.indexedDB.open('nia-todo-db', 7);
      request.onupgradeneeded = event => {
        const database = event.target.result;
        database.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
        database.createObjectStore('shoppingLists', { keyPath: 'id' });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const tx = database.transaction(['syncQueue', 'shoppingLists'], 'readwrite');
        tx.objectStore('syncQueue').put({ id: 1, action: 'CREATE_SHOPPING_STORE', data: { shopping_list_id: 4, store: { name: 'REWE', owner_household_id: 2 } } });
        tx.objectStore('syncQueue').put({ id: 2, action: 'UPDATE_SHOPPING_ITEM', data: { shopping_list_id: 4, item_id: 41, changes: { completed: true } } });
        tx.objectStore('shoppingLists').put({ id: 4, preferences: { hide_empty_sections: true } });
        tx.oncomplete = () => { database.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
    await indexedDb.openDatabase();
    return {
      queue: await indexedDb.getAll('syncQueue'),
      lists: await indexedDb.getAll('shoppingLists'),
    };
  });
  assert.deepEqual(cleanedLegacyState.queue, [], 'IndexedDB v8 must discard unreleased owner-scoped shopping mutations');
  assert.deepEqual(cleanedLegacyState.lists, [], 'IndexedDB v8 must discard unreleased shopping projections before list-scoped stores load');

  assert.deepEqual(pageErrors, []);
  console.log('✅ Shopping selected-list shared section content passed');
} finally {
  await browser.close();
}
