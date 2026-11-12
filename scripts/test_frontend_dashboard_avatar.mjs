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
const decodeResponses = [];
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, options });
  return responses.shift() || { ok: true, blob: async () => new Blob(['avatar']) };
};

// Exercise actor-scoped avatar caching through the real readiness controller.
const avatarRecords = new Map();
globalThis.indexedDB = {
  open() {
    const request = {};
    const database = {
      close() {},
      transaction(name) {
        assert.equal(name, 'avatars');
        const tx = {};
        tx.objectStore = () => ({
          get(id) {
            const result = {};
            queueMicrotask(() => { result.result = avatarRecords.get(id) || null; result.onsuccess?.(); });
            return result;
          },
          put(record) { avatarRecords.set(record.id, record); },
          delete(id) { avatarRecords.delete(id); },
        });
        queueMicrotask(() => tx.oncomplete?.());
        return tx;
      },
    };
    queueMicrotask(() => request.onsuccess?.({ target: { result: database } }));
    return request;
  },
  deleteDatabase() {
    const request = {};
    queueMicrotask(() => { avatarRecords.clear(); request.onsuccess?.(); });
    return request;
  },
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
  const classes = new Set();
  return {
    dataset: {},
    src: '',
    classList: {
      add(name) { classes.add(name); },
      contains(name) { return classes.has(name); },
    },
    decode() { return decodeResponses.shift() || Promise.resolve(); },
    removeAttribute(name) { if (name === 'src') this.src = ''; },
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
  const { openDatabase, closeAndDeleteDatabase } = await import('../web/static/js/storage/indexed-db.js');
  await openDatabase();
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
    id: 1,
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
  const firstDecode = deferredResponse();
  decodeResponses.push(firstDecode.promise);
  renderStats();
  assert.match(statsBar.innerHTML, /overview-avatar-initial">T<\/span>/, 'the initial remains available while the image is loading');
  assert.equal(statsBar.avatar.classList.contains('is-ready'), false, 'an image without bytes must not cover the initial');
  await new Promise(resolve => setTimeout(resolve, 0));
  const firstAvatar = statsBar.avatar;
  assert.equal(firstAvatar.src, 'blob:dashboard-avatar-1');
  assert.equal(firstAvatar.classList.contains('is-ready'), false, 'downloaded bytes must finish decoding before covering the initial');
  firstDecode.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(firstAvatar.classList.contains('is-ready'), true, 'the decoded image replaces the initial');

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
  assert.equal(statsBar.avatar.classList.contains('is-ready'), false, 'a failed image leaves the initial visible');

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
  await new Promise(resolve => setTimeout(resolve, 0));
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
  await new Promise(resolve => setTimeout(resolve, 0));

  currentUser.avatar_updated_at = '2026-10-02T13:00:00Z';
  renderStats();
  await new Promise(resolve => setTimeout(resolve, 0));
  const currentAvatar = statsBar.avatar;
  staleRequest.resolve({ ok: true, blob: async () => new Blob(['stale-avatar']) });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.notEqual(currentAvatar, staleAvatar, 'a newer avatar version must replace an older in-flight element');
  assert.equal(staleAvatar.src, '', 'a stale in-flight avatar result must never attach an object URL');

  currentFilter = 'pending';
  renderStats();
  assert.equal(statsBar.avatar, null, 'leaving the dashboard must remove its avatar element');
  assert.ok(!revokedObjectUrls.includes(currentAvatar.src), 'navigation away from the dashboard must retain the unchanged avatar object URL');

  const requestsBeforeReturn = requests.length;
  currentFilter = 'all';
  renderStats();
  assert.equal(statsBar.avatar, currentAvatar, 'returning to the dashboard must synchronously reuse the unchanged avatar element');
  assert.equal(statsBar.avatar.src, currentAvatar.src, 'the cached avatar must already be visible in the first render frame');
  assert.equal(requests.length, requestsBeforeReturn, 'returning to the dashboard must not fetch the unchanged avatar again');
  assert.equal(statsBar.avatar.classList.contains('is-ready'), true, 'returning to the dashboard preserves the decoded image state');

  currentUser.avatar_updated_at = '2026-10-02T14:00:00Z';
  const staleDecode = deferredResponse();
  decodeResponses.push(staleDecode.promise);
  renderStats();
  await new Promise(resolve => setTimeout(resolve, 0));
  const decodingAvatar = statsBar.avatar;
  assert.equal(decodingAvatar.classList.contains('is-ready'), false);
  currentUser.avatar_updated_at = '2026-10-02T15:00:00Z';
  renderStats();
  await new Promise(resolve => setTimeout(resolve, 0));
  const newestAvatar = statsBar.avatar;
  staleDecode.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(decodingAvatar.classList.contains('is-ready'), false, 'a late decode must not reveal a replaced image');
  assert.equal(newestAvatar.classList.contains('is-ready'), true);

  const failedDecode = deferredResponse();
  decodeResponses.push(failedDecode.promise);
  currentUser.avatar_updated_at = '2026-10-02T16:00:00Z';
  renderStats();
  await new Promise(resolve => setTimeout(resolve, 0));
  failedDecode.resolve(Promise.reject(new Error('Invalid image bytes')));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(statsBar.avatar.classList.contains('is-ready'), false, 'decode failure keeps the initial visible');
  assert.equal(statsBar.avatar.src, '');
  const requestsBeforeDecodeRetry = requests.length;
  assert.equal(avatarRecords.size, 0, 'undecodable bytes must be removed from the persistent cache');
  renderStats();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests.length, requestsBeforeDecodeRetry + 1, 'decode failure must fetch fresh bytes instead of retrying the damaged cached blob');
  assert.equal(statsBar.avatar.classList.contains('is-ready'), true, 'a later render retries after a decode failure');

  const previousActorAvatar = statsBar.avatar;
  currentUser.id = 2;
  renderStats();
  assert.notEqual(statsBar.avatar, previousActorAvatar, 'the same avatar URL and timestamp cannot reuse another account image');
  assert.equal(statsBar.avatar.classList.contains('is-ready'), false, 'a changed account begins with its own initial');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(statsBar.avatar.classList.contains('is-ready'), true);

  const previousGenerationAvatar = statsBar.avatar;
  const beforeResetRequests = requests.length;
  await closeAndDeleteDatabase();
  await openDatabase();
  renderStats();
  assert.notEqual(statsBar.avatar, previousGenerationAvatar, 'a reset private cache cannot reuse an old account-lifecycle image');
  assert.equal(statsBar.avatar.classList.contains('is-ready'), false);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests.length, beforeResetRequests + 1, 'the new lifecycle resolves its own missing cached bytes');
  assert.equal(statsBar.avatar.classList.contains('is-ready'), true);

  const oldLifecycleResponse = deferredResponse();
  responses.push(oldLifecycleResponse.promise);
  currentUser.avatar_updated_at = '2026-10-02T17:00:00Z';
  renderStats();
  await new Promise(resolve => setTimeout(resolve, 0));
  const oldLifecyclePendingAvatar = statsBar.avatar;
  const beforePendingResetRequests = requests.length;
  await closeAndDeleteDatabase();
  await openDatabase();
  renderStats();
  assert.notEqual(statsBar.avatar, oldLifecyclePendingAvatar, 'a pending image from the previous database lifecycle is replaced too');
  await new Promise(resolve => setTimeout(resolve, 0));
  const restoredAvatar = statsBar.avatar;
  assert.equal(requests.length, beforePendingResetRequests + 1, 'new lifecycle consumers cannot join a previous lifecycle network request');
  assert.equal(restoredAvatar.classList.contains('is-ready'), true);
  oldLifecycleResponse.resolve({ ok: true, blob: async () => new Blob(['obsolete lifecycle']) });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(statsBar.avatar, restoredAvatar);
  assert.equal(oldLifecyclePendingAvatar.classList.contains('is-ready'), false);

  console.log('✅ Dashboard avatar remains stable across periodic rendering and navigation');
} finally {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
}
