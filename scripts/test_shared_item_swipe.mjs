#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const fixtureSource = `
  import { initI18n, t } from '/static/js/i18n/index.js';
  import { renderTodoItem } from '/static/js/features/todo-rendering.js';
  import { createTodosFeature } from '/static/js/features/todos.js';
  import { renderShoppingItem, createShoppingItemsController } from '/static/js/features/shopping-items.js';

  localStorage.setItem('nia-todo-language', 'de');
  await initI18n();

  let todos = [{ id: 1, title: 'Todo swipe', status: 'pending', priority: 3 }];
  const renderTodos = () => {
    document.getElementById('todo-root').innerHTML = todos.map(renderTodoItem).join('');
  };
  createTodosFeature({
    getTodos: () => todos,
    setTodos: next => { todos = next; },
    getProjects: () => [],
    getCurrentProjectId: () => null,
    getCurrentWorkspaceId: () => null,
    getCurrentUser: () => null,
    setCurrentUser: () => {},
    getAppInitialized: () => true,
    getDb: () => ({}),
    dbPut: async () => {},
    dbGetAll: async () => [],
    deleteFromDB: async () => {},
    addToSyncQueue: async () => {},
    isOnlineForSync: () => false,
    syncWithServer: async () => {},
    todosApi: {}, sectionsApi: {}, placesApi: null,
    renderProjects: () => {}, renderStats: () => {}, renderTodos,
    closeModal: () => {}, confirmDanger: async () => false, showToast: () => {},
    setupDescPreview: () => {}, renderMarkdown: value => String(value || ''),
  });

  let lists = [{
    id: 7,
    client_mutation_id: 'temp-shopping-list-7',
    name: 'Swipe list',
    can_edit: true,
    items: [
      { id: 11, client_mutation_id: 'temp-shopping-item-11', name: 'Milch', completed: false },
      { id: 12, name: 'Brot', completed: true },
    ],
  }];
  let mutationCount = 0;
  let editCount = 0;
  const root = document.getElementById('shopping-root');
  let controller;
  const labels = item => ({
    markCompleted: item.name + ' als gekauft markieren',
    markOpen: item.name + ' wieder als offen markieren',
    edit: item.name + ' bearbeiten',
    swipeComplete: t('shopping.item.swipeComplete'),
    swipeReopen: t('shopping.item.swipeReopen'),
  });
  function renderShopping() {
    root.innerHTML = lists[0].items.map(item => renderShoppingItem({
      item,
      canEdit: lists[0].can_edit,
      locale: 'de-DE',
      labels: labels(item),
    })).join('') + renderShoppingItem({
      item: { id: 13, name: 'Nur lesen', completed: false },
      canEdit: false,
      locale: 'de-DE',
      labels: labels({ name: 'Nur lesen' }),
    });
    controller.bindRoot(root);
  }
  controller = createShoppingItemsController({
    getLists: () => lists,
    setLists: next => { lists = next; },
    getActiveListId: () => 7,
    commitMutation: async build => {
      const mutation = build();
      if (mutation) mutationCount += 1;
      return mutation;
    },
    render: renderShopping,
    onEdit: () => { editCount += 1; },
  });
  renderTodos();
  renderShopping();
  window.test = {
    mutationCount: () => mutationCount,
    editCount: () => editCount,
    item: id => lists[0].items.find(item => String(item.id) === String(id)),
    todoStatus: () => todos[0].status,
    renderShopping,
  };
`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 320, height: 700 }, hasTouch: true, isMobile: true });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error?.stack || error)));

async function pointer(selector, type, { dx = 0, dy = 0, pointerId = 41 } = {}) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `missing box for ${selector}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.locator(selector).dispatchEvent(type, {
    pointerId,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: x + dx,
    clientY: y + dy,
    bubbles: true,
    cancelable: true,
  });
}

try {
  await page.route('http://nia.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html class="mobile-swipe-ui"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/style.css"></head><body><div id="todo-root"></div><div id="shopping-root"></div><script type="module" src="/fixture.js"></script></body></html>',
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
        const contentType = url.pathname.endsWith('.json') ? 'application/json' : (url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
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

  assert.equal(await page.locator('.ui-swipe-shell').count(), 3, 'todo and editable shopping items must share one swipe shell');
  assert.equal(await page.locator('.shopping-item-card').count(), 3);
  assert.equal(await page.locator('.shopping-item-card').filter({ hasText: 'Nur lesen' }).locator('xpath=..').getAttribute('class'), null, 'read-only shopping items must not render a swipe shell');

  const todoShell = page.locator('.ui-swipe-shell').filter({ has: page.locator('.todo-item') });
  assert.equal(await todoShell.locator('[data-ui-swipe-direction="left"]').count(), 1);
  assert.equal(await todoShell.locator('[data-ui-swipe-direction="right"]').count(), 1);

  const milkCard = '.shopping-item-card[data-shopping-item-key="11"]';
  const milkShell = page.locator(milkCard).locator('xpath=..');
  assert.match(await milkShell.getAttribute('class'), /ui-swipe-shell/);
  assert.equal(await milkShell.locator('[data-ui-swipe-direction="left"]').count(), 1);
  assert.equal(await milkShell.locator('[data-ui-swipe-direction="right"]').count(), 0, 'shopping must not expose a right-swipe action');
  assert.equal((await milkShell.locator('[data-ui-swipe-direction="left"]').textContent()).trim().includes('Gekauft'), true);

  await pointer(milkCard, 'pointerdown');
  await pointer(milkCard, 'pointermove', { dx: 130 });
  const ignoredRight = await page.locator(milkCard).evaluate(element => ({
    className: element.className,
    swipeX: element.style.getPropertyValue('--swipe-x'),
    transform: getComputedStyle(element).transform,
    shellClass: element.parentElement.className,
    underlayVisibility: getComputedStyle(element.parentElement.querySelector('.ui-swipe-underlay')).visibility,
  }));
  assert(!ignoredRight.className.includes('swiping'), 'right swipe must not activate the card');
  assert.equal(ignoredRight.swipeX, '', 'right swipe must not set a movement value');
  assert.equal(ignoredRight.transform, 'none', 'right swipe must not move the card');
  assert(!ignoredRight.shellClass.includes('is-swiping'), 'right swipe must not activate the shell');
  assert.equal(ignoredRight.underlayVisibility, 'hidden', 'right swipe must not reveal an underlay');
  await pointer(milkCard, 'pointerup', { dx: 130 });
  assert.equal(await page.evaluate(() => window.test.mutationCount()), 0);
  await page.locator(`${milkCard} .shopping-item-edit-trigger`).click();
  assert.equal(await page.evaluate(() => window.test.editCount()), 1, 'ignored right swipe must not suppress the normal item action');

  await pointer(milkCard, 'pointerdown', { pointerId: 42 });
  await pointer(milkCard, 'pointermove', { dx: -55, pointerId: 42 });
  await page.waitForFunction(() => document.querySelector('.shopping-item-card[data-shopping-item-key="11"]')?.closest('.ui-swipe-shell')?.classList.contains('swipe-left'));
  assert.equal(await milkShell.locator('[data-ui-swipe-direction="left"]').evaluate(element => getComputedStyle(element).opacity), '1');
  await pointer(milkCard, 'pointercancel', { dx: -55, pointerId: 42 });
  assert.equal(await page.locator(milkCard).evaluate(element => element.classList.contains('swiping')), false);

  await pointer(milkCard, 'pointerdown', { pointerId: 43 });
  await pointer(milkCard, 'pointermove', { dx: -180, pointerId: 43 });
  await pointer(milkCard, 'pointerup', { dx: -180, pointerId: 43 });
  await page.locator(`${milkCard} .shopping-item-edit-trigger`).dispatchEvent('click');
  await page.waitForFunction(() => window.test.item(11)?.completed === true);
  assert.equal(await page.evaluate(() => window.test.mutationCount()), 1);
  assert.equal(await page.evaluate(() => window.test.editCount()), 1, 'committed left swipe must suppress its follow-up click');
  assert.equal(await page.locator(milkCard).getAttribute('class').then(value => value.includes('is-completed')), true);

  const breadCard = '.shopping-item-card[data-shopping-item-key="12"]';
  const breadShell = page.locator(breadCard).locator('xpath=..');
  assert.equal((await breadShell.locator('[data-ui-swipe-direction="left"]').textContent()).trim().includes('Wieder öffnen'), true);
  await pointer(breadCard, 'pointerdown', { pointerId: 44 });
  await pointer(breadCard, 'pointermove', { dx: -180, pointerId: 44 });
  await pointer(breadCard, 'pointerup', { dx: -180, pointerId: 44 });
  await page.waitForFunction(() => window.test.item(12)?.completed === false);
  assert.equal(await page.evaluate(() => window.test.mutationCount()), 2);

  await pointer(milkCard, 'pointerdown', { pointerId: 45 });
  await pointer(milkCard, 'pointermove', { dx: -5, dy: 90, pointerId: 45 });
  await pointer(milkCard, 'pointerup', { dx: -5, dy: 90, pointerId: 45 });
  assert.equal(await page.evaluate(() => window.test.mutationCount()), 2, 'vertical movement must remain scrolling');

  const todoCard = '.todo-item[data-id="1"]';
  const todoCardShell = page.locator(todoCard).locator('xpath=..');
  assert.equal(await todoCardShell.locator('[data-ui-swipe-direction]').count(), 2, 'Todo must retain both shared swipe directions');
  await pointer(todoCard, 'pointerdown', { pointerId: 56 });
  await pointer(todoCard, 'pointermove', { dx: -180, pointerId: 56 });
  await pointer(todoCard, 'pointerup', { dx: -180, pointerId: 56 });
  await page.waitForFunction(() => window.test.todoStatus() === 'done');
  await page.locator(`${milkCard} .shopping-item-edit-trigger`).click();
  assert.equal(await page.evaluate(() => window.test.editCount()), 2, 'a Todo swipe must not suppress clicks on a different shared card');
  await pointer(todoCard, 'pointerdown', { pointerId: 57 });
  await pointer(todoCard, 'pointermove', { dx: 180, pointerId: 57 });
  await pointer(todoCard, 'pointerup', { dx: 180, pointerId: 57 });
  await page.waitForFunction(() => window.test.todoStatus() === 'in_progress');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await pointer(milkCard, 'pointerdown', { pointerId: 58 });
  await pointer(milkCard, 'pointermove', { dx: -180, pointerId: 58 });
  await pointer(milkCard, 'pointerup', { dx: -180, pointerId: 58 });
  await page.waitForFunction(() => window.test.item(11)?.completed === false);
  assert.equal(await page.evaluate(() => window.test.mutationCount()), 3, 'reduced motion must keep the Shopping mutation contract');
  assert.equal(await page.locator(milkCard).evaluate(element => element.classList.contains('swiping')), false);

  await page.evaluate(() => {
    document.documentElement.classList.remove('mobile-swipe-ui');
    window.test.renderShopping();
  });
  const nonMobileMilkCard = '.shopping-item-card[data-shopping-item-key="11"]';
  await pointer(nonMobileMilkCard, 'pointerdown', { pointerId: 67 });
  await pointer(nonMobileMilkCard, 'pointermove', { dx: -180, pointerId: 67 });
  assert.equal(await page.locator(nonMobileMilkCard).evaluate(element => element.classList.contains('swiping')), false, 'non-mobile cards must never enter swipe state');
  await pointer(nonMobileMilkCard, 'pointerup', { dx: -180, pointerId: 67 });
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.test.mutationCount()), 3, 'swipe adapter must stay inactive without the mobile swipe shell');
  assert.equal(await page.locator(nonMobileMilkCard).evaluate(element => element.style.getPropertyValue('--swipe-x')), '');

  await page.reload();
  await page.waitForFunction(() => Boolean(window.test));
  await page.evaluate(() => {
    const trigger = document.querySelector('.shopping-item-card[data-shopping-item-key="11"] .shopping-item-edit-trigger');
    const rect = trigger.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const startY = rect.top + rect.height / 2;
    const fire = (type, dx, dy) => trigger.dispatchEvent(new PointerEvent(type, {
      pointerId: 68,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: startX + dx,
      clientY: startY + dy,
      bubbles: true,
      cancelable: true,
    }));
    fire('pointerdown', 0, 0);
    fire('pointermove', -20, 15);
    fire('pointermove', -150, 80);
    fire('pointerup', -150, 80);
  });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.test.item(11)?.completed), true, 'a diagonal left-down swipe from the Shopping edit surface must match Todo behavior');
  assert.equal(await page.evaluate(() => window.test.mutationCount()), 1);

  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '320px swipe UI must not create horizontal overflow');
  console.log('✅ Shared Todo/Shopping swipe engine and left-only Shopping gesture passed');
} finally {
  await browser.close();
}
