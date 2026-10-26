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

assert.match(taskDialogsSource, /todo-multi-add-intro-heading ui-section-heading ui-detail-section-heading[\s\S]*todo-multi-add-intro-icon ui-section-icon ui-detail-section-icon[^>]*data-icon="lightbulb"[\s\S]*todo\.multiAdd\.introTitle/, 'the quick-capture heading must reuse the canonical todo section heading and icon');
assert.match(taskDialogsSource, /todo-multi-add-defaults-head ui-section-heading ui-detail-section-heading[\s\S]*todo-multi-add-defaults-icon ui-section-icon ui-detail-section-icon[^>]*data-icon="sliders-horizontal"[\s\S]*todo\.multiAdd\.defaultsTitle/, 'the shared-defaults heading must reuse the canonical todo section heading and icon');
assert.match(iconsSource, /"lightbulb":/, 'the quick-capture section icon must exist in the local Lucide bundle');
assert.match(stylesheet, /#todo-modal\.todo-detail-view \.todo-multi-add-panel \.ui-detail-section-heading p\s*\{[^}]*display:\s*block;/s, 'multi-todo section subtitles must remain visible despite the compact todo-detail heading rule');
assert.match(taskDialogsSource, /todo-multi-add-defaults ui-section-divider/, 'the shared defaults area must use the global section divider');

assert.match(stylesheet, /\.todo-create-mode-switch\s*\{[^}]*border:\s*0;/s, 'the single/multiple todo mode switch must not have an outer border');
assert.match(stylesheet, /\.todo-multi-add-editor\s*\{[^}]*border:\s*0;/s, 'the multi-todo entry area must not have an outer border');
assert.match(stylesheet, /\.todo-multi-add-editor\s*\{[^}]*background:\s*transparent;/s, 'the multi-todo entry area must not have a container background');
assert.match(stylesheet, /\.todo-multi-add-editor\s*\{[^}]*box-shadow:\s*none;/s, 'the multi-todo entry area must not retain the rounded inset top line');
assert.match(stylesheet, /\.todo-multi-add-toolbar\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s, 'the inner multi-todo editor toolbar must not have a border or container background');
assert.doesNotMatch(stylesheet, /\.todo-multi-add-defaults::before/, 'the shared defaults area must not retain the old separator before the global divider');
assert.match(stylesheet, /\.todo-multi-add-panel\s*\{[^}]*gap:\s*0;/s, 'the global divider must not accumulate the old panel grid gap');

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
  inputLabel: 'todo.multiAdd.rowLabel:2',
  removeLabel: 'todo.multiAdd.removeRow:2',
});

assert.equal(feature.shouldOpenCreateTodoMetaDrawer({ matches: false }), true);
assert.equal(feature.shouldOpenCreateTodoMetaDrawer({ matches: true }), false);
assert.equal(feature.shouldOpenCreateTodoMetaDrawer(null), true);

const source = await readFile(modulePath, 'utf8');
assert.match(source, /syncMultiAddNativeValidation\(multi\)/, 'Mode switching must apply native validation state');
assert.match(source, /getMultiTodoValidationKey\(todoData\)/, 'Save must validate each parsed todo before persistence');
assert.match(source, /splitMultiTodoPaste\(text, availableRows\)/, 'Paste handling must use the bounded split result');
assert.match(source, /getMultiTodoRowA11y\(/, 'Rendered rows must use accessible row metadata');
assert.match(source, /shouldOpenCreateTodoMetaDrawer\(/, 'Single mode must restore the canonical drawer rule');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('http://multi-todo.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/todo-multi-add.js') {
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: source });
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
          <div id="todo-create-mode-switch">
            <button type="button" data-todo-create-mode="single">Single</button>
            <button type="button" data-todo-create-mode="multi">Multiple</button>
          </div>
          <div id="todo-multi-add-panel" hidden>
            <div id="todo-multi-add-rows"></div>
            <div class="todo-multi-add-toolbar">
              <span class="todo-multi-add-toolbar-hint">Quick Add works per line</span>
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
        <script type="module">
          import { createTodoMultiAddFeature } from '/todo-multi-add.js';
          const feature = createTodoMultiAddFeature({
            t: (key, params = {}) => key.startsWith('todo.multiAdd.create.') ? 'Save ' + params.count : key,
            getTodos: () => [],
            setTodos: () => {},
            getCurrentProjectId: () => 1,
            getAppInitialized: () => true,
            getDb: () => ({}),
            dbPut: async (...args) => window.__multiTodoDbWrites.push(args),
            addToSyncQueue: async (...args) => window.__multiTodoQueueWrites.push(args),
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

  await page.click('[data-todo-create-mode="multi"]');
  assert.equal(pageErrors.length, 0, `Opening multi-todo mode must not throw: ${pageErrors.join('; ')}`);

  const inputs = page.locator('.todo-multi-add-input');
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
  await page.locator('.todo-multi-add-preview .quick-add-chip').waitFor();
  assert.equal(await inputs.first().locator('xpath=..').locator('.todo-multi-add-preview .quick-add-chip').count(), 1, 'Recognized quick syntax must render a badge');
  const toolbarTopBeforeEdit = await page.locator('.todo-multi-add-toolbar').evaluate(element => element.getBoundingClientRect().top);
  await inputs.first().fill('Old morgen');
  await waitForParse('Old morgen');
  await inputs.first().fill('New plain');
  await resolveParse('Old morgen', {
    matches: [{ type: 'due', label: 'Due', value: 'Stale' }],
  });
  await page.evaluate(() => Promise.resolve());
  assert.equal(await inputs.first().locator('xpath=..').locator('.todo-multi-add-preview .quick-add-chip').count(), 1, 'The previous badges must remain visible while the replacement parse is pending');
  assert.equal(await inputs.first().locator('xpath=..').locator('.todo-multi-add-preview strong').textContent(), 'Tomorrow', 'A stale parse result must never replace the current badges');
  const toolbarTopDuringParse = await page.locator('.todo-multi-add-toolbar').evaluate(element => element.getBoundingClientRect().top);
  assert.equal(toolbarTopDuringParse, toolbarTopBeforeEdit, 'The Quick Add hint must not jump while badges are reparsed');
  assert.equal(await page.locator('.todo-multi-add-toolbar-hint').count(), 1, 'The shared Quick Add hint must remain a single stable element');
  await waitForParse('New plain');
  await resolveParse('New plain');
  await page.waitForFunction(() => document.querySelectorAll('.todo-multi-add-preview .quick-add-chip').length === 0);
  assert.equal(await inputs.first().locator('xpath=..').locator('.todo-multi-add-preview .quick-add-chip').count(), 0, 'The completed parse must replace obsolete badges');

  await inputs.nth(1).fill('Recurring todo');
  await waitForParse('Recurring todo');
  await resolveParse('Recurring todo', { changes: { recurring_rule: 'FREQ=WEEKLY' } });
  await page.waitForFunction(() => document.querySelectorAll('.todo-multi-add-row')[1]?.classList.contains('is-invalid'));
  assert.equal(await saveButton.isDisabled(), true, 'A known invalid row must disable the save action');
  const secondRow = page.locator('.todo-multi-add-row').nth(1);
  assert.equal(await secondRow.evaluate(row => row.classList.contains('is-invalid')), true, 'The parsed validation error must mark its row invalid');
  const invalidMessage = await secondRow.locator('.todo-multi-add-row-message').textContent();
  await inputs.nth(1).fill('Stale valid result');
  await waitForParse('Stale valid result');
  await inputs.nth(1).fill('Current invalid result');
  await resolveParse('Stale valid result');
  await page.evaluate(() => Promise.resolve());
  assert.equal(await secondRow.evaluate(row => row.classList.contains('is-invalid')), true, 'A stale parse must preserve the current validation state');
  assert.equal(await inputs.nth(1).getAttribute('aria-invalid'), 'true', 'A stale parse must preserve aria-invalid');
  assert.equal(await secondRow.locator('.todo-multi-add-row-message').textContent(), invalidMessage, 'A stale parse must preserve the validation message');
  await waitForParse('Current invalid result');
  await resolveParse('Current invalid result', { changes: { recurring_rule: 'FREQ=WEEKLY' } });

  await inputs.first().fill('x'.repeat(501));
  await page.waitForFunction(() => document.querySelector('.todo-multi-add-row')?.classList.contains('is-invalid'));
  assert.equal(await inputs.first().locator('xpath=..').locator('.todo-multi-add-preview .quick-add-chip').count(), 0, 'An overlong row must clear obsolete badges');

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
  assert.equal(await page.locator('[data-todo-create-mode="single"]').isDisabled(), true, 'Saving must lock mode switching');
  await resolveParse('Baseline');
  await page.waitForFunction(() => window.__multiTodoSectionRequests.length === 1);
  await page.evaluate(() => window.__multiTodoSectionRequests.shift()([]));
  await page.evaluate(() => Promise.all([window.__multiTodoSaveA, window.__multiTodoSaveB]));
  assert.equal(await page.evaluate(() => window.__multiTodoDbWrites.length), 1, 'Overlapping saves must persist exactly once');
  assert.equal(await page.evaluate(() => window.__multiTodoQueueWrites.length), 1, 'Overlapping saves must enqueue exactly once');
  assert.equal(await page.evaluate(() => window.__multiTodoDbWrites[0][1].title), 'Baseline', 'The persisted todo must use the title present when save started');
  assert.equal(await page.evaluate(() => window.__multiTodoQueueWrites[0][1].title), 'Baseline', 'The queued todo must use the title present when save started');
  assert.equal(pageErrors.length, 0, `Multi-todo state transitions must not throw: ${pageErrors.join('; ')}`);
} finally {
  await browser.close();
}

console.log('✅ Multi-todo add focused regression checks passed');
