#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCompletedVisibilityFeature } from '../web/static/js/features/completed-visibility.js';

function createButton(moduleId) {
  const classes = new Set();
  const attributes = new Map();
  const label = { textContent: '' };
  return {
    dataset: {
      completedVisibilityToggle: moduleId,
      completedShowKey: moduleId === 'shopping' ? 'shopping.preferences.showPurchased' : 'menu.showDone',
      completedHideKey: moduleId === 'shopping' ? 'shopping.preferences.hidePurchased' : 'menu.hideDone',
    },
    title: '',
    classes,
    attributes,
    label,
    classList: {
      toggle(name, active) { active ? classes.add(name) : classes.delete(name); },
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    querySelector(selector) { return selector === '[data-topbar-toggle-label]' ? label : null; },
  };
}

const tasksButton = createButton('tasks');
const shoppingButton = createButton('shopping');
const buttons = [tasksButton, shoppingButton];
const listeners = new Map();
const root = {
  querySelectorAll(selector) {
    return selector === '[data-completed-visibility-toggle]' ? buttons : [];
  },
  addEventListener(type, listener) { listeners.set(type, listener); },
};
const storageValues = new Map();
const storage = {
  getItem(key) { return storageValues.get(key) ?? null; },
  setItem(key, value) { storageValues.set(key, String(value)); },
};
let hidden = true;
let taskRenders = 0;
let shoppingRenders = 0;
const feature = createCompletedVisibilityFeature({
  getHidden: () => hidden,
  setHidden: value => { hidden = value; },
  storage,
  root,
  translate: key => ({ 'menu.showDone': 'Show done', 'menu.hideDone': 'Hide done', 'shopping.preferences.showPurchased': 'Show purchased', 'shopping.preferences.hidePurchased': 'Hide purchased' })[key] || key,
  renderTasks: () => { taskRenders += 1; },
  renderShopping: () => { shoppingRenders += 1; },
});

feature.bind();
feature.updateButtons();
for (const button of buttons) {
  assert.equal(button.attributes.get('aria-pressed'), 'false', 'hidden completed entries leave every module toggle unpressed');
  const label = button === shoppingButton ? 'Show purchased' : 'Show done';
  assert.equal(button.label.textContent, label);
  assert.equal(button.title, label);
  assert.equal(button.attributes.get('aria-label'), label);
}

const tasksTarget = {
  closest(selector) { return selector === '[data-completed-visibility-toggle]' ? tasksButton : null; },
};
listeners.get('click')({ target: tasksTarget, preventDefault() {} });
assert.equal(hidden, false, 'the Tasks entrypoint changes the app-wide visibility state');
assert.equal(storageValues.get('nia-hide-done'), 'false', 'the shared state remains device-local in the existing localStorage key');
assert.equal(taskRenders, 1);
assert.equal(shoppingRenders, 1, 'changing the state from Tasks also rerenders Shopping');
for (const button of buttons) {
  assert.equal(button.attributes.get('aria-pressed'), 'true');
  const label = button === shoppingButton ? 'Hide purchased' : 'Hide done';
  assert.equal(button.label.textContent, label);
  assert.equal(button.title, label);
  assert.equal(button.attributes.get('aria-label'), label);
}

const shoppingTarget = {
  closest(selector) { return selector === '[data-completed-visibility-toggle]' ? shoppingButton : null; },
};
listeners.get('click')({ target: shoppingTarget, preventDefault() {} });
assert.equal(hidden, true, 'the Shopping entrypoint changes the same app-wide state');
assert.equal(storageValues.get('nia-hide-done'), 'true');
assert.equal(taskRenders, 2);
assert.equal(shoppingRenders, 2);
assert.equal(tasksButton.attributes.get('aria-pressed'), 'false');
assert.equal(shoppingButton.attributes.get('aria-pressed'), 'false');

const shoppingSource = readFileSync(new URL('../web/static/js/modules/shopping.js', import.meta.url), 'utf8');
const tasksSource = readFileSync(new URL('../web/static/js/modules/tasks.js', import.meta.url), 'utf8');
assert.match(shoppingSource, /'data-completed-show-key': 'shopping\.preferences\.showPurchased'/);
assert.match(shoppingSource, /'data-completed-hide-key': 'shopping\.preferences\.hidePurchased'/);
assert.doesNotMatch(shoppingSource, /menu\.(showDone|hideDone)/);
assert.match(tasksSource, /'data-completed-show-key': 'menu\.showDone'/);
assert.match(tasksSource, /'data-completed-hide-key': 'menu\.hideDone'/);
for (const locale of ['cs','de','en','es','fr','it','nl','pl','pt-BR','ru','sv','zh-CN']) {
  const messages = JSON.parse(readFileSync(new URL(`../web/static/i18n/${locale}.json`, import.meta.url), 'utf8'));
  for (const key of ['shopping.preferences.showPurchased','shopping.preferences.hidePurchased']) {
    assert.equal(typeof messages[key], 'string', `${locale}: ${key}`);
    assert.ok(messages[key].trim(), `${locale}: ${key} must be translated`);
  }
}

const serviceWorkerSource = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
assert.match(serviceWorkerSource, /'\/static\/js\/features\/completed-visibility\.js'/, 'the shared controller must be available during offline startup');
assert.match(serviceWorkerSource, /CACHE_REVISION = 'nia-v4-module-platform-preview-\d+'/, 'the app-shell cache must use the versioned module-platform revision contract');

console.log('✅ Shared app-wide completed visibility contracts passed');
