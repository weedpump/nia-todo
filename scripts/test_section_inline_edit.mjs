#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const fixtureSource = `
  import { createSectionController, createSectionRootRegistry, renderSectionCollection } from '/static/js/features/section-ui.js';
  import { createShoppingSectionsAdapter } from '/static/js/features/shopping-sections.js';
  import { createSectionActionsFeature } from '/static/js/features/section-actions.js';

  const taskRoot = document.querySelector('#todo-list');
  const shoppingRoot = document.querySelector('#shopping-root');
  let sections = [{ id: 101, project_id: 1, name: 'Produce', sort_order: 0 }];
  let lists = [{ id: 7, can_edit: true, sections: [{ id: 101, shopping_list_id: 7, name: 'Produce', sort_order: 0 }], items: [] }];
  const mutations = { tasks: [], shopping: [] };
  const errors = { tasks: 0, shopping: 0 };
  let failing = null;
  let lastShoppingHtml = null;
  const registry = createSectionRootRegistry();
  const html = values => renderSectionCollection({
    sections: values, items: [], canManage: true, showUnsorted: false,
    newLabel: 'Add section', deleteLabel: 'Delete section',
  });
  function renderTasks() { taskRoot.innerHTML = html(sections); }
  function renderShopping() {
    const nextHtml = html(lists[0].sections);
    // Shopping navigation intentionally preserves the body when its data did
    // not change. Inline forms belong to the shared controller, not this key.
    if (nextHtml !== lastShoppingHtml) shoppingRoot.innerHTML = nextHtml;
    lastShoppingHtml = nextHtml;
  }
  const taskActions = createSectionActionsFeature({
    getTodos: () => [], setTodos: () => {},
    getProjects: () => [{ id: 1 }],
    getSections: () => sections, setSections: next => { sections = next; },
    getCurrentProjectId: () => 1,
    dbPut: async () => {}, dbGetAll: async () => [], deleteFromDB: async () => {},
    addToSyncQueue: async (action, data) => mutations.tasks.push({ action, data }),
    runSyncQueueMutation: async operation => {
      if (failing === 'tasks') throw new Error('Simulated local persistence failure');
      return operation(async (action, data) => mutations.tasks.push({ action, data }));
    },
    isOnlineForSync: () => false, syncWithServer: async () => {},
    renderTodos: renderTasks, renderProjects: () => {}, confirmDanger: async () => false,
    sectionsFeature: {}, sectionRegistry: registry,
  });
  taskActions.adapter.onError = () => { errors.tasks += 1; };
  const shoppingAdapter = createShoppingSectionsAdapter({
    getLists: () => lists, setLists: next => { lists = next; },
    getActiveListId: () => 7, getRoot: () => shoppingRoot,
    commitMutation: async build => {
      if (failing === 'shopping') throw new Error('Simulated local persistence failure');
      const mutation = build();
      if (mutation) mutations.shopping.push(mutation);
      return mutation;
    },
    render: renderShopping, onError: () => { errors.shopping += 1; },
  });
  renderTasks(); renderShopping();
  registry.register(taskRoot, taskActions.adapter);
  registry.register(shoppingRoot, shoppingAdapter);
  createSectionController({
    registry, root: document,
    labels: { save: 'Save', cancel: 'Cancel', namePlaceholder: 'Section name' },
  }).bind();
  window.test = {
    mutationCount: module => mutations[module].length,
    errorCount: module => errors[module],
    setFailure: module => { failing = module; },
    name: module => (module === 'tasks' ? sections : lists[0].sections).find(section => section.id === 101).name,
    names: module => (module === 'tasks' ? sections : lists[0].sections).map(section => section.name),
  };
`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.setDefaultTimeout(5000);
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error?.stack || error)));

try {
  await page.route('http://nia.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <html><head><link rel="stylesheet" href="/static/style.css"></head><body>
        <main style="padding:40px"><div id="todo-list" data-section-root="tasks"></div>
        <div id="shopping-root" data-section-root="shopping"></div></main>
        <script type="module" src="/fixture.js"></script></body></html>` });
    } else if (pathname === '/fixture.js') {
      await route.fulfill({ contentType: 'text/javascript', body: fixtureSource });
    } else if (pathname.startsWith('/static/')) {
      try {
        await route.fulfill({
          contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: readFileSync(new URL(`../web${pathname}`, import.meta.url), 'utf8'),
        });
      } catch {
        await route.fulfill({ status: 404, body: 'Missing fixture asset' });
      }
    } else await route.fulfill({ status: 404, body: 'Unexpected fixture request' });
  });
  await page.goto('http://nia.test/');
  await page.waitForFunction(() => Boolean(window.test));

  for (const module of ['shopping', 'tasks']) {
    const root = page.locator(module === 'shopping' ? '#shopping-root' : '#todo-list');
    const header = root.locator('.section-header[data-section-id="101"]');
    const input = header.locator('[data-section-input="edit"]');
    const mutationCount = () => page.evaluate(module => window.test.mutationCount(module), module);
    const name = () => page.evaluate(module => window.test.name(module), module);
    const open = async () => {
      await header.locator('[data-section-action="edit"]').click();
      assert.equal(await input.inputValue(), await name());
    };
    const assertClosed = async () => {
      await input.waitFor({ state: 'detached' });
      assert.equal(await header.locator('.section-name').textContent(), await name());
    };
    let before = await mutationCount();
    for (const draft of [null, 'Discarded draft']) {
      await open();
      if (draft) await input.fill(draft);
      await header.locator('[data-section-action="cancel"]').click();
      await assertClosed();
      assert.equal(await mutationCount(), before, `${module}: Cancel must not write, even with a changed draft`);
    }
    for (const key of ['click', 'Enter']) {
      await open();
      if (key === 'click') await header.locator('[data-section-action="save-edit"]').click();
      else await input.press(key);
      await assertClosed();
      assert.equal(await mutationCount(), before, `${module}: unchanged Save/${key} closes without a queued mutation`);
    }
    await open();
    await input.fill('  Produce  ');
    await header.locator('[data-section-action="save-edit"]').click();
    await assertClosed();
    assert.equal(await mutationCount(), before, `${module}: whitespace-normalized no-op must not write`);

    for (const key of ['click', 'Enter']) {
      const updatedName = `Updated ${module} ${key}`;
      await open();
      await input.fill(updatedName);
      if (key === 'click') await header.locator('[data-section-action="save-edit"]').click();
      else await input.press(key);
      await assertClosed();
      assert.equal(await name(), updatedName);
      assert.equal(await mutationCount(), ++before, `${module}: changed Save/${key} persists exactly once`);
    }
    await open();
    await input.fill('Escape draft');
    await input.press('Escape');
    await assertClosed();
    assert.equal(await mutationCount(), before, `${module}: Escape discards only the draft`);

    await open();
    await input.fill('');
    await input.press('Enter');
    assert.equal(await input.count(), 1, `${module}: empty titles must keep the editor open`);
    assert.equal(await mutationCount(), before);
    await input.press('Escape');
    await assertClosed();

    await open();
    const failedDraft = '  Preserve failed draft  ';
    await input.fill(failedDraft);
    await input.evaluate(element => { window.failedEditInput = element; });
    await page.evaluate(module => window.test.setFailure(module), module);
    await header.locator('[data-section-action="save-edit"]').click();
    await page.waitForFunction(module => window.test.errorCount(module) === 1, module);
    assert.equal(await input.inputValue(), failedDraft, `${module}: failed saves must preserve the exact draft`);
    assert.equal(await input.evaluate(element => element === window.failedEditInput && element === document.activeElement), true, `${module}: failure must retain the input and focus for retry`);
    assert.equal(await mutationCount(), before);
    await page.evaluate(() => window.test.setFailure(null));
    await input.press('Enter');
    await assertClosed();
    assert.equal(await name(), failedDraft.trim());
    assert.equal(await mutationCount(), ++before);

    for (const action of ['cancel', 'Escape']) {
      await root.locator('[data-section-action="show-add"]').click();
      const newInput = root.locator('[data-section-input="new"]');
      await newInput.fill('Discarded new section');
      if (action === 'cancel') await root.locator('.add-section-row [data-section-action="cancel"]').click();
      else await newInput.press('Escape');
      await newInput.waitFor({ state: 'detached' });
      assert.equal(await mutationCount(), before, `${module}: canceling a new section must not write`);
    }
    await root.locator('[data-section-action="show-add"]').click();
    const newInput = root.locator('[data-section-input="new"]');
    await newInput.fill('New section survives errors');
    await page.evaluate(module => window.test.setFailure(module), module);
    await newInput.press('Enter');
    await page.waitForFunction(module => window.test.errorCount(module) === 2, module);
    assert.equal(await newInput.inputValue(), 'New section survives errors');
    assert.equal(await newInput.evaluate(element => element === document.activeElement), true);
    assert.equal(await mutationCount(), before);
    await page.evaluate(() => window.test.setFailure(null));
    await newInput.press('Enter');
    await newInput.waitFor({ state: 'detached' });
    assert.equal(await mutationCount(), ++before, `${module}: retrying section creation persists once`);
    assert.ok((await page.evaluate(module => window.test.names(module), module)).includes('New section survives errors'));
  }

  assert.deepEqual(pageErrors, []);
  console.log('✅ Shared Shopping/Tasks inline section Save, Cancel, keyboard, no-op and failed-draft contracts passed');
} finally {
  await browser.close();
}
