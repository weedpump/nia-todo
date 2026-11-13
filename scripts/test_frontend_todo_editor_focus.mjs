#!/usr/bin/env node
// Real Tasks editor with mocked persistence and deliberately queued autofocus.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const fixture = `
import { TASK_DIALOGS_HTML } from '/static/js/modules/tasks-dialogs.js';
import { createTodosFeature } from '/static/js/features/todos.js';
import { initI18n } from '/static/js/i18n/index.js';
import { closeOpenDropdown } from '/static/js/ui/dropdowns.js';
localStorage.setItem('nia-todo-language', 'de');
await initI18n();
document.body.innerHTML = '<button id="outside">Outside editor</button>' + TASK_DIALOGS_HTML;
const saved = { id: 5, title: 'Existing task', status: 'pending', priority: 3, project_id: 1 };
const feature = createTodosFeature({
  getTodos: () => [saved], setTodos() {},
  getProjects: () => [{ id: 1, name: 'Inbox', is_inbox: true }], getSections: () => [],
  getCurrentProjectId: () => 1, getCurrentWorkspaceId: () => null,
  getCurrentUser: () => null, setCurrentUser() {}, getAppInitialized: () => true,
  getDb: () => ({}), dbPut: async () => {}, dbGetAll: async () => [],
  deleteFromDB: async () => {}, addToSyncQueue: async () => {},
  isOnlineForSync: () => false, syncWithServer: async () => {},
  todosApi: {}, sectionsApi: {}, placesApi: null,
  renderProjects() {}, renderStats() {}, renderTodos() {},
  closeModal: id => document.getElementById(id)?.classList.remove('active'),
  confirmDanger: async () => false, showToast() {}, setupDescPreview() {},
  renderMarkdown: value => String(value || ''),
});
const batches = [];
window.test = {
  async open(edit = false) {
    const raf = [], timers = [];
    const nativeRaf = window.requestAnimationFrame, nativeTimeout = window.setTimeout;
    // Intercept scheduling only while the actual production opener executes.
    window.requestAnimationFrame = callback => { raf.push(callback); return -raf.length; };
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 80) { timers.push(() => callback(...args)); return -timers.length; }
      return nativeTimeout.call(window, callback, delay, ...args);
    };
    try { await feature.showTodoModal(edit ? saved : null); }
    finally { window.requestAnimationFrame = nativeRaf; window.setTimeout = nativeTimeout; }
    batches.push({ raf, timers });
    return { index: batches.length - 1, frames: raf.length, timers: timers.length };
  },
  flush(index, phase) {
    for (const callback of batches[index][phase].splice(0)) callback(performance.now());
  },
  close() {
    closeOpenDropdown();
    document.getElementById('todo-modal').classList.remove('active', 'todo-meta-editing');
    document.getElementById('outside').focus();
  },
  focusState() {
    const select = document.getElementById('todo-status');
    const trigger = select.nextElementSibling.querySelector('.ui-select-trigger');
    return {
      titleFocused: document.activeElement === document.getElementById('todo-title'),
      outsideFocused: document.activeElement === document.getElementById('outside'),
      statusFocused: document.activeElement === trigger,
      drawerOpen: document.getElementById('todo-modal').classList.contains('todo-meta-editing'),
      statusExpanded: trigger.getAttribute('aria-expanded') === 'true',
    };
  },
};
`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://todo-focus.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/style.css"></head><body><script type="module" src="/fixture.js"></script></body></html>' });
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: fixture });
    if (path.startsWith('/static/')) return route.fulfill({
      contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.json') ? 'application/json' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream',
      body: await readFile(new URL('../web' + path, import.meta.url)),
    });
    return route.fulfill({ status: 404, body: 'No service used by this fixture' });
  });
  await page.goto('http://todo-focus.test/');
  await page.waitForFunction(() => Boolean(window.test));
  const open = async (edit = false) => {
    await page.locator('#outside').focus();
    return page.evaluate(value => window.test.open(value), edit);
  };
  const flush = (batch, phase) => page.evaluate(({ index, phase }) => window.test.flush(index, phase), { index: batch.index, phase });
  const state = () => page.evaluate(() => window.test.focusState());
  const close = () => page.evaluate(() => window.test.close());

  const initial = await open();
  assert(initial.frames >= 2 && initial.timers === 1, 'capture the production title RAF and delayed fallback');
  await flush(initial, 'raf');
  assert.equal((await state()).titleFocused, true, 'untouched create editor receives its initial title focus');
  await flush(initial, 'timers');
  assert.equal((await state()).titleFocused, true, 'fallback preserves normal create focus');
  await close();

  for (const movedAfterInitialFocus of [false, true]) {
    const current = await open();
    if (movedAfterInitialFocus) await flush(current, 'raf');
    await page.locator('.todo-meta-summary-chip[data-meta-edit-target="todo-status"]').click();
    assert.deepEqual(await state(), { titleFocused: false, outsideFocused: false, statusFocused: true, drawerOpen: true, statusExpanded: true });
    await flush(current, 'raf');
    await flush(current, 'timers');
    assert.deepEqual(await state(), { titleFocused: false, outsideFocused: false, statusFocused: true, drawerOpen: true, statusExpanded: true }, 'queued autofocus must preserve the actual badge-opened status editor');
    await close();
  }

  const closed = await open();
  await close();
  await flush(closed, 'raf');
  await flush(closed, 'timers');
  assert.equal((await state()).outsideFocused, true, 'closed editor callbacks cannot change focus');

  const oldCreate = await open();
  await close();
  const edit = await open(true);
  assert.equal(edit.timers, 0, 'edit mode must not schedule create autofocus');
  await flush(oldCreate, 'raf');
  await flush(oldCreate, 'timers');
  assert.equal((await state()).outsideFocused, true, 'old create callbacks must not focus an editor reopened in edit mode');
  await close();

  const previousCreate = await open();
  await close();
  const reopenedCreate = await open();
  await flush(previousCreate, 'raf');
  await flush(previousCreate, 'timers');
  assert.equal((await state()).outsideFocused, true, 'old create callbacks cannot act on a newer create modal');
  await flush(reopenedCreate, 'raf');
  await flush(reopenedCreate, 'timers');
  assert.equal((await state()).titleFocused, true, 'current create callbacks still focus the title');
  assert.deepEqual(errors, []);
  console.log('✅ Tasks autofocus preserves metadata focus, closed editors and modal generations');
} finally {
  await browser.close();
}
