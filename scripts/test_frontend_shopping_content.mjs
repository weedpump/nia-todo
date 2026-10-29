#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const moduleContentCss = readFileSync(new URL('../web/static/css/14-module-content.css', import.meta.url), 'utf8');
assert(!moduleContentCss.includes('.shopping-list-empty-state'), 'Shopping must use the existing shared empty-state spacing without a domain override');

const fixtureSource = `
  import { createShoppingNavigationFeature } from '/static/js/features/shopping-navigation.js';
  import { initI18n, setLanguagePreference } from '/static/js/i18n/index.js';

  localStorage.setItem('nia-todo-language', 'de');
  await initI18n();

  let lists = [
    { id: 1, name: 'Wocheneinkauf', color: '#2563eb', icon: 'shopping-cart', sort_order: 0, items: [], sections: [] },
    { id: 2, name: 'Gefüllte Liste', color: '#16a34a', icon: 'list-checks', sort_order: 1, items: [{ id: 10, name: 'Milch', completed: false }], sections: [] },
  ];

  document.body.innerHTML = \`
    <div id="shopping-list-sidebar" hidden></div>
    <button type="button" hidden data-entity-sidebar-action="add" data-entity-type="shopping-list">Liste hinzufügen</button>
    <main id="shopping-navigation-main" class="module-page module-empty-page"></main>
  \`;

  const navigation = createShoppingNavigationFeature({
    getLists: () => lists,
    root: document,
    getElementById: id => document.getElementById(id),
    storage: localStorage,
    historyTarget: history,
    locationTarget: location,
    eventTarget: window,
    closeSidebar: () => false,
    onAdd: () => {},
    onDetail: () => {},
  });
  navigation.bind();
  navigation.render();

  window.test = {
    select: id => navigation.selectList(id),
    setName: name => {
      lists = lists.map(list => String(list.id) === String(navigation.getActiveListId()) ? { ...list, name } : list);
      navigation.replaceLists(lists);
    },
    setLanguage: async language => {
      await setLanguagePreference(language);
      navigation.render();
    },
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
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><head><link rel="stylesheet" href="/static/style.css"></head><body><script type="module" src="/fixture.js"></script></body></html>',
      });
      return;
    }
    if (url.pathname === '/fixture.js') {
      await route.fulfill({ contentType: 'text/javascript', body: fixtureSource });
      return;
    }
    if (url.pathname.startsWith('/static/')) {
      try {
        const body = readFileSync(new URL(`../web${url.pathname}`, import.meta.url), 'utf8');
        await route.fulfill({
          contentType: url.pathname.endsWith('.json') ? 'application/json' : (url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript'),
          body,
        });
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
  await empty.waitFor({ state: 'visible' });
  assert.equal(await main.getAttribute('data-shopping-content-state'), 'empty');
  assert.equal((await header.locator('h1').textContent()).trim(), 'Wocheneinkauf');
  const desktop = await main.evaluate(element => ({
    paddingLeft: getComputedStyle(element).paddingLeft,
    headerTop: element.querySelector('.shopping-list-content-header').getBoundingClientRect().top,
    emptyPaddingTop: getComputedStyle(element.querySelector('.shopping-list-empty-state')).paddingTop,
  }));
  assert.equal(desktop.paddingLeft, '24px');
  assert(desktop.headerTop < 100, 'the selected-list header must stay in normal top content flow');
  assert.equal(desktop.emptyPaddingTop, '60px');

  await page.evaluate(() => window.test.select(2));
  assert.equal(await main.getAttribute('data-shopping-content-state'), 'populated');
  assert.equal(await empty.count(), 0, 'item data must suppress the empty-list message');
  assert.equal(await page.locator('.shopping-list-content-items').count(), 1);

  await page.setViewportSize({ width: 320, height: 700 });
  await page.evaluate(() => {
    window.test.select(1);
    window.test.setName('Sehr langer Name einer Einkaufsliste, der auf kleinen Bildschirmen sauber umbrechen muss');
  });
  await empty.waitFor({ state: 'visible' });
  const mobile = await main.evaluate(element => ({
    paddingLeft: getComputedStyle(element).paddingLeft,
    bodyFits: document.documentElement.scrollWidth <= innerWidth,
    titleWidth: element.querySelector('h1').getBoundingClientRect().width,
    emptyPaddingTop: getComputedStyle(element.querySelector('.shopping-list-empty-state')).paddingTop,
  }));
  assert.equal(mobile.paddingLeft, '16px');
  assert.equal(mobile.bodyFits, true);
  assert(mobile.titleWidth > 100);
  assert.equal(mobile.emptyPaddingTop, '60px');

  for (const language of ['cs', 'de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'zh-CN']) {
    await page.evaluate(language => window.test.setLanguage(language), language);
    await page.waitForFunction(() => document.documentElement.lang.length > 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${language} must fit at 320px`);
    assert((await page.locator('.shopping-list-empty-state h3').textContent()).trim(), `${language} empty title must render`);
  }

  assert.deepEqual(pageErrors, []);
  console.log('✅ Shopping selected-list content and responsive empty state passed');
} finally {
  await browser.close();
}
