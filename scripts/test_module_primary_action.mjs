#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderModulePrimaryAction } from '../web/static/js/ui/module-primary-action.js';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

const todoMarkup = renderModulePrimaryAction({
  actionAttribute: 'data-todo-action',
  action: 'new',
  ariaLabel: 'Create new todo',
  ariaLabelKey: 'todo.create',
  title: 'New todo',
  titleKey: 'todo.new',
});
const shoppingMarkup = renderModulePrimaryAction({
  actionAttribute: 'data-shopping-action',
  action: 'add-item',
  ariaLabel: 'Add item',
  ariaLabelKey: 'shopping.item.add',
  title: 'New item',
  titleKey: 'shopping.item.new',
});

for (const markup of [todoMarkup, shoppingMarkup]) {
  assert.match(markup, /<button class="ui-module-primary-action" type="button"/);
  assert.match(markup, /<span aria-hidden="true">\+<\/span>/);
  assert.doesNotMatch(markup, /fab-add-todo|todo-primary-action/);
}
assert.match(todoMarkup, /data-todo-action="new"/);
assert.match(todoMarkup, /aria-label="Create new todo" data-i18n-aria-label-key="todo\.create"/);
assert.match(todoMarkup, /title="New todo" data-i18n-title-key="todo\.new"/);
assert.match(shoppingMarkup, /data-shopping-action="add-item"/);
assert.throws(
  () => renderModulePrimaryAction({
    actionAttribute: 'onclick',
    action: 'unsafe',
    ariaLabel: 'Unsafe',
    ariaLabelKey: 'unsafe.label',
    title: 'Unsafe',
    titleKey: 'unsafe.title',
  }),
  /data attribute/,
);

const tasksSource = read('web/static/js/modules/tasks.js');
assert.match(tasksSource, /import \{ renderModulePrimaryAction \} from '\.\.\/ui\/module-primary-action\.js';/);
assert.match(tasksSource, /slots\.floating\.innerHTML = renderModulePrimaryAction\(\{/);
assert.doesNotMatch(tasksSource, /class="fab-add-todo"/);

const cssPaths = [
  'web/static/css/11-main-shell.css',
  'web/static/css/81-todo-cards-refresh.css',
  'web/static/css/40-responsive-mobile.css',
];
const cssSources = cssPaths.map(path => [path, read(path)]);
for (const [path, css] of cssSources) {
  assert.doesNotMatch(css, /\.fab-add-todo\b/, `${path} must not retain Todo-owned FAB visual authority`);
}

const shellCss = cssSources[0][1];
assert.match(shellCss, /\.ui-module-primary-action\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?right:\s*calc\(28px \+ env\(safe-area-inset-right, 0px\)\);[\s\S]*?bottom:\s*calc\(28px \+ env\(safe-area-inset-bottom, 0px\)\);[\s\S]*?width:\s*62px;[\s\S]*?height:\s*62px;[\s\S]*?\}/);
assert.match(shellCss, /\.ui-module-primary-action:hover\s*\{[\s\S]*?translateY\(-2px\) scale\(1\.03\);[\s\S]*?\}/);
assert.match(shellCss, /\.ui-module-primary-action:active\s*\{[\s\S]*?translateY\(0\) scale\(0\.98\);[\s\S]*?\}/);

const responsiveCss = cssSources[2][1];
assert.match(responsiveCss, /\.ui-module-primary-action\s*\{[\s\S]*?right:\s*calc\(18px \+ env\(safe-area-inset-right, 0px\)\);[\s\S]*?bottom:\s*calc\(18px \+ env\(safe-area-inset-bottom, 0px\)\);[\s\S]*?width:\s*56px;[\s\S]*?height:\s*56px;[\s\S]*?\}/);
const todoRefreshCss = cssSources[1][1];
assert.match(todoRefreshCss, /\.ui-module-primary-action\s*\{[\s\S]*?right:\s*calc\(22px \+ env\(safe-area-inset-right, 0px\)\);[\s\S]*?bottom:\s*calc\(22px \+ env\(safe-area-inset-bottom, 0px\)\);[\s\S]*?\}/);

for (const property of ['width: 62px', 'height: 62px', 'box-shadow: 0 12px 28px']) {
  const occurrences = cssSources.reduce((count, [, css]) => count + css.split(property).length - 1, 0);
  assert.equal(occurrences, 1, `base FAB geometry must have one neutral authority for ${property}`);
}

console.log('✅ Shared module primary action markup and neutral FAB CSS authority passed');
