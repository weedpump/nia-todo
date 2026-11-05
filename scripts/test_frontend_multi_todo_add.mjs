#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const modulePath = path.join(root, 'web/static/js/features/todo-multi-add.js');
const stylesheetPath = path.join(root, 'web/static/css/96-todo-multi-add.css');
const taskDialogsPath = path.join(root, 'web/static/js/modules/tasks-dialogs.js');
const todosFeaturePath = path.join(root, 'web/static/js/features/todos.js');
const iconsPath = path.join(root, 'web/static/js/icons/lucide-generated.js');
const moduleUrl = pathToFileURL(modulePath);
moduleUrl.searchParams.set('test', String(Date.now()));
const feature = await import(moduleUrl.href);
const stylesheet = await readFile(stylesheetPath, 'utf8');
const taskDialogsSource = await readFile(taskDialogsPath, 'utf8');
const todosFeatureSource = await readFile(todosFeaturePath, 'utf8');
const iconsSource = await readFile(iconsPath, 'utf8');

const sharedRenderer = await readFile(path.join(root,'web/static/js/features/multi-add.js'),'utf8');
assert.match(taskDialogsSource, /renderMultiAddPanel\(/);
assert.match(taskDialogsSource, /renderMultiAddModeSwitch\(/);
assert.match(sharedRenderer, /ui-multi-add-intro-heading ui-section-heading ui-detail-section-heading/);
assert.match(sharedRenderer, /capture\.multiAdd\.defaultsTitle/);
assert.match(stylesheet, /\.ui-multi-add-editor\s*\{[^}]*border:\s*0;/s);
assert.match(stylesheet, /\.ui-multi-add-mode-switch\s*\{[^}]*border:\s*0;/s);
assert.match(taskDialogsSource, /id="todo-recurring-panel"/, 'recurrence must be a first-class todo detail section');
assert.match(taskDialogsSource, /id="todo-location-reminder-panel"/, 'location reminders must be a first-class todo detail section');
assert.doesNotMatch(taskDialogsSource, /todo-recurring-subsection/, 'recurrence and location reminders must not remain nested schedule subsections');
for (const panelId of ['todo-organize-panel', 'todo-schedule-panel', 'todo-recurring-panel', 'todo-location-reminder-panel']) {
  assert.match(todosFeatureSource, new RegExp(`['"]${panelId}['"]`), `${panelId} must be mounted into the detail drawer`);
}

assert.equal(typeof feature.syncMultiAddNativeValidation, 'function', 'Multi mode must control native title validation');
assert.equal(typeof feature.getMultiTodoValidationKey, 'function', 'Multi todo data must be validated before local persistence');
assert.equal(typeof feature.splitMultiTodoPaste, 'function', 'Pasted rows must report omitted entries');
assert.equal(typeof feature.getMultiTodoRowA11y, 'function', 'Rows must expose stable accessible metadata');
assert.equal(typeof feature.shouldOpenCreateTodoMetaDrawer, 'function', 'Single mode must restore the desktop create drawer state');

const titleInput = { required: true };
globalThis.document = {
  getElementById(id) {
    return id === 'todo-title' ? titleInput : null;
  },
};
feature.syncMultiAddNativeValidation(true);
assert.equal(titleInput.required, false, 'The hidden single-title field must not block multi submit');
feature.syncMultiAddNativeValidation(false);
assert.equal(titleInput.required, true, 'Single mode must restore native title validation');

assert.equal(
  feature.getMultiTodoValidationKey({ recurring_rule: 'FREQ=WEEKLY', due_date: null }),
  'todo.multiAdd.recurringNeedsDue',
);
assert.equal(feature.getMultiTodoValidationKey({ recurring_rule: 'FREQ=WEEKLY', due_date: '2026-10-07' }), null);
assert.equal(feature.getMultiTodoValidationKey({ recurring_rule: null, due_date: null }), null);

assert.deepEqual(
  feature.splitMultiTodoPaste('- First\n* Second\n3. Third', 2),
  { values: ['First', 'Second'], omittedCount: 1 },
);
assert.deepEqual(feature.splitMultiTodoPaste('Single line', 4), { values: ['Single line'], omittedCount: 0 });

const a11y = feature.getMultiTodoRowA11y('row-7', 2, (key, params) => `${key}:${params.number}`);
assert.deepEqual(a11y, {
  inputId: 'todo-multi-add-input-row-7',
  previewId: 'todo-multi-add-preview-row-7',
  messageId: 'todo-multi-add-message-row-7',
  inputLabel: 'capture.multiAdd.rowLabel:2',
  removeLabel: 'capture.multiAdd.removeRow:2',
});

assert.equal(feature.shouldOpenCreateTodoMetaDrawer({ matches: false }), true);
assert.equal(feature.shouldOpenCreateTodoMetaDrawer({ matches: true }), false);
assert.equal(feature.shouldOpenCreateTodoMetaDrawer(null), true);

const source = await readFile(modulePath, 'utf8');
const sharedSource = await readFile(path.join(root,'web/static/js/features/multi-add.js'),'utf8');
assert.match(source, /createMultiAddFeature\(/, 'Tasks must delegate the shared engine');
assert.doesNotMatch(source, /function (?:createRow|parseRow|performSave|handlePaste)\(/, 'Tasks must not retain a parallel engine');
assert.match(sharedSource, /splitMultiAddPaste\(text,/);
const browser = await chromium.launch({ headless: true });
try {
  // Exercise the production editor, lazy mounting and native form validation.
  // Persistence is isolated browser IndexedDB; no service/API or live data.
  const productionPage = await browser.newPage();
  const productionErrors = [];
  const productionConsole = [];
  productionPage.on('pageerror', error => productionErrors.push(error.message));
  productionPage.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') productionConsole.push(message.text());
  });
  await productionPage.route('http://multi-todo-production.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/static/')) {
      const file = path.resolve(root, 'web', pathname.slice(1));
      assert.ok(file.startsWith(path.join(root, 'web/static') + path.sep));
      try {
        await route.fulfill({ contentType: pathname.endsWith('.js') ? 'text/javascript'
          : pathname.endsWith('.css') ? 'text/css' : 'application/json', body: await readFile(file, 'utf8') });
      } catch { await route.fulfill({ status: 404, body: `Unknown production fixture asset: ${pathname}` }); }
      return;
    }
    assert.equal(pathname, '/', `Unexpected production fixture request: ${pathname}`);
    await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
      <link rel="stylesheet" href="/static/style.css"></head><body>
      <button data-todo-action="new" id="new-todo">New</button><script type="module">
      import { TASK_DIALOGS_HTML } from '/static/js/modules/tasks-dialogs.js';
      import { createTodosFeature } from '/static/js/features/todos.js';
      import { initI18n } from '/static/js/i18n/index.js';
      localStorage.setItem('nia-todo-language', 'de');
      await initI18n();
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('multi-todo-production', 1);
        request.onupgradeneeded = () => {
          for (const store of ['todos', 'syncQueue', 'sections']) request.result.createObjectStore(store, { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const put = (store, value) => new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      const all = store => new Promise((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      let todos = [], projects = [{id: 1, name: 'Inbox', is_inbox: true}, {id: 2, name: 'Work'}];
      const catalogSections = [{id: 21, project_id: 2, name: 'J2jw'}];
      const sections = []; // Dashboard has no selected-project section projection.
      for (const section of catalogSections) await put('sections', section);
      const events = { submits: 0, invalid: [], puts: 0, enqueues: 0, closes: [], toasts: [] };
      let queueId = 0;
      const enqueue = async (action, data) => { events.enqueues++; await put('syncQueue', {id: ++queueId, action, data}); };
      const feature = createTodosFeature({
        getTodos: () => todos, setTodos: next => { todos = next; },
        getProjects: () => projects, getSections: () => sections,
        getCurrentProjectId: () => null, getCurrentWorkspaceId: () => null,
        getCurrentUser: () => null, setCurrentUser: () => {},
        getAppInitialized: () => true, getDb: () => db,
        dbPut: async (store, value) => { events.puts++; await put(store, value); }, dbGetAll: all,
        deleteFromDB: async () => {}, addToSyncQueue: enqueue,
        runSyncQueueMutation: async operation => {
          if (window.production?.beforeCommit) await window.production.beforeCommit();
          return operation(enqueue);
        },
        isOnlineForSync: () => false, syncWithServer: async () => {},
        todosApi: {}, sectionsApi: {}, placesApi: null,
        renderProjects: () => {}, renderStats: () => {}, renderTodos: () => {},
        closeModal: id => { events.closes.push(id); document.getElementById(id).classList.remove('active'); },
        confirmDanger: async () => false, showToast: text => events.toasts.push(text),
        setupDescPreview: () => {}, renderMarkdown: value => String(value || ''),
      });
      // App creates the feature before Tasks mounts its dialogs.
      document.body.insertAdjacentHTML('beforeend', TASK_DIALOGS_HTML);
      feature.bindTodoActions();
      document.getElementById('todo-form').addEventListener('submit', () => events.submits++);
      document.getElementById('todo-form').addEventListener('invalid', e => events.invalid.push(e.target.id), true);
      window.production = {events, all, todos: () => todos, revokeProjects: () => {projects = [];} };
      </script></body></html>` });
  });
  await productionPage.goto('http://multi-todo-production.test/');
  await productionPage.waitForFunction(() => window.production);
  await productionPage.click('#new-todo');
  await productionPage.waitForFunction(() => document.getElementById('todo-modal').classList.contains('active'));
  await productionPage.click('#todo-create-mode-switch [data-multi-add-mode="multi"]');
  const productionInputs = productionPage.locator('#todo-multi-add-rows .ui-multi-add-input');
  await productionInputs.first().fill('First production task');
  for (const shortcut of [
    { ctrlKey: true, isComposing: true },
    { metaKey: true, isComposing: true },
    { ctrlKey: true, keyCode: 229 },
    { metaKey: true, keyCode: 229 },
    { ctrlKey: true, handled: true },
    { metaKey: true, handled: true },
  ]) {
    await productionInputs.first().evaluate((input, shortcut) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...shortcut });
      if (shortcut.handled) event.preventDefault();
      input.dispatchEvent(event);
    }, shortcut);
    const blockedResult = await productionPage.evaluate(async () => ({
      submits: window.production.events.submits,
      todos: await window.production.all('todos'),
      queue: await window.production.all('syncQueue'),
    }));
    assert.deepEqual(blockedResult, { submits: 0, todos: [], queue: [] }, `production Tasks row must ignore composing or handled shortcuts: ${JSON.stringify(shortcut)}`);
  }
  await productionInputs.first().press('Enter');
  await productionInputs.nth(1).fill('Second production task');
  await productionPage.click('#todo-save-btn');
  await productionPage.waitForTimeout(250);
  const productionResult = await productionPage.evaluate(async () => ({
    events: window.production.events, todos: await window.production.all('todos'),
    queue: await window.production.all('syncQueue'), memory: window.production.todos(),
    active: document.getElementById('todo-modal').classList.contains('active'),
  }));
  console.log('Production Tasks native-submit diagnostics:', JSON.stringify({
    events: productionResult.events, todos: productionResult.todos.map(({title, project_id, section_id}) => ({title, project_id, section_id})),
    queue: productionResult.queue.map(({action, data}) => ({action, title: data.title})),
    active: productionResult.active, errors: productionErrors, console: productionConsole,
  }));
  assert.equal(productionResult.todos.length, 2, 'Native production save must persist both Tasks');
  assert.equal(productionResult.queue.length, 2, 'Native production save must enqueue both Tasks');
  assert.deepEqual(productionResult.todos.map(todo => todo.title), ['First production task', 'Second production task']);
  assert.deepEqual(productionResult.todos.map(todo => todo.project_id), [1, 1]);
  assert.deepEqual(productionResult.queue.map(entry => entry.data.title), productionResult.todos.map(todo => todo.title));
  assert.equal(productionResult.memory.length, 2);
  assert.equal(productionResult.events.submits, 1);
  assert.deepEqual(productionResult.events.invalid, []);
  assert.deepEqual(productionResult.events.closes, ['todo-modal']);
  assert.equal(productionResult.events.toasts.length, 1);
  assert.equal(productionResult.active, false);

  // Reopen the same production editor: native field states must restore, then
  // project/section defaults and Ctrl+Enter must reach the same real save path.
  await productionPage.click('#new-todo');
  await productionPage.waitForFunction(() => document.getElementById('todo-modal').classList.contains('active'));
  assert.equal(await productionPage.locator('#todo-title').evaluate(field => field.required && !field.disabled), true);
  await productionPage.click('#todo-create-mode-switch [data-multi-add-mode="multi"]');
  await productionPage.selectOption('#todo-multi-project', '2');
  await productionPage.waitForFunction(() => document.querySelector('#todo-multi-section option[value="21"]'));
  await productionPage.selectOption('#todo-multi-section', '21');
  await productionPage.selectOption('#todo-multi-priority', '2');
  await productionInputs.first().fill('Project default task');
  await productionInputs.first().press('Control+Enter');
  await productionPage.waitForFunction(() => document.getElementById('todo-modal').getAttribute('aria-busy') !== 'true');
  const defaultResult = await productionPage.evaluate(async () => ({
    todos: await window.production.all('todos'), queue: await window.production.all('syncQueue'), events: window.production.events,
  }));
  assert.equal(defaultResult.todos.length, 3);
  assert.equal(defaultResult.queue.length, 3);
  const defaultTodo = defaultResult.todos.find(todo => todo.title === 'Project default task');
  assert.deepEqual([defaultTodo.project_id, defaultTodo.section_id, defaultTodo.priority], [2, 21, 2]);
  assert.deepEqual(defaultResult.queue.at(-1).data, {
    ...Object.fromEntries(Object.entries(defaultTodo).filter(([key]) => !['id','created_at','updated_at','completed_at','reminders'].includes(key))),
    _tempId: defaultTodo.id,
  });
  assert.equal(defaultResult.events.submits, 2, 'Ctrl+Enter must submit exactly once');
  assert.deepEqual(defaultResult.events.invalid, []);

  let persistedTasks = defaultResult.todos.length;
  for (const titles of [['Test', 'Test', 'Jdjdjd'], ['First unique', 'Second unique', 'Third unique']]) {
    await productionPage.click('#new-todo');
    await productionPage.waitForFunction(() => document.getElementById('todo-modal').classList.contains('active'));
    await productionPage.click('#todo-create-mode-switch [data-multi-add-mode="multi"]');
    await productionPage.selectOption('#todo-multi-project', '2');
    await productionPage.waitForFunction(() => document.querySelector('#todo-multi-section option[value="21"]'));
    await productionPage.selectOption('#todo-multi-section', '21');
    for (const [index, title] of titles.entries()) {
      await productionInputs.nth(index).fill(title);
      await productionInputs.nth(index).press('Enter');
    }
    await productionPage.click('#todo-save-btn');
    await productionPage.waitForFunction(() => document.getElementById('todo-modal').getAttribute('aria-busy') !== 'true');
    const result = await productionPage.evaluate(async () => ({todos: await window.production.all('todos'), queue: await window.production.all('syncQueue')}));
    persistedTasks += titles.length;
    assert.equal(result.todos.length, persistedTasks, 'Dashboard to Work/J2jw must persist all nonempty lines via the native button');
    assert.equal(result.queue.length, persistedTasks);
    const latest = result.queue.slice(-titles.length);
    assert.deepEqual(latest.map(entry => entry.data.title), titles);
    assert(latest.every(entry => entry.data.project_id === 2 && entry.data.section_id === 21));
    assert.equal(new Set(latest.map(entry => entry.data._tempId)).size, titles.length);
  }
  console.log('✅ Dashboard → Work/J2jw: native button persists duplicate and unique batches; empty lines omitted');

  await productionPage.click('#new-todo');
  await productionPage.waitForFunction(() => document.getElementById('todo-modal').classList.contains('active'));
  await productionPage.click('#todo-create-mode-switch [data-multi-add-mode="multi"]');
  await productionInputs.first().fill('Meta shortcut task');
  const submitsBeforeMeta = await productionPage.evaluate(() => window.production.events.submits);
  await productionInputs.first().press('Meta+Enter');
  await productionPage.waitForFunction(() => !document.getElementById('todo-modal').classList.contains('active'));
  persistedTasks++;
  const metaResult = await productionPage.evaluate(async () => ({
    submits: window.production.events.submits,
    todos: await window.production.all('todos'), queue: await window.production.all('syncQueue'),
  }));
  assert.equal(metaResult.submits, submitsBeforeMeta + 1, 'Meta+Enter must submit exactly once');
  assert.equal(metaResult.todos.length, persistedTasks);
  assert.equal(metaResult.queue.length, persistedTasks);
  assert.equal(metaResult.queue.at(-1).data.title, 'Meta shortcut task');

  // Revocation at the actual commit boundary must still reject the whole batch.
  await productionPage.click('#new-todo');
  await productionPage.waitForFunction(() => document.getElementById('todo-modal').classList.contains('active'));
  await productionPage.click('#todo-create-mode-switch [data-multi-add-mode="multi"]');
  await productionInputs.first().fill('Revoked task');
  await productionPage.evaluate(() => {
    window.production.beforeCommit = async () => { window.production.revokeProjects(); };
  });
  await productionPage.click('#todo-save-btn');
  await productionPage.waitForFunction(() => document.getElementById('todo-modal').getAttribute('aria-busy') !== 'true');
  const revokedResult = await productionPage.evaluate(async () => ({
    todos: await window.production.all('todos'), queue: await window.production.all('syncQueue'), events: window.production.events,
    active: document.getElementById('todo-modal').classList.contains('active'),
  }));
  assert.equal(revokedResult.todos.length, persistedTasks, 'Revoked project must not persist a todo');
  assert.equal(revokedResult.queue.length, persistedTasks, 'Revoked project must not enqueue a todo');
  assert.equal(revokedResult.events.closes.length, 5);
  assert.equal(revokedResult.events.toasts.length, 5);
  assert.equal(revokedResult.active, true);
  assert.deepEqual(productionErrors, []);
  assert.deepEqual(productionConsole, []);
  await productionPage.close();

  // Geometry must see the complete production cascade, including the late
  // shared section-divider rules, and the actual Tasks dialog markup.
  const geometryPage = await browser.newPage();
  const geometryErrors = [];
  geometryPage.on('pageerror', error => geometryErrors.push(error.message));
  await geometryPage.route('http://multi-todo-geometry.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/static/')) {
      const file = path.resolve(root, 'web', pathname.slice(1));
      assert.ok(file.startsWith(path.join(root, 'web/static') + path.sep));
      const contentType = pathname.endsWith('.js') ? 'text/javascript'
        : pathname.endsWith('.css') ? 'text/css' : 'application/json';
      try {
        await route.fulfill({ status: 200, contentType, body: await readFile(file, 'utf8') });
      } catch {
        await route.fulfill({ status: 404, body: `Unknown geometry fixture asset: ${pathname}` });
      }
      return;
    }
    assert.equal(pathname, '/', `Unexpected geometry fixture request: ${pathname}`);
    await route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html>
      <html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/static/style.css"></head><body>
      <script type="module">
        import { TASK_DIALOGS_HTML } from '/static/js/modules/tasks-dialogs.js';
        import { initI18n, translatePage, t } from '/static/js/i18n/index.js';
        import { createTodoMultiAddFeature } from '/static/js/features/todo-multi-add.js';
        localStorage.setItem('nia-todo-language', 'de');
        await initI18n();
        document.body.innerHTML = TASK_DIALOGS_HTML;
        translatePage(document);
        const modal = document.getElementById('todo-modal');
        modal.classList.add('active', 'todo-detail-view', 'todo-create-view');
        const feature = createTodoMultiAddFeature({
          t, getCurrentProjectId: () => null, loadSectionsForQuickAdd: async () => [],
          hydrateSelect: () => {}, refreshSelect: () => {},
          parseQuickAddTitle: async title => ({ title, changes: {}, matches: [] }),
        });
        feature.bind();
        feature.reset({ editing: false });
        window.geometryFeature = feature;
        window.geometryReady = true;
      </script></body></html>` });
  });
  await geometryPage.goto('http://multi-todo-geometry.test/');
  await geometryPage.waitForFunction(() => window.geometryReady);
  assert.deepEqual(geometryErrors, []);
  const geometryFailures = [];
  for (const width of [1280, 920, 768, 390]) {
    await geometryPage.setViewportSize({ width, height: 900 });
    for (const mode of ['single', 'multi', 'single']) {
      await geometryPage.locator(`[data-multi-add-mode="${mode}"]`).click();
      const geometry = await geometryPage.evaluate(mode => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const tabs = rect('#todo-create-mode-switch');
        const target = rect(mode === 'multi' ? '.ui-multi-add-intro-heading h4' : '#todo-title');
        const shell = document.querySelector('.todo-editor-shell');
        return {
          gap: target.top - tabs.bottom,
          shellRowGap: getComputedStyle(shell).rowGap,
          targetHeight: target.height,
        };
      }, mode);
      assert.ok(geometry.targetHeight > 0, `${mode} capture target must be visible at ${width}px`);
      assert.equal(geometry.shellRowGap, '0px', 'Section dividers must retain their canonical zero shell gap');
      // The canonical detail layout defines 24px between capture rows; keep
      // that separation without reinstating gaps between every detail section.
      if (Math.abs(geometry.gap - 24) > 0.5) {
        geometryFailures.push(`${width}px ${mode}: expected 24px below capture tabs, got ${geometry.gap}px`);
      }
    }
  }
  assert.deepEqual(geometryFailures, [], 'Both capture modes must retain positive canonical spacing after the full stylesheet cascade');
  console.log('✅ Tasks capture tab geometry: 24px in both modes at 1280/920/768/390px');
  await geometryPage.close();

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if(message.type()==='error') console.error(message.text()); });
  await page.route('http://multi-todo.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('.js')) {
      try {
        const relative = pathname.slice(1);
        const file = path.resolve(root, 'web/static/js/features', relative);
        if (!file.startsWith(path.join(root, 'web/static/js') + path.sep)) throw new Error('outside fixture');
        await route.fulfill({status:200,contentType:'text/javascript',body:await readFile(file,'utf8')});
      } catch { await route.fulfill({status:404,body:'Unknown JS fixture: '+pathname}); }
      return;
    }
    if (pathname === '/todo-multi-add.css') {
      await route.fulfill({ status: 200, contentType: 'text/css', body: stylesheet });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><head><link rel="stylesheet" href="/todo-multi-add.css"></head><body>
        <div id="todo-modal" class="active">
          <div class="todo-editor-shell">
          <div id="todo-create-mode-switch" class="ui-multi-add-mode-switch">
            <button type="button" data-multi-add-mode="single">Single</button>
            <button type="button" data-multi-add-mode="multi">Multiple</button>
          </div>
          <div id="todo-multi-add-panel" class="ui-multi-add-panel" hidden>
            <div id="todo-multi-add-rows"></div>
            <div class="ui-multi-add-toolbar">
              <span class="ui-multi-add-toolbar-hint">Quick Add works per line</span>
              <button type="button" id="todo-multi-add-more">More</button>
            </div>
            <span id="todo-multi-add-count"></span>
            <span id="todo-multi-add-limit"></span>
            <select id="todo-multi-project"><option value="1">Project</option></select>
            <select id="todo-multi-section"></select>
            <select id="todo-multi-priority"><option value="3">Normal</option></select>
          </div>
          <input id="todo-title" required>
          <select id="todo-project"><option value="1">Project</option></select>
          <h2 id="todo-modal-title"></h2>
          <p id="todo-modal-subtitle"></p>
          <button type="submit" id="todo-save-btn">Save</button>
        </div>
        </div>
        <script type="module">
          import { createTodoMultiAddFeature } from '/todo-multi-add.js';
          const feature = createTodoMultiAddFeature({
            t: (key, params = {}) => key.startsWith('todo.multiAdd.create.') ? 'Save ' + params.count : key,
            getTodos: () => [],
            setTodos: () => {},
            getProjects: () => window.__multiTodoProjects,
            getSections: () => window.__multiTodoSections,
            getCurrentProjectId: () => 1,
            getAppInitialized: () => true,
            getDb: () => ({}),
            dbPut: async (...args) => window.__multiTodoDbWrites.push(args),
            addToSyncQueue: async (...args) => window.__multiTodoQueueWrites.push(args),
            runSyncQueueMutation: async operation => {
              window.__multiTodoCommitEntered = true;
              if (window.__multiTodoCommitGate) await window.__multiTodoCommitGate;
              return operation(async (...args) => window.__multiTodoQueueWrites.push(args));
            },
            isOnlineForSync: () => false,
            syncWithServer: async () => {},
            parseQuickAddTitle: raw => new Promise(resolve => {
              window.__multiTodoParses.push({ raw, resolve });
            }),
            loadSectionsForQuickAdd: () => window.__holdMultiTodoSections
              ? new Promise(resolve => window.__multiTodoSectionRequests.push(resolve))
              : Promise.resolve([]),
            hydrateSelect: () => {},
            refreshSelect: () => {},
            renderProjects: () => {},
            renderStats: () => {},
            renderTodos: () => {},
            closeModal: () => {},
            showToast: () => {},
          });
          window.__multiTodoParses = [];
          window.__multiTodoProjects = [{ id: 1 }];
          window.__multiTodoSections = [];
          window.__multiTodoCommitGate = null;
          window.__multiTodoCommitEntered = false;
          window.__multiTodoDbWrites = [];
          window.__multiTodoQueueWrites = [];
          window.__multiTodoSectionRequests = [];
          window.__holdMultiTodoSections = false;
          feature.bind();
          window.__multiTodoFeature = feature;
          window.__multiTodoReady = true;
        </script>
      </body></html>`,
    });
  });
  await page.goto('http://multi-todo.test/');
  await page.waitForFunction(() => window.__multiTodoReady === true);
  const waitForParse = raw => page.waitForFunction(
    expected => window.__multiTodoParses.some(request => request.raw === expected),
    raw,
  );
  const resolveParse = (raw, { title = raw, changes = {}, matches = [] } = {}) => page.evaluate(
    ({ expected, result }) => {
      const index = window.__multiTodoParses.findIndex(request => request.raw === expected);
      if (index < 0) throw new Error(`Missing parse request for ${expected}`);
      const [request] = window.__multiTodoParses.splice(index, 1);
      request.resolve(result);
    },
    { expected: raw, result: { title, changes, matches } },
  );

  await page.click('[data-multi-add-mode="multi"]');
  assert.equal(pageErrors.length, 0, `Opening multi-todo mode must not throw: ${pageErrors.join('; ')}`);

  for (const width of [1280,920,768,390]) {
    await page.setViewportSize({width,height:900});
    await page.mouse.move(0,0);
    await page.evaluate(()=>document.activeElement?.blur());
    await page.waitForTimeout(180);
    const shellWidth=await page.locator('.todo-editor-shell').evaluate(e=>e.getBoundingClientRect().width);
    assert.ok(shellWidth<=920 && shellWidth<=width, `Capture shell must fit ${width}px viewport and preserve its 920px cap`);
    assert.equal(await page.locator('.ui-multi-add-toolbar').evaluate(e=>getComputedStyle(e).flexDirection),width<=768?'column':'row');
    assert.equal(await page.locator('.ui-multi-add-remove').first().evaluate(e=>getComputedStyle(e).opacity),width<=768?'1':'0');
  }
  await page.setViewportSize({width:1280,height:900});
  const inputs = page.locator('.ui-multi-add-input');
  await inputs.first().fill('First todo');
  await waitForParse('First todo');
  await resolveParse('First todo');
  await page.click('#todo-multi-add-more');
  const saveButton = page.locator('#todo-save-btn');
  const saveHandle = await saveButton.elementHandle();
  await inputs.nth(1).fill('Second todo');
  assert.equal(await saveButton.isHidden(), false, 'The save action must stay visible while the new row is parsed');
  assert.equal(await saveButton.isDisabled(), false, 'The save action must not flash disabled while the new row is parsed');
  assert.equal(await saveButton.textContent(), 'Save 2', 'The save count must update immediately from current input values');
  assert.equal(await saveButton.evaluate((button, original) => button === original, saveHandle), true, 'Typing must preserve the existing save button node');
  await waitForParse('Second todo');
  await resolveParse('Second todo');
  assert.equal(pageErrors.length, 0, `Parsing multi-todo rows must not throw: ${pageErrors.join('; ')}`);

  await inputs.first().fill('First todo morgen');
  await waitForParse('First todo morgen');
  await resolveParse('First todo morgen', {
    matches: [{ type: 'due', label: 'Due', value: 'Tomorrow' }],
  });
  await page.locator('.ui-multi-add-preview .quick-add-chip').waitFor();
  assert.equal(await inputs.first().locator('xpath=..').locator('.ui-multi-add-preview .quick-add-chip').count(), 1, 'Recognized quick syntax must render a badge');
  const toolbarTopBeforeEdit = await page.locator('.ui-multi-add-toolbar').evaluate(element => element.getBoundingClientRect().top);
  await inputs.first().fill('Old morgen');
  await waitForParse('Old morgen');
  await inputs.first().fill('New plain');
  await resolveParse('Old morgen', {
    matches: [{ type: 'due', label: 'Due', value: 'Stale' }],
  });
  await page.evaluate(() => Promise.resolve());
  assert.equal(await inputs.first().locator('xpath=..').locator('.ui-multi-add-preview .quick-add-chip').count(), 1, 'The previous badges must remain visible while the replacement parse is pending');
  assert.equal(await inputs.first().locator('xpath=..').locator('.ui-multi-add-preview strong').textContent(), 'Tomorrow', 'A stale parse result must never replace the current badges');
  const toolbarTopDuringParse = await page.locator('.ui-multi-add-toolbar').evaluate(element => element.getBoundingClientRect().top);
  assert.equal(toolbarTopDuringParse, toolbarTopBeforeEdit, 'The Quick Add hint must not jump while badges are reparsed');
  assert.equal(await page.locator('.ui-multi-add-toolbar-hint').count(), 1, 'The shared Quick Add hint must remain a single stable element');
  await waitForParse('New plain');
  await resolveParse('New plain');
  await page.waitForFunction(() => document.querySelectorAll('.ui-multi-add-preview .quick-add-chip').length === 0);
  assert.equal(await inputs.first().locator('xpath=..').locator('.ui-multi-add-preview .quick-add-chip').count(), 0, 'The completed parse must replace obsolete badges');

  await inputs.nth(1).fill('Recurring todo');
  await waitForParse('Recurring todo');
  await resolveParse('Recurring todo', { changes: { recurring_rule: 'FREQ=WEEKLY' } });
  await page.waitForFunction(() => document.querySelectorAll('.ui-multi-add-row')[1]?.classList.contains('is-invalid'));
  assert.equal(await saveButton.isDisabled(), true, 'A known invalid row must disable the save action');
  const secondRow = page.locator('.ui-multi-add-row').nth(1);
  assert.equal(await secondRow.evaluate(row => row.classList.contains('is-invalid')), true, 'The parsed validation error must mark its row invalid');
  const invalidMessage = await secondRow.locator('.ui-multi-add-row-message').textContent();
  await inputs.nth(1).fill('Stale valid result');
  await waitForParse('Stale valid result');
  await inputs.nth(1).fill('Current invalid result');
  await resolveParse('Stale valid result');
  await page.evaluate(() => Promise.resolve());
  assert.equal(await secondRow.evaluate(row => row.classList.contains('is-invalid')), true, 'A stale parse must preserve the current validation state');
  assert.equal(await inputs.nth(1).getAttribute('aria-invalid'), 'true', 'A stale parse must preserve aria-invalid');
  assert.equal(await secondRow.locator('.ui-multi-add-row-message').textContent(), invalidMessage, 'A stale parse must preserve the validation message');
  await waitForParse('Current invalid result');
  await resolveParse('Current invalid result', { changes: { recurring_rule: 'FREQ=WEEKLY' } });

  await inputs.first().fill('x'.repeat(501));
  await page.waitForFunction(() => document.querySelector('.ui-multi-add-row')?.classList.contains('is-invalid'));
  assert.equal(await inputs.first().locator('xpath=..').locator('.ui-multi-add-preview .quick-add-chip').count(), 0, 'An overlong row must clear obsolete badges');

  await inputs.first().fill('');
  await inputs.nth(1).fill('');
  await page.waitForFunction(() => document.getElementById('todo-save-btn').hidden === true);
  assert.equal(await saveButton.isHidden(), true, 'Zero todos must hide the save action');

  await inputs.first().fill('Baseline');
  await waitForParse('Baseline');
  await resolveParse('Baseline');
  await page.waitForFunction(() => document.getElementById('todo-save-btn').disabled === false);
  await page.evaluate(() => {
    window.__multiTodoDbWrites = [];
    window.__multiTodoQueueWrites = [];
    window.__holdMultiTodoSections = true;
    window.__multiTodoSectionRequests = [];
    window.__multiTodoSaveA = window.__multiTodoFeature.save();
    window.__multiTodoSaveB = window.__multiTodoFeature.save();
  });
  await waitForParse('Baseline');
  assert.equal(await page.evaluate(() => window.__multiTodoParses.filter(request => request.raw === 'Baseline').length), 1, 'Overlapping saves must share one direct parse');
  assert.equal(await page.locator('#todo-multi-add-panel').getAttribute('inert'), '', 'Saving must lock the multi-todo inputs');
  assert.equal(await page.locator('[data-multi-add-mode="single"]').isDisabled(), true, 'Saving must lock mode switching');
  await resolveParse('Baseline');
  await page.waitForFunction(() => window.__multiTodoSectionRequests.length === 1);
  await page.evaluate(() => window.__multiTodoSectionRequests.shift()([]));
  await page.evaluate(() => Promise.all([window.__multiTodoSaveA, window.__multiTodoSaveB]));
  assert.equal(await page.evaluate(() => window.__multiTodoDbWrites.length), 1, 'Overlapping saves must persist exactly once');
  assert.equal(await page.evaluate(() => window.__multiTodoQueueWrites.length), 1, 'Overlapping saves must enqueue exactly once');
  assert.equal(await page.evaluate(() => window.__multiTodoDbWrites[0][1].title), 'Baseline', 'The persisted todo must use the title present when save started');
  assert.equal(await page.evaluate(() => window.__multiTodoQueueWrites[0][1].title), 'Baseline', 'The queued todo must use the title present when save started');

  const writesBeforeRevocation = await page.evaluate(() => ({ db: window.__multiTodoDbWrites.length, queue: window.__multiTodoQueueWrites.length }));
  await page.evaluate(() => {
    window.__holdMultiTodoSections = false;
    window.__multiTodoCommitEntered = false;
    window.__multiTodoCommitGate = new Promise(resolve => { window.__releaseMultiTodoCommit = resolve; });
    window.__revokedMultiTodoSave = window.__multiTodoFeature.save();
  });
  await waitForParse('Baseline');
  await resolveParse('Baseline');
  await page.waitForFunction(() => window.__multiTodoCommitEntered === true);
  await page.evaluate(() => {
    window.__multiTodoProjects = [];
    window.__releaseMultiTodoCommit();
  });
  await page.evaluate(() => window.__revokedMultiTodoSave);
  assert.deepEqual(
    await page.evaluate(() => ({ db: window.__multiTodoDbWrites.length, queue: window.__multiTodoQueueWrites.length })),
    writesBeforeRevocation,
    'if any prepared todo loses its project before the atomic commit, the whole batch must write neither todos nor queue entries',
  );
  assert.equal(pageErrors.length, 0, `Multi-todo state transitions must not throw: ${pageErrors.join('; ')}`);
} finally {
  await browser.close();
}

console.log('✅ Multi-todo add focused regression checks passed');
