#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createDashboardDrilldownFeature } from '../web/static/js/features/dashboard-drilldown.js';

console.log('🔎 Running dashboard drilldown interaction test...');

function createDocumentHarness(querySelector = () => null) {
  const listeners = new Map();
  return {
    documentElement: { dataset: {} },
    querySelector,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatchClick(target, detail = 1) {
      listeners.get('click')?.({ target, detail, preventDefault() {} });
    },
  };
}

function focusable(label) {
  return {
    label,
    focus() { globalThis.__dashboardFocused = this; },
  };
}

function actionTarget(selector, dataset) {
  return {
    closest(requestedSelector) {
      return requestedSelector === selector ? { dataset } : null;
    },
  };
}

{
  const document = createDocumentHarness();
  const calls = [];
  let drilldown = null;
  const feature = createDashboardDrilldownFeature({
    document,
    setDashboardDrilldown: value => { drilldown = value; },
    setFilter: (filter, options) => calls.push({ filter, options }),
    scrollToTodos: () => calls.push({ scroll: true }),
  });

  feature.bindDashboardDrilldownActions();
  feature.bindDashboardDrilldownActions();
  document.dispatchClick(actionTarget('[data-dashboard-metric]', { dashboardMetric: 'due_today' }));

  assert.equal(drilldown, 'due_today');
  assert.deepEqual(calls[0], { filter: 'all', options: { preserveDashboardDrilldown: true } });
  assert.deepEqual(calls[1], { scroll: true });
  assert.equal(document.documentElement.dataset.dashboardDrilldownActionsBound, '1');
}

{
  const document = createDocumentHarness();
  const calls = [];
  let drilldown = null;
  const feature = createDashboardDrilldownFeature({
    document,
    setDashboardDrilldown: value => { drilldown = value; },
    setFilter: (filter, options) => calls.push({ filter, options }),
    scrollToTodos: () => calls.push({ scroll: true }),
  });

  feature.bindDashboardDrilldownActions();
  document.dispatchClick(actionTarget('[data-dashboard-metric]', { dashboardMetric: 'overdue', dashboardProjectId: '42' }));

  assert.equal(drilldown, 'overdue');
  assert.deepEqual(calls[0], { filter: '42', options: { preserveDashboardDrilldown: true } });
  assert.deepEqual(calls[1], { scroll: true });
}

{
  const document = createDocumentHarness();
  const calls = [];
  let drilldown = 'overdue';
  const feature = createDashboardDrilldownFeature({
    document,
    setDashboardDrilldown: value => { drilldown = value; },
    setFilter: (filter, options) => calls.push({ filter, options }),
  });

  feature.bindDashboardDrilldownActions();
  document.dispatchClick(actionTarget('[data-dashboard-drilldown-action]', { dashboardDrilldownAction: 'clear', dashboardReturnFilter: 'all' }));

  assert.equal(drilldown, null);
  assert.deepEqual(calls, [{ filter: 'all', options: { preserveDashboardDrilldown: true } }]);
}

{
  const document = createDocumentHarness();
  const calls = [];
  let drilldown = 'pending';
  const feature = createDashboardDrilldownFeature({
    document,
    setDashboardDrilldown: value => { drilldown = value; },
    setFilter: (filter, options) => calls.push({ filter, options }),
  });

  feature.bindDashboardDrilldownActions();
  document.dispatchClick(actionTarget('[data-dashboard-project-id]', { dashboardProjectId: '42' }));

  assert.equal(drilldown, 'pending', 'project multiselect options must not mutate the active drilldown');
  assert.deepEqual(calls, [], 'project multiselect options must not trigger dashboard navigation');
}

{
  let drilldown = null;
  let clearButton = null;
  let restoredMetric = null;
  const document = createDocumentHarness(selector => {
    if (selector === '[data-dashboard-drilldown-action="clear"]') return clearButton;
    if (selector === '[data-dashboard-metric="due_today"]:not([data-dashboard-project-id])') return restoredMetric;
    return null;
  });
  const feature = createDashboardDrilldownFeature({
    document,
    setDashboardDrilldown: value => { drilldown = value; },
    setFilter: () => Promise.resolve().then(() => {
      if (drilldown) clearButton = focusable('aggregate-clear');
      else restoredMetric = focusable('aggregate-due-today');
    }),
    scrollToTodos() {},
  });

  feature.bindDashboardDrilldownActions();
  globalThis.__dashboardFocused = null;
  document.dispatchClick(actionTarget('[data-dashboard-metric]', { dashboardMetric: 'due_today' }), 0);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(globalThis.__dashboardFocused, clearButton, 'keyboard activation of an aggregate metric must move focus to the applied-filter clear action');
  document.dispatchClick(actionTarget('[data-dashboard-drilldown-action]', { dashboardDrilldownAction: 'clear', dashboardReturnFilter: 'all' }), 0);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(globalThis.__dashboardFocused, restoredMetric, 'clearing an aggregate drilldown must restore focus to its rerendered metric button');
}

{
  let drilldown = null;
  let clearButton = null;
  let restoredMetric = null;
  const document = createDocumentHarness(selector => {
    if (selector === '[data-dashboard-drilldown-action="clear"]') return clearButton;
    if (selector === '[data-dashboard-metric="overdue"][data-dashboard-project-id="42"]') return restoredMetric;
    return null;
  });
  const feature = createDashboardDrilldownFeature({
    document,
    setDashboardDrilldown: value => { drilldown = value; },
    setFilter: () => Promise.resolve().then(() => {
      if (drilldown) clearButton = focusable('project-clear');
      else restoredMetric = focusable('project-overdue');
    }),
    scrollToTodos() {},
  });

  feature.bindDashboardDrilldownActions();
  globalThis.__dashboardFocused = null;
  document.dispatchClick(actionTarget('[data-dashboard-metric]', { dashboardMetric: 'overdue', dashboardProjectId: '42' }), 0);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(globalThis.__dashboardFocused, clearButton, 'keyboard activation of a project metric must move focus to the applied-filter clear action');
  document.dispatchClick(actionTarget('[data-dashboard-drilldown-action]', { dashboardDrilldownAction: 'clear', dashboardReturnFilter: '42' }), 0);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(globalThis.__dashboardFocused, restoredMetric, 'clearing a project drilldown must restore focus to its rerendered project metric button');
}

{
  const css = fs.readFileSync(new URL('../web/static/css/12-overview-dashboard.css', import.meta.url), 'utf8');
  const projectCss = fs.readFileSync(new URL('../web/static/css/81-todo-cards-refresh.css', import.meta.url), 'utf8');
  const renderingSource = fs.readFileSync(new URL('../web/static/js/features/app-rendering.js', import.meta.url), 'utf8');
  const projectDashboardSource = renderingSource.slice(
    renderingSource.indexOf('function renderProjectDashboard'),
    renderingSource.indexOf('function parseTodoDate'),
  );
  assert.match(css, /\.dashboard-drilldown-banner\s*\{[^}]*padding:\s*10px 12px/s, 'drilldown banner must use balanced pill spacing');
  assert.match(css, /\.dashboard-drilldown-banner\s*\{[^}]*border-radius:\s*999px/s, 'drilldown banner must use the nia-todo pill shape');
  assert.match(css, /\.dashboard-drilldown-banner \.btn\s*\{[^}]*margin-left:\s*auto[^}]*border-radius:\s*999px/s, 'drilldown clear action must be right-aligned and use the nia-todo pill shape');
  assert.match(projectCss, /\.project-dashboard \.overview-stat-card:hover\s*\{[^}]*background:/s, 'clickable project metrics need the same visible hover feedback as dashboard metrics');
  assert.match(projectDashboardSource, /dashboardPreferences\.stats\s*\.map\(/, 'project widgets must use the configured dashboard metrics');
  assert.match(projectDashboardSource, /data-dashboard-compact=/, 'project widgets must inherit compact dashboard presentation');
  assert.match(projectDashboardSource, /<\/section>\$\{drilldownBanner\}/, 'project drilldown feedback must render below the project widget');
  assert.match(renderingSource, /if \(!filtered\.length\) \{\s*html \+= `<div class="empty-state">/s, 'empty drilldowns must preserve the applied-filter banner');
}

console.log('✅ Dashboard drilldown interaction test passed');
