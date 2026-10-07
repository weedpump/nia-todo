#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  calculateDashboardMetrics,
  DASHBOARD_PREFERENCES_KEY,
  DEFAULT_DASHBOARD_PREFERENCES,
  filterTodosForDashboard,
  filterTodosForDashboardDrilldown,
  filterTodosForTodayFocus,
  selectDashboardWorkspaceTodos,
  getEffectiveDashboardPreferences,
  loadDashboardPreferences,
  normalizeDashboardPreferences,
  saveDashboardPreferences,
} from '../web/static/js/features/dashboard-preferences.js';

function createStorage(entries = []) {
  const values = new Map(entries);
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    snapshot() {
      return new Map(values);
    },
  };
}

console.log('🧭 Running dashboard preferences tests...');

const dashboardCss = readFileSync(new URL('../web/static/css/12-overview-dashboard.css', import.meta.url), 'utf8');
assert.match(dashboardCss, /\.overview-dashboard\[data-dashboard-compact="true"\] \.overview-subtitle,[\s\S]*?\.overview-dashboard\[data-dashboard-compact="true"\] \.overview-stat-hint\s*\{[^}]*display:\s*none/s, 'compact display must visibly reduce greeting and stat details');
assert.equal(DEFAULT_DASHBOARD_PREFERENCES.hideEmptyFocusItems, false, 'empty relevant groups must be visible by default');
assert.deepEqual(DEFAULT_DASHBOARD_PREFERENCES.focusItems, ['overdue', 'due_today', 'due_week', 'high_priority'], 'high priority must be selected by default');
assert.match(dashboardCss, /\.overview-detail-grid\s*\{[^}]*align-items:\s*start/s, 'dashboard detail panels must keep their own content height');
assert.match(dashboardCss, /\.overview-focus-list,[\s\S]*?\.overview-project-list\s*\{[^}]*grid-auto-rows:\s*minmax\(36px, auto\)/s, 'dashboard lists must not reserve empty project rows');

{
  const storage = createStorage();
  const preferences = loadDashboardPreferences(storage);

  assert.deepEqual(preferences, DEFAULT_DASHBOARD_PREFERENCES);
  assert.notEqual(preferences, DEFAULT_DASHBOARD_PREFERENCES, 'defaults must be returned as a mutable copy');
  assert.equal(storage.getItem(DASHBOARD_PREFERENCES_KEY), null, 'loading defaults must not write storage');
}

{
  assert.equal(DEFAULT_DASHBOARD_PREFERENCES.groupByStatus, true, 'status grouping must remain enabled by default');
  assert.equal(normalizeDashboardPreferences({ groupByStatus: false }).groupByStatus, false, 'status grouping must be independently configurable');
}

{
  const preferences = normalizeDashboardPreferences({
    version: 99,
    mode: 'compact',
    showFocus: false,
    showActiveProjects: false,
    showProjectWidgets: false,
    projectScope: {
      mode: 'exclude',
      projectIds: [7, '7', 4, 0, -3, 'invalid'],
    },
    stats: ['due_today', 'pending', 'pending', 'invalid', 'overdue', 'done'],
    focusItems: ['due_week', 'high_priority', 'invalid', 'due_week'],
    hideEmptyFocusItems: false,
    activeProjects: {
      limit: 6,
      sort: 'open_count',
    },
  });

  assert.deepEqual(preferences, {
    version: 3,
    compactDisplay: true,
    groupByStatus: true,
    showFocus: false,
    showActiveProjects: false,
    showProjectWidgets: false,
    projectScope: {
      mode: 'exclude',
      projectIds: [7, 4],
    },
    stats: ['due_today', 'pending', 'overdue', 'done'],
    focusItems: ['due_week', 'high_priority'],
    hideEmptyFocusItems: false,
    activeProjects: {
      limit: 6,
      sort: 'open_count',
    },
  });
}

{
  assert.deepEqual(
    normalizeDashboardPreferences({ focusItems: [] }).focusItems,
    [],
    'an explicitly empty focus selection must remain empty',
  );
  assert.deepEqual(
    normalizeDashboardPreferences({}).focusItems,
    DEFAULT_DASHBOARD_PREFERENCES.focusItems,
    'a missing focus selection must use defaults',
  );
  assert.deepEqual(
    normalizeDashboardPreferences({ focusItems: 'overdue' }).focusItems,
    DEFAULT_DASHBOARD_PREFERENCES.focusItems,
    'an invalid focus selection must use defaults',
  );
}

{
  const storage = createStorage();
  const saved = saveDashboardPreferences(storage, { focusItems: [] });

  assert.deepEqual(saved.focusItems, [], 'saving must preserve an explicitly empty focus selection');
  assert.deepEqual(loadDashboardPreferences(storage).focusItems, [], 'reloading must preserve an explicitly empty focus selection');
}

{
  const storage = createStorage();
  const workspaceOne = saveDashboardPreferences(storage, {
    compactDisplay: true,
    projectScope: { mode: 'exclude', projectIds: [11] },
  }, 1);
  const workspaceTwo = saveDashboardPreferences(storage, {
    showFocus: false,
    projectScope: { mode: 'include', projectIds: [22] },
  }, 2);

  assert.deepEqual(loadDashboardPreferences(storage, 1), workspaceOne, 'the complete dashboard configuration must be isolated for workspace one');
  assert.deepEqual(loadDashboardPreferences(storage, 2), workspaceTwo, 'the complete dashboard configuration must be isolated for workspace two');
  assert.deepEqual(loadDashboardPreferences(storage, 3), DEFAULT_DASHBOARD_PREFERENCES, 'a workspace without saved preferences must start from defaults');
}

{
  const legacyPreferences = normalizeDashboardPreferences({
    compactDisplay: true,
    showFocus: false,
    projectScope: { mode: 'exclude', projectIds: [7] },
  });
  const storage = createStorage([[DASHBOARD_PREFERENCES_KEY, JSON.stringify(legacyPreferences)]]);

  assert.deepEqual(loadDashboardPreferences(storage, 10), legacyPreferences, 'the existing global configuration must migrate to the active workspace');
  assert.equal(storage.getItem(DASHBOARD_PREFERENCES_KEY), null, 'the migrated global key must be removed so other workspaces start independently');
  assert.deepEqual(loadDashboardPreferences(storage, 20), DEFAULT_DASHBOARD_PREFERENCES, 'a second workspace must not inherit the migrated global configuration');
}

{
  const renderingSource = readFileSync(new URL('../web/static/js/features/app-rendering.js', import.meta.url), 'utf8');
  assert.match(
    renderingSource,
    /const showFocusPanel = dashboardPreferences\.showFocus && focusItems\.length > 0;/,
    'the focus panel must naturally stay hidden when no focus groups are selected',
  );
}

{
  const stored = {
    version: 2,
    focusItems: ['overdue', 'due_today', 'due_week'],
  };
  const storage = createStorage([['nia-dashboard-preferences-v2', JSON.stringify(stored)]]);
  const preferences = loadDashboardPreferences(storage);
  assert.deepEqual(
    preferences.focusItems,
    ['overdue', 'due_today', 'due_week', 'high_priority'],
    'the previous default focus selection must migrate to include high priority',
  );
}

{
  const stored = {
    mode: 'focused',
    projectScope: { mode: 'include', projectIds: [3], includeUnassigned: false },
    stats: ['pending', 'in_progress', 'due_today', 'overdue'],
  };
  const storage = createStorage([['nia-dashboard-preferences-v1', JSON.stringify(stored)]]);
  const preferences = loadDashboardPreferences(storage);

  assert.equal(preferences.compactDisplay, false);
  assert.equal(preferences.showActiveProjects, false, 'legacy focused mode must migrate its effective section visibility');
  assert.deepEqual(preferences.projectScope, { mode: 'include', projectIds: [3] });
  assert.deepEqual(preferences.stats, ['pending', 'in_progress', 'due_today', 'overdue']);
}

{
  const storage = createStorage([[DASHBOARD_PREFERENCES_KEY, '{broken-json']]);
  assert.deepEqual(loadDashboardPreferences(storage), DEFAULT_DASHBOARD_PREFERENCES);
}

{
  const storage = createStorage([['nia-project-widget', 'false']]);
  const preferences = loadDashboardPreferences(storage);

  assert.equal(preferences.showProjectWidgets, false);
  assert.equal(storage.getItem(DASHBOARD_PREFERENCES_KEY), null, 'legacy migration is returned without writing during load');
}

{
  const workspaceKey = `${DASHBOARD_PREFERENCES_KEY}:workspace:10`;
  const storage = createStorage([['nia-project-widget', 'false']]);
  const migrated = loadDashboardPreferences(storage, 10);

  assert.deepEqual(
    migrated,
    normalizeDashboardPreferences({ showProjectWidgets: false }),
    'the legacy project-widget preference must migrate into the active workspace configuration',
  );
  assert.deepEqual(
    JSON.parse(storage.getItem(workspaceKey)),
    migrated,
    'workspace migration must persist the complete normalized dashboard preferences',
  );
  assert.equal(storage.getItem('nia-project-widget'), null, 'workspace migration must consume the global legacy project-widget key');
  assert.deepEqual(
    loadDashboardPreferences(storage, 20),
    DEFAULT_DASHBOARD_PREFERENCES,
    'later workspaces must start from defaults after the legacy project-widget preference was migrated',
  );
}

{
  const globalPreferences = normalizeDashboardPreferences({
    compactDisplay: true,
    showProjectWidgets: true,
  });
  const storage = createStorage([
    [DASHBOARD_PREFERENCES_KEY, JSON.stringify(globalPreferences)],
    ['nia-project-widget', 'false'],
  ]);
  const migrated = loadDashboardPreferences(storage, 10);

  assert.equal(migrated.compactDisplay, true, 'the complete global dashboard configuration must migrate to the first workspace');
  assert.equal(migrated.showProjectWidgets, false, 'the legacy project-widget override must be applied during the same workspace migration');
  assert.equal(storage.getItem(DASHBOARD_PREFERENCES_KEY), null, 'the global dashboard key must be consumed by the first workspace migration');
  assert.equal(storage.getItem('nia-project-widget'), null, 'the legacy project-widget key must be consumed by the first workspace migration');
  assert.deepEqual(loadDashboardPreferences(storage, 20), DEFAULT_DASHBOARD_PREFERENCES, 'a second workspace must start from defaults after the combined migration');
}

{
  const workspaceKey = `${DASHBOARD_PREFERENCES_KEY}:workspace:10`;
  const concretePreferences = normalizeDashboardPreferences({
    compactDisplay: true,
    showFocus: false,
    showProjectWidgets: true,
    projectScope: { mode: 'exclude', projectIds: [17] },
  });
  const storage = createStorage([
    [workspaceKey, JSON.stringify(concretePreferences)],
    [DASHBOARD_PREFERENCES_KEY, JSON.stringify({ compactDisplay: false, showFocus: true, showProjectWidgets: true })],
    ['nia-dashboard-preferences-v2', JSON.stringify({ mode: 'focused', showProjectWidgets: true })],
    ['nia-dashboard-preferences-v1', JSON.stringify({ mode: 'compact' })],
    ['nia-project-widget', 'false'],
  ]);
  const reconciled = loadDashboardPreferences(storage, 10);

  assert.equal(reconciled.compactDisplay, true, 'the existing concrete workspace configuration must remain the migration base');
  assert.equal(reconciled.showFocus, false, 'newer concrete workspace fields must win over pending global preferences');
  assert.deepEqual(reconciled.projectScope, { mode: 'exclude', projectIds: [17] }, 'reconciliation must preserve unrelated concrete workspace fields');
  assert.equal(reconciled.showProjectWidgets, false, 'the explicit historical project-widget field must override the concrete workspace field exactly once');
  assert.deepEqual(JSON.parse(storage.getItem(workspaceKey)), reconciled, 'the reconciled concrete workspace configuration must be persisted');
  assert.equal(storage.getItem(DASHBOARD_PREFERENCES_KEY), null, 'the pending global v3 key must be consumed even when concrete workspace preferences exist');
  assert.equal(storage.getItem('nia-dashboard-preferences-v2'), null, 'the pending global v2 key must be consumed during reconciliation');
  assert.equal(storage.getItem('nia-dashboard-preferences-v1'), null, 'the pending global v1 key must be consumed during reconciliation');
  assert.equal(storage.getItem('nia-project-widget'), null, 'the explicit legacy project-widget key must be consumed during reconciliation');
  assert.deepEqual(loadDashboardPreferences(storage, 20), DEFAULT_DASHBOARD_PREFERENCES, 'consumed migration data must not leak into a later workspace');
}

{
  const workspaceKey = `${DASHBOARD_PREFERENCES_KEY}:workspace:10`;
  const storage = createStorage([['nia-project-widget', 'true']]);
  const migrated = loadDashboardPreferences(storage, 10);

  assert.deepEqual(migrated, DEFAULT_DASHBOARD_PREFERENCES, 'an enabled legacy project-widget preference must migrate as the workspace default');
  assert.deepEqual(JSON.parse(storage.getItem(workspaceKey)), migrated, 'the enabled legacy preference must still create the concrete workspace configuration');
  assert.equal(storage.getItem('nia-project-widget'), null, 'every migrated legacy project-widget key must be removed');
}

{
  const storage = createStorage();
  const saved = saveDashboardPreferences(storage, {
    compactDisplay: true,
    stats: ['done', 'done', 'invalid'],
  });

  assert.equal(saved.compactDisplay, true);
  assert.deepEqual(saved.stats, ['done', 'total', 'pending', 'in_progress']);
  assert.deepEqual(JSON.parse(storage.getItem(DASHBOARD_PREFERENCES_KEY)), saved);
}

{
  const base = normalizeDashboardPreferences({
    compactDisplay: false,
    showFocus: true,
    showActiveProjects: true,
    stats: ['total', 'done', 'pending', 'overdue'],
  });
  const effective = getEffectiveDashboardPreferences(base, { minimal: true });

  assert.equal(effective.compactDisplay, true);
  assert.equal(effective.showFocus, false);
  assert.equal(effective.showActiveProjects, false);
  assert.equal(effective.showProjectWidgets, false);
  assert.deepEqual(effective.stats, ['total', 'done', 'pending', 'overdue'], 'minimal mode must preserve the configured dashboard metrics');
  assert.equal(base.compactDisplay, false, 'minimal mode must not mutate the base preferences');
  assert.deepEqual(base.stats, ['total', 'done', 'pending', 'overdue']);
  assert.deepEqual(getEffectiveDashboardPreferences(base, { minimal: false }), base);
}

{
  const now = new Date(2026, 9, 6, 12, 0, 0);
  const todos = [
    { id: 1, status: 'pending', due_date: '2026-10-06T18:00:00', priority: 4 },
    { id: 2, status: 'pending', due_date: '2026-10-07T09:00:00', priority: 1 },
    { id: 3, status: 'pending', priority: 1 },
    { id: 4, status: 'pending', priority: 4, is_pinned: true },
    { id: 5, status: 'done', due_date: '2026-10-06T09:00:00', is_pinned: true },
    { id: 6, status: 'in_progress', remind_at: '2026-10-06T16:00:00', priority: 3 },
    { id: 7, status: 'pending', due_date: '2026-10-07T09:00:00', remind_at: '2026-10-06T17:00:00', priority: 3 },
  ];
  assert.deepEqual(
    filterTodosForTodayFocus(todos, now).map(todo => todo.id),
    [1, 3, 4, 6, 7],
    'today focus must drive dashboard metrics and todo lists from the same focused dataset',
  );
}

{
  const todos = [
    { id: 1, project_id: 1, status: 'pending', priority: 1, due_date: '2026-10-05T18:00:00' },
    { id: 2, project_id: 2, status: 'in_progress', priority: 2, due_date: '2026-10-06T15:00:00' },
    { id: 3, project_id: 1, status: 'done', priority: 3, due_date: '2026-10-01T12:00:00' },
    { id: 4, project_id: null, status: 'pending', priority: 4, due_date: '2026-10-10T12:00:00' },
    { id: 5, project_id: 3, status: 'pending', priority: 3, due_date: '2026-10-20T12:00:00' },
    { id: 6, project_id: 99, status: 'pending', priority: 1, due_date: null },
  ];
  const preferences = normalizeDashboardPreferences({
    projectScope: { mode: 'exclude', projectIds: [2] },
  });
  const scoped = filterTodosForDashboard(todos, preferences, new Set([1, 2, 3]));

  assert.deepEqual(scoped.map(todo => todo.id), [1, 3, 4, 5], 'exclude scope must retain projectless Todos while excluding selected projects');
  const included = filterTodosForDashboard(todos, normalizeDashboardPreferences({
    projectScope: { mode: 'include', projectIds: [1] },
  }), new Set([1, 2, 3]));
  assert.deepEqual(included.map(todo => todo.id), [1, 3], 'include scope must exclude projectless Todos and retain only selected projects');
  assert.deepEqual(calculateDashboardMetrics(scoped, new Date(2026, 9, 6, 12, 0, 0)), {
    total: 4,
    pending: 3,
    in_progress: 0,
    done: 1,
    overdue: 1,
    due_today: 0,
    due_week: 1,
    high_priority: 1,
  });

  const todayTodos = [
    { id: 10, project_id: 1, status: 'pending', is_pinned: true },
    { id: 11, project_id: 2, status: 'pending', is_pinned: true },
  ];
  for (const projectScope of [
    { mode: 'include', projectIds: [1] },
    { mode: 'exclude', projectIds: [2] },
  ]) {
    const scopedToday = filterTodosForTodayFocus(
      filterTodosForDashboard(todayTodos, normalizeDashboardPreferences({ projectScope }), new Set([1, 2])),
      new Date(2026, 9, 6, 12, 0, 0),
    );
    assert.deepEqual(scopedToday.map(todo => todo.id), [10], `${projectScope.mode} scope must be applied before Today filtering`);
    assert.equal(calculateDashboardMetrics(scopedToday).total, 1, `${projectScope.mode} Today metrics must match the scoped Today list`);
  }
}

{
  const todos = [
    { id: 1, project_id: 10 },
    { id: 2, project_id: null, workspace_id: 3 },
    { id: 3, project_id: null, workspace_id: 4 },
    { id: 4, project_id: 20 },
  ];
  assert.deepEqual(
    selectDashboardWorkspaceTodos(todos, new Set([10]), 3).map(todo => todo.id),
    [1, 2],
    'dashboard workspace selection must retain projectless todos assigned to the active workspace',
  );
}

{
  const now = new Date(2026, 9, 6, 12, 0, 0);
  const todos = [
    { id: 1, status: 'pending', priority: 1, due_date: '2026-10-05T18:00:00' },
    { id: 2, status: 'in_progress', priority: 2, due_date: '2026-10-06T15:00:00' },
    { id: 3, status: 'done', priority: 3, due_date: '2026-10-01T12:00:00' },
    { id: 4, status: 'pending', priority: 4, due_date: '2026-10-10T12:00:00' },
    { id: 5, status: 'archived', priority: 1, due_date: '2026-10-04T12:00:00' },
  ];

  assert.deepEqual(filterTodosForDashboardDrilldown(todos, 'total', now).map(todo => todo.id), [1, 2, 3, 4]);
  assert.deepEqual(filterTodosForDashboardDrilldown(todos, 'pending', now).map(todo => todo.id), [1, 4]);
  assert.deepEqual(filterTodosForDashboardDrilldown(todos, 'in_progress', now).map(todo => todo.id), [2]);
  assert.deepEqual(filterTodosForDashboardDrilldown(todos, 'done', now).map(todo => todo.id), [3]);
  assert.deepEqual(filterTodosForDashboardDrilldown(todos, 'overdue', now).map(todo => todo.id), [1]);
  assert.deepEqual(filterTodosForDashboardDrilldown(todos, 'due_today', now).map(todo => todo.id), [2]);
  assert.deepEqual(filterTodosForDashboardDrilldown(todos, 'due_week', now).map(todo => todo.id), [4]);
  assert.deepEqual(filterTodosForDashboardDrilldown(todos, 'high_priority', now).map(todo => todo.id), [1, 2]);
  assert.deepEqual(filterTodosForDashboardDrilldown(todos, 'invalid', now), []);
}

{
  const now = new Date(2026, 9, 7, 12, 0, 0);
  const todos = [
    { id: 1, status: 'pending', due_date: '2026-10-06' },
    { id: 2, status: 'pending', due_date: '2026-10-07' },
    { id: 3, status: 'pending', due_date: '2026-10-08' },
  ];

  assert.deepEqual(filterTodosForDashboardDrilldown(todos, 'overdue', now).map(todo => todo.id), [1], 'date-only deadlines before the local calendar day must be overdue');
  assert.deepEqual(filterTodosForDashboardDrilldown(todos, 'due_today', now).map(todo => todo.id), [2], 'date-only deadlines must use the local calendar day');
  assert.deepEqual(filterTodosForDashboardDrilldown(todos, 'due_week', now).map(todo => todo.id), [3], 'a next-day date-only deadline must not appear one day early');
  assert.deepEqual(filterTodosForTodayFocus(todos, now).map(todo => todo.id), [1, 2], 'Today must include local date-only deadlines through the current day only');
}

console.log('✅ Dashboard preferences tests passed');
