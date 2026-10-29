#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  projectPendingShoppingStores,
  projectShoppingStoresSnapshot,
  rewriteShoppingQueueReferences,
} from '../web/static/js/features/shopping-pending.js';

const serverStores = [
  { id: 1, name: 'REWE', ownership_type: 'user', active: true },
];
const localStores = [
  ...serverStores,
  { id: 'temp-shopping-store-1', name: 'Lidl', ownership_type: 'user', active: true, is_pending: true },
];
const queue = [
  {
    id: 1,
    action: 'CREATE_SHOPPING_STORE',
    data: {
      temp_id: 'temp-shopping-store-1',
      store: { name: 'Lidl', sort_order: 1 },
      client_mutation_id: 'temp-shopping-store-1',
    },
  },
  {
    id: 2,
    action: 'UPDATE_SHOPPING_STORE',
    data: { store_id: 1, changes: { name: 'REWE Center' } },
  },
];

assert.deepEqual(
  projectPendingShoppingStores(serverStores, queue).map(store => store.name),
  ['REWE Center', 'Lidl'],
);
const snapshot = projectShoppingStoresSnapshot(serverStores, localStores, queue);
assert.deepEqual(snapshot.map(store => store.name), ['REWE Center', 'Lidl']);

const rewritten = rewriteShoppingQueueReferences([
  {
    action: 'CREATE_SHOPPING_ITEM',
    data: { item: { name: 'Milk', store_ids: ['temp-shopping-store-1'] } },
  },
  {
    action: 'UPDATE_SHOPPING_ITEM',
    data: { changes: { store_ids: [1, 'temp-shopping-store-1'] } },
  },
  {
    action: 'UPDATE_SHOPPING_PREFERENCES',
    data: { changes: { selected_store_id: 'temp-shopping-store-1' } },
  },
], {
  storeIdFrom: 'temp-shopping-store-1',
  storeIdTo: 2,
});
assert.deepEqual(rewritten[0].data.item.store_ids, [2]);
assert.deepEqual(rewritten[1].data.changes.store_ids, [1, 2]);
assert.equal(rewritten[2].data.changes.selected_store_id, 2);

console.log('✅ Shopping store snapshots and stable-ID references stay offline-safe');
