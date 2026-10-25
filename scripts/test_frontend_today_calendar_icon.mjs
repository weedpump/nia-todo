#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

console.log('📅 Running Today calendar icon regression test...');

const tasksModuleSource = readFileSync(new URL('../web/static/js/modules/tasks.js', import.meta.url), 'utf8');
const focusCss = readFileSync(new URL('../web/static/css/64-focus-controls.css', import.meta.url), 'utf8');
const mobileCss = readFileSync(new URL('../web/static/css/40-responsive-mobile.css', import.meta.url), 'utf8');
const workspaceCss = readFileSync(new URL('../web/static/css/61-workspace-confirm-icons.css', import.meta.url), 'utf8');

const todayButtonMarkup = tasksModuleSource.match(/<button[^>]*id="today-focus-btn"[^>]*>[\s\S]*?<\/button>/)?.[0] || '';
assert.match(todayButtonMarkup, /<span class="today-calendar-icon" aria-hidden="true"><\/span>/);
assert.doesNotMatch(todayButtonMarkup, /data-icon="calendar-days"/);
assert.match(focusCss, /\.today-focus-btn \.ui-icon,[\s\S]*?width: 19px;[\s\S]*?height: 19px;/);
assert.match(focusCss, /\.today-calendar-icon[\s\S]*?width: 19px;[\s\S]*?height: 19px;/);
assert.doesNotMatch(focusCss, /\.today-focus-btn\.active::after|\.minimal-todos-btn\.active::after/);
assert.match(mobileCss, /\.search-box > \.search-toggle-btn[\s\S]*?border: 0;/);
assert.match(mobileCss, /#search-toggle-btn \.ui-icon[\s\S]*?width: 19px;[\s\S]*?height: 19px;/);
assert.match(workspaceCss, /\.workspace-current-dot\.has-icon \.ui-icon[\s\S]*?width: 19px;[\s\S]*?height: 19px;/);

const RealDate = Date;
let nowMs = new RealDate(2026, 9, 13, 23, 59, 59, 900).getTime();
class FakeDate extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [nowMs]));
  }
  static now() {
    return nowMs;
  }
}
globalThis.Date = FakeDate;
globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
};

let timerCallback = null;
let timerDelay = null;
globalThis.setTimeout = (callback, delay) => {
  timerCallback = callback;
  timerDelay = delay;
  return 1;
};
globalThis.clearTimeout = () => {};

const icon = { innerHTML: '' };
const label = { textContent: '' };
const buttonClasses = new Set();
const todayButton = {
  title: '',
  addEventListener() {},
  setAttribute() {},
  classList: {
    toggle(name, active) {
      active ? buttonClasses.add(name) : buttonClasses.delete(name);
    },
  },
  querySelector(selector) {
    if (selector === '.today-calendar-icon') return icon;
    if (selector === '[data-i18n-key="todayFocus.short"]') return label;
    return null;
  },
};
const minimalButton = { addEventListener() {} };
let visibilityListener = null;
globalThis.document = {
  visibilityState: 'visible',
  getElementById(id) {
    if (id === 'today-focus-btn') return todayButton;
    if (id === 'minimal-todos-btn') return minimalButton;
    return null;
  },
  addEventListener(type, listener) {
    if (type === 'visibilitychange') visibilityListener = listener;
  },
};

const { createViewPreferencesFeature } = await import('../web/static/js/features/view-preferences.js');
const feature = createViewPreferencesFeature({
  getHideDone: () => false,
  setHideDone() {},
  getSortMode: () => 'order',
  setSortMode() {},
  getShowProjectWidget: () => true,
  setShowProjectWidget() {},
  getTodayFocus: () => false,
  setTodayFocus() {},
  getMinimalTodos: () => false,
  setMinimalTodos() {},
  renderTodos() {},
  renderStats() {},
});

feature.updateTodayFocusButton();
assert.match(icon.innerHTML, /class="today-calendar-day">13<\/span>/, 'the icon must use the browser-local calendar day');

feature.bindTopbarPreferenceButtons();
assert.equal(typeof timerCallback, 'function', 'binding the top bar must schedule the midnight refresh');
assert.ok(timerDelay >= 100 && timerDelay <= 200, `the refresh must target the next local midnight, got ${timerDelay}ms`);

nowMs = new RealDate(2026, 9, 14, 0, 0, 0, 50).getTime();
const midnightCallback = timerCallback;
midnightCallback();
assert.match(icon.innerHTML, /class="today-calendar-day">14<\/span>/, 'the icon must update without a reload after local midnight');
assert.equal(typeof timerCallback, 'function', 'the midnight refresh must schedule the following day');

nowMs = new RealDate(2026, 9, 15, 12, 0, 0, 0).getTime();
assert.equal(typeof visibilityListener, 'function', 'the icon must listen for app/browser resume');
visibilityListener();
assert.match(icon.innerHTML, /class="today-calendar-day">15<\/span>/, 'resuming the app must correct a throttled or suspended timer');

console.log('✅ Today calendar icon follows local time and refreshes at midnight/resume');
