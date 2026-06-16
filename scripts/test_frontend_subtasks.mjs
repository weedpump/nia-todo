#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

await withFreshDb(async () => {
  const { browser, page, loginApp, openTodoModal, assertNoFrontendErrors } = await launchPage();
  try {
    await loginApp();

    await openTodoModal();
    await page.fill('#todo-title', 'Frontend subtasks persistence');
    await page.click('#todo-subtasks-panel > summary');
    await page.fill('#todo-subtask-new-title', 'First checklist item');
    await page.press('#todo-subtask-new-title', 'Enter');
    const focusedAfterFirstAdd = await page.evaluate(() => document.activeElement?.id);
    if (focusedAfterFirstAdd !== 'todo-subtask-new-title') {
      throw new Error(`Expected focus to return to new subtask input, got ${focusedAfterFirstAdd}`);
    }
    await page.fill('#todo-subtask-new-title', 'Second checklist item');
    await page.press('#todo-subtask-new-title', 'Enter');
    await page.click('#todo-modal button[type="submit"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 10000 });

    await page.waitForFunction(async () => {
      const token = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' }).then(r => r.json());
      const todo = data.todos?.find?.(item => item.title === 'Frontend subtasks persistence');
      return todo && Array.isArray(todo.subtasks) && todo.subtasks.length === 2;
    }, null, { timeout: 10000 });

    const beforeReload = await page.evaluate(async () => {
      const token = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' }).then(r => r.json());
      return data.todos.find(item => item.title === 'Frontend subtasks persistence');
    });
    if (!beforeReload?.id || String(beforeReload.id).startsWith('temp-')) {
      throw new Error(`Todo was not synced to a server id before reload: ${JSON.stringify(beforeReload)}`);
    }
    if (beforeReload.subtasks.map(item => item.title).join('|') !== 'First checklist item|Second checklist item') {
      throw new Error(`Unexpected subtasks before reload: ${JSON.stringify(beforeReload.subtasks)}`);
    }

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 15000 });
    await page.locator('#user-menu-button').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(async () => {
      const token = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' }).then(r => r.json());
      const todo = data.todos?.find?.(item => item.title === 'Frontend subtasks persistence');
      return todo && Array.isArray(todo.subtasks) && todo.subtasks.length === 2;
    }, null, { timeout: 15000 });

    const afterReload = await page.evaluate(async () => {
      const token = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' }).then(r => r.json());
      return data.todos.find(item => item.title === 'Frontend subtasks persistence');
    });
    if (afterReload.subtasks.map(item => item.title).join('|') !== 'First checklist item|Second checklist item') {
      throw new Error(`Subtasks were not persisted after reload: ${JSON.stringify(afterReload.subtasks)}`);
    }
    await page.waitForTimeout(250);
    const cachedAfterWs = await page.evaluate(async () => {
      const todos = await window.dbGetAll('todos');
      return todos.find(item => item.title === 'Frontend subtasks persistence');
    });
    if (!Array.isArray(cachedAfterWs?.subtasks) || cachedAfterWs.subtasks.length !== 2) {
      throw new Error(`IndexedDB lost subtasks after REST refresh/reload: ${JSON.stringify(cachedAfterWs)}`);
    }

    const cardText = await page.locator('.todo-item').filter({ hasText: 'Frontend subtasks persistence' }).first().innerText();
    if (!cardText.includes('0/2')) {
      throw new Error(`Subtask progress pill missing after reload: ${cardText}`);
    }

    await page.locator('.todo-item').filter({ hasText: 'Frontend subtasks persistence' }).first().click();
    await page.locator('#todo-modal').waitFor({ state: 'visible', timeout: 5000 });
    const subtaskPanelOpen = await page.locator('#todo-subtasks-panel').evaluate(panel => panel.open);
    if (!subtaskPanelOpen) {
      throw new Error('Expected subtasks panel to open automatically when subtasks exist');
    }

    assertNoFrontendErrors();
    console.log('✅ Frontend subtasks persistence test passed');
  } finally {
    await browser.close();
  }
});
