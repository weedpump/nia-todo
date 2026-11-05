#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTodoQuickAddFeature } from '../web/static/js/features/todo-quick-add.js';
import { chromium } from 'playwright';

const dictionaries = {
  en: JSON.parse(await readFile(new URL('../web/static/i18n/en.json', import.meta.url), 'utf8')),
  de: JSON.parse(await readFile(new URL('../web/static/i18n/de.json', import.meta.url), 'utf8')),
};

let activeLanguage = 'en';

const projects = [
  { id: 10, name: 'Quick Shopping' },
  { id: 20, name: 'Active Context' },
];

const sections = [
  { id: 101, project_id: 10, name: 'Cold Goods' },
  { id: 201, project_id: 20, name: 'Active Section' },
];

function t(key) {
  return dictionaries[activeLanguage][key] || key;
}

const quickAdd = createTodoQuickAddFeature({
  getActiveLanguage: () => activeLanguage,
  t,
  getProjects: () => projects,
  getCurrentProjectId: () => 20,
  dbGetAll: async (store) => store === 'sections' ? sections : [],
});

function assertMatchTypes(result, expectedTypes) {
  for (const type of expectedTypes) {
    assert.ok(result.matches.some(match => match.type === type), `expected quick-add match type: ${type}`);
  }
}

function assertHour(value, hour, minute) {
  const date = new Date(value);
  assert.equal(date.getHours(), hour);
  assert.equal(date.getMinutes(), minute);
}

console.log('⚡ Running quick-add parser test...');

activeLanguage = 'en';
let result = await quickAdd.parseQuickAddTitle('Buy milk tomorrow 18:00 remind:17:30 #Quick Shopping /Cold Goods !high', 20, null);
assert.equal(result.title, 'Buy milk');
assert.equal(result.changes.project_id, 10);
assert.equal(result.changes.section_id, 101);
assert.equal(result.changes.priority, 2);
assert.ok(result.changes.due_date);
assert.ok(result.changes.remind_at);
assertHour(result.changes.due_date, 18, 0);
assertHour(result.changes.remind_at, 17, 30);
assertMatchTypes(result, ['due', 'reminder', 'project', 'section', 'priority']);

activeLanguage = 'de';
result = await quickAdd.parseQuickAddTitle('Deutsch morgen 19 Uhr erinnerung: 17:30 #Quick Shopping /Cold Goods !hoch', 20, null);
assert.equal(result.title, 'Deutsch');
assert.equal(result.changes.project_id, 10);
assert.equal(result.changes.section_id, 101);
assert.equal(result.changes.priority, 2);
assertHour(result.changes.due_date, 19, 0);
assertHour(result.changes.remind_at, 17, 30);
assertMatchTypes(result, ['due', 'reminder', 'project', 'section', 'priority']);

result = await quickAdd.parseQuickAddTitle('Project only #Quick Shopping', 20, 201);
assert.equal(result.title, 'Project only');
assert.equal(result.changes.project_id, 10);
assert.equal(result.changes.section_id, undefined);
assertMatchTypes(result, ['project']);

result = await quickAdd.parseQuickAddTitle('Reminder only erinnerung: morgen 17:30', 20, null);
assert.equal(result.title, 'Reminder only');
assert.equal(result.changes.due_date, undefined);
assert.ok(result.changes.remind_at);
assertHour(result.changes.remind_at, 17, 30);
assertMatchTypes(result, ['reminder']);

activeLanguage = 'en';
result = await quickAdd.parseQuickAddTitle('Plan next week', 20, null);
assert.equal(result.title, 'Plan');
assert.ok(result.changes.due_date);
assertMatchTypes(result, ['due']);

console.log('✅ Quick-add parser test passed');

for (const consumer of ['todo-quick-add.js', 'multi-add.js', 'shopping-item-editor.js']) {
  const source = await readFile(new URL(`../web/static/js/features/${consumer}`, import.meta.url), 'utf8');
  assert.match(source, /from '\.\/quick-add\.js'/, `${consumer} must consume the neutral primitive`);
  assert.doesNotMatch(source, /chip\.className\s*=\s*.*quick-add-chip/, `${consumer} must not retain a second chip renderer`);
}

const fixture = `
  import { initI18n, getActiveLanguage, t, setLanguagePreference } from '/static/js/i18n/index.js';
  import { TASK_DIALOGS_HTML } from '/static/js/modules/tasks-dialogs.js';
  import { SHOPPING_DIALOGS_HTML } from '/static/js/modules/shopping-dialogs.js';
  import { createTodoQuickAddFeature } from '/static/js/features/todo-quick-add.js';
  import { renderQuickAddPreview } from '/static/js/features/quick-add.js';
  localStorage.setItem('nia-todo-language', 'en');
  await initI18n();
  document.body.innerHTML = TASK_DIALOGS_HTML + SHOPPING_DIALOGS_HTML;
  const taskModal = document.getElementById('todo-modal');
  taskModal.classList.add('active', 'todo-detail-view', 'todo-create-view');
  document.getElementById('todo-project').innerHTML = '<option value="10">Quick Shopping</option>';
  window.pendingSections = [];
  window.holdSections = false;
  const feature = createTodoQuickAddFeature({
    getActiveLanguage, t,
    getProjects: () => [{ id: 10, name: 'Quick Shopping' }],
    getCurrentProjectId: () => 10,
    dbGetAll: () => window.holdSections ? new Promise(resolve => window.pendingSections.push(resolve)) : Promise.resolve([{ id: 101, project_id: 10, name: 'Cold Goods' }]),
  });
  feature.bindQuickAddPreview();
  window.test = {
    feature, setLanguagePreference,
    renderShopping: () => {
      taskModal.classList.remove('active');
      document.getElementById('shopping-item-modal').classList.add('active');
      renderQuickAddPreview(document.getElementById('shopping-item-quick-add-preview'), {
        matches: [{ type: 'section', label: 'Section', value: 'Cold Goods' }],
      }, t);
    },
  };
`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://quick-add.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/static/style.css"></head><body><script type="module" src="/fixture.js"></script></body></html>' });
    if (pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: fixture });
    if (pathname.startsWith('/static/')) {
      try {
        const body = await readFile(new URL(`../web${pathname}`, import.meta.url), 'utf8');
        return route.fulfill({ contentType: pathname.endsWith('.json') ? 'application/json' : pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body });
      } catch { return route.fulfill({ status: 404, body: 'Missing fixture asset: ' + pathname }); }
    }
    return route.fulfill({ status: 404, body: 'Unexpected request: ' + pathname });
  });
  await page.goto('http://quick-add.test/');
  await page.waitForFunction(() => Boolean(window.test));
  const title = page.locator('#todo-title');
  await title.fill('Milk');
  await page.waitForFunction(() => document.getElementById('quick-add-preview').hidden);
  await title.evaluate(input => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = 'Milk #Quick Shopping /Cold Goods !high';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '!high', isComposing: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('#quick-add-preview .quick-add-chip').length === 3);
  assert.equal(await title.inputValue(), 'Milk #Quick Shopping /Cold Goods !high', 'Tasks shares live read-only composition previews');
  await title.evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  assert.deepEqual(await page.locator('#quick-add-preview strong').allTextContents(), ['High', 'Quick Shopping', 'Cold Goods']);
  await page.evaluate(() => window.test.setLanguagePreference('de'));
  await title.fill('Milch #Quick Shopping /Cold Goods !hoch');
  await page.waitForFunction(() => document.querySelector('#quick-add-preview .priority strong')?.textContent === 'Hoch');
  await page.evaluate(() => { window.holdSections = true; });
  await title.fill('Old morgen');
  await page.waitForFunction(() => window.pendingSections.length === 1);
  await page.evaluate(() => {
    const modal = document.getElementById('todo-modal');
    modal.classList.remove('active');
    window.holdSections = false;
    document.getElementById('todo-title').value = 'New plain';
    window.test.feature.bindQuickAddPreview();
    modal.classList.add('active');
    document.getElementById('todo-title').dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.getElementById('quick-add-preview').hidden);
  await page.evaluate(() => { for (const resolve of window.pendingSections.splice(0)) resolve([]); });
  assert.equal(await page.locator('#quick-add-preview').isHidden(), true, 'closed/reopened Tasks must reject stale parse results');
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => {
      document.getElementById('shopping-item-modal').classList.remove('active');
      document.getElementById('todo-modal').classList.add('active');
    });
    await title.fill('Milk /Cold Goods');
    await page.waitForFunction(() => document.querySelector('#quick-add-preview .section strong')?.textContent === 'Cold Goods');
    const geometry = selector => page.locator(selector).evaluate(element => {
      const style = getComputedStyle(element);
      return Object.fromEntries(['padding', 'borderRadius', 'fontSize', 'lineHeight', 'gap', 'backgroundColor'].map(key => [key, style[key]]));
    });
    const taskGeometry = await geometry('#quick-add-preview .section');
    await page.evaluate(() => window.test.renderShopping());
    assert.deepEqual(await geometry('#shopping-item-quick-add-preview .section'), taskGeometry, `shared Quick Add chip geometry at ${width}px`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Quick Add must fit ${width}px`);
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
console.log('✅ Shared Quick Add production consumers, Tasks lifecycle and desktop/mobile style parity passed');
