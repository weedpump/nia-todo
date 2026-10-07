#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

console.log('🧘 Running minimal mode contract test...');

const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
};
globalThis.location = { origin: 'http://localhost' };

let minimal = false;
let focus = false;
let renderTodosCalls = 0;
let renderStatsCalls = 0;
const classes = new Set();
const button = {
  classList: { toggle(name, active) { active ? classes.add(name) : classes.delete(name); } },
  setAttribute() {},
  querySelector() { return null; },
};
const todoList = { innerHTML: '' };
const searchInput = { value: '' };
globalThis.document = {
  body: { classList: { toggle(name, active) { active ? classes.add(name) : classes.delete(name); } } },
  getElementById(id) {
    if (id === 'minimal-todos-btn') return button;
    if (id === 'todo-list') return todoList;
    if (id === 'search-input') return searchInput;
    return null;
  },
};

const { createViewPreferencesFeature } = await import('../web/static/js/features/view-preferences.js');
const feature = createViewPreferencesFeature({
  getHideDone: () => true,
  setHideDone() {},
  getSortMode: () => 'priority',
  setSortMode() {},
  getShowProjectWidget: () => true,
  setShowProjectWidget() {},
  getTodayFocus: () => focus,
  setTodayFocus: value => { focus = value; },
  getMinimalTodos: () => minimal,
  setMinimalTodos: value => { minimal = value; },
  renderTodos: () => { renderTodosCalls += 1; },
  renderStats: () => { renderStatsCalls += 1; },
});

feature.toggleTodayFocus();
assert.equal(focus, true);
assert.equal(storage.get('nia-today-focus'), 'true');
assert.equal(renderTodosCalls, 1);
assert.equal(renderStatsCalls, 1, 'today focus must immediately refresh dashboard metrics');

feature.toggleMinimalTodos();
assert.equal(minimal, true);
assert.equal(storage.get('nia-minimal-todos'), 'true');
assert.equal(renderTodosCalls, 2);
assert.equal(renderStatsCalls, 2, 'minimal mode must immediately refresh the dashboard presentation');
assert.equal(classes.has('is-minimal-todos'), true);

const { createAppRenderingFeature } = await import('../web/static/js/features/app-rendering.js');
const renderingTodos = [
  { id: 1, title: 'Match open', status: 'pending', project_id: 10, priority: 3, is_pinned: true },
  { id: 2, title: 'Match done', status: 'done', project_id: 10, priority: 3 },
  { id: 3, title: 'Match excluded pinned', status: 'pending', project_id: 20, priority: 3, is_pinned: true },
  { id: 4, title: 'Sorted pending', status: 'pending', project_id: 10, priority: 3 },
  { id: 5, title: 'Sorted in progress', status: 'in_progress', project_id: 10, priority: 3 },
  { id: 6, title: 'Pinned in progress', status: 'in_progress', project_id: 10, priority: 3, is_pinned: true },
];
let renderingProjectId = null;
let renderingDrilldown = null;
let renderingTodayFocus = false;
let renderingMinimal = true;
let renderingShowProjectWidget = false;
let renderingPreferences = { stats: ['total', 'done', 'pending', 'overdue'] };
const rendering = createAppRenderingFeature({
  appVersion: 'test',
  escapeHtml: value => String(value ?? ''),
  escapeHtmlAttr: value => String(value ?? ''),
  getTodos: () => renderingTodos,
  getProjects: () => [
    { id: 10, name: 'Project', workspace_id: 1 },
    { id: 20, name: 'Excluded', workspace_id: 1 },
  ],
  getSections: () => [],
  getCurrentFilter: () => 'all',
  getCurrentProjectId: () => renderingProjectId,
  getCurrentWorkspaceId: () => 1,
  getHideDone: () => false,
  getTodayFocus: () => renderingTodayFocus,
  getShowProjectWidget: () => renderingShowProjectWidget && !renderingMinimal,
  getDashboardPreferences: () => renderingPreferences,
  getDashboardDrilldown: () => renderingDrilldown,
  getMinimalTodos: () => renderingMinimal,
  getCurrentUser: () => null,
  getFocusFilters: () => ({}),
  sortTodoList: items => items,
  renderTodoItem: todo => `<article data-test-todo="${todo.id}"></article>`,
  renderSectionHeader: () => '',
  cleanupCalendarView() {},
});

rendering.renderTodos();
assert.doesNotMatch(todoList.innerHTML, /data-test-todo="2"/, 'normal quiet mode must continue hiding completed todos');
renderingDrilldown = 'total';
rendering.renderTodos();
assert.match(todoList.innerHTML, /data-test-todo="2"/, 'aggregate Total drilldown must show the completed todos counted by the metric');
renderingDrilldown = 'done';
renderingProjectId = 10;
renderingMinimal = false;
rendering.renderTodos();
assert.match(todoList.innerHTML, /data-test-todo="2"/, 'project Done drilldown must show the completed todos counted by the metric');
assert.match(todoList.innerHTML, /data-dashboard-drilldown-action="clear"/, 'active project drilldown must retain its banner when project widgets are disabled');

renderingShowProjectWidget = true;
renderingMinimal = true;
rendering.renderTodos();
assert.match(todoList.innerHTML, /data-dashboard-drilldown-action="clear"/, 'active project drilldown must retain its banner in Ruhe mode');

renderingDrilldown = null;
renderingProjectId = null;
renderingMinimal = false;
renderingTodayFocus = false;
renderingPreferences = {
  stats: ['total', 'done', 'pending', 'overdue'],
  groupByStatus: false,
  projectScope: { mode: 'exclude', projectIds: [20] },
};
rendering.renderTodos();
assert.match(todoList.innerHTML, /data-test-todo="1"/, 'the normal dashboard list must retain todos inside the configured dashboard project scope');
assert.doesNotMatch(todoList.innerHTML, /data-test-todo="3"/, 'the normal dashboard list must exclude todos from excluded projects');
assert.equal((todoList.innerHTML.match(/project-group-name/g) || []).length, 1, 'disabled status grouping must render each project only once');
const ungroupedProjectTodos = todoList.innerHTML.match(/<div class="project-group-todos">([\s\S]*?)<\/div>/)?.[1] || '';
const pinnedTodos = todoList.innerHTML.match(/<div class="project-group-todos pinned-todos">([\s\S]*?)<\/div>/)?.[1] || '';
assert.deepEqual({
  standalonePinnedGroups: (todoList.innerHTML.match(/pinned-todos-group/g) || []).length,
  pinnedTodoIds: [...pinnedTodos.matchAll(/data-test-todo="(\d+)"/g)].map(match => Number(match[1])),
  projectCount: Number(todoList.innerHTML.match(/project-group-count">(\d+)</)?.[1]),
  projectTodoIds: [...ungroupedProjectTodos.matchAll(/data-test-todo="(\d+)"/g)].map(match => Number(match[1])),
}, {
  standalonePinnedGroups: 1,
  pinnedTodoIds: [6, 1],
  projectCount: 3,
  projectTodoIds: [5, 2, 4],
}, 'pinned todos must retain their standalone group and use the same stable in-progress-first status ordering internally');
assert.ok(todoList.innerHTML.indexOf('data-test-todo="5"') < todoList.innerHTML.indexOf('data-test-todo="2"'), 'in-progress todos must move ahead of other statuses');
assert.ok(todoList.innerHTML.indexOf('data-test-todo="2"') < todoList.innerHTML.indexOf('data-test-todo="4"'), 'the configured sort order must remain stable inside the non-in-progress block');

renderingPreferences.groupByStatus = true;
rendering.renderTodos();
assert.equal((todoList.innerHTML.match(/project-group-name/g) || []).length, 3, 'enabled status grouping must retain separate project blocks per visible status');

renderingTodayFocus = true;
renderingPreferences = {
  stats: ['total', 'done', 'pending', 'overdue'],
  projectScope: { mode: 'include', projectIds: [10] },
};
rendering.renderTodos();
assert.match(todoList.innerHTML, /data-test-todo="1"/, 'Today aggregate list must retain todos inside the configured dashboard project scope');
assert.doesNotMatch(todoList.innerHTML, /data-test-todo="3"/, 'Today aggregate list must exclude todos outside the configured dashboard project scope');

renderingTodayFocus = false;
renderingDrilldown = 'pending';
searchInput.value = 'match';
rendering.renderTodos();
assert.match(todoList.innerHTML, /data-test-todo="1"/, 'search with a drilldown must retain matching todos inside the configured dashboard project scope');
assert.match(todoList.innerHTML, /data-test-todo="3"/, 'search with a drilldown must ignore the dashboard project scope');
assert.doesNotMatch(todoList.innerHTML, /data-test-todo="2"/, 'search with a drilldown must still apply the drilldown metric filter');
searchInput.value = '';
renderingDrilldown = null;

const todoRendering = fs.readFileSync(new URL('../web/static/js/features/todo-rendering.js', import.meta.url), 'utf8');
assert.match(todoRendering, /data-priority=/, 'todo cards must expose priority for minimal-mode attention styling');
assert.match(todoRendering, /minimal-attention/, 'today and overdue dates must expose an attention class');

const minimalCss = fs.readFileSync(new URL('../web/static/css/90-minimal-list.css', import.meta.url), 'utf8');
assert.match(minimalCss, /\.todo-item\.done/, 'minimal mode must hide completed todos');
assert.match(minimalCss, /data-priority="1"/, 'minimal mode must preserve very-high-priority signals');
assert.match(minimalCss, /data-priority="2"/, 'minimal mode must preserve high-priority signals');
assert.match(minimalCss, /\.todo-meta-chip:not\(\.minimal-attention\)/, 'minimal mode must hide secondary metadata while retaining urgent dates');

const indexHtml = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
assert.match(indexHtml, /id="today-focus-btn"[^>]*>[\s\S]*?data-icon="calendar-days"/, 'the Today button must use a calendar icon');
assert.match(indexHtml, /id="minimal-todos-btn"[^>]*>[\s\S]*?data-icon="leaf"/, 'the Calm button must use a quiet leaf icon');

const de = JSON.parse(fs.readFileSync(new URL('../web/static/i18n/de.json', import.meta.url), 'utf8'));
const en = JSON.parse(fs.readFileSync(new URL('../web/static/i18n/en.json', import.meta.url), 'utf8'));
assert.equal(de['todayFocus.short'], 'Heute');
assert.equal(de['minimalTodos.short'], 'Ruhe');
assert.equal(en['todayFocus.short'], 'Today');
assert.equal(en['minimalTodos.short'], 'Calm');

console.log('✅ Minimal mode contract passed');
