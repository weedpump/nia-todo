#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

await withFreshDb(async () => {
  const { browser, page, loginApp, openTodoModal, waitForText, assertNoFrontendErrors } = await launchPage();
  try {
    await loginApp();

    await openTodoModal();
    const initialState = await page.evaluate(() => ({
      detailView: document.getElementById('todo-modal')?.classList.contains('todo-detail-view'),
      metaEditing: document.getElementById('todo-modal')?.classList.contains('todo-meta-editing'),
      subtasks: document.querySelector('#todo-subtasks-panel')?.open,
      comments: document.querySelector('#todo-comments-panel')?.open,
    }));
    if (!initialState.detailView || !initialState.metaEditing || !initialState.subtasks || !initialState.comments) {
      throw new Error(`Expected create todo modal with visible content sections and open desktop meta drawer: ${JSON.stringify(initialState)}`);
    }
    await page.fill('#todo-title', 'Frontend subtasks persistence');
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

    await page.locator('.todo-item').filter({ hasText: 'Frontend subtasks persistence' }).first().click();
    await page.locator('#todo-modal').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#todo-subtasks-panel').evaluate(panel => { panel.open = true; });
    const saveDisabledBeforeImmediateSubtask = await page.locator('#todo-save-btn').evaluate(button => button.disabled);
    if (!saveDisabledBeforeImmediateSubtask) {
      throw new Error('Expected save button to be disabled before subtask-only changes');
    }
    await page.fill('#todo-subtask-new-title', 'Immediate checklist item');
    await page.press('#todo-subtask-new-title', 'Enter');
    await page.waitForFunction(async () => {
      const todos = await window.dbGetAll('todos');
      const todo = todos.find(item => item.title === 'Frontend subtasks persistence');
      return Array.isArray(todo?.subtasks) && todo.subtasks.length === 3;
    }, null, { timeout: 10000 });
    const saveDisabledAfterImmediateSubtask = await page.locator('#todo-save-btn').evaluate(button => button.disabled);
    if (!saveDisabledAfterImmediateSubtask) {
      throw new Error('Expected save button to stay disabled after immediate subtask create');
    }
    await page.locator('.todo-subtask-remove').first().click();
    await page.locator('#confirm-modal').waitFor({ state: 'visible', timeout: 5000 });
    await page.click('#confirm-cancel-btn');
    await page.locator('#confirm-modal').waitFor({ state: 'hidden', timeout: 5000 });
    let editorSubtaskCount = await page.locator('#todo-subtasks-list .todo-subtask-row').count();
    if (editorSubtaskCount !== 3) {
      throw new Error(`Canceling subtask delete should keep all rows, got ${editorSubtaskCount}`);
    }
    await page.locator('.todo-subtask-remove').first().click();
    await page.locator('#confirm-modal').waitFor({ state: 'visible', timeout: 5000 });
    await page.click('#confirm-confirm-btn');
    await page.locator('#confirm-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction(async () => {
      const rows = document.querySelectorAll('#todo-subtasks-list .todo-subtask-row').length;
      const todos = await window.dbGetAll('todos');
      const todo = todos.find(item => item.title === 'Frontend subtasks persistence');
      return rows === 2 && Array.isArray(todo?.subtasks) && todo.subtasks.length === 2;
    }, null, { timeout: 10000 });
    editorSubtaskCount = await page.locator('#todo-subtasks-list .todo-subtask-row').count();
    if (editorSubtaskCount !== 2) {
      const debugSubtasks = await page.evaluate(async () => {
        const rows = Array.from(document.querySelectorAll('#todo-subtasks-list .todo-subtask-row')).map(row => ({ id: row.dataset.subtaskId, title: row.querySelector('.todo-subtask-title-input')?.value }));
        const todos = await window.dbGetAll('todos');
        const todo = todos.find(item => item.title === 'Frontend subtasks persistence');
        return { rows, cached: todo?.subtasks };
      });
      throw new Error(`Confirming subtask delete should remove one row, got ${editorSubtaskCount}: ${JSON.stringify(debugSubtasks)}`);
    }
    await page.evaluate(() => window.closeModal?.('todo-modal'));
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });

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
    await page.evaluate(() => window.closeModal?.('todo-modal'));
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });

    await openTodoModal();
    await page.fill('#todo-title', 'Frontend metadata panels');
    const metadataDrawerOpen = await page.evaluate(() => document.getElementById('todo-modal')?.classList.contains('todo-meta-editing'));
    if (!metadataDrawerOpen) await page.click('#todo-meta-edit-toggle');
    await page.locator('.todo-meta-edit-drawer').waitFor({ state: 'visible', timeout: 5000 });
    await page.selectOption('#todo-priority', '1', { force: true });
    await page.fill('#todo-due', '2099-01-02T03:04', { force: true });
    await page.click('#todo-modal button[type="submit"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 10000 });
    await waitForText('Frontend metadata panels');
    await page.locator('.todo-item').filter({ hasText: 'Frontend metadata panels' }).first().click();
    await page.locator('#todo-modal').waitFor({ state: 'visible', timeout: 5000 });
    const metadataState = await page.evaluate(() => ({
      metaEditing: document.getElementById('todo-modal')?.classList.contains('todo-meta-editing'),
      summary: document.getElementById('todo-meta-summary')?.innerText || '',
    }));
    if (metadataState.metaEditing || !metadataState.summary.includes('2099') || !metadataState.summary.trim()) {
      throw new Error(`Expected saved metadata to reopen as summary pills with closed drawer: ${JSON.stringify(metadataState)}`);
    }
    await page.click('#todo-meta-edit-toggle');
    await page.locator('.todo-meta-edit-drawer').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(() => document.getElementById('todo-priority')?.value === '1' && document.getElementById('todo-due')?.value.startsWith('2099-01-02T03:04'), null, { timeout: 5000 });

    assertNoFrontendErrors();
    console.log('✅ Frontend subtasks persistence test passed');
  } finally {
    await browser.close();
  }
});
