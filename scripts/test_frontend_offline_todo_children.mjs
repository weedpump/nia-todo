#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

const TODO_TITLE = `Offline child mutations ${process.pid}-${Date.now()}`;

await withFreshDb(async () => {
  const { browser, page, loginApp, openTodoModal, dumpErrors } = await launchPage();
  try {
    await loginApp();
    await page.evaluate(title => localStorage.setItem('__offline_children_title', title), TODO_TITLE);

    await openTodoModal();
    await page.fill('#todo-title', TODO_TITLE);
    await page.click('#todo-modal button[type="submit"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForFunction(async () => {
      const todos = await window.dbGetAll('todos');
      return todos.some(todo => todo.title === localStorage.getItem('__offline_children_title') && typeof todo.id === 'number');
    }, null, { timeout: 10000 });

    await page.context().setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false, null, { timeout: 5000 });
    await page.locator('.todo-item').filter({ hasText: TODO_TITLE }).first().click();
    await page.locator('#todo-modal').waitFor({ state: 'visible', timeout: 5000 });

    await page.fill('#todo-subtask-new-title', 'Keep offline subtask');
    await page.press('#todo-subtask-new-title', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#todo-subtasks-list .todo-subtask-row').length === 1);
    await page.fill('#todo-subtask-new-title', 'Delete offline subtask');
    await page.press('#todo-subtask-new-title', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#todo-subtasks-list .todo-subtask-row').length === 2);
    const subtaskRows = page.locator('#todo-subtasks-list .todo-subtask-row');
    const keptSubtask = subtaskRows.nth(0);
    await keptSubtask.locator('.todo-subtask-title-input').fill('Edited offline subtask');
    await keptSubtask.locator('.todo-subtask-title-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#todo-subtasks-list .todo-subtask-title-input')?.value === 'Edited offline subtask');
    await keptSubtask.locator('.todo-subtask-check-label').click();
    await page.waitForFunction(() => document.querySelector('#todo-subtasks-list .todo-subtask-check')?.checked === true);
    await keptSubtask.locator('.todo-subtask-check-label').click();
    await page.waitForFunction(() => document.querySelector('#todo-subtasks-list .todo-subtask-check')?.checked === false);
    await keptSubtask.locator('.todo-subtask-check-label').click();
    await page.waitForFunction(() => document.querySelector('#todo-subtasks-list .todo-subtask-check')?.checked === true);
    const deletedSubtask = subtaskRows.nth(1);
    await deletedSubtask.locator('.todo-subtask-remove').click();
    await page.locator('#confirm-modal').waitFor({ state: 'visible', timeout: 5000 });
    await page.click('#confirm-confirm-btn');
    await page.locator('#confirm-modal').waitFor({ state: 'hidden', timeout: 5000 });

    const commentEditor = page.locator('#todo-comment-new-editor');
    await commentEditor.fill('Keep offline comment');
    await page.click('#todo-comment-add-btn');
    await page.waitForFunction(() => document.querySelectorAll('#todo-comments-list .todo-comment-item').length === 1);
    await commentEditor.fill('Delete offline comment');
    await page.waitForFunction(() => document.getElementById('todo-comment-add-btn')?.disabled === false);
    await page.click('#todo-comment-add-btn');
    await page.waitForFunction(async () => {
      const comments = document.querySelectorAll('#todo-comments-list .todo-comment-item').length;
      const queue = await window.dbGetAll('syncQueue');
      return comments === 2 && queue.filter(item => item.action === 'CREATE_COMMENT').length === 2;
    });
    const commentRows = page.locator('#todo-comments-list .todo-comment-item');
    const keptComment = commentRows.nth(0);
    await keptComment.locator('.todo-comment-actions button').first().dispatchEvent('click');
    const commentEditInput = page.locator('#todo-comments-list .todo-comment-edit-input');
    await commentEditInput.waitFor({ state: 'visible', timeout: 5000 });
    await commentEditInput.fill('Edited offline comment');
    await page.locator('#todo-comments-list .todo-comment-item[data-editing="1"] .todo-comment-actions button').first().dispatchEvent('click');
    const deletedComment = commentRows.nth(1);
    await deletedComment.locator('.todo-comment-actions button').last().click();
    await page.locator('#confirm-modal').waitFor({ state: 'visible', timeout: 5000 });
    await page.click('#confirm-confirm-btn');
    await page.locator('#confirm-modal').waitFor({ state: 'hidden', timeout: 5000 });

    const offlineState = await page.evaluate(async () => {
      const todos = await window.dbGetAll('todos');
      const queue = await window.dbGetAll('syncQueue');
      const todo = todos.find(item => item.title === localStorage.getItem('__offline_children_title'));
      return { todo, queue };
    });
    if (offlineState.todo?.subtasks?.length !== 1 || offlineState.todo.subtasks[0].title !== 'Edited offline subtask' || !offlineState.todo.subtasks[0].is_done) {
      throw new Error(`Offline subtask mutations were not cached: ${JSON.stringify(offlineState)}`);
    }
    if (offlineState.todo?.comments?.length !== 1 || offlineState.todo.comments[0].body !== 'Edited offline comment') {
      throw new Error(`Offline comment mutations were not cached: ${JSON.stringify(offlineState)}`);
    }
    const actions = offlineState.queue.map(item => item.action);
    for (const expected of ['CREATE_SUBTASK', 'UPDATE_SUBTASK', 'DELETE_SUBTASK', 'CREATE_COMMENT', 'UPDATE_COMMENT', 'DELETE_COMMENT']) {
      if (!actions.includes(expected)) throw new Error(`Missing ${expected} in offline queue: ${JSON.stringify(offlineState.queue)}`);
    }

    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(async () => (await window.dbGetAll('syncQueue')).length === 0, null, { timeout: 20000 });
    await page.waitForFunction(async () => {
      const token = localStorage.getItem('jwt_token');
      const response = await fetch('/api/todos', { headers: { Authorization: `Bearer ${token}` }, credentials: 'include', cache: 'no-store' });
      const data = await response.json();
      const todo = data.todos?.find(item => item.title === localStorage.getItem('__offline_children_title'));
      return response.ok
        && todo?.subtasks?.length === 1
        && todo.subtasks[0].title === 'Edited offline subtask'
        && todo.subtasks[0].is_done === true
        && todo?.comments?.length === 1
        && todo.comments[0].body === 'Edited offline comment';
    }, null, { timeout: 20000 });

    await page.context().setOffline(true);
    await page.locator('#todo-modal').waitFor({ state: 'visible', timeout: 5000 });
    const visibleOffline = await page.evaluate(() => ({
      subtasks: Array.from(document.querySelectorAll('#todo-subtasks-list .todo-subtask-title-input')).map(input => ({ title: input.value, done: input.closest('.todo-subtask-row')?.querySelector('.todo-subtask-check')?.checked })),
      comments: Array.from(document.querySelectorAll('#todo-comments-list .todo-comment-body')).map(body => body.dataset.rawBody),
    }));
    if (JSON.stringify(visibleOffline.subtasks) !== JSON.stringify([{ title: 'Edited offline subtask', done: true }])) {
      throw new Error(`Synced subtasks are not available offline: ${JSON.stringify(visibleOffline)}`);
    }
    if (JSON.stringify(visibleOffline.comments) !== JSON.stringify(['Edited offline comment'])) {
      throw new Error(`Synced comments are not available offline: ${JSON.stringify(visibleOffline)}`);
    }

    const frontendErrors = dumpErrors();
    const unexpectedConsoleErrors = frontendErrors.consoleErrors.filter(message => (
      !message.includes('Failed to load resource: the server responded with a status of 404')
      && !message.includes('net::ERR_INTERNET_DISCONNECTED')
    ));
    if (frontendErrors.pageErrors.length || unexpectedConsoleErrors.length) {
      throw new Error(`Frontend emitted errors:\npageErrors=${JSON.stringify(frontendErrors.pageErrors)}\nconsoleErrors=${JSON.stringify(unexpectedConsoleErrors)}`);
    }
    console.log('✅ Offline todo child mutations test passed');
  } finally {
    await page.context().setOffline(false).catch(() => {});
    await browser.close();
  }
});
