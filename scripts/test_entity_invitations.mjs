#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  createEntityInvitationsFeature,
  renderEntityInvitationRows,
} from '../web/static/js/features/entity-invitations.js';
import { createShoppingNavigationFeature } from '../web/static/js/features/shopping-navigation.js';
import { createSyncController } from '../web/static/js/features/sync-controller.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const refreshResult = { refreshed: true, revision: 4 };
let authoritativeRefreshCommits = 0;
const syncController = createSyncController({
  syncFeature: {
    isOnlineForSync: () => true,
    refreshFromServer: async () => refreshResult,
  },
  syncInProgressRef: { value: false },
  getWsState: () => 'connected',
  updateConnectionStatusView: async () => {},
  setSyncInProgress: () => {},
  ensureCurrentWorkspace: () => {},
  renderWorkspaces: () => {},
  renderProjects: () => {},
  renderStats: () => {},
  renderTodos: () => {},
  onAuthoritativeRefreshCommitted: () => { authoritativeRefreshCommits += 1; },
});
assert.equal(
  await syncController.refreshFromServer(),
  refreshResult,
  'the sync controller must forward the refresh result unchanged',
);
assert.equal(authoritativeRefreshCommits, 1, 'a successful authoritative refresh must open a new eviction generation');

const renders = [];
const responses = [];
const projections = [];
let authoritativeLoads = 0;
let online = true;
const feature = createEntityInvitationsFeature({
  entityType: 'shopping-list',
  listInvitations: async () => ({ invitations: [{ id: 7, entityId: 41, name: 'Market' }] }),
  respondInvitation: async (invitation, accept) => { responses.push([invitation.id, accept]); },
  loadAuthoritativeProjection: async invitation => {
    authoritativeLoads += 1;
    return { id: invitation.entityId, name: invitation.name, can_edit: true };
  },
  applyAuthoritativeProjection: projection => { projections.push(projection); },
  isOnline: () => online,
  render: state => { renders.push(structuredClone(state)); },
});

await feature.load();
assert.deepEqual(feature.snapshot().invitations.map(invite => invite.name), ['Market']);
const acceptPromise = feature.respond(7, true);
assert.equal(feature.snapshot().busyIds.includes('7'), true, 'accept must mark the invitation busy synchronously');
assert.equal(await feature.respond(7, true), false, 'a busy invitation must reject duplicate activation');
await acceptPromise;
assert.deepEqual(responses, [[7, true]], 'accept must be single-flight');
assert.equal(authoritativeLoads, 1, 'accept must load the authoritative domain projection');
assert.deepEqual(projections, [{ id: 41, name: 'Market', can_edit: true }]);
assert.deepEqual(feature.snapshot().invitations, [], 'accept removes the invitation only after projection application');

feature.setInvitations([{ id: 8, entityId: 42, name: 'Weekend' }]);
online = false;
assert.equal(await feature.respond(8, false), false, 'offline responses must be rejected');
assert.equal(feature.snapshot().invitations.length, 1, 'offline decline must keep the row');
assert.equal(feature.snapshot().errors['8'], 'entity.invitation.error.onlineOnly');
assert.deepEqual(responses, [[7, true]], 'offline responses must not call the API');

online = true;
const failing = createEntityInvitationsFeature({
  entityType: 'project',
  respondInvitation: async () => { throw new Error('network'); },
  render: () => {},
});
failing.setInvitations([{ id: 9, entityId: 99, name: 'Roadmap' }]);
assert.equal(await failing.respond(9, false), false);
assert.equal(failing.snapshot().invitations.length, 1, 'failed decline must keep the row');
assert.equal(failing.snapshot().errors['9'], 'entity.invitation.error.respondFailed');

const lateResponse = deferred();
let staleResponseCalls = 0;
let staleProjectionCalls = 0;
const stale = createEntityInvitationsFeature({
  entityType: 'project',
  respondInvitation: () => { staleResponseCalls += 1; return staleResponseCalls === 1 ? lateResponse.promise : Promise.resolve(); },
  loadAuthoritativeProjection: async () => { staleProjectionCalls += 1; return { id: 1 }; },
  applyAuthoritativeProjection: () => {},
  render: () => {},
});
stale.setInvitations([{ id: 10, entityId: 1, name: 'Old' }]);
const staleMutation = stale.respond(10, true);
stale.destroy();
lateResponse.resolve({});
assert.equal(await staleMutation, false, 'a response from an older generation must be ignored');
stale.setInvitations([{ id: 10, entityId: 1, name: 'Reused' }]);
assert.equal(await stale.respond(10, true), true, 'a reused feature must perform a fresh server transition after destroy');
assert.equal(staleResponseCalls, 2);
assert.equal(staleProjectionCalls, 1);

const realtimeResponse = deferred();
let realtimeCalls = 0;
const realtime = createEntityInvitationsFeature({
  entityType: 'project',
  respondInvitation: async () => { realtimeCalls += 1; await realtimeResponse.promise; },
  loadAuthoritativeProjection: async () => ({ id: 3 }),
  applyAuthoritativeProjection: () => {},
  render: () => {},
});
realtime.setInvitations([{ id: 14, entityId: 3, name: 'Realtime' }]);
const realtimeMutation = realtime.respond(14, true);
realtime.setInvitations([{ id: 14, entityId: 3, name: 'Realtime' }]);
const realtimeLoad = realtime.load();
assert.deepEqual(realtime.snapshot().busyIds, ['14'], 'a realtime snapshot must not unlock an in-flight response');
assert.equal(await realtimeLoad.then(result => result.ok), true, 'a concurrent invitation load must be queued without invalidating the response');
assert.equal(await realtime.respond(14, true), false, 'a realtime snapshot must not permit a duplicate response');
realtimeResponse.resolve({});
assert.equal(await realtimeMutation, true, 'the successful response must survive the realtime snapshot');
assert.equal(realtimeCalls, 1);
assert.deepEqual(realtime.snapshot().invitations, []);

const staleLoadResponse = deferred();
const staleLoad = createEntityInvitationsFeature({
  entityType: 'project',
  listInvitations: () => staleLoadResponse.promise,
  render: () => {},
});
const oldLoad = staleLoad.load();
staleLoad.setInvitations([{ id: 51, entityId: 8, name: 'New realtime state' }]);
staleLoadResponse.resolve({ invitations: [{ id: 50, entityId: 7, name: 'Old REST state' }] });
assert.equal((await oldLoad).stale, true, 'a newer realtime snapshot must invalidate an older REST load');
assert.deepEqual(staleLoad.snapshot().invitations.map(invite => invite.id), [51]);

const parallelFirst = deferred();
const parallelSecond = deferred();
const parallel = createEntityInvitationsFeature({
  entityType: 'shopping-list',
  respondInvitation: invitation => invitation.id === 16 ? parallelFirst.promise : parallelSecond.promise,
  loadAuthoritativeProjection: async invitation => ({ id: invitation.entityId }),
  applyAuthoritativeProjection: () => {},
  render: () => {},
});
parallel.setInvitations([
  { id: 16, entityId: 6, name: 'First' },
  { id: 17, entityId: 7, name: 'Second' },
]);
const firstMutation = parallel.respond(16, true);
const secondMutation = parallel.respond(17, true);
parallelFirst.resolve({});
assert.equal(await firstMutation, true);
assert.deepEqual(parallel.snapshot().busyIds, ['17'], 'completing one invitation must not invalidate another in-flight response');
parallelSecond.resolve({});
assert.equal(await secondMutation, true);
assert.deepEqual(parallel.snapshot().busyIds, []);
assert.deepEqual(parallel.snapshot().invitations, []);

const firstProjection = deferred();
const secondProjection = deferred();
const projectionStarts = [];
const projectionApplications = [];
const serializedProjection = createEntityInvitationsFeature({
  entityType: 'project',
  respondInvitation: async () => {},
  loadAuthoritativeProjection: invitation => {
    projectionStarts.push(invitation.id);
    return invitation.id === 61 ? firstProjection.promise : secondProjection.promise;
  },
  applyAuthoritativeProjection: projection => { projectionApplications.push(projection); },
  render: () => {},
});
serializedProjection.setInvitations([
  { id: 61, entityId: 11, name: 'First projection' },
  { id: 62, entityId: 12, name: 'Second projection' },
]);
const serializedFirst = serializedProjection.respond(61, true);
const serializedSecond = serializedProjection.respond(62, true);
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(projectionStarts, [61], 'full authoritative projections must be fetched and applied serially');
firstProjection.resolve({ revision: 1 });
for (let index = 0; index < 10 && projectionStarts.length < 2; index += 1) await Promise.resolve();
assert.deepEqual(projectionStarts, [61, 62]);
secondProjection.resolve({ revision: 2 });
assert.equal(await serializedFirst, true);
assert.equal(await serializedSecond, true);
assert.deepEqual(projectionApplications, [{ revision: 1 }, { revision: 2 }]);

const destroyFirstProjection = deferred();
const destroyProjectionStarts = [];
const destroyQueuedProjection = createEntityInvitationsFeature({
  entityType: 'project',
  respondInvitation: async () => {},
  loadAuthoritativeProjection: invitation => {
    destroyProjectionStarts.push(invitation.id);
    return invitation.id === 71 ? destroyFirstProjection.promise : Promise.resolve({ id: invitation.entityId });
  },
  applyAuthoritativeProjection: () => {},
  render: () => {},
});
destroyQueuedProjection.setInvitations([
  { id: 71, entityId: 21, name: 'First destroy projection' },
  { id: 72, entityId: 22, name: 'Queued destroy projection' },
]);
void destroyQueuedProjection.respond(71, true);
void destroyQueuedProjection.respond(72, true);
for (let index = 0; index < 10 && destroyProjectionStarts.length < 1; index += 1) await Promise.resolve();
destroyQueuedProjection.destroy();
destroyQueuedProjection.setInvitations([{ id: 73, entityId: 23, name: 'New lifecycle projection' }]);
const destroyNewProjection = destroyQueuedProjection.respond(73, true);
for (let index = 0; index < 10 && destroyProjectionStarts.length < 2; index += 1) await Promise.resolve();
assert.deepEqual(destroyProjectionStarts, [71, 73], 'new lifecycle projections must not wait for an old destroyed chain');
assert.equal(await destroyNewProjection, true);
destroyFirstProjection.resolve({ id: 21 });
for (let index = 0; index < 10; index += 1) await Promise.resolve();
assert.deepEqual(destroyProjectionStarts, [71, 73], 'destroy must prevent queued old projections from starting');

let projectionErrors = 0;
let projectionAttempts = 0;
let projectionResponses = 0;
const projectionFailure = createEntityInvitationsFeature({
  entityType: 'shopping-list',
  respondInvitation: async () => { projectionResponses += 1; },
  loadAuthoritativeProjection: async () => {
    projectionAttempts += 1;
    if (projectionAttempts === 1) throw new Error('projection unavailable');
    return { id: 4 };
  },
  applyAuthoritativeProjection: () => {},
  onProjectionError: () => { projectionErrors += 1; },
  render: () => {},
});
projectionFailure.setInvitations([{ id: 15, entityId: 4, name: 'Accepted' }]);
assert.equal(await projectionFailure.respond(15, true), false, 'projection failure must keep a committed invitation recoverable');
assert.equal(projectionErrors, 1);
assert.deepEqual(projectionFailure.snapshot().invitations.map(invite => invite.id), [15]);
assert.equal(projectionFailure.snapshot().errors['15'], 'entity.invitation.error.respondFailed');
assert.equal(await projectionFailure.respond(15, false), false, 'a committed accept cannot be converted into a decline during projection recovery');
assert.deepEqual(projectionFailure.snapshot().invitations.map(invite => invite.id), [15]);
assert.equal(await projectionFailure.respond(15, true), true, 'retry must recover the authoritative projection');
assert.equal(projectionResponses, 1, 'projection retry must not repeat the committed server transition');
assert.deepEqual(projectionFailure.snapshot().invitations, []);

let disappearingEvictionResolve;
let disappearingEvictionOptions;
const disappearingRoot = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
const disappearingEvictionNavigation = createShoppingNavigationFeature({
  root: disappearingRoot,
  eventTarget: { addEventListener() {}, removeEventListener() {} },
  getLists: () => [],
  getStores: () => [],
  removePendingEntities: (_ids, options) => {
    disappearingEvictionOptions = options;
    return new Promise(resolve => { disappearingEvictionResolve = resolve; });
  },
});
disappearingEvictionNavigation.setInvites([{ id: 81, entity_id: 9, entity_name: 'Pending list' }]);
assert.equal(disappearingEvictionOptions.signal.aborted, false);
disappearingEvictionNavigation.setInvites([]);
assert.equal(
  disappearingEvictionOptions.signal.aborted,
  false,
  'a disappeared or revoked invitation must not cancel privacy eviction',
);
disappearingEvictionResolve();
await Promise.resolve();

let unappliedEvictionOptions;
const unappliedEvictionNavigation = createShoppingNavigationFeature({
  root: disappearingRoot,
  eventTarget: { addEventListener() {}, removeEventListener() {} },
  getLists: () => [],
  getStores: () => [],
  shoppingApi: { respondInvite: async () => {} },
  loadAuthoritativeProjection: async () => null,
  removePendingEntities: (_ids, options) => {
    unappliedEvictionOptions = options;
    return new Promise(() => {});
  },
});
unappliedEvictionNavigation.setInvites([{ id: 84, entity_id: 10, entity_name: 'Unapplied list' }]);
assert.equal(
  await unappliedEvictionNavigation.respondInvite(84, true),
  false,
  'an accept without an applicable authoritative projection must stay retryable',
);
assert.equal(
  unappliedEvictionOptions.signal.aborted,
  false,
  'an unapplied authoritative projection must not cancel privacy eviction',
);

let acceptedEvictionOptions;
let acceptedEvictionResolve;
const acceptedEvictionNavigation = createShoppingNavigationFeature({
  root: disappearingRoot,
  getElementById: () => null,
  storage: { getItem: () => null, setItem() {}, removeItem() {} },
  historyTarget: null,
  locationTarget: { search: '', pathname: '/', hash: '' },
  eventTarget: { addEventListener() {}, removeEventListener() {} },
  getLists: () => [],
  getStores: () => [],
  shoppingApi: {
    respondInvite: async () => {},
  },
  loadAuthoritativeProjection: async () => [{ id: 9, name: 'Accepted list' }],
  removePendingEntities: (_ids, options) => {
    acceptedEvictionOptions = options;
    return new Promise(resolve => { acceptedEvictionResolve = resolve; });
  },
});
acceptedEvictionNavigation.setInvites([{ id: 82, entity_id: 9, entity_name: 'Accepted list' }]);
assert.equal(await acceptedEvictionNavigation.respondInvite(82, true), true);
assert.equal(
  acceptedEvictionOptions.signal.aborted,
  true,
  'a successful accept may cancel its matching old eviction only after applying the authoritative projection',
);
acceptedEvictionResolve();

const revokedAcceptProjection = deferred();
let revokedAcceptProjectionStarted = false;
let revokedAcceptEvictionOptions;
const revokedAcceptAppliedLists = [];
const revokedAcceptNavigation = createShoppingNavigationFeature({
  root: disappearingRoot,
  eventTarget: { addEventListener() {}, removeEventListener() {} },
  getLists: () => [],
  getStores: () => [],
  setLists: lists => { revokedAcceptAppliedLists.push(structuredClone(lists)); },
  shoppingApi: { respondInvite: async () => {} },
  loadAuthoritativeProjection: () => {
    revokedAcceptProjectionStarted = true;
    return revokedAcceptProjection.promise;
  },
  removePendingEntities: (_ids, options) => {
    revokedAcceptEvictionOptions = options;
    return new Promise(() => {});
  },
});
revokedAcceptNavigation.setInvites([{ id: 85, entity_id: 13, entity_name: 'Revoked private list' }]);
const revokedAccept = revokedAcceptNavigation.respondInvite(85, true);
for (let index = 0; index < 10 && !revokedAcceptProjectionStarted; index += 1) await Promise.resolve();
assert.equal(revokedAcceptProjectionStarted, true, 'accept must reach the deferred authoritative projection');
revokedAcceptNavigation.setInvites([]);
revokedAcceptProjection.resolve([{ id: 13, name: 'Stale private list' }]);
assert.equal(await revokedAccept, false, 'a projection older than an authoritative revocation must be discarded');
assert.deepEqual(
  revokedAcceptAppliedLists,
  [],
  'the late private projection must not be applied or resurrect revoked shopping data',
);
assert.equal(
  revokedAcceptEvictionOptions.signal.aborted,
  false,
  'the late stale projection must not cancel the running privacy eviction',
);
assert.equal(
  await revokedAcceptNavigation.respondInvite(85, true),
  false,
  'the newer authoritative empty invitation snapshot must remain reconciled after the stale accept settles',
);

const rejectedRevokedProjection = deferred();
let rejectedRevokedProjectionStarted = false;
let rejectedRevokedEvictionOptions;
const rejectedRevokedAppliedLists = [];
const rejectedRevokedSection = { hidden: true };
const rejectedRevokedList = { innerHTML: '' };
const rejectedRevokedRoot = {
  getElementById: id => ({
    'shopping-invites-section': rejectedRevokedSection,
    'shopping-invites-list': rejectedRevokedList,
  })[id] || null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
const rejectedRevokedNavigation = createShoppingNavigationFeature({
  root: rejectedRevokedRoot,
  eventTarget: { addEventListener() {}, removeEventListener() {} },
  getLists: () => [],
  getStores: () => [],
  setLists: lists => { rejectedRevokedAppliedLists.push(structuredClone(lists)); },
  shoppingApi: { respondInvite: async () => {} },
  loadAuthoritativeProjection: () => {
    rejectedRevokedProjectionStarted = true;
    return rejectedRevokedProjection.promise;
  },
  removePendingEntities: (_ids, options) => {
    rejectedRevokedEvictionOptions = options;
    return new Promise(() => {});
  },
});
rejectedRevokedNavigation.setInvites([{ id: 86, entity_id: 14, entity_name: 'Rejected revoked list' }]);
const rejectedRevokedAccept = rejectedRevokedNavigation.respondInvite(86, true);
for (let index = 0; index < 10 && !rejectedRevokedProjectionStarted; index += 1) await Promise.resolve();
assert.equal(rejectedRevokedProjectionStarted, true, 'accept must commit before the deferred projection rejects');
rejectedRevokedNavigation.setInvites([]);
rejectedRevokedProjection.reject(new Error('stale private projection rejected'));
assert.equal(await rejectedRevokedAccept, false, 'a rejected projection superseded by a newer snapshot must be ignored');
assert.equal(rejectedRevokedSection.hidden, true, 'the newer authoritative empty invitation snapshot must win');
assert.equal(rejectedRevokedList.innerHTML, '', 'the revoked invitation must not be restored after the stale rejection');
assert.doesNotMatch(rejectedRevokedList.innerHTML, /entity\.invitation\.error\.respondFailed/, 'a superseded operation must not publish respondFailed');
assert.deepEqual(rejectedRevokedAppliedLists, [], 'a rejected stale private projection must not be applied');
assert.equal(
  rejectedRevokedEvictionOptions.signal.aborted,
  false,
  'a stale projection rejection must not cancel the running privacy eviction',
);
assert.equal(
  await rejectedRevokedNavigation.respondInvite(86, true),
  false,
  'the current empty snapshot must remain authoritative after the stale projection rejects',
);

let repeatedEvictions = 0;
const repeatedEvictionNavigation = createShoppingNavigationFeature({
  root: disappearingRoot,
  eventTarget: { addEventListener() {}, removeEventListener() {} },
  getLists: () => [],
  getStores: () => [],
  removePendingEntities: async () => { repeatedEvictions += 1; },
});
repeatedEvictionNavigation.setInvites([{ id: 83, entity_id: 12, entity_name: 'Still pending' }]);
await Promise.resolve();
await Promise.resolve();
repeatedEvictionNavigation.commitAuthoritativeSnapshot();
await Promise.resolve();
await Promise.resolve();
assert.equal(
  repeatedEvictions,
  2,
  'a later authoritative invitation snapshot must retry eviction for an entity that is still pending',
);

const projectionAppSource = readFileSync(new URL('../web/static/js/app.js', import.meta.url), 'utf8');
assert.match(projectionAppSource, /if \(!result\?\.refreshed\) throw new Error\('Authoritative project projection was not refreshed'\)/);
assert.match(projectionAppSource, /if \(!result\?\.refreshed\) throw new Error\('Authoritative shopping projection was not refreshed'\)/);

const lateProjection = deferred();
const ordering = [];
const ordered = createEntityInvitationsFeature({
  entityType: 'shopping-list',
  respondInvitation: async () => { ordering.push('responded'); },
  loadAuthoritativeProjection: () => lateProjection.promise,
  applyAuthoritativeProjection: value => { ordering.push(`applied:${value.id}`); },
  render: state => { ordering.push(`render:${state.invitations.length}`); },
});
ordered.setInvitations([{ id: 12, entityId: 5, name: 'Slow' }]);
const orderedAccept = ordered.respond(12, true);
await Promise.resolve();
assert.equal(ordered.snapshot().invitations.length, 1, 'accepted row remains until authoritative loading finishes');
lateProjection.resolve({ id: 5 });
await orderedAccept;
assert.ok(ordering.indexOf('applied:5') < ordering.lastIndexOf('render:0'), 'projection must apply before the row disappears');

const rendered = renderEntityInvitationRows({
  entityType: 'shopping-list',
  invitations: [{ id: 'a&b', entityId: 'list<1', name: '<Groceries>' }],
  busyIds: ['a&b'],
  errors: { 'a&b': 'entity.invitation.error.respondFailed' },
  translate: (key, vars) => vars?.name ? `${key}:${vars.name}` : key,
  renderIcon: name => `<i>${name}</i>`,
});
assert.match(rendered, /data-entity-invitation-action="accept"/);
assert.match(rendered, /data-entity-type="shopping-list"/);
assert.match(rendered, /disabled/);
assert.match(rendered, /&lt;Groceries&gt;/);
assert.doesNotMatch(rendered, /data-project-sharing-action/);

const projectSharingSource = readFileSync(new URL('../web/static/js/features/project-sharing.js', import.meta.url), 'utf8');
const shoppingNavigationSource = readFileSync(new URL('../web/static/js/features/shopping-navigation.js', import.meta.url), 'utf8');
const shoppingApiSource = readFileSync(new URL('../web/static/js/api/shopping.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../web/static/js/app.js', import.meta.url), 'utf8');
const tasksModuleSource = readFileSync(new URL('../web/static/js/modules/tasks.js', import.meta.url), 'utf8');
const shoppingModuleSource = readFileSync(new URL('../web/static/js/modules/shopping.js', import.meta.url), 'utf8');
assert.match(projectSharingSource, /createEntityInvitationsFeature/, 'Projects must use the shared invitation state machine');
assert.match(shoppingNavigationSource, /createEntityInvitationsFeature/, 'Shopping must use the shared invitation state machine');
assert.match(shoppingApiSource, /\/api\/entity-sharing\/invites/, 'Shopping invite discovery must use the generic entity-sharing endpoint');
assert.match(shoppingApiSource, /\/api\/shopping\/lists\/\$\{encodeURIComponent\(listId\)\}\/invites/, 'Shopping invite responses must remain adapter-compatible with the thin domain route');
assert.match(shoppingNavigationSource, /removePendingEntities/, 'Shopping invite rendering must evict pending entities from the normal projection');
assert.match(appSource, /evictPendingShoppingEntities/, 'Pending Shopping entities must be evicted atomically from IndexedDB');
assert.match(appSource, /remainingStores/, 'Pending Shopping eviction must remove list-scoped stores from memory');
assert.match(shoppingNavigationSource, /createEntityAccessPrivacyController/, 'Shopping must use the shared retryable privacy controller');
assert.match(projectSharingSource, /createEntityAccessPrivacyController/, 'Projects must use the same retryable privacy controller');
assert.doesNotMatch(projectSharingSource, /data-project-sharing-action="(?:accept|decline)-invite"/, 'Project invitation actions must be neutral');
assert.match(tasksModuleSource, /entity-invitations-section/, 'Tasks must host the neutral invitation renderer');
assert.match(shoppingModuleSource, /entity-invitations-section[\s\S]*shopping-invites-section/, 'Shopping invitations must have a Shopping-sidebar host');

const fixtureSource = `
  import { createEntityInvitationsFeature, renderEntityInvitationsHost } from '/static/js/features/entity-invitations.js';
  document.body.innerHTML = '<div id="app"><aside class="sidebar"><nav id="shopping-invites-section" class="nav-section entity-invitations-section" hidden><div class="nav-title">Invites</div><div id="shopping-invites-list"></div></nav></aside></div>';
  let release;
  const feature = createEntityInvitationsFeature({
    entityType: 'shopping-list',
    root: document,
    respondInvitation: () => new Promise(resolve => { release = resolve; }),
    loadAuthoritativeProjection: async invite => [{ id: invite.entityId, name: invite.name }],
    applyAuthoritativeProjection: () => {},
    render: state => renderEntityInvitationsHost({ document, sectionId: 'shopping-invites-section', listId: 'shopping-invites-list', entityType: 'shopping-list', state }),
  });
  feature.bind();
  feature.setInvitations([{ id: 21, entityId: 55, name: 'Weekend' }]);
  window.testInvitations = { resolve: () => release?.() };
`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
try {
  await page.route('http://nia.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/static/style.css"></head><body><script type="module" src="/fixture.js"></script></body></html>' });
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: fixtureSource });
    if (url.pathname.startsWith('/static/')) {
      try {
        const body = readFileSync(new URL(`../web${url.pathname}`, import.meta.url), 'utf8');
        return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : (url.pathname.endsWith('.json') ? 'application/json' : 'text/javascript'), body });
      } catch {
        return route.fulfill({ status: 404 });
      }
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('http://nia.test/');
  const section = page.locator('#shopping-invites-section');
  await section.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.entity-invitation-item').count(), 1);
  await page.locator('[data-entity-invitation-action="accept"]').click();
  assert.equal(await page.locator('.invite-action:disabled').count(), 2, 'busy state must disable both actions');
  await page.evaluate(() => { document.getElementById('app').dataset.desktopSidebarMode = 'rail'; });
  assert.equal(await section.isHidden(), true, 'invitation sections must stay hidden in desktop rail mode');
  await page.evaluate(() => { document.getElementById('app').dataset.desktopSidebarMode = 'expanded'; window.testInvitations.resolve(); });
  await section.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 390, height: 700 });
  assert.equal(await section.isHidden(), true, 'an empty invitation section must stay hidden on mobile');
} finally {
  await browser.close();
}

console.log('✅ Shared entity invitation state machine passed');
