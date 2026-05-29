#!/usr/bin/env node
import { withFreshDb, launchPage, USERNAME, USER_PASSWORD } from './frontend_test_lib.mjs';

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

async function assertTodoModalHidden(page, context) {
  const active = await page.locator('#todo-modal.active').count();
  if (active !== 0) throw new Error(`Todo modal opened from ${context}`);
}

async function assertTodoDidNotPress(page, item, context) {
  const pressed = await item.evaluate((el) => el.classList.contains('todo-press-active'));
  if (pressed) throw new Error(`Todo press feedback leaked from ${context}`);
}

async function run() {
  console.log('🖱️ Running todo interactive click isolation test...');
  const { browser, page, openTodoModal, loginApp, assertNoFrontendErrors } = await launchPage();
  const title = 'Interactive Click Isolation Todo';
  const todoItem = () => page.locator('.todo-item').filter({ hasText: title }).last();

  try {
    await loginApp();

    await openTodoModal();
    await page.fill('#todo-title', title);
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction((value) => document.body.innerText.includes(value), title, { timeout: 10000 });

    let item = todoItem();
    await item.waitFor({ state: 'visible', timeout: 5000 });

    await item.locator('.todo-check').click();
    await waitForTodo(page, title, { status: 'in_progress' });
    await assertTodoModalHidden(page, 'todo checkbox');
    await assertTodoDidNotPress(page, item, 'todo checkbox');

    item = todoItem();
    await item.locator('.todo-status-menu summary').click();
    await item.locator('.todo-status-menu[open]').waitFor({ state: 'visible', timeout: 5000 });
    await assertTodoModalHidden(page, 'status summary');
    await assertTodoDidNotPress(page, item, 'status summary');
    await page.keyboard.press('Escape');
    await assertTodoModalHidden(page, 'status menu');

    item = todoItem();
    await item.locator('.todo-snooze-menu summary').click();
    await item.locator('.todo-snooze-menu[open]').waitFor({ state: 'visible', timeout: 5000 });
    await assertTodoModalHidden(page, 'snooze summary');
    await assertTodoDidNotPress(page, item, 'snooze summary');
    await item.locator('.todo-snooze-menu .todo-status-options button').filter({ hasText: /Morgen|Tomorrow/i }).click();
    await waitForTodo(page, title, { due: true });
    await assertTodoModalHidden(page, 'snooze option');

    item = todoItem();
    await item.locator('.todo-pin-btn').click();
    await waitForTodo(page, title, { pinned: true });
    await assertTodoModalHidden(page, 'pin button');
    await assertTodoDidNotPress(page, item, 'pin button');

    item = todoItem();
    await item.locator('.todo-body').click();
    await page.locator('#todo-modal.active').waitFor({ state: 'visible', timeout: 5000 });
    await page.evaluate(() => window.closeModal('todo-modal'));
    await page.locator('#todo-modal.active').waitFor({ state: 'hidden', timeout: 5000 });

    assertNoFrontendErrors();
    console.log('✅ Todo interactive click isolation test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);
