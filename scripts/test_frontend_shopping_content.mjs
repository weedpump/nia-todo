#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const moduleContentCss = readFileSync(new URL('../web/static/css/14-module-content.css', import.meta.url), 'utf8');
assert(!moduleContentCss.includes('.shopping-section-'), 'Shopping must not create a parallel section CSS authority');

const fixtureSource = `
  import { createShoppingNavigationFeature } from '/static/js/features/shopping-navigation.js';
  import { createShoppingItemsController } from '/static/js/features/shopping-items.js';
  import { initI18n, setLanguagePreference } from '/static/js/i18n/index.js';

  localStorage.setItem('nia-todo-language', 'de');
  await initI18n();
  let lists = [
    { id: 1, name: 'Wocheneinkauf', color: '#2563eb', icon: 'shopping-cart', sort_order: 0, can_manage: true, can_edit: true,
      preferences: { selected_store_id: null, hide_empty_sections: true }, items: [], sections: [{ id: 'hidden-empty', name: 'Versteckt', sort_order: 0 }] },
    { id: 2, name: 'Gefüllte Liste', color: '#16a34a', icon: 'list-checks', sort_order: 1, can_manage: 'false', can_edit: 'true',
      preferences: { selected_store_id: null, hide_empty_sections: true },
      items: [{ id: 10, name: 'Milch', quantity_value: 1.5, quantity_unit: 'l', completed: false, section_id: 'produce' }],
      sections: [{ id: 'produce', name: 'Obst & Gemüse', sort_order: 0 }, { id: 'empty', name: 'Leer', sort_order: 1 }] },
    { id: 3, name: 'Bearbeitbar', color: '#7c3aed', icon: 'shopping-basket', sort_order: 2, can_manage: false, can_edit: true,
      items: [
        { id: 'temp-shopping-item-3', name: 'Sehr langer responsiver Artikeltitel ohne horizontalen Überlauf', quantity_value: 0, quantity_unit: 'SehrLangeMengeneinheitOhneTrennzeichen', completed: false, section_id: null },
        { id: 31, name: 'Erledigt', quantity_value: 2, quantity_unit: 'kg', completed: true, section_id: null },
      ], sections: [] },
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
  const itemController = createShoppingItemsController({
    getLists: () => lists,
    setLists: next => { lists = next; },
    getActiveListId: () => navigation?.getActiveListId?.(),
    commitMutation: async build => build(),
    render: () => navigation?.render?.(),
  });
  navigation = createShoppingNavigationFeature({
    getLists: () => lists, root: document,
    getElementById: id => document.getElementById(id),
    storage: localStorage, historyTarget: history, locationTarget: location, eventTarget: window,
    closeSidebar: () => false, onAdd: () => {}, onDetail: () => {},
    itemController,
  });
  navigation.bind();
  navigation.render();
  window.test = {
    select: id => navigation.selectList(id),
    setName: name => {
      lists = lists.map(list => String(list.id) === String(navigation.getActiveListId()) ? { ...list, name } : list);
      navigation.replaceLists(lists);
    },
    setLanguage: async language => { await setLanguagePreference(language); navigation.render(); },
    setSearch: value => navigation.setSearchQuery(value),
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
  await page.evaluate(() => { window.test.select(2); window.test.setName('Sehr langer Name einer Einkaufsliste, der auf kleinen Bildschirmen sauber umbrechen muss'); });
  const visibleSection = page.locator('.section-header:not(.section-unsorted)');
  await visibleSection.waitFor({ state: 'visible' });
  const mobile = await main.evaluate(element => ({
    paddingLeft: getComputedStyle(element).paddingLeft,
    bodyFits: document.documentElement.scrollWidth <= innerWidth,
    titleWidth: element.querySelector('h1').getBoundingClientRect().width,
    sectionWidth: element.querySelector('.section-header').getBoundingClientRect().width,
  }));
  assert.equal(mobile.paddingLeft, '16px');
  assert.equal(mobile.bodyFits, true);
  assert(mobile.titleWidth > 100);
  assert(mobile.sectionWidth > 100);
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
  assert.deepEqual(pageErrors, []);
  console.log('✅ Shopping selected-list shared section content passed');
} finally {
  await browser.close();
}
