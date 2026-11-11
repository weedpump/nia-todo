#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolveEntityIdentity, entityIdentity } from '../web/static/js/core/entity-identity.js';
// Production snapshots identify each creator; receipt aliases are account-local.
const ownedFixtures = rows => rows.map(row => ({ ...row,
  ...(row.client_mutation_id ? { created_by_user_id: 1 } : {}),
  ...(row.sections ? { sections: ownedFixtures(row.sections) } : {}),
  ...(row.items ? { items: ownedFixtures(row.items) } : {}),
}));
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createShoppingStoresController } from '../web/static/js/features/shopping-stores.js';
import { createShoppingItemsController } from '../web/static/js/features/shopping-items.js';
import { bindShoppingStoreCreator } from '../web/static/js/features/shopping-store-creator.js';
import { createShoppingStoreEditorFeature } from '../web/static/js/features/shopping-store-editor.js';

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

let stores = [{ id: 'existing', shopping_list_id: 7, name: 'REWE', active: true, sort_order: 0 }];
const commits = [];
const queuedListIds = [];
let syncCalls = 0;
const controller = createShoppingStoresController({ getActorId: () => 1,
  getStores: () => ownedFixtures(stores),
  setStores: next => { stores = structuredClone(next); },
  commitMutation: async build => {
    const mutation = build();
    if (!mutation) return null;
    commits.push(structuredClone(mutation));
    return mutation;
  },
  enqueueListMutation: async (listId, task) => {
    queuedListIds.push(listId);
    return task();
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
  data: { shopping_list_id: 7, store_id: 'existing', changes: { name: 'REWE Center' } },
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
  data: { shopping_list_id: 7, store_id: 'existing' },
  result: deleted,
});
assert.equal(stores.find(store => store.id === 'existing').active, false);
assert.equal(syncCalls, 3);
assert.deepEqual(queuedListIds.slice(0, 3), [7, 7, 7], 'create, update and delete must use the shared per-list mutation queue');

const missingDeleteCount = commits.length;
assert.equal(await controller.remove('missing', { authorize: () => true }), null, 'missing stores must not create delete mutations');
assert.equal(commits.length, missingDeleteCount);

stores = stores.map(store => store.id === 'existing' ? { ...store, active: true, is_pending: false } : store);
let deleteAllowed = true;
const delayedDeleteGate = deferred();
const delayedDelete = createShoppingStoresController({ getActorId: () => 1,
  getStores: () => ownedFixtures(stores),
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
const delayedUpdate = createShoppingStoresController({ getActorId: () => 1,
  getStores: () => ownedFixtures(stores),
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

const remappedQueue = new Map();
const enqueueRemappedListMutation = (identity, task) => {
  const key = String(identity);
  const previous = remappedQueue.get(key);
  const operation = (previous ? previous.catch(() => null) : Promise.resolve()).then(task);
  remappedQueue.set(key, operation);
  operation.finally(() => {
    if (remappedQueue.get(key) === operation) remappedQueue.delete(key);
  }).catch(() => {});
  return operation;
};
let remappedLists = [{
  id: 42,
  client_mutation_id: 'temp-list-42',
  can_edit: true,
  sections: [],
  items: [{ id: 20, name: 'Milk', completed: false, store_ids: [], stores: [] }],
}];
let remappedStores = [{ id: 9, shopping_list_id: 42, name: 'Market', active: true }];
const remappedDeleteGate = deferred();
let remappedCommitCalls = 0;
const remappedStoreController = createShoppingStoresController({ getActorId: () => 1,
  getStores: () => ownedFixtures(remappedStores),
  setStores: next => { remappedStores = structuredClone(next); },
  commitMutation: async build => {
    remappedCommitCalls += 1;
    const mutation = build();
    await remappedDeleteGate.promise;
    return mutation;
  },
  enqueueListMutation: enqueueRemappedListMutation,
  resolveListIdentity: listId => remappedLists.find(list => String(list.id) === String(listId))?.client_mutation_id ?? listId,
  resolveListId: identity => remappedLists.find(list => String(list.id) === String(identity) || list.client_mutation_id === identity)?.id ?? null,
});
const remappedItemController = createShoppingItemsController({ getActorId: () => 1,
  getLists: () => ownedFixtures(remappedLists),
  setLists: next => { remappedLists = structuredClone(next); },
  getActiveListId: () => 42,
  getStores: () => ownedFixtures(remappedStores),
  commitMutation: async build => {
    remappedCommitCalls += 1;
    return build();
  },
  enqueueListMutation: enqueueRemappedListMutation,
});
const remappedDelete = remappedStoreController.remove(9);
const remappedItemUpdate = remappedItemController.update(42, 20, {
  name: 'Fresh milk', quantity: '', unit: '', sectionId: null, storeId: 9,
});
await Promise.resolve();
await Promise.resolve();
assert.equal(remappedCommitCalls, 1, 'store and item mutations must share the stable queue after list ID remapping');
remappedDeleteGate.resolve();
await remappedDelete;
assert.equal(await remappedItemUpdate, null, 'the queued item update must observe the completed store deletion');
assert.deepEqual(remappedLists[0].items[0].store_ids, []);

const gate = deferred();
let delayedStores = [];
const delayed = createShoppingStoresController({ getActorId: () => 1,
  getStores: () => ownedFixtures(delayedStores),
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

for (const wait of ['queue', 'commit']) {
  for (const outcome of ['allowed', 'duplicate', 'denied', 'missing']) {
    let originLists = [{ id: 'temp-list-origin', client_mutation_id: 'temp-list-origin', can_edit: true }];
    let scopedStores = [];
    const gate = deferred();
    const queueKeys = [];
    const mutations = [];
    const resolveList = identity => originLists.find(list => String(list.id) === String(identity) || list.client_mutation_id === identity);
    const creating = createShoppingStoresController({ getActorId: () => 1,
      getStores: () => ownedFixtures(scopedStores),
      setStores: next => { scopedStores = next; },
      resolveListIdentity: identity => resolveList(identity)?.client_mutation_id ?? identity,
      resolveListId: identity => resolveList(identity)?.id ?? null,
      enqueueListMutation: async (identity, task) => {
        queueKeys.push(identity);
        if (wait === 'queue') await gate.promise;
        return task();
      },
      commitMutation: async build => {
        if (wait === 'commit') await gate.promise;
        const mutation = build();
        if (mutation) mutations.push(structuredClone(mutation));
        return mutation;
      },
    });
    const pendingCreate = creating.create('Market', {
      shoppingListId: 'temp-list-origin',
      authorize: () => outcome === 'missing' || resolveList('temp-list-origin')?.can_edit === true,
    });
    originLists = outcome === 'missing' ? [] : [{ ...originLists[0], id: 99, can_edit: outcome !== 'denied' }];
    if (outcome === 'duplicate') scopedStores = [{ id: 55, shopping_list_id: 99, name: 'Market', active: true }];
    else scopedStores = [{ id: 56, shopping_list_id: 99, name: 'Other', active: true, sort_order: 7 }];
    gate.resolve();
    const result = await pendingCreate;
    const label = wait + '/' + outcome;
    assert.deepEqual(queueKeys, ['temp-list-origin'], label + ': queue must retain the stable list key');
    assert.equal(mutations.length, outcome === 'allowed' ? 1 : 0, label + ': recheck duplicate, authority and existence after waits');
    if (outcome === 'allowed') {
      assert.equal(result.shopping_list_id, 99, label + ': cache must use current canonical list ID');
      assert.equal(mutations[0].data.shopping_list_id, 99, label + ': API payload must use current canonical list ID');
      assert.equal(mutations[0].data.store.shopping_list_id, 99);
      assert.equal(result.sort_order, 8, label + ': ordering must use the remapped list scope');
      assert.equal(scopedStores.at(-1).shopping_list_id, 99);
    } else if (outcome === 'duplicate') assert.equal(result.id, 55, label + ': return canonical-scope duplicate');
    else assert.equal(result, null, label + ': revoked/absent origin must not publish a store');
  }
}

// Exercise the shipped composition-root resolvers against a live remapping collection.
const appSource = readFileSync(new URL('../web/static/js/app.js', import.meta.url), 'utf8');
const composition = appSource.match(/const shoppingStoresController = createShoppingStoresController\(\{[\s\S]*?\n\}\);/)?.[0];
assert(composition, 'production store controller composition must exist');
const compositionLists = [{ id: 'temp-composition', client_mutation_id: 'temp-composition', created_by_user_id: 1 }];
const options = runInNewContext(composition + '\nshoppingStoresController;', {
  createShoppingStoresController: options => options,
  shoppingLists: compositionLists, shoppingStores: [], currentUser: { id: 1 }, resolveEntityIdentity, entityIdentity,
  setShoppingStoresState() {}, commitShoppingMutation() {}, enqueueShoppingListMutation() {},
  isOnlineForSync() {}, syncWithServer() {}, console,
});
assert.equal(options.resolveListIdentity('temp-composition'), 'temp-composition');
assert.equal(options.resolveListId('temp-composition'), 'temp-composition');
compositionLists[0].id = 701;
assert.equal(options.resolveListIdentity(701), 'temp-composition');
assert.equal(options.resolveListId('temp-composition'), 701);
compositionLists.length = 0;
assert.equal(options.resolveListId('temp-composition'), null);

// Exercise the actual keyboard listeners, including already handled row shortcuts
// and the Enter events used to confirm an IME conversion.
function keyboardDocument(elements) {
  const listeners = new Map();
  return {
    getElementById: id => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    async emit(type, event) {
      await Promise.all([...listeners.get(type) || []].map(handler => handler(event)));
    },
  };
}
const keyboardInput = id => ({ id, value: 'Market', setAttribute() {}, removeAttribute() {}, focus() {} });
const creatorInput = keyboardInput('keyboard-new-store-name');
let keyboardCreates = 0;
const creatorDoc = keyboardDocument(new Map([
  [creatorInput.id, creatorInput],
  ['keyboard-new-store', { hidden: false }],
]));
const keyboardCreator = bindShoppingStoreCreator({
  document: creatorDoc, prefix: 'keyboard',
  getContext: () => ({ id: 7 }),
  storeController: { create: async () => { keyboardCreates++; return { id: 77 }; } },
});
keyboardCreator.show();
creatorInput.value = 'Market';
for (const blocked of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
  let prevented = 0;
  await creatorDoc.emit('keydown', { key: 'Enter', target: creatorInput, ...blocked, preventDefault() { prevented++; } });
  assert.equal(keyboardCreates, 0, 'composing/handled Enter must not create an inline store');
  assert.equal(prevented, 0, 'the composition owner must retain its Enter event');
}
await creatorDoc.emit('keydown', { key: 'Enter', target: creatorInput, preventDefault() {} });
assert.equal(keyboardCreates, 1, 'ordinary Enter must still create exactly one store');
keyboardCreator.destroy();

const editorInput = keyboardInput('shopping-store-name');
let keyboardUpdates = 0;
let editorSubmits = 0;
const editorModal = {
  classList: { contains: () => true, remove() {} },
  setAttribute() {}, querySelectorAll: () => [],
};
const editorForm = {
  id: 'shopping-store-form', addEventListener() {}, removeEventListener() {},
  requestSubmit() {
    editorSubmits++;
    void editorDoc.emit('submit', { target: this, preventDefault() {} });
  },
};
const editorDoc = keyboardDocument(new Map([
  ['shopping-store-modal', editorModal], ['shopping-store-form', editorForm],
  ['shopping-store-name', editorInput], ['shopping-store-list-id', { value: '7' }],
  ['shopping-store-id', { value: '77' }], ['shopping-store-save-btn', { disabled: false }],
]));
const keyboardEditor = createShoppingStoreEditorFeature({
  document: editorDoc,
  getLists: () => [{ id: 7, can_edit: true }],
  getStores: () => [{ id: 77, shopping_list_id: 7, name: 'Before', active: true }],
  storeController: { update: async () => { keyboardUpdates++; return { id: 77 }; } },
});
keyboardEditor.bind();
for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
  for (const blocked of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
    await editorDoc.emit('keydown', { key: 'Enter', target: editorInput, ...modifier, ...blocked, preventDefault() {} });
    assert.equal(editorSubmits, 0, 'handled or composing shortcuts must not submit the store editor');
    assert.equal(keyboardUpdates, 0, 'composing shortcuts must not update a store');
  }
}
await editorDoc.emit('keydown', { key: 'Enter', ctrlKey: true, target: editorInput, preventDefault() {} });
assert.equal(editorSubmits, 1, 'ordinary Ctrl+Enter retains the form submission path');
assert.equal(keyboardUpdates, 1, 'ordinary Ctrl+Enter updates the store once');
keyboardEditor.destroy();

console.log('✅ Shared shopping store create controller contracts passed');
