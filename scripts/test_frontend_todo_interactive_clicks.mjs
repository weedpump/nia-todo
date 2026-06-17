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


async function waitForTodoTimes(page, title, expectedDue, expectedReminder) {
  return page.waitForFunction(async ({ title, expectedDue, expectedReminder }) => {
    const jwt = localStorage.getItem('jwt_token');
    const data = await fetch('/api/todos', { headers: { Authorization: `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
    const todo = data.todos.find(item => item.title === title);
    if (!todo) return false;
    const reminder = todo.remind_at || todo.reminders?.find?.(item => !item.sent_at)?.remind_at || todo.reminders?.[0]?.remind_at || null;
    const dueTime = todo.due_date ? new Date(todo.due_date).getTime() : null;
    const remindTime = reminder ? new Date(reminder).getTime() : null;
    const expectedDueTime = expectedDue ? new Date(expectedDue).getTime() : null;
    const expectedReminderTime = expectedReminder ? new Date(expectedReminder).getTime() : null;
    const dueOk = expectedDueTime === null ? dueTime === null : Math.abs(dueTime - expectedDueTime) < 1000;
    const reminderOk = expectedReminderTime === null ? remindTime === null : Math.abs(remindTime - expectedReminderTime) < 1000;
    return dueOk && reminderOk ? todo : false;
  }, { title, expectedDue, expectedReminder }, { timeout: 10000 });
}

function localDateTimeValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function nextWeekday(from, weekday) {
  const date = new Date(from);
  const diff = (weekday - date.getDay() + 7) % 7 || 7;
  date.setDate(date.getDate() + diff);
  date.setHours(9, 0, 0, 0);
  return date;
}

async function clickSnoozeMode(page, item, mode) {
  await item.locator('.todo-snooze-menu').evaluate((menu, snoozeMode) => {
    menu.setAttribute('open', '');
    const button = Array.from(menu.querySelectorAll('.todo-status-options button'))
      .find((candidate) => (candidate.getAttribute('onclick') || '').includes(`\"${snoozeMode}\"`));
    if (!button) throw new Error(`Snooze mode button not found: ${snoozeMode}`);
    button.click();
  }, mode);
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
  const longDescriptionTitle = 'Four Line Description Reveal Todo';
  const todoItem = () => page.locator('.todo-item').filter({ hasText: title }).last();
  const snoozeReminderItem = () => page.locator('.todo-item').filter({ hasText: snoozeReminderTitle }).last();
  const longDescriptionItem = () => page.locator('.todo-item').filter({ hasText: longDescriptionTitle }).last();
  const openSchedulePanel = async () => {
    await page.evaluate(() => {
      const panel = document.getElementById('todo-schedule-panel');
      if (panel) panel.open = true;
    });
  };

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
    await openSchedulePanel();
    await page.selectOption('#todo-recurring-frequency', 'monthly', { force: true });
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
    await page.selectOption('#todo-recurring-frequency', 'none', { force: true });
    await page.locator('#todo-recurring-interval').blur();
    await page.evaluate(() => window.closeModal('todo-modal'));
    await page.locator('#todo-modal.active').waitFor({ state: 'hidden', timeout: 5000 });

    await openTodoModal();
    const originalDue = new Date();
    originalDue.setDate(originalDue.getDate() + 7);
    originalDue.setHours(10, 0, 0, 0);
    const originalReminder = new Date(originalDue.getTime() - 60 * 60 * 1000);
    await page.fill('#todo-title', snoozeReminderTitle);
    await page.fill('#todo-due', localDateTimeValue(originalDue), { force: true });
    await page.fill('#todo-remind', localDateTimeValue(originalReminder), { force: true });
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

    await page.click('#toast-undo', { force: true });
    await waitForTodoTimes(page, snoozeReminderTitle, originalDue.toISOString(), originalReminder.toISOString());

    item = snoozeReminderItem();
    await clickSnoozeMode(page, item, 'hour');
    const duePlusHour = new Date(originalDue.getTime() + 60 * 60 * 1000);
    const reminderPlusHour = new Date(originalReminder.getTime() + 60 * 60 * 1000);
    await waitForTodoTimes(page, snoozeReminderTitle, duePlusHour.toISOString(), reminderPlusHour.toISOString());

    await page.evaluate(() => window.undoLastAction?.());
    await waitForTodoTimes(page, snoozeReminderTitle, originalDue.toISOString(), originalReminder.toISOString());

    item = snoozeReminderItem();
    await clickSnoozeMode(page, item, 'evening');
    const thisEvening = new Date();
    thisEvening.setHours(18, 0, 0, 0);
    if (thisEvening <= new Date()) thisEvening.setDate(thisEvening.getDate() + 1);
    const thisEveningReminder = new Date(thisEvening.getTime() - 60 * 60 * 1000);
    await waitForTodoTimes(page, snoozeReminderTitle, thisEvening.toISOString(), thisEveningReminder.toISOString());

    await page.evaluate(() => window.undoLastAction?.());
    await waitForTodoTimes(page, snoozeReminderTitle, originalDue.toISOString(), originalReminder.toISOString());

    const nowForCalendarPresets = new Date();
    const calendarPresetCases = [
      ['tomorrow', (() => { const date = new Date(nowForCalendarPresets); date.setDate(nowForCalendarPresets.getDate() + 1); date.setHours(9, 0, 0, 0); return date; })()],
      ['weekend', nextWeekday(nowForCalendarPresets, 6)],
      ['next-week', (() => { const date = new Date(nowForCalendarPresets); date.setDate(nowForCalendarPresets.getDate() + 7); date.setHours(9, 0, 0, 0); return date; })()],
    ];
    for (const [mode, expectedDue] of calendarPresetCases) {
      item = snoozeReminderItem();
      await clickSnoozeMode(page, item, mode);
      const expectedReminder = new Date(expectedDue.getTime() - 60 * 60 * 1000);
      await waitForTodoTimes(page, snoozeReminderTitle, expectedDue.toISOString(), expectedReminder.toISOString());
      await page.evaluate(() => window.undoLastAction?.());
      await waitForTodoTimes(page, snoozeReminderTitle, originalDue.toISOString(), originalReminder.toISOString());
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await openTodoModal();
    await page.fill('#todo-title', longDescriptionTitle);
    await page.fill('#todo-desc', 'Line one with enough content for the preview.\nLine two adds more visible height.\nLine three keeps the card tall.\nLine four catches reveal hitbox regressions.');
    const longDescriptionDue = new Date();
    longDescriptionDue.setDate(longDescriptionDue.getDate() + 2);
    longDescriptionDue.setHours(13, 30, 0, 0);
    const longDescriptionReminder = new Date(longDescriptionDue.getTime() - 30 * 60 * 1000);
    await page.fill('#todo-due', localDateTimeValue(longDescriptionDue), { force: true });
    await page.fill('#todo-remind', localDateTimeValue(longDescriptionReminder), { force: true });
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction((value) => document.body.innerText.includes(value), longDescriptionTitle, { timeout: 10000 });
    await waitForTodoTimes(page, longDescriptionTitle, longDescriptionDue.toISOString(), longDescriptionReminder.toISOString());
    item = longDescriptionItem();
    await item.waitFor({ state: 'visible', timeout: 5000 });
    const revealHitTarget = await page.evaluate((value) => {
      const titleEl = Array.from(document.querySelectorAll('.todo-title')).find((el) => (el.textContent || '').includes(value));
      const item = titleEl?.closest('.todo-item');
      const button = item?.querySelector('.todo-actions-reveal-btn');
      if (!item || !button) return { ok: false };
      item.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { ok: Boolean(hit?.closest?.('.todo-actions-reveal-btn')), x, y };
    }, longDescriptionTitle);
    if (!revealHitTarget.ok) throw new Error('Mobile reveal button hit target is covered on multi-line timed description todo');
    await page.mouse.click(revealHitTarget.x, revealHitTarget.y);
    await item.locator('.todo-pin-btn').waitFor({ state: 'visible', timeout: 5000 });
    await assertTodoModalHidden(page, 'mobile reveal on multi-line description todo');
    await page.waitForTimeout(750);
    await item.locator('.todo-body').click();
    await assertTodoModalHidden(page, 'outside dismiss after multi-line description reveal');
    await item.locator('.todo-pin-btn').waitFor({ state: 'hidden', timeout: 5000 });
    await page.evaluate(() => window.closeModal?.('todo-modal'));
    await page.locator('#todo-modal.active').waitFor({ state: 'hidden', timeout: 5000 });

    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window.closeModal?.('todo-modal');
      document.getElementById('todo-modal')?.classList.remove('active');
    });
    await page.locator('#todo-modal.active').waitFor({ state: 'hidden', timeout: 5000 });
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
