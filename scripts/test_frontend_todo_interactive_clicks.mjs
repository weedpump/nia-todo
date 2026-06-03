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

async function waitForSnoozedReminderOffset(page, title, expectedOffsetMs) {
  return page.waitForFunction(async ({ title, expectedOffsetMs }) => {
    const jwt = localStorage.getItem('jwt_token');
    const data = await fetch('/api/todos', { headers: { Authorization: `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
    const todo = data.todos.find(item => item.title === title);
    if (!todo) return false;
    const reminder = todo.remind_at || todo.reminders?.find?.(item => !item.sent_at)?.remind_at || todo.reminders?.[0]?.remind_at;
    if (!todo.due_date || !reminder) return false;
    const due = new Date(todo.due_date);
    const remind = new Date(reminder);
    if (!Number.isFinite(due.getTime()) || !Number.isFinite(remind.getTime())) return false;
    return Math.abs((due.getTime() - remind.getTime()) - expectedOffsetMs) < 1000 ? todo : false;
  }, { title, expectedOffsetMs }, { timeout: 10000 });
}

function localDateTimeValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
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
  const snoozeReminderTitle = 'Snooze Keeps Reminder Offset Todo';
  const todoItem = () => page.locator('.todo-item').filter({ hasText: title }).last();
  const snoozeReminderItem = () => page.locator('.todo-item').filter({ hasText: snoozeReminderTitle }).last();

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

    await openTodoModal();
    await page.selectOption('#todo-recurring-frequency', 'monthly');
    await page.click('#todo-recurring-interval');
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    const recurringIntervalAfterDelete = await page.locator('#todo-recurring-interval').inputValue();
    if (recurringIntervalAfterDelete !== '') {
      throw new Error(`Recurring interval should stay editable after deleting default 1, got ${JSON.stringify(recurringIntervalAfterDelete)}`);
    }
    await page.keyboard.type('6');
    const recurringIntervalAfterTyping = await page.locator('#todo-recurring-interval').inputValue();
    if (recurringIntervalAfterTyping !== '6') {
      throw new Error(`Recurring interval should allow replacing 1 with 6, got ${JSON.stringify(recurringIntervalAfterTyping)}`);
    }
    await page.selectOption('#todo-recurring-frequency', 'none');
    await page.locator('#todo-recurring-interval').blur();
    await page.evaluate(() => window.closeModal('todo-modal'));
    await page.locator('#todo-modal.active').waitFor({ state: 'hidden', timeout: 5000 });

    await openTodoModal();
    const originalDue = new Date();
    originalDue.setDate(originalDue.getDate() + 7);
    originalDue.setHours(10, 0, 0, 0);
    const originalReminder = new Date(originalDue.getTime() - 60 * 60 * 1000);
    await page.fill('#todo-title', snoozeReminderTitle);
    await page.fill('#todo-due', localDateTimeValue(originalDue));
    await page.fill('#todo-remind', localDateTimeValue(originalReminder));
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await waitForTodo(page, snoozeReminderTitle, { due: true });

    const reminderItem = snoozeReminderItem();
    await reminderItem.locator('.todo-snooze-menu summary').click();
    await reminderItem.locator('.todo-snooze-menu[open]').waitFor({ state: 'visible', timeout: 5000 });
    await reminderItem.locator('.todo-snooze-menu .todo-status-options button').filter({ hasText: /Morgen|Tomorrow/i }).click();
    const snoozedHandle = await waitForSnoozedReminderOffset(page, snoozeReminderTitle, 60 * 60 * 1000);
    const snoozed = await snoozedHandle.jsonValue();
    if (!snoozed?.due_date) throw new Error('Snoozed todo did not retain due date and reminder');
    await assertTodoModalHidden(page, 'snooze reminder option');

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
