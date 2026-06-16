#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function run() {
  console.log('🔁 Running frontend offline→online sync test...');
  const { browser, page, loginApp, visible, waitForText, openTodoModal, assertNoFrontendErrors, dumpErrors } = await launchPage();

  try {
    await loginApp();
    await visible('#sidebar');

    await openTodoModal();
    await page.fill('#todo-title', 'Offline Sync Todo');
    await page.fill('#todo-desc', 'Created for offline sync regression');
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await waitForText('Offline Sync Todo');

    await page.waitForFunction(async () => {
      if (typeof window.dbGetAll !== 'function') return false;
      const todos = await window.dbGetAll('todos');
      return todos.some(todo => todo.title === 'Offline Sync Todo' && typeof todo.id === 'number');
    }, null, { timeout: 10000 });

    await page.context().setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false, null, { timeout: 5000 });

    await page.locator('.todo-item').filter({ hasText: 'Offline Sync Todo' }).first().click();
    await page.locator('#todo-modal').waitFor({ state: 'visible', timeout: 5000 });
    await page.fill('#todo-subtask-new-title', 'Offline subtask A');
    await page.press('#todo-subtask-new-title', 'Enter');
    await page.fill('#todo-subtask-new-title', 'Offline subtask B');
    await page.press('#todo-subtask-new-title', 'Enter');
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });

    const queuedOffline = await page.evaluate(async () => {
      const todos = await window.dbGetAll('todos');
      const queue = await window.dbGetAll('syncQueue');
      const todo = todos.find(item => item.title === 'Offline Sync Todo');
      return { subtasks: todo?.subtasks || [], queueLength: queue.length, queue };
    });
    if (queuedOffline.subtasks.length !== 2 || queuedOffline.queueLength < 1 || !queuedOffline.queue.some(item => item.action === 'UPDATE_TODO' && item.data?.changes?.subtasks?.length === 2)) {
      throw new Error(`Offline subtask update was not queued correctly: ${JSON.stringify(queuedOffline)}`);
    }

    await page.context().setOffline(false);
    await page.waitForFunction(() => navigator.onLine === true, null, { timeout: 5000 });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    await page.waitForFunction(async () => {
      if (typeof window.dbGetAll !== 'function') return false;
      const queue = await window.dbGetAll('syncQueue');
      const todos = await window.dbGetAll('todos');
      const todo = todos.find(item => item.title === 'Offline Sync Todo');
      return queue.length === 0 && Array.isArray(todo?.subtasks) && todo.subtasks.length === 2;
    }, null, { timeout: 15000 });

    await page.waitForFunction(async () => {
      const token = localStorage.getItem('jwt_token') || localStorage.getItem('auth_token');
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const response = await fetch('/api/todos', { cache: 'no-store', headers });
      const data = await response.json();
      const todos = data.todos || [];
      const todo = todos.find(item => item.title === 'Offline Sync Todo');
      return response.ok && Array.isArray(todo?.subtasks) && todo.subtasks.length === 2;
    }, null, { timeout: 15000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForFunction(async () => {
      if (typeof window.dbGetAll !== 'function') return false;
      const todos = await window.dbGetAll('todos');
      const todo = todos.find(item => item.title === 'Offline Sync Todo');
      return Array.isArray(todo?.subtasks) && todo.subtasks.length === 2;
    }, null, { timeout: 15000 });

    const errors = dumpErrors();
    const unexpectedConsoleErrors = errors.consoleErrors.filter(msg => {
      if (msg.includes('net::ERR_INTERNET_DISCONNECTED')) return false;
      if (msg.includes('[WS] 💥 Error: Event')) return false;
      if (msg.includes("WebSocket connection to 'ws://localhost:8754/ws' failed")) return false;
      if (msg.includes('Failed to load resource: the server responded with a status of 404')) return false;
      return true;
    });
    if (errors.pageErrors.length || unexpectedConsoleErrors.length) {
      throw new Error(`Unexpected frontend errors:\npageErrors=${JSON.stringify(errors.pageErrors)}\nconsoleErrors=${JSON.stringify(unexpectedConsoleErrors)}`);
    }
    console.log('✅ Frontend offline→online sync test passed');
  } catch (error) {
    console.log('DEBUG frontend errors:', JSON.stringify(dumpErrors()));
    throw error;
  } finally {
    await page.context().setOffline(false).catch(() => {});
    await browser.close();
  }
}

await withFreshDb(run);
