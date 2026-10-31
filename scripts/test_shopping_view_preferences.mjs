#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createShoppingViewPreferencesFeature } from '../web/static/js/features/shopping-view-preferences.js';

function createHarness(initialLists) {
  let lists = structuredClone(initialLists);
  const commits = [];
  const events = [];
  let renderCount = 0;
  const feature = createShoppingViewPreferencesFeature({
    getLists: () => lists,
    setLists: next => { events.push('publish'); lists = structuredClone(next); },
    getActiveListId: () => lists[0]?.client_mutation_id ?? lists[0]?.id ?? null,
    commitMutation: async build => {
      const mutation = build();
      if (!mutation) return null;
      events.push('commit');
      commits.push(structuredClone(mutation));
      return mutation;
    },
    render: () => { renderCount += 1; },
    isOnlineForSync: () => false,
  });
  return { feature, getLists: () => lists, setLists: next => { lists = structuredClone(next); }, commits, events, getRenderCount: () => renderCount };
}

const viewer = createHarness([{
  id: 'list-1',
  can_edit: false,
  can_manage: false,
  preferences: { selected_store_id: 'store-7', hide_empty_sections: false },
  sections: [],
  items: [],
}]);
const updated = await viewer.feature.toggleHideEmptySections();
assert.equal(updated.preferences.hide_empty_sections, true, 'every authorized list viewer may change the personal view preference');
assert.deepEqual(viewer.events, ['commit', 'publish'], 'memory and UI publish only after the durable mutation commits');
assert.deepEqual(viewer.commits[0].data, {
  shopping_list_id: 'list-1',
  changes: { selected_store_id: 'store-7', hide_empty_sections: true },
}, 'the PUT-shaped queue mutation must preserve every neighboring preference field');
assert.equal(viewer.commits[0].action, 'UPDATE_SHOPPING_PREFERENCES');
assert.equal(viewer.getLists()[0].preferences.selected_store_id, 'store-7');
assert.equal(viewer.getRenderCount(), 1);

const temp = createHarness([{
  id: 'server-list-1',
  client_mutation_id: 'temp-list-1',
  preferences: { selected_store_id: null, hide_empty_sections: true },
  sections: [],
  items: [],
}]);
await temp.feature.toggleHideEmptySections();
assert.equal(temp.commits[0].data.shopping_list_id, 'server-list-1', 'stable temp navigation must emit the current canonical list ID');
assert.equal(temp.commits[0].data.changes.hide_empty_sections, false);

let queuedLists = [{
  id: 'list-queued',
  preferences: { selected_store_id: null, hide_empty_sections: false },
  sections: [],
  items: [],
}];
let queuedCommitCalls = 0;
let releaseFirstQueuedCommit;
let reachFirstQueuedCommit;
const firstQueuedCommitReached = new Promise(resolve => { reachFirstQueuedCommit = resolve; });
const queuedMutations = [];
const queuedFeature = createShoppingViewPreferencesFeature({
  getLists: () => queuedLists,
  setLists: next => { queuedLists = structuredClone(next); },
  getActiveListId: () => 'list-queued',
  commitMutation: async build => {
    queuedCommitCalls += 1;
    const mutation = build();
    if (queuedCommitCalls === 1) {
      reachFirstQueuedCommit();
      await new Promise(resolve => { releaseFirstQueuedCommit = resolve; });
    }
    queuedMutations.push(structuredClone(mutation));
    return mutation;
  },
});
const firstQueuedToggle = queuedFeature.toggleHideEmptySections();
const secondQueuedToggle = queuedFeature.toggleHideEmptySections();
await firstQueuedCommitReached;
assert.equal(queuedCommitCalls, 1, 'preference changes for one list must serialize the full durable commit and publish lifecycle');
releaseFirstQueuedCommit();
await Promise.all([firstQueuedToggle, secondQueuedToggle]);
assert.deepEqual(queuedMutations.map(mutation => mutation.data.changes.hide_empty_sections), [true, false]);
assert.equal(queuedLists[0].preferences.hide_empty_sections, false, 'two rapid toggles must not collapse into one stale target state');

let delayedLists = [{
  id: 'list-race',
  preferences: { selected_store_id: 'store-before', hide_empty_sections: false },
  sections: [],
  items: [],
}];
let releaseCommit;
let reachCommit;
const commitReached = new Promise(resolve => { reachCommit = resolve; });
let raceMutation = null;
const raceFeature = createShoppingViewPreferencesFeature({
  getLists: () => delayedLists,
  setLists: next => { delayedLists = structuredClone(next); },
  getActiveListId: () => 'list-race',
  commitMutation: async build => {
    reachCommit();
    await new Promise(resolve => { releaseCommit = resolve; });
    raceMutation = build();
    return raceMutation;
  },
});
const pendingRace = raceFeature.toggleHideEmptySections();
await commitReached;
delayedLists = delayedLists.map(list => ({ ...list, preferences: { ...list.preferences, selected_store_id: 'store-after' } }));
releaseCommit();
await pendingRace;
assert.equal(raceMutation.data.changes.selected_store_id, 'store-after', 'the mutation builder must re-read adjacent preferences after waiting for the queue-writer gate');

let failedLists = [{
  id: 'list-failure',
  preferences: { selected_store_id: null, hide_empty_sections: false },
  sections: [],
  items: [],
}];
const failureSnapshot = structuredClone(failedLists);
const failureFeature = createShoppingViewPreferencesFeature({
  getLists: () => failedLists,
  setLists: next => { failedLists = structuredClone(next); },
  getActiveListId: () => 'list-failure',
  commitMutation: async () => { throw new Error('simulated IndexedDB failure'); },
});
await assert.rejects(() => failureFeature.toggleHideEmptySections(), /simulated IndexedDB failure/);
assert.deepEqual(failedLists, failureSnapshot, 'a failed durable write must not publish the preference optimistically');

const classes = new Set();
const attributes = new Map();
const label = { textContent: '' };
const button = {
  title: '',
  classList: { toggle(name, active) { active ? classes.add(name) : classes.delete(name); } },
  setAttribute(name, value) { attributes.set(name, String(value)); },
  querySelector(selector) { return selector === '[data-topbar-toggle-label]' ? label : null; },
};
globalThis.document = { getElementById: id => id === 'shopping-hide-empty-sections-btn' ? button : null };
viewer.feature.updateButton();
assert.equal(classes.has('active'), true);
assert.equal(attributes.get('aria-pressed'), 'true');
assert.equal(label.textContent, 'shopping.preferences.hideEmpty.on');
assert.equal(attributes.get('aria-label'), 'shopping.preferences.hideEmpty.disable');

console.log('✅ Shopping hide-empty durable preference contracts passed');
