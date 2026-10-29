#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createShoppingSectionsAdapter } from '../web/static/js/features/shopping-sections.js';

let lists = [{
  id: 'list-1',
  can_manage: true,
  sections: [
    { id: 'opaque-a', name: 'A', sort_order: 0 },
    { id: 'opaque-b', name: 'B', sort_order: 1 },
    { id: 'opaque-c', name: 'C', sort_order: 2 },
  ],
  items: [{ id: 'item-1', section_id: 'opaque-b', name: 'Milk' }],
}];
const commits = [];
let renderCount = 0;
const adapter = createShoppingSectionsAdapter({
  getLists: () => lists,
  setLists: next => { lists = structuredClone(next); },
  getActiveListId: () => 'list-1',
  getRoot: () => null,
  commitMutation: async build => {
    const mutation = build();
    if (!mutation) return null;
    commits.push(structuredClone(mutation));
    return mutation;
  },
  render: () => { renderCount += 1; },
  isOnlineForSync: () => false,
});

const created = await adapter.createSection('Bakery');
assert.match(created.id, /^temp-shopping-section-/);
assert.equal(commits[0].list.sections.at(-1).name, 'Bakery');
assert.equal(commits[0].action, 'CREATE_SHOPPING_SECTION');
assert.equal(lists[0].sections.at(-1).id, created.id, 'memory changes only after the durable commit');

const renamed = await adapter.renameSection('opaque-a', 'Produce');
assert.equal(renamed.name, 'Produce');
assert.deepEqual(commits[1].data, { shopping_list_id: 'list-1', section_id: 'opaque-a', changes: { name: 'Produce' } });

await adapter.deleteSection('opaque-b');
assert.equal(lists[0].sections.some(section => section.id === 'opaque-b'), false);
assert.equal(lists[0].items[0].section_id, null, 'section deletion moves items to the unsorted group in the same projection');
assert.equal(commits[2].list.items[0].section_id, null);
assert.equal(commits[2].action, 'DELETE_SHOPPING_SECTION');

const beforeReorderCommits = commits.length;
await adapter.reorderSections(['opaque-c', 'opaque-a', created.id]);
const reorder = commits[beforeReorderCommits];
assert.deepEqual(reorder.list.sections.map(section => [section.id, section.sort_order]), [
  ['opaque-c', 0], ['opaque-a', 1], [created.id, 2],
]);
assert.deepEqual(reorder.mutations.map(mutation => mutation.data.section_id), ['opaque-c', 'opaque-a', created.id]);
assert.equal(reorder.mutations.every(mutation => mutation.action === 'UPDATE_SHOPPING_SECTION'), true);

const commitCountBeforeNoop = commits.length;
await adapter.reorderSections(['opaque-c', 'opaque-a', created.id]);
assert.equal(commits.length, commitCountBeforeNoop, 'no-op reorder writes nothing');

const commitCountBeforeDuplicateOrder = commits.length;
const duplicateOrderSnapshot = structuredClone(lists);
assert.equal(await adapter.reorderSections(['opaque-c', 'opaque-c', created.id]), null);
assert.equal(commits.length, commitCountBeforeDuplicateOrder, 'a reorder must be a unique permutation of the current sections');
assert.deepEqual(lists, duplicateOrderSnapshot, 'duplicate reorder IDs cannot corrupt the durable projection');

lists = [{
  id: 'list-1',
  can_manage: true,
  sections: [
    { id: 'opaque-a', name: 'A', sort_order: 0, is_pending: false },
    { id: 'opaque-b', name: 'B', sort_order: 1, is_pending: false },
    { id: 'opaque-c', name: 'C', sort_order: 2, is_pending: false },
  ],
  items: [],
}];
const partialReorderCommitIndex = commits.length;
await adapter.reorderSections(['opaque-b', 'opaque-a', 'opaque-c']);
const partialReorder = commits[partialReorderCommitIndex];
assert.deepEqual(partialReorder.mutations.map(mutation => mutation.data.section_id), ['opaque-b', 'opaque-a'], 'only sections whose order changed are queued');
assert.deepEqual(partialReorder.list.sections.map(section => [section.id, Boolean(section.is_pending)]), [
  ['opaque-b', true], ['opaque-a', true], ['opaque-c', false],
], 'only sections whose order changed are marked pending');

const commitCountBeforePermissionLoss = commits.length;
lists = lists.map(list => ({ ...list, can_manage: false }));
assert.equal(adapter.canManage(), false);
assert.equal(await adapter.createSection('Forbidden'), null);
assert.equal(await adapter.renameSection('opaque-a', 'Forbidden'), null);
assert.equal(await adapter.deleteSection('opaque-a'), null);
assert.equal(await adapter.reorderSections(['opaque-a']), null);
assert.equal(commits.length, commitCountBeforePermissionLoss, 'direct controller calls fail closed after permission loss');
assert(renderCount >= 4);

for (const invalidPermission of ['0', 'false', 0, null, undefined]) {
  lists = [{ id: 'list-1', can_manage: invalidPermission, sections: [], items: [] }];
  const before = commits.length;
  assert.equal(adapter.canManage(), false, `can_manage=${String(invalidPermission)} must fail closed`);
  assert.equal(await adapter.createSection('Forbidden'), null);
  assert.equal(commits.length, before);
}

let releaseCommit;
let reachedCommit;
const commitReached = new Promise(resolve => { reachedCommit = resolve; });
const delayedAdapter = createShoppingSectionsAdapter({
  getLists: () => lists,
  setLists: next => { lists = structuredClone(next); },
  getActiveListId: () => 'list-1',
  getRoot: () => null,
  commitMutation: async build => {
    reachedCommit();
    await new Promise(resolve => { releaseCommit = resolve; });
    return build();
  },
  render: () => {},
  isOnlineForSync: () => false,
});
lists = lists.map(list => ({ ...list, can_manage: true }));
const pending = delayedAdapter.renameSection('opaque-a', 'Stale');
await commitReached;
lists = lists.map(list => ({ ...list, can_manage: false }));
releaseCommit();
assert.equal(await pending, null, 'mutation builder re-resolves permission after the queue-writer gate');

async function assertStaleSectionRaceFailsClosed(mutateLiveLists, message) {
  let raceLists = [{
    id: 'race-list',
    can_manage: true,
    sections: [{ id: 'temp-shopping-section-race', client_mutation_id: 'mutation-race', name: 'Before', sort_order: 0 }],
    items: [],
  }];
  let releaseRaceCommit;
  let reachRaceCommit;
  const raceCommitReached = new Promise(resolve => { reachRaceCommit = resolve; });
  const raceAdapter = createShoppingSectionsAdapter({
    getLists: () => raceLists,
    setLists: next => { raceLists = structuredClone(next); },
    getActiveListId: () => 'race-list',
    commitMutation: async build => {
      reachRaceCommit();
      await new Promise(resolve => { releaseRaceCommit = resolve; });
      return build();
    },
  });
  const raceMutation = raceAdapter.renameSection('temp-shopping-section-race', 'After');
  await raceCommitReached;
  raceLists = mutateLiveLists(raceLists);
  releaseRaceCommit();
  assert.equal(await raceMutation, null, message);
}

await assertStaleSectionRaceFailsClosed(
  current => current.map(list => ({ ...list, sections: list.sections.map(section => ({ ...section, id: 'server-section-race' })) })),
  'a temp-ID remap while waiting for the writer gate cannot emit a stale update',
);
await assertStaleSectionRaceFailsClosed(
  current => current.map(list => ({ ...list, sections: [] })),
  'an external delete while waiting for the writer gate cannot recreate or update the missing section',
);

let storageLists = [{ id: 'storage-list', can_manage: true, sections: [], items: [] }];
const storageSnapshot = structuredClone(storageLists);
const storageFailureAdapter = createShoppingSectionsAdapter({
  getLists: () => storageLists,
  setLists: next => { storageLists = structuredClone(next); },
  getActiveListId: () => 'storage-list',
  commitMutation: async () => { throw new Error('simulated IndexedDB failure'); },
});
await assert.rejects(() => storageFailureAdapter.createSection('Not durable'), /simulated IndexedDB failure/);
assert.deepEqual(storageLists, storageSnapshot, 'memory remains unchanged when the atomic IndexedDB transaction fails');

console.log('✅ Shopping section offline adapter, permission and reorder contracts passed');
