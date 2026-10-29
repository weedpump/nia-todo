#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ICON_PICKER } from '../web/static/js/icons/lucide-icons.js';
import { createFormSaveState } from '../web/static/js/features/form-save-state.js';
import {
  createEntityAppearanceController,
  renderEntityAppearanceFields,
} from '../web/static/js/features/entity-appearance.js';
import { renderEntityDetailHeader } from '../web/static/js/features/entity-detail-header.js';
import {
  canManageShoppingListMetadata,
  createOptimisticShoppingList,
  updateShoppingListProjection,
} from '../web/static/js/features/shopping-list-details.js';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter(candidate => candidate !== listener));
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) || []) listener({ type });
  }
}

const form = new FakeEventTarget();
const button = { hidden: false, disabled: false };
let formValue = { name: 'Weekly' };
const saveState = createFormSaveState({
  form,
  button,
  readState: () => formValue,
  isValid: value => Boolean(value.name.trim()),
});
saveState.reset();
assert.equal(button.hidden, true, 'unchanged forms must hide Save');
formValue = { name: 'Weekend' };
form.dispatch('input');
assert.equal(button.hidden, false, 'changed valid forms must show Save');
formValue = { name: '   ' };
form.dispatch('change');
assert.equal(button.disabled, true, 'invalid forms must disable Save');
saveState.destroy();

const projectAppearance = renderEntityAppearanceFields({ prefix: 'project' });
const shoppingAppearance = renderEntityAppearanceFields({ prefix: 'shopping-list' });
const normalizePrefix = html => html.replaceAll('project-', 'entity-').replaceAll('shopping-list-', 'entity-');
assert.equal(normalizePrefix(projectAppearance), normalizePrefix(shoppingAppearance), 'project and shopping must render the same appearance DOM contract');
for (const contract of ['ui-detail-title-section', 'entity-appearance-grid', 'entity.appearance.title', 'entity.appearance.hint', 'common.name', 'common.color', 'common.icon', 'entity.chooseColor', 'entity.chooseIcon']) {
  assert(projectAppearance.includes(contract), `shared appearance markup must include ${contract}`);
}
assert.equal(typeof createEntityAppearanceController, 'function');
const localizedHeader = renderEntityDetailHeader({
  icon: 'folder',
  title: { key: 'project.new' },
  subtitle: { key: 'project.modalHint' },
});
assert(localizedHeader.includes('data-i18n-key="project.new"'));
assert(!localizedHeader.includes('>undefined<'), 'shared headers must resolve localized text without hardcoded caller fallbacks');

assert.equal(canManageShoppingListMetadata({ can_manage: true }), true);
assert.equal(canManageShoppingListMetadata({ can_manage: false, can_edit: true, is_owner: true }), false, 'explicit can_manage=false must be authoritative');
assert.equal(canManageShoppingListMetadata({ can_edit: true }), false, 'content edit rights must not grant metadata management');

const optimistic = createOptimisticShoppingList({
  id: 'temp-list-1',
  name: ' Weekly ',
  color: '#10B981',
});
assert.equal(optimistic.name, 'Weekly');
assert.equal(optimistic.color, '#10b981');
assert.equal(optimistic.icon, 'shopping-cart', 'new shopping lists must default to the shopping-cart icon');
assert.equal(optimistic.can_manage, true);
assert.deepEqual(optimistic.sections, []);
assert.deepEqual(optimistic.items, []);

const existing = {
  id: 7,
  name: 'Weekly',
  color: '#6366f1',
  icon: 'shopping-cart',
  can_manage: true,
  sections: [{ id: 1 }],
  items: [{ id: 2 }],
  preferences: { hide_empty_sections: false },
};
const updated = updateShoppingListProjection(existing, { name: 'Weekend', color: '#10B981', icon: null });
assert.equal(updated.name, 'Weekend');
assert.equal(updated.color, '#10b981');
assert.equal(updated.icon, null);
assert.equal(updated.sections, existing.sections, 'metadata edits must preserve child projections');
assert.equal(updated.items, existing.items, 'metadata edits must preserve item projections');

const projectSource = read('web/static/js/features/projects.js');
const shoppingDetailsSource = read('web/static/js/features/shopping-list-details.js');
const taskDialogsSource = read('web/static/js/modules/tasks-dialogs.js');
const shoppingDialogsSource = read('web/static/js/modules/shopping-dialogs.js');
const shoppingModuleSource = read('web/static/js/modules/shopping.js');
const appSource = read('web/static/js/app.js');

assert(projectSource.includes("from './entity-appearance.js'"), 'projects must consume the shared appearance controller');
assert(projectSource.includes('createFormSaveState'), 'projects must consume the shared save-state controller');
assert(shoppingDetailsSource.includes("from './entity-appearance.js'"), 'shopping must consume the same appearance controller');
assert(shoppingDetailsSource.includes('createFormSaveState'), 'shopping must consume the same save-state controller');
assert(taskDialogsSource.includes('renderEntityAppearanceFields'), 'project markup must use the shared appearance renderer');
assert(shoppingDialogsSource.includes('renderEntityAppearanceFields'), 'shopping markup must use the shared appearance renderer');
assert(taskDialogsSource.includes('renderEntityDetailHeader'), 'project header must use the shared detail-header renderer');
assert(shoppingDialogsSource.includes('renderEntityDetailHeader'), 'shopping header must use the shared detail-header renderer');
assert(!taskDialogsSource.includes("text: 'New project'"), 'project detail headers must not hardcode an English fallback');
assert(!taskDialogsSource.includes('Strukturiere Todos mit Farbe'), 'project detail headers must not hardcode a German fallback');
assert(!taskDialogsSource.includes('aria-label="Close"'), 'project detail actions must not hardcode an English close label');
assert(shoppingModuleSource.includes('SHOPPING_DIALOGS_HTML'), 'shopping dialogs must be owned by the shopping module');
assert(appSource.includes('createShoppingListDetailsFeature'), 'the app must wire the shopping details feature');
assert(appSource.includes('commitShoppingReplay: appStorage.commitShoppingReplay'), 'the real sync feature must commit shopping replays atomically');
assert(shoppingDetailsSource.includes('commitMutation'), 'shopping metadata changes must use the atomic mutation boundary');
assert(shoppingDetailsSource.includes('canManageShoppingListMetadata'), 'shopping submit must recheck metadata authority');

const appearancePython = read('api/services/appearance.py');
const allowlistBlock = appearancePython.match(/VALID_ICON_NAMES\s*=\s*\{([\s\S]*?)\n\}/)?.[1] || '';
const backendIcons = new Set([...allowlistBlock.matchAll(/["']([^"']+)["']/g)].map(match => match[1]));
assert.equal(backendIcons.size, new Set(ICON_PICKER).size, 'backend and frontend icon catalogs must have identical breadth');
for (const icon of ICON_PICKER) assert(backendIcons.has(icon), `backend icon catalog must accept ${icon}`);

const requiredKeys = [
  'common.icon',
  'entity.appearance.title',
  'entity.appearance.hint',
  'entity.chooseColor',
  'entity.chooseIcon',
  'entity.namePlaceholder',
  'shopping.list.modal.createTitle',
  'shopping.list.modal.editTitle',
  'shopping.list.modal.subtitle',
  'shopping.list.error.invalidName',
  'shopping.list.error.saveFailed',
];
for (const locale of ['cs', 'de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'zh-CN']) {
  const dictionary = JSON.parse(read(`web/static/i18n/${locale}.json`));
  for (const key of requiredKeys) {
    assert.equal(typeof dictionary[key], 'string', `${locale} must contain ${key}`);
    assert(dictionary[key].trim(), `${locale} ${key} must not be empty`);
  }
}

console.log('✅ Shared entity appearance, shopping metadata roles, offline projection, icon catalog, and i18n contracts passed');
