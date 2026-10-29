#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const moduleContentCss = readFileSync(new URL('../web/static/css/14-module-content.css', import.meta.url), 'utf8');
assert(!moduleContentCss.includes('.shopping-section-'), 'Shopping must not create a parallel section CSS authority');

const fixtureSource = `
  import { createShoppingNavigationFeature } from '/static/js/features/shopping-navigation.js';
  import { initI18n, setLanguagePreference } from '/static/js/i18n/index.js';

  localStorage.setItem('nia-todo-language', 'de');
  await initI18n();
  let lists = [
    { id: 1, name: 'Wocheneinkauf', color: '#2563eb', icon: 'shopping-cart', sort_order: 0, can_manage: true, items: [], sections: [] },
    { id: 2, name: 'Gefüllte Liste', color: '#16a34a', icon: 'list-checks', sort_order: 1, can_manage: 'false',
      items: [{ id: 10, name: 'Milch', completed: false, section_id: 'missing' }],
      sections: [{ id: 'produce', name: 'Obst & Gemüse', sort_order: 0 }, { id: 'empty', name: 'Leer', sort_order: 1 }] },
  ];
  document.body.innerHTML = \`
    <div id="shopping-list-sidebar" hidden></div>
    <button type="button" hidden data-entity-sidebar-action="add" data-entity-type="shopping-list">Liste hinzufügen</button>
    <main id="shopping-navigation-main" class="module-page module-empty-page"></main>
  \`;
  const navigation = createShoppingNavigationFeature({
    getLists: () => lists, root: document,
    getElementById: id => document.getElementById(id),
    storage: localStorage, historyTarget: history, locationTarget: location, eventTarget: window,
    closeSidebar: () => false, onAdd: () => {}, onDetail: () => {},
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
  assert.equal(await page.locator('.section-header:not(.section-unsorted)').count(), 2);
  assert.equal(await page.locator('[data-section-action], .section-dropzone, .section-header[draggable="true"]').count(), 0, 'non-boolean management values must render read-only section UI');
  assert.deepEqual(await page.locator('.section-count').allTextContents(), ['0', '0', '1']);
  assert.equal((await page.locator('.section-item-name').textContent()).trim(), 'Milch');
  assert.equal(await page.locator('[data-section-action]').count(), 0);
  assert.equal(await page.locator('.section-dropzone').count(), 0);

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

  await page.setViewportSize({ width: 320, height: 700 });
  await page.evaluate(() => { window.test.select(2); window.test.setName('Sehr langer Name einer Einkaufsliste, der auf kleinen Bildschirmen sauber umbrechen muss'); });
  await unsorted.waitFor({ state: 'visible' });
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

  for (const language of ['cs', 'de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'zh-CN']) {
    await page.evaluate(language => window.test.setLanguage(language), language);
    await page.waitForFunction(() => document.documentElement.lang.length > 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${language} must fit at 320px`);
    assert((await page.locator('.section-unsorted .section-name').textContent()).trim(), `${language} unsorted label must render`);
  }
  assert.deepEqual(pageErrors, []);
  console.log('✅ Shopping selected-list shared section content passed');
} finally {
  await browser.close();
}
