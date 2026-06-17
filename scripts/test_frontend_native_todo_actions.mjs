#!/usr/bin/env node
import { withFreshDb, launchPage, BASE_URL, USERNAME, USER_PASSWORD } from './frontend_test_lib.mjs';

async function waitForTodo(page, title, expected = {}) {
  await page.waitForFunction(async ({ title, expected }) => {
    const jwt = localStorage.getItem('jwt_token');
    const data = await fetch('/api/todos', { headers: { Authorization: `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
    return data.todos.some((todo) => {
      if (todo.title !== title) return false;
      if (expected.status && todo.status !== expected.status) return false;
      if (expected.pinned === true && !todo.is_pinned) return false;
      if (expected.due === true && !todo.due_date) return false;
      return true;
    });
  }, { title, expected }, { timeout: 10000 });
}

async function run() {
  console.log('🖱️ Running native todo quick actions test...');
  const { browser, page, openTodoModal, assertNoFrontendErrors } = await launchPage();
  const title = 'Native Quick Actions Todo';
  const todoItem = () => page.locator('.todo-item').filter({ hasText: title }).last();

  try {
    await page.addInitScript((serverUrl) => {
      window.__TAURI__ = { core: { invoke: async (command) => {
        if (command === 'desktop_get_settings') return { serverUrl };
        return null;
      } } };
    }, BASE_URL);

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10000 });
    await page.fill('#login-username', USERNAME);
    await page.fill('#login-password', USER_PASSWORD);
    await page.click('button.login-btn');
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 15000 });
    await page.evaluate(() => window.setFilter?.('all'));

    await openTodoModal();
    await page.fill('#todo-title', title);
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await waitForTodo(page, title);
    await page.evaluate(() => window.setFilter?.('all'));

    let item = todoItem();
    await item.waitFor({ state: 'visible', timeout: 5000 });

    const statusSummary = item.locator('.todo-status-menu summary');
    const summaryBox = await statusSummary.boundingBox();
    if (!summaryBox) throw new Error('Status summary bounding box missing');
    await page.mouse.move(12, 12);
    await page.mouse.down();
    await page.mouse.move(summaryBox.x + summaryBox.width / 2, summaryBox.y + summaryBox.height / 2);
    await page.mouse.up();
    await page.waitForTimeout(100);
    const openedByMismatchedPointer = await page.locator('.todo-status-menu[open]').count();
    if (openedByMismatchedPointer !== 0) throw new Error('Status menu opened from mismatched pointerdown/pointerup');

    await statusSummary.click();
    await page.waitForFunction(() => document.querySelector('.todo-status-menu[open]'), null, { timeout: 5000 });
    await item.locator('.todo-status-options button').filter({ hasText: /In Arbeit|In progress/i }).click();
    await waitForTodo(page, title, { status: 'in_progress' });
    await page.waitForTimeout(150);

    item = todoItem();
    await item.locator('.todo-snooze-menu summary').click();
    await item.locator('.todo-snooze-menu[open]').waitFor({ state: 'visible', timeout: 5000 });
    const tomorrowButton = item.locator('.todo-snooze-menu .todo-status-options button').filter({ hasText: /Morgen|Tomorrow/i });
    await tomorrowButton.waitFor({ state: 'visible', timeout: 5000 });
    await tomorrowButton.click();
    await waitForTodo(page, title, { due: true });

    item = todoItem();
    await item.locator('.todo-pin-btn').click();
    await waitForTodo(page, title, { pinned: true });

    item = todoItem();
    await item.locator('button[title="Löschen"], button[title="Delete"]').click();
    await page.locator('#confirm-modal.active').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#confirm-cancel-btn').click();
    await page.locator('#confirm-modal.active').waitFor({ state: 'hidden', timeout: 5000 });

    item = todoItem();
    await item.locator('.todo-check').click();
    await waitForTodo(page, title, { status: 'done' });

    assertNoFrontendErrors();
    console.log('✅ Native todo quick actions test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);
