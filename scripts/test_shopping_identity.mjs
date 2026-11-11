#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolveEntityIdentity, entityIdentity, sameEntityIdentity } from '../web/static/js/core/entity-identity.js';
import { createShoppingItemsController } from '../web/static/js/features/shopping-items.js';
import { createShoppingSectionsAdapter } from '../web/static/js/features/shopping-sections.js';
import { createShoppingStoresController } from '../web/static/js/features/shopping-stores.js';
import { createShoppingViewPreferencesFeature } from '../web/static/js/features/shopping-view-preferences.js';
import { shoppingStoreOptionAction } from '../web/static/js/features/shopping-store-option-action.js';
import { resolveBrainDumpShoppingTarget } from '../web/static/js/features/braindump-candidate-review.js';
import { parseShoppingQuickAdd } from '../web/static/js/features/shopping-quick-add.js';

// No browser/service/database: deliberately hostile, differently ordered records.
const actorId = 1;
const own = { id: 10, created_by_user_id: actorId, client_mutation_id: 'own-list', can_edit: true, sections: [], items: [] };
const foreign = { id: 99, created_by_user_id: 2, client_mutation_id: '10', can_edit: true, sections: [], items: [] };
const resolve = (rows, identity, options = {}) => resolveEntityIdentity(rows, identity, { actorId, parentField: 'shopping_list_id', ...options });
assert.equal(resolve([foreign, own], '10'), own, 'an exact server ID wins over a preceding foreign numeric CMI');
assert.equal(resolve([foreign], 10), null, 'a revoked numeric ID must never become a foreign CMI');
assert.equal(resolve([{ ...foreign, created_by_user_id: actorId }], 10), null, 'a numeric ID must not become an own CMI either');
assert.equal(resolve([{ ...foreign, client_mutation_id: 'own-list' }], 'own-list'), null, 'nonnumeric foreign CMIs are not aliases');
assert.equal(resolve([own], 'own-list'), own);
assert.equal(resolveEntityIdentity([own], 'own-list'), null, 'aliases need an authenticated actor');
assert.equal(resolve([own, { ...own, id: 11 }], 'own-list'), null, 'ambiguous aliases fail closed');
assert.equal(entityIdentity(foreign, actorId), 99, 'shared confirmed entities retain their actual ID');
assert.equal(entityIdentity(own, actorId), 'own-list', 'own queue identity survives acknowledgement');
assert.equal(sameEntityIdentity(own, { ...foreign, client_mutation_id: 'own-list' }, actorId), false);

let lists = [structuredClone(foreign), structuredClone(own)], activeId = 10, stores = [], mutations = [];
const commitMutation = async build => {
  const mutation = build();
  if (mutation) mutations.push(structuredClone(mutation));
  return mutation;
};
const common = { getActorId: () => actorId, getLists: () => lists, setLists: next => { lists = next; },
  getActiveListId: () => activeId, getStores: () => stores, commitMutation };
const items = createShoppingItemsController(common);
await items.create({ name: 'Exact list' });
assert.equal(mutations.at(-1).data.shopping_list_id, 10);
assert.equal(lists.find(list => list.id === 99).items.length, 0);
await createShoppingSectionsAdapter(common).createSection('Produce');
assert.equal(mutations.at(-1).data.shopping_list_id, 10);
await createShoppingViewPreferencesFeature(common).toggleHideEmptySections();
assert.equal(mutations.at(-1).data.shopping_list_id, 10);
assert.equal(lists.find(list => list.id === 99).preferences, undefined, 'preference publishing cannot overwrite another list with an overlapping CMI');

lists = [structuredClone(own), { ...structuredClone(foreign), client_mutation_id: 'own-list' }];
activeId = 99;
await items.create({ name: 'Shared list with a colliding CMI' });
assert.equal(mutations.at(-1).data.shopping_list_id, 99, 'a confirmed foreign list is held by its real ID across delayed mutation construction');
assert.equal(lists[0].items.length, 0);
await createShoppingSectionsAdapter(common).createSection('Shared produce');
assert.equal(mutations.at(-1).data.shopping_list_id, 99);
await createShoppingViewPreferencesFeature(common).toggleHideEmptySections();
assert.equal(mutations.at(-1).data.shopping_list_id, 99);
assert.equal(lists[0].preferences, undefined);
activeId = 10;
lists = [structuredClone(foreign), structuredClone(own)];

const shadowSection = { id: 80, client_mutation_id: '20', created_by_user_id: 2 };
const realSection = { id: 20, client_mutation_id: 'section-own', created_by_user_id: actorId };
const shadowStore = { id: 81, shopping_list_id: 10, client_mutation_id: '30', created_by_user_id: 2, active: true };
const realStore = { id: 30, shopping_list_id: 10, client_mutation_id: 'store-own', created_by_user_id: actorId, active: true };
lists.find(list => list.id === 10).sections = [shadowSection, realSection];
stores = [shadowStore, realStore, { ...realStore, id: 82, shopping_list_id: 99 }];
await items.create({ name: 'Correct children', sectionId: 20, storeId: 30 });
assert.equal(mutations.at(-1).data.item.section_id, 20);
assert.deepEqual(mutations.at(-1).data.item.store_ids, [30]);
const target = resolveBrainDumpShoppingTarget({ shopping_list_id: 10, shopping_section_id: 20, shopping_store_ids: [30] }, lists, stores, { actorId });
assert.equal(target.list.id, 10); assert.equal(target.section.id, 20); assert.equal(target.stores[0].id, 30);
const action = shoppingStoreOptionAction({ list: lists[1], stores, actorId, option: { value: 30 } });
let edited;
shoppingStoreOptionAction({ list: lists[1], stores, actorId, option: { value: 30 }, onEdit: (...args) => { edited = args; } }).onActivate({});
assert(action); assert.deepEqual(edited.slice(0, 2), [10, 30]);
assert.equal(shoppingStoreOptionAction({ list: lists[1], stores: [shadowStore], actorId, option: { value: 30 } }), null);
assert.equal(resolveBrainDumpShoppingTarget({ shopping_list_id: 10, shopping_store_ids: [30] }, lists, [shadowStore], { actorId }), null);
assert.equal(resolve(stores, 'store-own', { parentId: 99 })?.id, 82, 'child aliases are resolved only within the captured parent');
assert.equal(parseShoppingQuickAdd('Milk @Cross', { list: own, stores: [{ ...realStore, shopping_list_id: 'own-list', name: 'Cross' }] }).changes.store_ids, undefined,
  'Quick Add cannot reinterpret a parent CMI as a list ID');

const storeMutations = [];
const storeController = createShoppingStoresController({ getActorId: () => actorId, getStores: () => stores,
  setStores: next => { stores = next; }, commitMutation: async build => { const mutation = build(); if (mutation) storeMutations.push(mutation); return mutation; } });
await storeController.update(30, 'Real market');
assert.equal(storeMutations.at(-1).data.store_id, 30);
stores = stores.filter(store => store.id !== 30);
assert.equal(await storeController.remove(30), null, 'a stale numeric store ID must not delete a numeric-CMI shadow');

{
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  lists = [{ ...own, sections: [{ id: 'temp-section', client_mutation_id: 'temp-section', created_by_user_id: actorId }] }];
  activeId = 10;
  const sections = createShoppingSectionsAdapter({ ...common, enqueueListMutation: async (_key, work) => { await gate; return work(); } });
  const renaming = sections.renameSection('temp-section', 'Canonical section');
  lists = [{ ...own, sections: [{ id: 55, client_mutation_id: 'temp-section', created_by_user_id: actorId }] }];
  release(); await renaming;
  assert.equal(mutations.at(-1).data.section_id, 55, 'a pending section edit follows its own parent-scoped acknowledgement');
  lists[0].sections = [{ id: 56, client_mutation_id: '55', created_by_user_id: 2 }];
  assert.equal(await sections.renameSection(55, 'Must not change'), null);
}

for (const revoked of [false, true]) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const temp = 'temp-own-shopping-list';
  lists = [{ id: temp, client_mutation_id: temp, created_by_user_id: actorId, can_edit: true,
    sections: [{ id: 'temp-section', client_mutation_id: 'temp-section', created_by_user_id: actorId }], items: [] }];
  stores = [{ id: 'temp-store', shopping_list_id: temp, client_mutation_id: 'temp-store', created_by_user_id: actorId, active: true }];
  activeId = temp;
  let committed = null;
  const queued = createShoppingItemsController({ ...common, enqueueListMutation: async (_key, work) => { await gate; return work(); },
    commitMutation: async build => { committed = build(); return committed; } });
  const pending = queued.create({ name: 'Pending', sectionId: 'temp-section', storeId: 'temp-store' });
  lists = [{ ...foreign, client_mutation_id: temp }, ...(revoked ? [] : [{ ...lists[0], id: 42,
    sections: [{ id: 55, client_mutation_id: 'temp-section', created_by_user_id: actorId }] }])];
  stores = [{ id: 66, shopping_list_id: 42, client_mutation_id: 'temp-store', created_by_user_id: actorId, active: true }];
  activeId = revoked ? 99 : 42;
  release();
  const result = await pending;
  if (revoked) { assert.equal(result, null); assert.equal(committed, null); }
  else {
    assert.equal(committed.data.shopping_list_id, 42, 'a foreign alias cannot intercept an own acknowledgement');
    assert.equal(committed.data.item.section_id, 55); assert.deepEqual(committed.data.item.store_ids, [66]);
  }
}
lists = [foreign]; activeId = 10;
assert.equal(await items.create({ name: 'Revoked' }), null);
assert.equal(await items.createManyForList({ listId: 10, items: [{ name: 'Revoked' }] }), null);
assert.equal(resolveBrainDumpShoppingTarget({ shopping_list_id: 10 }, lists, [], { actorId }), null);

// Caller-supplied mutation IDs are an explicit request namespace, even when
// numeric. They must never replace a local temp ID or act as a stale server ID.
{
  let actor = actorId;
  lists = [{ ...own, sections: [], items: [{ id: 123, client_mutation_id: 'different-request', created_by_user_id: 2, name: 'Existing real ID' }] }];
  activeId = 10;
  let localId;
  const explicitReceipt = createShoppingItemsController({ ...common, getActorId: () => actor,
    createTempId: () => 'temp-custom-mutation', isOnlineForSync: () => true,
    syncWithServer: async () => {
      const pending = lists[0].items.find(item => item.id === 'temp-custom-mutation');
      if (!pending) return;
      localId = pending.id;
      lists[0] = { ...lists[0], items: [
        lists[0].items[0],
        { ...pending, id: 999, client_mutation_id: localId, created_by_user_id: 2 },
        { ...pending, id: 200 },
      ] };
    } });
  const created = await explicitReceipt.create({ name: 'Numeric receipt', client_mutation_id: '123' });
  assert.equal(created.id, 200);
  assert.equal(mutations.at(-1).data.client_mutation_id, '123');
  assert.equal(mutations.at(-1).data.temp_id, localId);
  assert.notEqual(localId, '123');
  assert.equal(await explicitReceipt.createManyForList({ listId: 10,
    items: [{ name: 'One', client_mutation_id: '456' }, { name: 'Two', client_mutation_id: '456' }] }), null,
  'separate local temp IDs cannot hide duplicate explicit request identities');
  await explicitReceipt.toggleCompleted(10, localId);
  assert.equal(mutations.at(-1).data.item_id, 200, 'a captured local temp ID follows only its own explicit creation receipt');
  await explicitReceipt.toggleCompleted(10, 123);
  assert.equal(mutations.at(-1).data.item_id, 123, 'a true numeric ID remains in the ID namespace');
  lists[0].items = lists[0].items.filter(item => item.id !== 123);
  assert.equal(await explicitReceipt.toggleCompleted(10, 123), null, 'a now-revoked numeric ID cannot become the numeric mutation receipt');
  actor = 2;
  assert.equal(explicitReceipt.resolveItem(10, localId), null, 'captured receipts cannot cross accounts');
}
{
  const pending = { id: 'temp-restored-numeric', client_mutation_id: '123', created_by_user_id: actorId, name: 'Restored offline draft' };
  lists = [{ ...own, items: [pending] }];
  const restored = createShoppingItemsController(common);
  assert.equal(restored.resolveItem(10, pending.id).id, pending.id, 'opening the restored local item captures its own durable request context');
  lists = [{ ...own, items: [{ ...pending, id: 200 }] }];
  assert.equal(restored.resolveItem(10, pending.id).id, 200, 'a restored editor follows its numeric creation receipt without losing its draft');
  assert.equal(restored.resolveItem(10, 123), null, 'restored receipts never reinterpret numeric server IDs');
}
console.log('✅ Shopping exact IDs, actor-scoped aliases, parent boundaries and delayed own remaps passed');
