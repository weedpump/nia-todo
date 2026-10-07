#!/usr/bin/env node
import assert from 'node:assert/strict';

const storage = new Map([
  ['jwt_token', 'header.payload.signature'],
]);

globalThis.window = {};
globalThis.isTauri = true;
globalThis.location = { origin: 'http://tauri.localhost', search: '' };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32', maxTouchPoints: 0 },
});
globalThis.localStorage = {
  getItem(key) { return storage.get(key) ?? null; },
};

const requests = [];
const responses = [];
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, options });
  return responses.shift() || { ok: true, blob: async () => new Blob(['avatar']) };
};

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
let objectUrlSequence = 0;
const revokedObjectUrls = [];
URL.createObjectURL = () => `blob:dashboard-avatar-${++objectUrlSequence}`;
URL.revokeObjectURL = url => revokedObjectUrls.push(url);

function deferredResponse() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

function createAvatarNode() {
  return {
    dataset: {},
    src: '',
    replaceWith() {},
  };
}

const statsBar = {
  hidden: false,
  _innerHTML: '',
  avatar: null,
  set innerHTML(value) {
    this._innerHTML = value;
    this.avatar = value.includes('data-auth-avatar') ? createAvatarNode() : null;
    if (this.avatar) {
      this.avatar.replaceWith = replacement => {
        this.avatar = replacement;
      };
    }
  },
  get innerHTML() {
    return this._innerHTML;
  },
  querySelector(selector) {
    return selector === '[data-auth-avatar]' ? this.avatar : null;
  },
};

const countNodes = new Map();
globalThis.document = {
  getElementById(id) {
    if (id === 'stats-bar') return statsBar;
    if (id === 'search-input') return null;
    if (!countNodes.has(id)) countNodes.set(id, { textContent: '' });
    return countNodes.get(id);
  },
  querySelectorAll() {
    return [];
  },
};

try {
  const { createAppRenderingFeature } = await import('../web/static/js/features/app-rendering.js');
  let currentFilter = 'all';
  let dashboardPreferences = {
    compactDisplay: false,
    showFocus: true,
    showActiveProjects: true,
    showProjectWidgets: true,
    projectScope: { mode: 'all', projectIds: [], includeUnassigned: true },
    stats: ['total', 'pending', 'in_progress', 'overdue'],
    focusItems: ['overdue', 'due_today', 'due_week'],
    hideEmptyFocusItems: true,
    activeProjects: { limit: 4, sort: 'recent' },
  };
  const currentUser = {
    display_name: 'Tobi',
    avatar_url: '/api/me/avatar',
    avatar_updated_at: '2026-10-02T08:00:00Z',
  };
  const { renderStats } = createAppRenderingFeature({
    appVersion: 'test',
    escapeHtml: value => String(value),
    escapeHtmlAttr: value => String(value),
    getTodos: () => [],
    getProjects: () => [],
    getSections: () => [],
    getCurrentFilter: () => currentFilter,
    getCurrentProjectId: () => null,
    getCurrentWorkspaceId: () => null,
    getCurrentUser: () => currentUser,
    getDashboardPreferences: () => dashboardPreferences,
    getMinimalTodos: () => false,
    getFocusFilters: () => ({}),
    sortTodoList: items => items,
    renderTodoItem: () => '',
    renderSectionHeader: () => '',
  });

  console.log('🖼️ Running dashboard avatar refresh regression test...');
  renderStats();
  await new Promise(resolve => setTimeout(resolve, 0));
  const firstAvatar = statsBar.avatar;

  renderStats();
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(requests.length, 1, 'unchanged dashboard avatars must not be fetched again during periodic stats rendering');
  assert.equal(statsBar.avatar, firstAvatar, 'periodic stats rendering must preserve the existing avatar element');
  assert.equal(statsBar.avatar.src, 'blob:dashboard-avatar-1');

  dashboardPreferences = {
    ...dashboardPreferences,
    compactDisplay: true,
    stats: ['done', 'due_today', 'pending', 'overdue'],
  };
  renderStats();
  assert.match(statsBar.innerHTML, /data-dashboard-compact="true"/);
  assert.doesNotMatch(statsBar.innerHTML, /overview-subtitle/);
  assert.match(statsBar.innerHTML, /overview-detail-grid/, 'compact display must not override independently enabled dashboard sections');
  const metricOrder = [...statsBar.innerHTML.matchAll(/data-dashboard-metric="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(metricOrder, ['done', 'due_today', 'pending', 'overdue']);
  dashboardPreferences = { ...dashboardPreferences, compactDisplay: false };

  currentUser.avatar_updated_at = '2026-10-02T09:00:00Z';
  renderStats();
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(requests.length, 2, 'a changed avatar version must be fetched');
  assert.notEqual(statsBar.avatar, firstAvatar, 'a changed avatar version must replace the old image element');
  assert.equal(statsBar.avatar.src, 'blob:dashboard-avatar-2');
  assert.deepEqual(revokedObjectUrls, ['blob:dashboard-avatar-1'], 'replacing an avatar must release its old object URL');

  currentUser.avatar_updated_at = '2026-10-02T10:00:00Z';
  responses.push({ ok: false });
  renderStats();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests.length, 3, 'the first request for another avatar version must run');

  renderStats();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests.length, 4, 'a failed avatar request must be retried during the next stats rendering');
  assert.equal(statsBar.avatar.src, 'blob:dashboard-avatar-3');

  currentUser.avatar_updated_at = '2026-10-02T11:00:00Z';
  const pendingSameVersion = deferredResponse();
  responses.push(pendingSameVersion.promise);
  renderStats();
  const pendingAvatar = statsBar.avatar;
  renderStats();
  assert.equal(requests.length, 5, 'an unchanged avatar request already in flight must not be duplicated');
  assert.equal(statsBar.avatar, pendingAvatar, 'an in-flight avatar element must survive periodic rendering');
  pendingSameVersion.resolve({ ok: true, blob: async () => new Blob(['pending-avatar']) });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(pendingAvatar.src, 'blob:dashboard-avatar-4');

  currentUser.avatar_updated_at = '2026-10-02T12:00:00Z';
  const staleRequest = deferredResponse();
  responses.push(staleRequest.promise);
  renderStats();
  const staleAvatar = statsBar.avatar;

  currentUser.avatar_updated_at = '2026-10-02T13:00:00Z';
  renderStats();
  await new Promise(resolve => setTimeout(resolve, 0));
  const currentAvatar = statsBar.avatar;
  staleRequest.resolve({ ok: true, blob: async () => new Blob(['stale-avatar']) });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.notEqual(currentAvatar, staleAvatar, 'a newer avatar version must replace an older in-flight element');
  assert.ok(staleAvatar.src, 'the stale request must have produced an object URL for cleanup verification');
  assert.ok(revokedObjectUrls.includes(staleAvatar.src), 'a stale in-flight avatar result must release its object URL');

  currentFilter = 'pending';
  renderStats();
  assert.equal(statsBar.avatar, null, 'leaving the dashboard must remove its avatar element');
  assert.ok(revokedObjectUrls.includes(currentAvatar.src), 'leaving the dashboard must release the displayed avatar object URL');

  console.log('✅ Dashboard avatar remains stable across periodic stats rendering');
} finally {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
}
