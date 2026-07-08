#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTodoQuickAddFeature } from '../web/static/js/features/todo-quick-add.js';

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
