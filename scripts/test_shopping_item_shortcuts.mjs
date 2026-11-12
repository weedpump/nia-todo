#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const fixtureSource = `
  import { initI18n, t } from '/static/js/i18n/index.js';
  import { createShoppingItemsController, renderShoppingItem } from '/static/js/features/shopping-items.js';
  import { createTodosFeature } from '/static/js/features/todos.js';
  import { renderTodoItem } from '/static/js/features/todo-rendering.js';
  localStorage.setItem('nia-todo-language', 'de');
  await initI18n();

  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('shopping-shortcuts-private', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('syncQueue', { autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = operation => new Promise((resolve, reject) => {
    const tx = db.transaction('syncQueue', 'readwrite');
    operation(tx.objectStore('syncQueue'));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('private queue transaction aborted'));
  });
  const root = document.getElementById('shopping-root');
  const taskRoot = document.getElementById('task-root');
  let controller, lists = [], activeListId = 1, actorId = 1, activeModule = 'shopping';
  let session = 'initial', generation = 0, queued = 0, edits = 0, externalClicks = 0;
  let confirmations = [], pendingConfirmation = null, confirmMode = 'cancel', lastConfirm = null;
  let errors = [], taskQueue = [], taskConfirmations = 0, taskEdits = 0;
  let todos = [{ id: 901, title: 'Task shortcut', status: 'pending', priority: 3 }];
  const renderTasks = () => { taskRoot.innerHTML = todos.map(renderTodoItem).join(''); };
  createTodosFeature({
    getTodos: () => todos, setTodos: value => { todos = value; }, getProjects: () => [], getSections: () => [],
    getCurrentProjectId: () => null, getCurrentWorkspaceId: () => null,
    getCurrentUser: () => ({ id: actorId }), setCurrentUser: () => {}, getActiveModule: () => activeModule,
    getAppInitialized: () => true, getDb: () => ({}), dbPut: async () => {}, dbGetAll: async () => [],
    deleteFromDB: async () => {}, addToSyncQueue: async (action, data) => { taskQueue.push({ action, data }); },
    isOnlineForSync: () => false, syncWithServer: async () => {}, todosApi: {}, sectionsApi: {}, placesApi: null,
    renderProjects: () => {}, renderStats: () => {}, renderTodos: renderTasks,
    closeModal: () => {}, confirmDanger: async () => { taskConfirmations += 1; return false; }, showToast: () => {},
    setupDescPreview: () => {}, renderMarkdown: value => String(value || ''),
  });
  // Observe the native title activation while keeping this fixture independent of
  // the separate Tasks modal implementation.
  taskRoot.addEventListener('click', event => {
    if (!event.target.closest('[data-item-card-open]')) return;
    taskEdits += 1;
    event.preventDefault();
  }, true);
  document.getElementById('external-button').addEventListener('click', () => { externalClicks += 1; });
  const activeList = () => lists.find(list => String(list.id) === String(activeListId));
  function render() {
    const list = activeList();
    root.innerHTML = (list?.items || []).map(item => renderShoppingItem({
      item, canEdit: list.can_edit, labels: {
        edit: t('shopping.item.edit', { name: item.name }),
        markCompleted: t('shopping.item.markCompleted', { name: item.name }),
        markOpen: t('shopping.item.markOpen', { name: item.name }),
      },
    })).join('');
    controller?.bindRoot(root);
  }
  async function reset({ temporary = false, defaultConfirmation = false } = {}) {
    pendingConfirmation?.(false);
    pendingConfirmation = null;
    controller?.destroy();
    actorId = 1; activeModule = 'shopping'; session = 'session-' + (++generation);
    queued = edits = externalClicks = taskConfirmations = taskEdits = 0;
    confirmations = []; taskQueue = []; confirmMode = 'cancel'; lastConfirm = null;
    lists = [
      { id: temporary ? 'temp-list' : 1, client_mutation_id: 'origin-list', created_by_user_id: 1,
        can_edit: true, name: 'First', items: [{ id: temporary ? 'temp-item' : 11,
          client_mutation_id: 'origin-item', created_by_user_id: 1, name: 'Milch', completed: false }] },
      { id: 2, can_edit: true, name: 'Second', items: [{ id: 21, name: 'Brot', completed: false }] },
      { id: 3, can_edit: false, name: 'Read only', items: [{ id: 31, name: 'Salz', completed: false }] },
    ];
    activeListId = lists[0].id;
    todos = [{ id: 901, title: 'Task shortcut', status: 'pending', priority: 3 }];
    await transaction(store => store.clear());
    document.querySelectorAll('.test-guard-dialog').forEach(element => element.remove());
    document.body.classList.remove('native-pointer-dragging');
    controller = createShoppingItemsController({
      getLists: () => lists, setLists: value => { lists = value; }, getActiveListId: () => activeListId,
      getActorId: () => actorId, getSessionIdentity: () => session, getActiveModule: () => activeModule,
      commitMutation: async build => {
        const mutation = build();
        if (mutation) {
          await transaction(store => store.add({ action: mutation.action, data: structuredClone(mutation.data) }));
          queued += 1;
        }
        return mutation;
      },
      render, onEdit: () => { edits += 1; }, onError: error => { errors.push(String(error?.stack || error)); },
      confirmDanger: defaultConfirmation ? undefined : async options => {
        lastConfirm = options;
        confirmations.push({ title: options.title, message: options.message, confirmText: options.confirmText });
        const dialog = document.createElement('div');
        dialog.className = 'modal active test-guard-dialog';
        const cancel = document.createElement('button');
        cancel.textContent = 'Cancel'; dialog.appendChild(cancel); document.body.appendChild(dialog); cancel.focus();
        const confirmed = confirmMode === 'hold'
          ? await new Promise(resolve => { pendingConfirmation = resolve; })
          : confirmMode === 'accept';
        dialog.remove();
        if (!confirmed) options.returnFocus?.()?.focus?.();
        return confirmed;
      },
    });
    render(); renderTasks();
    document.activeElement?.blur();
  }
  await reset();
  window.test = {
    reset,
    state: () => ({ lists: structuredClone(lists), activeListId, queued, edits, externalClicks,
      confirmations: structuredClone(confirmations), errors: [...errors], taskQueue: structuredClone(taskQueue),
      taskStatus: todos[0]?.status, taskConfirmations, taskEdits }),
    queue: () => new Promise((resolve, reject) => {
      const request = db.transaction('syncQueue').objectStore('syncQueue').getAll();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }),
    confirm: mode => { confirmMode = mode; },
    resolveConfirmation: value => { const resolve = pendingConfirmation; pendingConfirmation = null; resolve?.(value); },
    confirmationFocusTag: () => lastConfirm?.returnFocus?.()?.tagName,
    requestRemoveAgain: () => { controller.requestRemove(activeListId, activeList()?.items[0]?.id); },
    change: (type, value) => {
      if (type === 'module') activeModule = value;
      else if (type === 'actor') actorId = value;
      else if (type === 'session') session = value;
      else if (type === 'list') { activeListId = value; render(); }
      else if (type === 'permission') { activeList().can_edit = value; render(); }
      else if (type === 'remove-item') { activeList().items = []; render(); }
      else if (type === 'remove-list') { lists = lists.filter(list => list.id !== activeListId); render(); }
      else if (type === 'foreign-remap') { lists[0].id = 100; lists[0].created_by_user_id = 2; lists[0].items[0].id = 110; lists[0].items[0].created_by_user_id = 2; activeListId = 100; render(); }
      else if (type === 'remap') { lists[0].id = 100; lists[0].items[0].id = 110; activeListId = 100; render(); }
      else if (type === 'destroy') controller.destroy();
      else if (type === 'rebind') { controller.bindRoot(null); controller.bindRoot(root); }
      else throw new Error('unknown private test transition');
    },
  };
`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.setDefaultTimeout(5000);
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error?.stack || error)));

try {
  await page.route('http://shopping-shortcuts.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html>
      <html><head><link rel="stylesheet" href="/static/style.css"></head><body>
      <main style="padding:40px"><section id="task-root"></section><section id="shopping-root"></section>
      <div style="display:flex;gap:8px;margin-top:40px">
        <input id="typing-input"><textarea id="typing-textarea"></textarea>
        <div id="typing-rich" contenteditable="true" style="min-width:60px">Text</div><div id="typing-rich-empty" contenteditable="">Text</div>
        <button id="external-button">External</button><select id="external-select"><option>Choice</option></select>
        <div id="external-role" role="button" tabindex="0">Action</div>
      </div></main><script type="module" src="/fixture.js"></script></body></html>` });
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: fixtureSource });
    if (path.startsWith('/static/')) {
      try {
        return await route.fulfill({ contentType: path.endsWith('.css') ? 'text/css' : path.endsWith('.json') ? 'application/json' : 'text/javascript',
          body: readFileSync(new URL(`../web${path}`, import.meta.url), 'utf8') });
      } catch { return route.fulfill({ status: 404, body: 'Missing private fixture asset' }); }
    }
    return route.fulfill({ status: 404, body: 'Unexpected private fixture request' });
  });
  await page.goto('http://shopping-shortcuts.test/');
  await page.waitForFunction(() => Boolean(window.test));
  const state = () => page.evaluate(() => window.test.state());
  const queue = () => page.evaluate(() => window.test.queue());
  const reset = async options => {
    await page.evaluate(options => window.test.reset(options), options);
    await page.mouse.move(1198, 898);
  };
  const hover = async (selector = '#shopping-root .shopping-item-card') => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.move(1198, 898);
    await page.locator(selector).first().hover();
  };
  const noShortcutMutation = async label => {
    await page.keyboard.press('Space');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(35);
    assert.deepEqual(await queue(), [], `${label}: no Shopping mutation may be queued`);
    assert.equal((await state()).confirmations.length, 0, `${label}: Delete must not open confirmation`);
  };

  await hover();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.test.state().queued === 1);
  assert.deepEqual((await queue())[0], { action: 'UPDATE_SHOPPING_ITEM', data: { shopping_list_id: 1, item_id: 11, changes: { completed: true } } }, 'hover Space persists completion through the real controller queue boundary');
  assert.equal((await state()).lists[0].items[0].completed, true);
  await hover();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.test.state().queued === 2);
  assert.equal((await queue())[1].data.changes.completed, false, 'Space reopens the item through the same durable path');

  await reset();
  await hover();
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => window.test.state().confirmations.length === 1);
  const confirmation = (await state()).confirmations[0];
  assert.ok(confirmation.title && confirmation.confirmText);
  assert.ok(confirmation.message.includes('Milch'), 'the translated confirmation identifies the target');
  assert.equal(Object.values(confirmation).some(text => String(text).includes('shopping.item.')), false, 'confirmation labels must be translated');
  assert.deepEqual(await queue(), [], 'cancelled deletion does not enqueue anything');
  assert.equal((await state()).lists[0].items.length, 1);
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BODY', 'cancelling keyboard deletion restores the previous focus instead of moving focus into the title action');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.test.state().queued === 1);
  assert.equal((await state()).lists[0].items[0].completed, true, 'Space after cancelled Delete still completes the hovered item');
  assert.equal((await state()).edits, 0, 'cancelled hover deletion must not turn the next Space into native title editing');
  await reset();
  await page.evaluate(() => window.test.confirm('accept'));
  await hover();
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => window.test.state().queued === 1);
  assert.deepEqual((await queue())[0], { action: 'DELETE_SHOPPING_ITEM', data: { shopping_list_id: 1, item_id: 11 } });
  assert.equal((await state()).lists[0].items.length, 0);

  await reset({ defaultConfirmation: true }); await hover();
  await page.keyboard.press('Delete'); await page.waitForTimeout(35);
  assert.deepEqual(await queue(), [], 'without an injected confirmation service, Delete must safely default to cancellation');
  assert.equal((await state()).lists[0].items.length, 1);

  for (const selector of ['#typing-input', '#typing-textarea', '#typing-rich', '#typing-rich-empty', '#external-button', '#external-select', '#external-role']) {
    await reset(); await hover(); await page.locator(selector).focus();
    await noShortcutMutation(`focused ${selector}`);
  }
  await reset(); await hover();
  await page.locator('#shopping-root [data-item-card-open]').focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.test.state().edits === 1);
  assert.deepEqual(await queue(), [], 'native title Space opens editing once without also toggling completion');

  for (const dialogType of ['modal', 'native']) {
    await reset(); await hover();
    await page.evaluate(type => {
      const dialog = document.createElement(type === 'native' ? 'dialog' : 'div');
      dialog.className = type === 'native' ? 'test-guard-dialog' : 'modal active test-guard-dialog';
      dialog.tabIndex = -1; document.body.appendChild(dialog);
      if (type === 'native') dialog.showModal();
      dialog.focus();
    }, dialogType);
    await noShortcutMutation(`${dialogType} dialog`);
  }
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'repeat']) {
    await reset(); await hover();
    await page.evaluate(modifier => {
      for (const key of [' ', 'Delete']) document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, [modifier]: true }));
    }, modifier);
    await page.waitForTimeout(35);
    assert.deepEqual(await queue(), [], `${modifier}: modified/repeated shortcut is ignored`);
    assert.equal((await state()).confirmations.length, 0);
  }
  await reset(); await hover();
  await page.evaluate(() => {
    const prevent = event => event.preventDefault();
    for (const key of [' ', 'Delete']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      prevent(event); document.dispatchEvent(event);
    }
  });
  assert.deepEqual(await queue(), [], 'defaultPrevented events are ignored');
  assert.equal((await state()).confirmations.length, 0);

  for (const condition of ['pointerout', 'module', 'actor', 'session', 'list', 'permission', 'readonly', 'dragging', 'swiping', 'native-pointer-dragging', 'destroy']) {
    await reset(); await hover();
    if (condition === 'pointerout') await page.mouse.move(1198, 898);
    else if (condition === 'module') await page.evaluate(() => window.test.change('module', 'tasks'));
    else if (condition === 'actor') await page.evaluate(() => window.test.change('actor', 2));
    else if (condition === 'session') await page.evaluate(() => window.test.change('session', 'new-hover-session'));
    else if (condition === 'permission') await page.evaluate(() => window.test.change('permission', false));
    else if (condition === 'list') await page.evaluate(() => window.test.change('list', 2));
    else if (condition === 'readonly') { await page.evaluate(() => window.test.change('list', 3)); await hover(); }
    else if (condition === 'destroy') await page.evaluate(() => window.test.change('destroy'));
    else await page.evaluate(condition => (condition === 'native-pointer-dragging' ? document.body : document.querySelector('#shopping-root .shopping-item-card')).classList.add(condition), condition);
    await noShortcutMutation(condition);
  }

  for (const transition of ['actor', 'session', 'module', 'list', 'permission', 'remove-item', 'remove-list', 'destroy', 'rebind']) {
    await reset(); await page.evaluate(() => window.test.confirm('hold')); await hover();
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => window.test.state().confirmations.length === 1);
    await page.keyboard.press('Delete');
    await page.evaluate(() => window.test.requestRemoveAgain());
    assert.equal((await state()).confirmations.length, 1, 'pending confirmations for the same item are deduplicated');
    await page.evaluate(transition => {
      const values = { actor: 2, session: 'replacement-session', module: 'tasks', list: 2, permission: false };
      window.test.change(transition, values[transition]);
      window.test.resolveConfirmation(true);
    }, transition);
    await page.waitForTimeout(50);
    assert.deepEqual(await queue(), [], `${transition}: resolving an old confirmation must not mutate stale/private data`);
  }

  await reset({ temporary: true });
  await hover();
  await page.evaluate(() => window.test.change('remap'));
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.test.state().queued === 1);
  assert.deepEqual((await queue())[0], { action: 'UPDATE_SHOPPING_ITEM', data: { shopping_list_id: 100, item_id: 110, changes: { completed: true } } }, 'hover shortcuts survive own creation acknowledgements without moving the pointer again');

  await reset({ temporary: true });
  await page.evaluate(() => window.test.confirm('hold')); await hover();
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => window.test.state().confirmations.length === 1);
  await page.evaluate(() => { window.test.change('foreign-remap'); window.test.resolveConfirmation(true); });
  await page.waitForTimeout(50);
  assert.deepEqual(await queue(), [], 'another creator cannot satisfy the original temporary list/item identity during confirmation');

  await reset({ temporary: true });
  await page.evaluate(() => window.test.confirm('hold')); await hover();
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => window.test.state().confirmations.length === 1);
  await page.evaluate(() => window.test.change('remap'));
  assert.equal(await page.evaluate(() => window.test.confirmationFocusTag()), 'BODY', 'keyboard confirmation retains the original body focus through creation acknowledgement');
  await page.evaluate(() => window.test.resolveConfirmation(true));
  await page.waitForFunction(() => window.test.state().queued === 1);
  assert.deepEqual((await queue())[0], { action: 'DELETE_SHOPPING_ITEM', data: { shopping_list_id: 100, item_id: 110 } }, 'a valid own creation acknowledgement preserves the pending operation and remaps both IDs');

  await reset();
  await page.evaluate(() => window.test.change('module', 'tasks'));
  await hover('#task-root .todo-item');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.test.state().taskStatus === 'in_progress');
  assert.equal((await state()).taskQueue[0].action, 'UPDATE_TODO');
  assert.deepEqual(await queue(), [], 'Tasks shortcuts do not mutate the hovered/inactive Shopping list');
  await hover('#task-root .todo-item');
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => window.test.state().taskConfirmations === 1);
  const taskWrites = (await state()).taskQueue.length;
  await page.locator('#task-root [data-item-card-open]').focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.test.state().taskEdits === 1);
  assert.equal((await state()).taskQueue.length, taskWrites, 'native Tasks title Space is not also handled by hover shortcuts');

  assert.deepEqual((await state()).errors, []);
  assert.deepEqual(pageErrors, []);
  console.log('✅ Shopping/Tasks shared hover shortcuts, durable queue, native controls and pending-confirmation privacy fences passed');
} finally {
  await browser.close();
}
