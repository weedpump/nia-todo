#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createShoppingStoresController } from '../web/static/js/features/shopping-stores.js';

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

let stores = [{ id: 'existing', shopping_list_id: 7, name: 'REWE', active: true, sort_order: 0 }];
const commits = [];
let syncCalls = 0;
const controller = createShoppingStoresController({
  getStores: () => stores,
  setStores: next => { stores = structuredClone(next); },
  commitMutation: async build => {
    const mutation = build();
    if (!mutation) return null;
    commits.push(structuredClone(mutation));
    return mutation;
  },
  createTempId: () => 'temp-store-created',
  isOnlineForSync: () => true,
  syncWithServer: async () => { syncCalls += 1; },
});

assert.equal(await controller.create('', { shoppingListId: 7 }), null, 'empty names must be rejected before any durable mutation');
assert.equal(await controller.create('x'.repeat(121), { shoppingListId: 7 }), null, 'overlong names must be rejected before any durable mutation');
assert.equal(await controller.create('PENNY'), null, 'a list identity is required before any durable mutation');
assert.equal(commits.length, 0);

const duplicate = await controller.create('  rewe  ', { shoppingListId: 7 });
assert.equal(duplicate.id, 'existing', 'active store names must deduplicate case-insensitively');
assert.equal(commits.length, 0, 'duplicates must not create queue mutations');

const created = await controller.create('  PENNY  ', { shoppingListId: 7 });
assert.equal(created.id, 'temp-store-created');
assert.equal(created.name, 'PENNY');
assert.equal(created.shopping_list_id, 7);
assert.equal(created.sort_order, 1);
assert.equal(created.is_pending, true);
assert.deepEqual(commits[0], {
  store: created,
  action: 'CREATE_SHOPPING_STORE',
  data: {
    temp_id: 'temp-store-created',
    store: created,
    shopping_list_id: 7,
    name: 'PENNY',
    sort_order: 1,
    client_mutation_id: 'temp-store-created',
  },
  result: created,
});
assert.deepEqual(stores.map(store => store.name), ['REWE', 'PENNY']);
assert.equal(syncCalls, 1);

const updated = await controller.update('existing', '  REWE Center  ', { authorize: () => true });
assert.equal(updated.id, 'existing');
assert.equal(updated.shopping_list_id, 7);
assert.equal(updated.name, 'REWE Center');
assert.equal(updated.is_pending, true);
assert.deepEqual(commits.at(-1), {
  store: updated,
  action: 'UPDATE_SHOPPING_STORE',
  data: { store_id: 'existing', changes: { name: 'REWE Center' } },
  result: updated,
});
assert.equal(stores.find(store => store.id === 'existing').name, 'REWE Center');
assert.equal(syncCalls, 2);

const deleted = await controller.remove('existing', { authorize: () => true });
assert.equal(deleted.id, 'existing');
assert.equal(deleted.shopping_list_id, 7);
assert.equal(deleted.active, false);
assert.equal(deleted.is_pending, true);
assert.deepEqual(commits.at(-1), {
  store: deleted,
  action: 'DELETE_SHOPPING_STORE',
  data: { store_id: 'existing' },
  result: deleted,
});
assert.equal(stores.find(store => store.id === 'existing').active, false);
assert.equal(syncCalls, 3);

const missingDeleteCount = commits.length;
assert.equal(await controller.remove('missing', { authorize: () => true }), null, 'missing stores must not create delete mutations');
assert.equal(commits.length, missingDeleteCount);

stores = stores.map(store => store.id === 'existing' ? { ...store, active: true, is_pending: false } : store);
let deleteAllowed = true;
const delayedDeleteGate = deferred();
const delayedDelete = createShoppingStoresController({
  getStores: () => stores,
  setStores: next => { stores = structuredClone(next); },
  commitMutation: async build => {
    await delayedDeleteGate.promise;
    return build();
  },
});
const deniedDelete = delayedDelete.remove('existing', { authorize: () => deleteAllowed });
deleteAllowed = false;
delayedDeleteGate.resolve();
assert.equal(await deniedDelete, null, 'permission loss before the durable builder runs must cancel store deletion');
assert.equal(stores.find(store => store.id === 'existing').active, true);

const duplicateUpdateCount = commits.length;
assert.equal(await controller.update('existing', 'PENNY', { authorize: () => true }), null, 'renaming to an active store in the same list must be rejected');
assert.equal(commits.length, duplicateUpdateCount);

let updateAllowed = true;
const delayedUpdateGate = deferred();
const delayedUpdate = createShoppingStoresController({
  getStores: () => stores,
  setStores: next => { stores = structuredClone(next); },
  commitMutation: async build => {
    await delayedUpdateGate.promise;
    return build();
  },
});
const deniedUpdate = delayedUpdate.update('existing', 'REWE City', { authorize: () => updateAllowed });
updateAllowed = false;
delayedUpdateGate.resolve();
assert.equal(await deniedUpdate, null, 'permission loss before the durable builder runs must cancel store updates');
assert.equal(stores.find(store => store.id === 'existing').name, 'REWE Center');

const sameNameOnAnotherList = await controller.create('REWE', { shoppingListId: 8 });
assert.equal(sameNameOnAnotherList.shopping_list_id, 8, 'store names deduplicate only inside one shopping list');

const gate = deferred();
let delayedStores = [];
const delayed = createShoppingStoresController({
  getStores: () => delayedStores,
  setStores: next => { delayedStores = structuredClone(next); },
  commitMutation: async build => {
    await gate.promise;
    return build();
  },
  createTempId: () => 'temp-store-denied',
});
let allowed = true;
const pending = delayed.create('ALDI', { authorize: () => allowed, shoppingListId: 7 });
allowed = false;
gate.resolve();
assert.equal(await pending, null, 'permission loss before the durable builder runs must cancel creation');
assert.deepEqual(delayedStores, []);

console.log('✅ Shared shopping store create controller contracts passed');
