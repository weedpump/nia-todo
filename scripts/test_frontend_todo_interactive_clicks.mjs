#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function waitForTodo(page, title, expected = {}) {
  await page.waitForFunction(async ({ title, expected }) => {
    const jwt = localStorage.getItem('jwt_token');
    const data = await fetch('/api/todos', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
    const todo = data.todos.find(item => item.title === title);
    if (!todo) return false;
    if (expected.status && todo.status !== expected.status) return false;
    if (expected.pinned === true && !todo.is_pinned) return false;
    return true;
  }, { title, expected }, { timeout: 10000 });
}

async function assertTodoModalHidden(page, label) {
  const visible = await page.locator('#todo-modal.active').isVisible().catch(() => false);
  if (visible) throw new Error(`Todo modal opened after ${label}`);
}

async function run() {
  console.log('🖱️ Running slim todo interactive click isolation test...');
  const { browser, page, loginApp, openTodoModal, assertNoFrontendErrors } = await launchPage();
  const title = 'Todo Click Isolation Smoke';

  try {
    await loginApp();
    await openTodoModal();
    await page.fill('#todo-title', title);
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await waitForTodo(page, title);

    const todoItem = () => page.locator('.todo-item').filter({ hasText: title }).last();
    let item = todoItem();
    await item.waitFor({ state: 'visible', timeout: 5000 });

    await item.locator('.todo-check').evaluate((el) => el.click());
    await waitForTodo(page, title, { status: 'in_progress' });
    await assertTodoModalHidden(page, 'todo checkbox');

    item = todoItem();
    await item.locator('.todo-status-menu-left summary').click();
    await item.locator('.todo-status-menu-left[open]').waitFor({ state: 'visible', timeout: 5000 });
    await assertTodoModalHidden(page, 'status menu');
    await page.keyboard.press('Escape');

    item = todoItem();
    await item.locator('.todo-snooze-menu summary').click();
    await item.locator('.todo-snooze-menu[open]').waitFor({ state: 'visible', timeout: 5000 });
    await assertTodoModalHidden(page, 'snooze menu');
    await page.keyboard.press('Escape');

    item = todoItem();
    await item.locator('.todo-pin-btn').click();
    await waitForTodo(page, title, { pinned: true });
    await assertTodoModalHidden(page, 'pin button');

    assertNoFrontendErrors();
    console.log('✅ Slim todo interactive click isolation test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);
