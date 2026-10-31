#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createShoppingItemsController,
  formatShoppingQuantity,
  renderShoppingItem,
} from '../web/static/js/features/shopping-items.js';

const labels = {
  markCompleted: 'Milch als gekauft markieren',
  markOpen: 'Milch wieder als offen markieren',
  swipeComplete: 'Gekauft',
  swipeReopen: 'Wieder öffnen',
};

assert.equal(formatShoppingQuantity({ quantity_value: 1.5, quantity_unit: 'kg' }, 'de-DE'), '1,5 kg');
assert.equal(formatShoppingQuantity({ quantity_value: 1.23456, quantity_unit: 'kg' }, 'de-DE'), '1,23456 kg', 'stored quantity precision must remain visible');
assert.equal(formatShoppingQuantity({ quantity_value: 0, quantity_unit: 'Stück' }, 'de-DE'), '0 Stück');
assert.equal(formatShoppingQuantity({ quantity_value: null, quantity_unit: '' }, 'de-DE'), '');

const openHtml = renderShoppingItem({
  item: { id: 'temp-shopping-item-1', name: '<img src=x onerror=alert(1)> Milch', quantity_value: 2.5, quantity_unit: '<b>kg</b>', completed: false, is_pending: true },
  canEdit: true,
  locale: 'de-DE',
  labels,
});
assert.match(openHtml, /class="ui-item-card shopping-item-card ui-swipe-card is-pending"/);
assert.match(openHtml, /class="shopping-item-title"/);
assert.match(openHtml, /class="ui-badge shopping-item-quantity"/);
assert(openHtml.indexOf('shopping-item-title') < openHtml.indexOf('shopping-item-quantity'), 'title must precede the right-side quantity badge');
assert.match(openHtml, /data-shopping-item-action="toggle-completed"/);
assert.match(openHtml, /data-shopping-item-action="open-edit"/);
assert.match(openHtml, /class="shopping-item-edit-trigger"/);
assert.match(openHtml, /data-shopping-item-id="temp-shopping-item-1"/);
assert.match(openHtml, /data-item-dnd="true"/);
assert.match(openHtml, /draggable="true"/);
assert.match(openHtml, /role="checkbox"/);
assert.match(openHtml, /aria-checked="false"/);
assert.match(openHtml, /aria-label="Milch als gekauft markieren"/);
assert(!openHtml.includes('<img src=x'), 'item title must be escaped');
assert(!openHtml.includes('<b>kg</b>'), 'free quantity unit must be escaped');
assert.match(openHtml, /&lt;img src=x onerror=alert\(1\)&gt; Milch/);
assert.match(openHtml, /2,5 &lt;b&gt;kg&lt;\/b&gt;/);
for (const forbidden of ['todo-item', 'todo-check', 'todo-title', 'data-todo-action', ' data-id=', 'data-touch-dnd']) {
  assert(!openHtml.includes(forbidden), `shopping item markup must not expose ${forbidden}`);
}

const completedHtml = renderShoppingItem({
  item: { id: 7, name: 'Brot', quantity_value: 0, quantity_unit: '', completed: true },
  canEdit: true,
  locale: 'en-US',
  labels,
});
assert.match(completedHtml, /shopping-item-card ui-swipe-card is-completed/);
assert.match(completedHtml, /aria-checked="true"/);
assert.match(completedHtml, /aria-label="Milch wieder als offen markieren"/);
assert.match(completedHtml, /shopping-item-check-icon/);
assert.match(completedHtml, />0<\/span>/, 'zero quantity must remain visible');

for (const canEdit of [false, undefined, null, 'true', 1]) {
  const html = renderShoppingItem({ item: { id: 8, name: 'Read only', completed: false }, canEdit, labels });
  assert.match(html, /disabled/, `canEdit=${String(canEdit)} must fail closed`);
  assert(!html.includes('data-shopping-item-action='), `canEdit=${String(canEdit)} must not expose a mutating action`);
  assert(!html.includes('shopping-item-edit-trigger'), `canEdit=${String(canEdit)} must not expose the item editor`);
  assert(!html.includes('data-item-dnd='), `canEdit=${String(canEdit)} must not expose item drag-and-drop`);
  assert(!html.includes('draggable='), `canEdit=${String(canEdit)} must not be draggable`);
}
assert(!renderShoppingItem({ item: { id: 9, name: 'No quantity', completed: false }, canEdit: true, labels }).includes('shopping-item-quantity'), 'empty quantity badge must be omitted');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let lists = [{
  id: 1,
  can_edit: true,
  items: [{ id: 'temp-shopping-item-1', name: 'Milch', completed: false }],
}];
let activeListId = 1;
let published = 0;
let rendered = 0;
let synced = 0;
let commitCalls = 0;
const durable = deferred();
const controller = createShoppingItemsController({
  getLists: () => lists,
  setLists: next => { lists = next; published += 1; },
  getActiveListId: () => activeListId,
  commitMutation: async build => {
    commitCalls += 1;
    const mutation = build();
    await durable.promise;
    return mutation;
  },
  render: () => { rendered += 1; },
  isOnlineForSync: () => true,
  syncWithServer: async () => { synced += 1; },
});
const first = controller.toggleCompleted(1, 'temp-shopping-item-1');
const second = controller.toggleCompleted(1, 'temp-shopping-item-1');
await Promise.resolve();
assert.equal(commitCalls, 1, 'double activation must stay single-flight per list/item identity');
assert.equal(published, 0, 'local state must not publish before durable commit');
assert.equal(rendered, 0, 'UI must not render the optimistic state before durable commit');
durable.resolve();
await Promise.all([first, second]);
assert.equal(published, 1);
assert.equal(rendered, 1);
assert.equal(synced, 1);
assert.equal(lists[0].items[0].completed, true);
assert.equal(lists[0].items[0].is_pending, true);

let concurrentLists = [{
  id: 10,
  can_edit: true,
  items: [
    { id: 'item-a', completed: false },
    { id: 'item-b', completed: false },
  ],
}];
const concurrentGates = [deferred(), deferred()];
const concurrentMutations = [];
let concurrentCommitCalls = 0;
const concurrent = createShoppingItemsController({
  getLists: () => concurrentLists,
  setLists: next => { concurrentLists = next; },
  getActiveListId: () => 10,
  commitMutation: async build => {
    const call = concurrentCommitCalls++;
    const mutation = build();
    concurrentMutations.push(mutation);
    await concurrentGates[call].promise;
    return mutation;
  },
  render: () => {},
});
const toggleA = concurrent.toggleCompleted(10, 'item-a');
const toggleB = concurrent.toggleCompleted(10, 'item-b');
await Promise.resolve();
await Promise.resolve();
assert.equal(concurrentCommitCalls, 1, 'different items in one list must serialize before building their full-list projections');
concurrentGates[0].resolve();
await toggleA;
await Promise.resolve();
assert.equal(concurrentCommitCalls, 2);
assert.equal(concurrentMutations[1].list.items.find(item => item.id === 'item-a').completed, true, 'the later mutation must build from the first published durable state');
concurrentGates[1].resolve();
await toggleB;
assert.deepEqual(concurrentLists[0].items.map(item => item.completed), [true, true], 'different item toggles must not overwrite each other');

let failedPublishes = 0;
const failure = createShoppingItemsController({
  getLists: () => [{ id: 2, can_edit: true, items: [{ id: 3, completed: false }] }],
  setLists: () => { failedPublishes += 1; },
  getActiveListId: () => 2,
  commitMutation: async build => { build(); throw new Error('disk full'); },
  render: () => { failedPublishes += 1; },
});
await assert.rejects(() => failure.toggleCompleted(2, 3), /disk full/);
assert.equal(failedPublishes, 0, 'failed durable commit must not publish or render');

for (const race of ['permission', 'list', 'item']) {
  let raceLists = [{ id: 4, can_edit: true, items: [{ id: 5, completed: false }] }];
  let raceActive = 4;
  let buildMutation;
  let racePublishes = 0;
  const racing = createShoppingItemsController({
    getLists: () => raceLists,
    setLists: () => { racePublishes += 1; },
    getActiveListId: () => raceActive,
    commitMutation: async build => { buildMutation = build; await Promise.resolve(); return build(); },
    render: () => { racePublishes += 1; },
  });
  const pending = racing.toggleCompleted(4, 5);
  await Promise.resolve();
  if (race === 'permission') raceLists = [{ ...raceLists[0], can_edit: false }];
  if (race === 'list') raceActive = 99;
  if (race === 'item') raceLists = [{ ...raceLists[0], items: [] }];
  assert.equal(typeof buildMutation, 'function');
  assert.equal(await pending, null, `${race} race must cancel the mutation`);
  assert.equal(racePublishes, 0, `${race} race must not publish`);
}

let capturedMutation = null;
const identityLists = [{ id: 'temp-shopping-list-1', can_edit: true, items: [{ id: 'temp-shopping-item-9', completed: true }] }];
const identity = createShoppingItemsController({
  getLists: () => identityLists,
  setLists: () => {},
  getActiveListId: () => 'temp-shopping-list-1',
  commitMutation: async build => { capturedMutation = build(); return capturedMutation; },
  render: () => {},
});
await identity.toggleCompleted('temp-shopping-list-1', 'temp-shopping-item-9');
assert.deepEqual(capturedMutation.data, {
  shopping_list_id: 'temp-shopping-list-1',
  item_id: 'temp-shopping-item-9',
  changes: { completed: false },
});
assert.equal(capturedMutation.action, 'UPDATE_SHOPPING_ITEM');

let remappedLists = [{
  id: 6,
  can_edit: true,
  items: [{ id: 'temp-shopping-item-remap', client_mutation_id: 'temp-shopping-item-remap', completed: false }],
}];
let releaseRemap;
const remapGate = new Promise(resolve => { releaseRemap = resolve; });
let remappedMutation = null;
const remapped = createShoppingItemsController({
  getLists: () => remappedLists,
  setLists: next => { remappedLists = next; },
  getActiveListId: () => 6,
  commitMutation: async build => { await remapGate; remappedMutation = build(); return remappedMutation; },
  render: () => {},
});
const remappedToggle = remapped.toggleCompleted(6, 'temp-shopping-item-remap');
await Promise.resolve();
remappedLists = [{
  ...remappedLists[0],
  items: [{ id: 61, client_mutation_id: 'temp-shopping-item-remap', completed: false }],
}];
releaseRemap();
await remappedToggle;
assert.equal(remappedMutation.data.item_id, 61, 'a queued toggle must follow a Temp-ID remap before the durable commit');
remappedMutation = null;
await remapped.toggleCompleted(6, 'temp-shopping-item-remap');
assert.equal(remappedMutation.data.item_id, 61, 'a later gesture may still resolve the stable client identity after remapping');
assert.deepEqual(remappedMutation.data.changes, { completed: false });

let movedLists = [{
  id: 70,
  can_edit: true,
  sections: [
    { id: 701, client_mutation_id: 'stable-section-a', name: 'A' },
    { id: 702, client_mutation_id: 'stable-section-b', name: 'B' },
  ],
  items: [{ id: 711, client_mutation_id: 'stable-item', name: 'Milch', section_id: 701 }],
}];
const moveDurable = deferred();
let movedMutation = null;
let movedPublishes = 0;
const mover = createShoppingItemsController({
  getLists: () => movedLists,
  setLists: next => { movedLists = next; movedPublishes += 1; },
  getActiveListId: () => 70,
  commitMutation: async build => {
    await moveDurable.promise;
    movedMutation = build();
    return movedMutation;
  },
  render: () => {},
});
const pendingMove = mover.moveToSection(70, 'stable-item', 'stable-section-b');
await Promise.resolve();
assert.equal(movedPublishes, 0, 'a dragged item must not publish before its durable commit');
movedLists = [{
  ...movedLists[0],
  sections: [
    movedLists[0].sections[0],
    { ...movedLists[0].sections[1], id: 712 },
  ],
  items: [{ ...movedLists[0].items[0], id: 721 }],
}];
moveDurable.resolve();
const movedItem = await pendingMove;
assert.equal(movedMutation.action, 'UPDATE_SHOPPING_ITEM');
assert.deepEqual(movedMutation.data, {
  shopping_list_id: 70,
  item_id: 721,
  changes: { section_id: 712 },
});
assert.equal(movedItem.section_id, 712);
assert.equal(movedLists[0].items[0].section_id, 712);
assert.equal(movedPublishes, 1);
assert.equal(await mover.moveToSection(70, 'stable-item', 'stable-section-b'), null, 'dropping into the current section must be a no-op');

let deniedMoveLists = [{
  id: 73,
  can_edit: true,
  sections: [{ id: 731 }, { id: 732 }],
  items: [{ id: 733, section_id: 731 }],
}];
const deniedMoveGate = deferred();
let deniedMovePublishes = 0;
const deniedMover = createShoppingItemsController({
  getLists: () => deniedMoveLists,
  setLists: () => { deniedMovePublishes += 1; },
  getActiveListId: () => 73,
  commitMutation: async build => { await deniedMoveGate.promise; return build(); },
  render: () => { deniedMovePublishes += 1; },
});
const deniedMove = deniedMover.moveToSection(73, 733, 732);
await Promise.resolve();
deniedMoveLists = [{ ...deniedMoveLists[0], can_edit: false }];
deniedMoveGate.resolve();
assert.equal(await deniedMove, null, 'permission loss while waiting for the queue writer must cancel item drag persistence');
assert.equal(deniedMovePublishes, 0);

let createLists = [{
  id: 'list-create',
  client_mutation_id: 'stable-list-create',
  can_edit: true,
  sections: [{ id: 'temp-shopping-section-produce', name: 'Produce' }],
  items: [{ id: 'existing', sort_order: 7 }],
}];
const createStores = [{ id: 'temp-shopping-store-market', name: 'Market', active: true }];
const createDurable = deferred();
let createMutation = null;
let createPublishes = 0;
let createRenders = 0;
let createTempCalls = 0;
const creator = createShoppingItemsController({
  getLists: () => createLists,
  setLists: next => { createLists = next; createPublishes += 1; },
  getActiveListId: () => 'list-create',
  getStores: () => createStores,
  createTempId: () => { createTempCalls += 1; return 'temp-shopping-item-created'; },
  commitMutation: async build => {
    createMutation = build();
    await createDurable.promise;
    return createMutation;
  },
  render: () => { createRenders += 1; },
});
const createFirst = creator.create({
  name: '  Apples  ',
  quantity: '0',
  unit: '  kg  ',
  sectionId: 'temp-shopping-section-produce',
  storeId: 'temp-shopping-store-market',
});
const createSecond = creator.create({
  name: '  Apples  ',
  quantity: '0',
  unit: '  kg  ',
  sectionId: 'temp-shopping-section-produce',
  storeId: 'temp-shopping-store-market',
});
await Promise.resolve();
assert.equal(createTempCalls, 1, 'duplicate create submission must allocate one identity');
assert.strictEqual(createFirst, createSecond, 'duplicate create submission must be single-flight');
assert.equal(createPublishes, 0, 'created items must not publish before durable commit');
assert.equal(createRenders, 0, 'created items must not render before durable commit');
assert.equal(createMutation.action, 'CREATE_SHOPPING_ITEM');
assert.deepEqual(createMutation.data, {
  shopping_list_id: 'list-create',
  temp_id: 'temp-shopping-item-created',
  item: {
    name: 'Apples',
    section_id: 'temp-shopping-section-produce',
    quantity_value: 0,
    quantity_unit: 'kg',
    store_ids: ['temp-shopping-store-market'],
    sort_order: 8,
    client_mutation_id: 'temp-shopping-item-created',
  },
  client_mutation_id: 'temp-shopping-item-created',
});
assert.equal(createMutation.result.id, 'temp-shopping-item-created');
assert.equal(createMutation.result.client_mutation_id, 'temp-shopping-item-created');
assert.equal(createMutation.result.completed, false);
assert.equal(createMutation.result.is_pending, true);
createDurable.resolve();
const createdItem = await createFirst;
assert.equal(createdItem.id, 'temp-shopping-item-created');
assert.equal(createPublishes, 1);
assert.equal(createRenders, 1);
assert.equal(createLists[0].items.at(-1).quantity_value, 0, 'zero quantity must survive creation');

let rejectedSyncLists = [{ id: 'sync-reject-list', can_edit: true, sections: [], items: [] }];
const rejectedSyncCreator = createShoppingItemsController({
  getLists: () => rejectedSyncLists,
  setLists: next => { rejectedSyncLists = next; },
  getActiveListId: () => 'sync-reject-list',
  createTempId: () => 'temp-shopping-item-sync-reject',
  commitMutation: async build => build(),
  render: () => {},
  isOnlineForSync: () => true,
  syncWithServer: async () => {
    rejectedSyncLists = [{ id: 'sync-reject-list', can_edit: true, sections: [], items: [] }];
    return { successCount: 0, failCount: 1 };
  },
});
await assert.rejects(
  () => rejectedSyncCreator.create({ name: 'Cheese' }),
  /not visible after synchronization/,
  'an online create must not report success after synchronization removed the item',
);

const invalidCreateInputs = [
  [{ name: '   ' }, 'blank name'],
  [{ name: 'x'.repeat(501) }, 'overlong name'],
  [{ name: 'Milk', quantity: '-1' }, 'negative quantity'],
  [{ name: 'Milk', quantity: 'not-a-number' }, 'non-finite quantity'],
  [{ name: 'Milk', quantity: 'Infinity' }, 'infinite quantity'],
  [{ name: 'Milk', unit: 'x'.repeat(41) }, 'overlong unit'],
  [{ name: 'Milk', store_ids: ['store-a', 'store-b'] }, 'multiple stores'],
];
for (const [input, label] of invalidCreateInputs) {
  let invalidCommits = 0;
  let invalidTempIds = 0;
  const invalid = createShoppingItemsController({
    getLists: () => [{ id: 'validation-list', can_edit: true, sections: [], items: [] }],
    getActiveListId: () => 'validation-list',
    commitMutation: async build => { invalidCommits += 1; return build(); },
    createTempId: () => { invalidTempIds += 1; return 'should-not-exist'; },
  });
  assert.equal(await invalid.create(input), null, `${label} must fail validation`);
  assert.equal(invalidCommits, 0, `${label} must not reach durable commit`);
  assert.equal(invalidTempIds, 0, `${label} must not allocate an identity`);
}
for (const [input, label] of [
  [{ name: 'Milk', sectionId: 'missing-section' }, 'unknown section'],
  [{ name: 'Milk', storeId: 'missing-store' }, 'unknown store'],
]) {
  let invalidReferenceCommits = 0;
  let invalidReferenceTempIds = 0;
  const invalidReference = createShoppingItemsController({
    getLists: () => [{ id: 'reference-list', can_edit: true, sections: [], items: [] }],
    getActiveListId: () => 'reference-list',
    getStores: () => [],
    commitMutation: async build => { invalidReferenceCommits += 1; return build(); },
    createTempId: () => { invalidReferenceTempIds += 1; return 'should-not-exist'; },
  });
  assert.equal(await invalidReference.create(input), null, `${label} must fail validation`);
  assert.equal(invalidReferenceCommits, 0, `${label} must not reach durable commit`);
  assert.equal(invalidReferenceTempIds, 0, `${label} must not allocate an identity`);
}
for (const canEdit of [false, undefined, null, 'true', 1]) {
  let deniedCommits = 0;
  const denied = createShoppingItemsController({
    getLists: () => [{ id: 'denied-list', can_edit: canEdit, sections: [], items: [] }],
    getActiveListId: () => 'denied-list',
    commitMutation: async build => { deniedCommits += 1; return build(); },
  });
  assert.equal(await denied.create({ name: 'Milk' }), null, `can_edit=${String(canEdit)} must deny create`);
  assert.equal(deniedCommits, 0, `can_edit=${String(canEdit)} must fail closed before commit`);
}

let blankQuantityMutation = null;
const blankQuantity = createShoppingItemsController({
  getLists: () => [{ id: 'blank-quantity-list', can_edit: true, sections: [], items: [] }],
  setLists: () => {},
  getActiveListId: () => 'blank-quantity-list',
  createTempId: () => 'temp-shopping-item-blank',
  commitMutation: async build => { blankQuantityMutation = build(); return blankQuantityMutation; },
});
await blankQuantity.create({ name: 'Milk', quantity: '   ', unit: '   ' });
assert.equal(blankQuantityMutation.data.item.quantity_value, null, 'blank quantity must normalize to null');
assert.equal(blankQuantityMutation.data.item.quantity_unit, null, 'blank unit must normalize to null');

let mixedLists = [{
  id: 'mixed-list',
  can_edit: true,
  sections: [],
  items: [{ id: 'mixed-existing', completed: false, sort_order: 0 }],
}];
const mixedGates = [deferred(), deferred()];
const mixedMutations = [];
let mixedCommitCalls = 0;
const mixed = createShoppingItemsController({
  getLists: () => mixedLists,
  setLists: next => { mixedLists = next; },
  getActiveListId: () => 'mixed-list',
  createTempId: () => 'temp-shopping-item-mixed',
  commitMutation: async build => {
    const call = mixedCommitCalls++;
    const mutation = build();
    mixedMutations.push(mutation);
    await mixedGates[call].promise;
    return mutation;
  },
});
const mixedCreate = mixed.create({ name: 'Bread' });
const mixedToggle = mixed.toggleCompleted('mixed-list', 'mixed-existing');
await Promise.resolve();
await Promise.resolve();
assert.equal(mixedCommitCalls, 1, 'create and completion must share the per-list serialization queue');
mixedGates[0].resolve();
await mixedCreate;
await Promise.resolve();
assert.equal(mixedCommitCalls, 2);
assert(mixedMutations[1].list.items.some(item => item.id === 'temp-shopping-item-mixed'), 'queued completion must build from the published create projection');
mixedGates[1].resolve();
await mixedToggle;
assert.equal(mixedLists[0].items.find(item => item.id === 'mixed-existing').completed, true);
assert(mixedLists[0].items.some(item => item.id === 'temp-shopping-item-mixed'));

let remappedCreateMutation = null;
const remappedCreate = createShoppingItemsController({
  getLists: () => [{
    id: 'remapped-create-list',
    can_edit: true,
    sections: [{ id: 91, client_mutation_id: 'temp-shopping-section-remapped' }],
    items: [],
  }],
  setLists: () => {},
  getActiveListId: () => 'remapped-create-list',
  getStores: () => [{ id: 81, client_mutation_id: 'temp-shopping-store-remapped', active: true }],
  createTempId: () => 'temp-shopping-item-remapped-reference',
  commitMutation: async build => {
    remappedCreateMutation = build();
    return remappedCreateMutation;
  },
  render: () => {},
});
await remappedCreate.create({
  name: 'Milk',
  sectionId: 'temp-shopping-section-remapped',
  storeId: 'temp-shopping-store-remapped',
});
assert.equal(remappedCreateMutation.data.item.section_id, 91, 'a stale section Temp-ID must resolve through its stable mutation identity');
assert.deepEqual(remappedCreateMutation.data.item.store_ids, [81], 'a stale store Temp-ID must resolve through its stable mutation identity');

let updateLists = [{
  id: 'update-list',
  client_mutation_id: 'stable-update-list',
  can_edit: true,
  sections: [{ id: 'temp-update-section', client_mutation_id: 'temp-update-section', name: 'Produce' }],
  items: [{
    id: 'temp-update-item',
    client_mutation_id: 'temp-update-item',
    name: 'Old milk',
    quantity_value: 1,
    quantity_unit: 'l',
    section_id: null,
    store_ids: [],
    stores: [],
    completed: false,
  }],
}];
let updateStores = [{ id: 'temp-update-store', client_mutation_id: 'temp-update-store', name: 'Market', active: true }];
const updateGate = deferred();
let updateMutation = null;
let updatePublishes = 0;
let activeUpdateListId = 'update-list';
const updater = createShoppingItemsController({
  getLists: () => updateLists,
  setLists: next => { updateLists = next; updatePublishes += 1; },
  getActiveListId: () => activeUpdateListId,
  getStores: () => updateStores,
  commitMutation: async build => {
    await updateGate.promise;
    updateMutation = build();
    return updateMutation;
  },
  render: () => {},
});
const firstUpdate = updater.update('update-list', 'temp-update-item', {
  name: '  Fresh milk  ',
  quantity: '0',
  unit: '  bottles  ',
  sectionId: 'temp-update-section',
  storeId: 'temp-update-store',
});
const secondUpdate = updater.update('update-list', 'temp-update-item', {
  name: '  Fresh milk  ',
  quantity: '0',
  unit: '  bottles  ',
  sectionId: 'temp-update-section',
  storeId: 'temp-update-store',
});
assert.strictEqual(firstUpdate, secondUpdate, 'duplicate item saves must be single-flight');
assert.equal(updatePublishes, 0, 'item edits must not publish before durable commit');
updateLists = [{
  ...updateLists[0],
  id: 61,
  sections: [{ id: 71, client_mutation_id: 'temp-update-section', name: 'Produce' }],
  items: [{ ...updateLists[0].items[0], id: 81 }],
}];
activeUpdateListId = 61;
updateStores = [{ id: 91, client_mutation_id: 'temp-update-store', name: 'Market', active: true }];
updateGate.resolve();
const updatedItem = await firstUpdate;
assert.equal(updateMutation.action, 'UPDATE_SHOPPING_ITEM');
assert.deepEqual(updateMutation.data, {
  shopping_list_id: 61,
  item_id: 81,
  changes: {
    name: 'Fresh milk',
    section_id: 71,
    quantity_value: 0,
    quantity_unit: 'bottles',
    store_ids: [91],
  },
});
assert.equal(updatedItem.id, 81);
assert.equal(updatedItem.name, 'Fresh milk');
assert.equal(updatedItem.quantity_value, 0);
assert.equal(updatedItem.section_id, 71);
assert.deepEqual(updatedItem.store_ids, [91]);
assert.deepEqual(updatedItem.stores.map(store => store.id), [91]);
assert.equal(updatedItem.is_pending, true);
assert.equal(updatePublishes, 1);

let hiddenStoreMutation = null;
const hiddenStoreEditor = createShoppingItemsController({
  getLists: () => [{
    id: 'hidden-store-list',
    can_edit: true,
    sections: [],
    items: [{
      id: 'hidden-store-item',
      name: 'Private assignment',
      quantity_value: null,
      quantity_unit: null,
      section_id: null,
      store_ids: [501],
      stores: [],
    }],
  }],
  setLists: () => {},
  getActiveListId: () => 'hidden-store-list',
  getStores: () => [],
  commitMutation: async build => {
    hiddenStoreMutation = build();
    return hiddenStoreMutation;
  },
});
await hiddenStoreEditor.update('hidden-store-list', 'hidden-store-item', {
  name: 'Renamed assignment',
  quantity: '',
  unit: '',
  sectionId: null,
  storeId: null,
});
assert.deepEqual(
  hiddenStoreMutation.data.changes.store_ids,
  [501],
  'editing an item must preserve opaque store assignments the recipient cannot enumerate',
);

let deleteLists = [{
  id: 'delete-list',
  client_mutation_id: 'stable-delete-list',
  can_edit: true,
  sections: [],
  items: [{ id: 'temp-delete-item', client_mutation_id: 'temp-delete-item', name: 'Remove me' }],
}];
const deleteGate = deferred();
let deleteMutation = null;
let deletePublishes = 0;
let activeDeleteListId = 'delete-list';
const remover = createShoppingItemsController({
  getLists: () => deleteLists,
  setLists: next => { deleteLists = next; deletePublishes += 1; },
  getActiveListId: () => activeDeleteListId,
  commitMutation: async build => {
    await deleteGate.promise;
    deleteMutation = build();
    return deleteMutation;
  },
  render: () => {},
});
const firstDelete = remover.remove('delete-list', 'temp-delete-item');
const secondDelete = remover.remove('delete-list', 'temp-delete-item');
assert.strictEqual(firstDelete, secondDelete, 'duplicate item deletes must be single-flight');
assert.equal(deletePublishes, 0, 'item deletion must not publish before durable commit');
deleteLists = [{ ...deleteLists[0], id: 111, items: [{ ...deleteLists[0].items[0], id: 101 }] }];
activeDeleteListId = 111;
deleteGate.resolve();
const deletedItem = await firstDelete;
assert.equal(deleteMutation.action, 'DELETE_SHOPPING_ITEM');
assert.deepEqual(deleteMutation.data, { shopping_list_id: 111, item_id: 101 });
assert.equal(deletedItem.id, 101);
assert.equal(deleteLists[0].items.length, 0);
assert.equal(deletePublishes, 1);

let createFailurePublishes = 0;
const createFailure = createShoppingItemsController({
  getLists: () => [{ id: 'create-failure-list', can_edit: true, sections: [], items: [] }],
  setLists: () => { createFailurePublishes += 1; },
  getActiveListId: () => 'create-failure-list',
  createTempId: () => 'temp-shopping-item-failure',
  commitMutation: async build => { build(); throw new Error('create disk full'); },
  render: () => { createFailurePublishes += 1; },
});
await assert.rejects(() => createFailure.create({ name: 'Milk' }), /create disk full/);
assert.equal(createFailurePublishes, 0, 'failed create commit must not publish or render');

for (const race of ['active-list', 'permission', 'list', 'section', 'store']) {
  let raceCreateLists = [{
    id: 'create-race-list',
    can_edit: true,
    sections: [{ id: 'temp-shopping-section-race' }],
    items: [],
  }];
  let raceCreateStores = [{ id: 'temp-shopping-store-race' }];
  let raceCreateActive = 'create-race-list';
  let raceCreatePublishes = 0;
  let releaseCreateBuild;
  const createBuildGate = new Promise(resolve => { releaseCreateBuild = resolve; });
  const racingCreate = createShoppingItemsController({
    getLists: () => raceCreateLists,
    setLists: () => { raceCreatePublishes += 1; },
    getActiveListId: () => raceCreateActive,
    getStores: () => raceCreateStores,
    createTempId: () => `temp-shopping-item-${race}`,
    commitMutation: async build => { await createBuildGate; return build(); },
    render: () => { raceCreatePublishes += 1; },
  });
  const pendingCreate = racingCreate.create({
    name: 'Milk',
    sectionId: 'temp-shopping-section-race',
    storeId: 'temp-shopping-store-race',
  });
  await Promise.resolve();
  if (race === 'active-list') raceCreateActive = 'another-list';
  if (race === 'permission') raceCreateLists = [{ ...raceCreateLists[0], can_edit: false }];
  if (race === 'list') raceCreateLists = [];
  if (race === 'section') raceCreateLists = [{ ...raceCreateLists[0], sections: [] }];
  if (race === 'store') raceCreateStores = [];
  releaseCreateBuild();
  assert.equal(await pendingCreate, null, `${race} change must cancel queued create`);
  assert.equal(raceCreatePublishes, 0, `${race} change must not publish`);
}

const todoRenderingSource = readFileSync(new URL('../web/static/js/features/todo-rendering.js', import.meta.url), 'utf8');
const todoDialogsSource = readFileSync(new URL('../web/static/js/modules/tasks-dialogs.js', import.meta.url), 'utf8');
const todoFeatureSource = readFileSync(new URL('../web/static/js/features/todos.js', import.meta.url), 'utf8');
const todoQuickAddSource = readFileSync(new URL('../web/static/js/features/todo-quick-add.js', import.meta.url), 'utf8');
const braindumpSource = readFileSync(new URL('../web/static/js/features/braindump-live.js', import.meta.url), 'utf8');
const shoppingDialogsSource = readFileSync(new URL('../web/static/js/modules/shopping-dialogs.js', import.meta.url), 'utf8');
const primitiveCss = readFileSync(new URL('../web/static/css/99-ui-primitives.css', import.meta.url), 'utf8');
const todoCardCss = readFileSync(new URL('../web/static/css/81-todo-cards-refresh.css', import.meta.url), 'utf8');
const shoppingCardCss = readFileSync(new URL('../web/static/css/14-module-content.css', import.meta.url), 'utf8');
assert.match(todoRenderingSource, /class="todo-item[^"$]*ui-item-card|class="ui-item-card[^"$]*todo-item/, 'todo cards must consume the neutral item-card primitive');
assert.match(todoRenderingSource, /class="todo-meta-chip ui-badge|class="ui-badge todo-meta-chip/, 'todo metadata badges must consume the neutral badge primitive');
assert.match(primitiveCss, /\.ui-item-card\s*\{[^}]*min-height:[^}]*gap:[^}]*padding:[^}]*border:[^}]*border-radius:[^}]*background:[^}]*box-shadow:/s, 'the shared primitive authority must own the complete common item-card surface');
assert.match(primitiveCss, /\.ui-badge\s*\{/, 'the shared primitive authority must define neutral badge styling');
const todoCardBlocks = [...todoCardCss.matchAll(/^\s*\.todo-item\s*\{([^}]*)\}/gm)].map(match => match[1]);
const shoppingCardBlock = shoppingCardCss.match(/\.shopping-item-card\s*\{([^}]*)\}/s)?.[1] || '';
assert(todoCardBlocks.length > 0, 'the todo stylesheet must still contain domain-specific todo-item blocks');
for (const property of ['min-height', 'gap', 'padding', 'border-color', 'border-radius', 'background', 'box-shadow']) {
  for (const block of todoCardBlocks) {
    const declarations = [...block.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)].map(match => match[1]);
    assert(!declarations.includes(property), `plain todo cards must inherit shared ${property} instead of redefining it`);
  }
  assert(!shoppingCardBlock.includes(`${property}:`), `shopping card must inherit shared ${property} instead of redefining it`);
}
assert.equal((todoDialogsSource.match(/data-i18n-key="common\.section"/g) || []).length, 2, 'single and bulk todo section labels must share the neutral section key');
assert.match(todoFeatureSource, /t\('common\.section'\)/, 'todo preview chips must share the neutral section key');
assert.match(todoQuickAddSource, /t\('common\.section'\)/, 'quick-add section badges must share the neutral section key');
assert.match(braindumpSource, /t\('common\.section'\)/, 'BrainDump section labels must share the neutral section key');
assert.match(shoppingDialogsSource, /data-i18n-key="common\.section"/, 'shopping item creation must share the neutral section key');
for (const source of [todoDialogsSource, todoFeatureSource, todoQuickAddSource, braindumpSource, shoppingDialogsSource]) {
  assert.doesNotMatch(source, /(?:todo|shopping\.item)\.section(?=['"])|quickAdd\.detected\.section|braindump\.quickfix\.section/, 'equivalent section labels must not retain module-specific i18n keys');
}

for (const locale of ['cs', 'de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'zh-CN']) {
  const dictionary = JSON.parse(readFileSync(new URL(`../web/static/i18n/${locale}.json`, import.meta.url), 'utf8'));
  for (const key of ['shopping.item.markCompleted', 'shopping.item.markOpen', 'shopping.item.edit', 'shopping.item.delete.message']) {
    assert.equal(typeof dictionary[key], 'string', `${locale} must contain ${key}`);
    assert(dictionary[key].trim(), `${locale} ${key} must not be empty`);
    assert(dictionary[key].includes('{name}'), `${locale} ${key} must identify the affected item`);
  }
  for (const key of [
    'shopping.item.add',
    'shopping.item.modal.title',
    'shopping.item.modal.editTitle',
    'shopping.item.modal.subtitle',
    'shopping.item.name',
    'shopping.item.namePlaceholder',
    'shopping.item.details',
    'shopping.item.detailsHint',
    'shopping.item.quantity',
    'shopping.item.quantityPlaceholder',
    'shopping.item.unit',
    'shopping.item.unitPlaceholder',
    'common.section',
    'shopping.item.store',
    'shopping.item.store.none',
    'shopping.item.store.search',
    'shopping.item.store.empty',
    'shopping.item.store.add',
    'shopping.store.name',
    'shopping.store.namePlaceholder',
    'shopping.store.error.invalidName',
    'shopping.store.error.saveFailed',
    'shopping.item.error.invalidName',
    'shopping.item.error.invalidQuantity',
    'shopping.item.error.invalidUnit',
    'shopping.item.error.saveFailed',
    'shopping.item.swipeComplete',
    'shopping.item.swipeReopen',
    'shopping.item.delete',
    'shopping.item.delete.title',
    'shopping.item.delete.confirm',
    'shopping.item.error.deleteFailed',
  ]) {
    assert.equal(typeof dictionary[key], 'string', `${locale} must contain ${key}`);
    assert(dictionary[key].trim(), `${locale} ${key} must not be empty`);
  }
  assert.equal(dictionary['todo.section'], undefined, `${locale} must not retain the duplicate todo.section key`);
  assert.equal(dictionary['shopping.item.section'], undefined, `${locale} must not retain the duplicate shopping.item.section key`);
  assert.equal(dictionary['quickAdd.detected.section'], undefined, `${locale} must not retain the duplicate quickAdd.detected.section key`);
  assert.equal(dictionary['braindump.quickfix.section'], undefined, `${locale} must not retain the duplicate braindump.quickfix.section key`);
  if (locale === 'de') {
    const legacySectionValues = Object.entries(dictionary).filter(([, value]) => typeof value === 'string' && /\bSection/.test(value));
    assert.deepEqual(legacySectionValues, [], 'German task surfaces must consistently say Abschnitt instead of Section');
  }
}

console.log('✅ Shopping item renderer and durable create/completion controller passed');
