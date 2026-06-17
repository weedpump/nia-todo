#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function installRealtimeProbe(page) {
  await page.addInitScript(() => {
    window.__niaRealtimeProbe = { authOk: 0, syncResponses: 0, outboundSyncRequests: 0, dataMessages: [] };
    const NativeWebSocket = window.WebSocket;
    class TrackedWebSocket extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'auth_ok') window.__niaRealtimeProbe.authOk += 1;
            if (msg.type === 'sync_response') window.__niaRealtimeProbe.syncResponses += 1;
            if (msg.type && !['auth_ok', 'pong', 'sync_response'].includes(msg.type)) {
              window.__niaRealtimeProbe.dataMessages.push(msg.type);
            }
          } catch {}
        });
      }
      send(data) {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'sync_request') window.__niaRealtimeProbe.outboundSyncRequests += 1;
        } catch {}
        return super.send(data);
      }
    }
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
      Object.defineProperty(TrackedWebSocket, key, { value: NativeWebSocket[key] });
      Object.defineProperty(TrackedWebSocket.prototype, key, { value: NativeWebSocket[key] });
    }
    window.WebSocket = TrackedWebSocket;
  });
}

async function waitForRealtimeReady(page, label) {
  await page.waitForFunction(() => {
    const probe = window.__niaRealtimeProbe;
    return probe?.authOk >= 1;
  }, null, { timeout: 15000 }).catch(async error => {
    const probe = await page.evaluate(() => window.__niaRealtimeProbe || null).catch(() => null);
    throw new Error(`${label} WebSocket auth not ready after login: ${JSON.stringify(probe)} (${error.message})`);
  });
}

async function waitForTodoInDb(page, title, timeout = 15000) {
  await page.waitForFunction(async value => {
    if (typeof window.dbGetAll !== 'function') return false;
    const todos = await window.dbGetAll('todos');
    return todos.some(todo => todo.title === value);
  }, title, { timeout });
}

async function run() {
  console.log('📡 Running frontend realtime WebSocket sync test...');
  const clientA = await launchPage();
  const clientB = await launchPage();
  await installRealtimeProbe(clientA.page);
  await installRealtimeProbe(clientB.page);
  await clientA.page.addInitScript(() => localStorage.setItem('nia-hide-done', 'false'));
  await clientB.page.addInitScript(() => localStorage.setItem('nia-hide-done', 'false'));
  const { browser: browserA, page: pageA, loginApp: loginA, visible: visibleA, waitForText: waitForTextA, openTodoModal } = clientA;
  const { browser: browserB, page: pageB, loginApp: loginB, visible: visibleB, waitForText: waitForTextB, dumpErrors } = clientB;

  try {
    await loginA();
    await visibleA('#sidebar');
    await pageA.locator('#online-status').waitFor({ state: 'hidden', timeout: 10000 });
    await waitForRealtimeReady(pageA, 'Client A');

    await loginB();
    await visibleB('#sidebar');
    await pageB.locator('#online-status').waitFor({ state: 'hidden', timeout: 10000 });
    await waitForRealtimeReady(pageB, 'Client B');

    const startupProbeA = await pageA.evaluate(() => window.__niaRealtimeProbe);
    const startupProbeB = await pageB.evaluate(() => window.__niaRealtimeProbe);
    if (startupProbeA.outboundSyncRequests || startupProbeB.outboundSyncRequests) {
      throw new Error(`Normal WebSocket startup must not request full sync: A=${JSON.stringify(startupProbeA)} B=${JSON.stringify(startupProbeB)}`);
    }

    await openTodoModal();
    await pageA.fill('#todo-title', 'Realtime Sync Todo');
    await pageA.fill('#todo-desc', 'Created for realtime sync regression');
    await pageA.click('button[form="todo-form"]');
    await pageA.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await waitForTextA('Realtime Sync Todo', 20000);
    await waitForTodoInDb(pageB, 'Realtime Sync Todo');
    await waitForTextB('Realtime Sync Todo', 20000);

    await pageA.locator('.todo-item').filter({ hasText: 'Realtime Sync Todo' }).first().click();
    await pageA.locator('#todo-modal').waitFor({ state: 'visible', timeout: 5000 });
    await pageA.selectOption('#todo-status', 'done', { force: true });
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

    const deleteFixture = await pageA.evaluate(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const csrf = localStorage.getItem('csrf_token');
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`, 'X-CSRF-Token': csrf };
      const createProject = async (body) => fetch('/api/projects', { method: 'POST', headers, credentials: 'include', body: JSON.stringify(body) }).then(r => r.json());
      const parent = await createProject({ name: 'Realtime Delete Parent', color: '#6366f1' });
      const child = await createProject({ name: 'Realtime Delete Child', color: '#6366f1', parent_id: parent.id, workspace_id: parent.workspace_id });
      const todo = await fetch('/api/todos', {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify({ title: 'Realtime Delete Child Todo', project_id: child.id })
      }).then(r => r.json());
      await fetch(`/api/projects/${parent.id}`, { method: 'DELETE', headers, credentials: 'include' });
      return { parentId: parent.id, childId: child.id, todoId: todo.id, workspaceId: parent.workspace_id };
    });

    await pageB.waitForFunction(async ({ parentId, childId, todoId, workspaceId }) => {
      const projects = await window.dbGetAll('projects');
      const todos = await window.dbGetAll('todos');
      const inbox = projects.find(project => project.is_inbox && String(project.workspace_id || '') === String(workspaceId || ''));
      const todo = todos.find(item => item.id === todoId);
      return !projects.some(project => project.id === parentId || project.id === childId)
        && inbox
        && todo?.project_id === inbox.id
        && todo?.section_id == null;
    }, deleteFixture, { timeout: 10000 });

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
