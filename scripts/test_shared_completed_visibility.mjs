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
      completedShowKey: 'menu.showDone',
      completedHideKey: 'menu.hideDone',
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
  translate: key => ({ 'menu.showDone': 'Show done', 'menu.hideDone': 'Hide done' })[key] || key,
  renderTasks: () => { taskRenders += 1; },
  renderShopping: () => { shoppingRenders += 1; },
});

feature.bind();
feature.updateButtons();
for (const button of buttons) {
  assert.equal(button.attributes.get('aria-pressed'), 'false', 'hidden completed entries leave every module toggle unpressed');
  assert.equal(button.label.textContent, 'Show done');
  assert.equal(button.title, 'Show done');
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
  assert.equal(button.label.textContent, 'Hide done');
  assert.equal(button.title, 'Hide done');
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

const serviceWorkerSource = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
assert.match(serviceWorkerSource, /'\/static\/js\/features\/completed-visibility\.js'/, 'the shared controller must be available during offline startup');
assert.match(serviceWorkerSource, /CACHE_REVISION = 'nia-v4-module-platform-preview-271'/, 'the app-shell cache must advance for the new shared controller and module markup');

console.log('✅ Shared app-wide completed visibility contracts passed');
