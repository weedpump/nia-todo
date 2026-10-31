#!/usr/bin/env node
import assert from 'node:assert/strict';
import { renderTopbarToggle, updateTopbarToggle } from '../web/static/js/ui/topbar-toggle.js';

const markup = renderTopbarToggle({
  id: 'example-toggle',
  icon: 'leaf',
  label: 'Calm',
  labelKey: 'minimalTodos.short',
  title: 'Enable calm view',
});
assert.match(markup, /class="ui-topbar-toggle"/);
assert.match(markup, /id="example-toggle"/);
assert.match(markup, /aria-pressed="false"/);
assert.match(markup, /data-icon="leaf"/);
assert.match(markup, /data-topbar-toggle-label/);
assert.match(markup, /data-i18n-key="minimalTodos.short"/);
assert.match(markup, /title="Enable calm view"/);

const classes = new Set();
const attributes = new Map();
const label = { textContent: '' };
const button = {
  title: '',
  classList: { toggle(name, active) { active ? classes.add(name) : classes.delete(name); } },
  setAttribute(name, value) { attributes.set(name, String(value)); },
  querySelector(selector) { return selector === '[data-topbar-toggle-label]' ? label : null; },
};
updateTopbarToggle(button, { pressed: true, label: 'Calm enabled', title: 'Disable calm view' });
assert.equal(classes.has('active'), true);
assert.equal(attributes.get('aria-pressed'), 'true');
assert.equal(attributes.get('aria-label'), 'Disable calm view');
assert.equal(button.title, 'Disable calm view');
assert.equal(label.textContent, 'Calm enabled');

updateTopbarToggle(button, { pressed: false, label: 'Calm', title: 'Enable calm view' });
assert.equal(classes.has('active'), false);
assert.equal(attributes.get('aria-pressed'), 'false');
assert.equal(attributes.get('aria-label'), 'Enable calm view');
assert.equal(label.textContent, 'Calm');

console.log('✅ Shared topbar toggle rendering and state contract passed');
