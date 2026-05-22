#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function run() {
  console.log('📡 Running frontend realtime WebSocket sync test...');
  const clientA = await launchPage();
  const clientB = await launchPage();
  await clientA.page.addInitScript(() => localStorage.setItem('nia-hide-done', 'false'));
  await clientB.page.addInitScript(() => localStorage.setItem('nia-hide-done', 'false'));
  const { browser: browserA, page: pageA, loginApp: loginA, visible: visibleA, waitForText: waitForTextA, openTodoModal } = clientA;
  const { browser: browserB, page: pageB, loginApp: loginB, visible: visibleB, waitForText: waitForTextB, dumpErrors } = clientB;

  try {
    await loginA();
    await visibleA('#sidebar');
    await pageA.locator('#online-status').waitFor({ state: 'hidden', timeout: 10000 });

    await loginB();
    await visibleB('#sidebar');
    await pageB.locator('#online-status').waitFor({ state: 'hidden', timeout: 10000 });

    await openTodoModal();
    await pageA.fill('#todo-title', 'Realtime Sync Todo');
    await pageA.fill('#todo-desc', 'Created for realtime sync regression');
    await pageA.click('button[form="todo-form"]');
    await pageA.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await waitForTextA('Realtime Sync Todo');
    await waitForTextB('Realtime Sync Todo', 10000);

    await pageA.locator('.todo-item').filter({ hasText: 'Realtime Sync Todo' }).first().click();
    await pageA.locator('#todo-modal').waitFor({ state: 'visible', timeout: 5000 });
    await pageA.selectOption('#todo-status', 'done');
    await pageA.click('button[form="todo-form"]');
    await pageA.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });

    await pageB.waitForFunction(async () => {
      const todos = await window.dbGetAll('todos');
      const todo = todos.find(item => item.title === 'Realtime Sync Todo');
      return todo?.status === 'done';
    }, null, { timeout: 10000 });

    await pageB.waitForFunction(() => {
      const item = Array.from(document.querySelectorAll('.todo-item')).find(el => el.textContent.includes('Realtime Sync Todo'));
      return item?.textContent.includes('Erledigt') || item?.classList.contains('done') || item?.querySelector('.status-done');
    }, null, { timeout: 10000 });

    const errorsA = clientA.dumpErrors();
    const errorsB = dumpErrors();
    const filter = msg => !msg.includes('404') && !msg.includes('[WS] 💥 Error: Event');
    const unexpectedA = errorsA.consoleErrors.filter(filter);
    const unexpectedB = errorsB.consoleErrors.filter(filter);
    if (errorsA.pageErrors.length || errorsB.pageErrors.length || unexpectedA.length || unexpectedB.length) {
      throw new Error(`Unexpected frontend errors:\nA=${JSON.stringify(errorsA)}\nB=${JSON.stringify(errorsB)}`);
    }

    console.log('✅ Frontend realtime WebSocket sync test passed');
  } catch (error) {
    console.log('DEBUG A errors:', JSON.stringify(clientA.dumpErrors()));
    console.log('DEBUG B errors:', JSON.stringify(clientB.dumpErrors()));
    throw error;
  } finally {
    await browserA.close();
    await browserB.close();
  }
}

await withFreshDb(run);
