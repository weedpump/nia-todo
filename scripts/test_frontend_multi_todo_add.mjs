#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const modulePath = path.join(root, 'web/static/js/features/todo-multi-add.js');
const stylesheetPath = path.join(root, 'web/static/css/96-todo-multi-add.css');
const indexPath = path.join(root, 'web/index.html');
const iconsPath = path.join(root, 'web/static/js/icons/lucide-generated.js');
const moduleUrl = pathToFileURL(modulePath);
moduleUrl.searchParams.set('test', String(Date.now()));
const feature = await import(moduleUrl.href);
const stylesheet = await readFile(stylesheetPath, 'utf8');
const indexSource = await readFile(indexPath, 'utf8');
const iconsSource = await readFile(iconsPath, 'utf8');

assert.match(indexSource, /todo-multi-add-intro-heading ui-section-heading ui-detail-section-heading[\s\S]*todo-multi-add-intro-icon ui-section-icon ui-detail-section-icon[^>]*data-icon="lightbulb"[\s\S]*todo\.multiAdd\.introTitle/, 'the quick-capture heading must reuse the canonical todo section heading and icon');
assert.match(indexSource, /todo-multi-add-defaults-head ui-section-heading ui-detail-section-heading[\s\S]*todo-multi-add-defaults-icon ui-section-icon ui-detail-section-icon[^>]*data-icon="sliders-horizontal"[\s\S]*todo\.multiAdd\.defaultsTitle/, 'the shared-defaults heading must reuse the canonical todo section heading and icon');
assert.match(iconsSource, /"lightbulb":/, 'the quick-capture section icon must exist in the local Lucide bundle');
assert.match(stylesheet, /#todo-modal\.todo-detail-view \.todo-multi-add-panel \.ui-detail-section-heading p\s*\{[^}]*display:\s*block;/s, 'multi-todo section subtitles must remain visible despite the compact todo-detail heading rule');
assert.match(stylesheet, /\.todo-multi-add-defaults\s*\{[^}]*padding:\s*0;/s, 'the shared-defaults heading must align with the quick-capture and canonical todo section heading');

assert.match(stylesheet, /\.todo-create-mode-switch\s*\{[^}]*border:\s*0;/s, 'the single/multiple todo mode switch must not have an outer border');
assert.match(stylesheet, /\.todo-multi-add-editor\s*\{[^}]*border:\s*0;/s, 'the multi-todo entry area must not have an outer border');
assert.match(stylesheet, /\.todo-multi-add-editor\s*\{[^}]*background:\s*transparent;/s, 'the multi-todo entry area must not have a container background');
assert.match(stylesheet, /\.todo-multi-add-editor\s*\{[^}]*box-shadow:\s*none;/s, 'the multi-todo entry area must not retain the rounded inset top line');
assert.match(stylesheet, /\.todo-multi-add-toolbar\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s, 'the inner multi-todo editor toolbar must not have a border or container background');
assert.match(stylesheet, /\.todo-multi-add-defaults\s*\{[^}]*position:\s*relative;[^}]*margin-top:\s*20px;[^}]*border:\s*0;/s, 'the shared defaults area must remain borderless and reserve space for the canonical section separator');
assert.match(stylesheet, /\.todo-multi-add-defaults\s*\{[^}]*background:\s*transparent;/s, 'the shared defaults area must not have a container background');
assert.match(stylesheet, /\.todo-multi-add-defaults::before\s*\{[^}]*top:\s*-20px;[^}]*border-top:\s*1px\s+solid\s+color-mix\(in srgb, var\(--border\) 44%, transparent\);/s, 'the shared defaults area must use the canonical detail-modal separator in the gap');

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

console.log('✅ Multi-todo add focused regression checks passed');
