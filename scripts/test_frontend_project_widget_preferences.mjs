#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  loadDashboardPreferences,
  saveDashboardPreferences,
} from '../web/static/js/features/dashboard-preferences.js';
import { createViewPreferencesFeature } from '../web/static/js/features/view-preferences.js';

console.log('🧭 Running project-widget quick-toggle persistence regression test...');

const values = new Map();
const storage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key),
};
globalThis.localStorage = storage;
globalThis.document = { getElementById: () => null };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { language: 'en', languages: ['en'] },
});

let currentWorkspaceId = 1;
let currentPreferences = loadDashboardPreferences(storage, currentWorkspaceId);
let showProjectWidget = currentPreferences.showProjectWidgets;
const feature = createViewPreferencesFeature({
  getHideDone: () => true,
  setHideDone() {},
  getSortMode: () => 'priority',
  setSortMode() {},
  getShowProjectWidget: () => showProjectWidget,
  setShowProjectWidget: value => { showProjectWidget = value; },
  saveShowProjectWidget: value => {
    currentPreferences = saveDashboardPreferences(storage, {
      ...currentPreferences,
      showProjectWidgets: value,
    }, currentWorkspaceId);
    showProjectWidget = currentPreferences.showProjectWidgets;
  },
  getTodayFocus: () => false,
  setTodayFocus() {},
  getMinimalTodos: () => false,
  setMinimalTodos() {},
  renderTodos() {},
});

feature.toggleProjectWidget();
currentWorkspaceId = 2;
currentPreferences = loadDashboardPreferences(storage, currentWorkspaceId);
showProjectWidget = currentPreferences.showProjectWidgets;
const workspaceTwo = currentPreferences;
currentWorkspaceId = 1;
currentPreferences = loadDashboardPreferences(storage, currentWorkspaceId);
showProjectWidget = currentPreferences.showProjectWidgets;

assert.equal(currentPreferences.showProjectWidgets, false, 'the quick toggle must remain saved in the workspace where it was changed');
assert.equal(workspaceTwo.showProjectWidgets, true, 'switching workspaces before reload must not move the quick-toggle value');
assert.equal(storage.getItem('nia-project-widget'), null, 'the quick toggle must never recreate the legacy project-widget key');

const appSource = readFileSync(new URL('../web/static/js/app.js', import.meta.url), 'utf8');
assert.match(appSource, /saveShowProjectWidget:\s*\(value\)\s*=>\s*\{[\s\S]*?saveDashboardPreferences\(localStorage,[\s\S]*?currentWorkspaceId\)/, 'app wiring must save the quick toggle through active-workspace dashboard preferences');

console.log('✅ Project-widget quick-toggle persistence regression test passed');
