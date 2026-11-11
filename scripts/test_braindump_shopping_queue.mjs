#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createShoppingItemsController } from '../web/static/js/features/shopping-items.js';
import { rewriteShoppingQueueReferences } from '../web/static/js/features/shopping-pending.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture() {
  let lists = [
    { id: 1, can_edit: true, items: [], sections: [] },
    { id: 2, client_mutation_id: 'temp-list-2', can_edit: true, items: [], sections: [{ id: 21, client_mutation_id: 'temp-section-2' }] },
  ];
  let stores = [{ id: 22, client_mutation_id: 'temp-store-2', shopping_list_id: 2, active: true }];
  let gate = null;
  const queued = [];
  const controller = createShoppingItemsController({
    getLists: () => lists,
    setLists: value => { lists = value; },
    getActiveListId: () => 1,
    getStores: () => stores,
    commitMutation: async build => {
      if (gate) await gate.promise;
      const mutation = build();
      if (mutation) queued.push(...structuredClone(mutation.mutations || [mutation]));
      return mutation;
    },
  });
  return { controller, queued, get lists() { return lists; }, set lists(value) { lists = value; },
    get stores() { return stores; }, set stores(value) { stores = value; }, set gate(value) { gate = value; } };
}

const route = {
  original_module_id: 'shopping', original_shopping_list_id: 'temp-list-2',
  original_shopping_section_id: 'temp-section-2', original_shopping_store_ids: ['temp-store-2'],
  original_route_present: true,
};
const input = {
  name: 'Milk', quantity_value: 0, quantity_unit: 'l', section_id: 21, store_ids: [22],
  client_mutation_id: 'temp-bd-item-1', braindump_route: route,
  routing_feedback: {event_id:'bd-route-1',generation:7,fields:['list','section','stores']},
};

{
  const f = fixture();
  assert.equal(await f.controller.createMany([input], { listId: 2 }), null, 'the normal editor keeps its active-list guard');
  const gate = deferred();
  f.gate = gate;
  const operation = f.controller.createManyForList({ listId: 2, items: [input] });
  await Promise.resolve();
  assert.equal(f.lists[1].items.length, 0, 'BrainDump must not publish before durable commit');
  gate.resolve();
  const created = await operation;
  assert.equal(created.length, 1);
  assert.equal(f.lists[0].items.length, 0);
  assert.equal(f.lists[1].items[0].client_mutation_id, input.client_mutation_id);
  assert.equal(f.lists[1].items[0].quantity_value, 0);
  assert.equal('braindump_route' in f.lists[1].items[0], false, 'private feedback stays in the user queue, not the item projection');
  assert.deepEqual(f.queued[0].data.item.braindump_route, route);
  assert.deepEqual(f.queued[0].data.item.routing_feedback,input.routing_feedback,'shared routing feedback stays in the durable mutation');
  assert.equal('routing_feedback' in f.lists[1].items[0],false,'private learning metadata never enters shared item snapshots');
  await f.controller.createManyForList({ listId: 2, items: [input] });
  assert.equal(f.lists[1].items.length, 1, 'retrying a durably accepted candidate must not create a duplicate');
  assert.equal(f.queued.length, 1, 'idempotent local retry must not add a second queue mutation');
  const rewritten = rewriteShoppingQueueReferences(f.queued, {
    listIdFrom: 'temp-list-2', listIdTo: 2,
    sectionIdFrom: 'temp-section-2', sectionIdTo: 21,
    storeIdFrom: 'temp-store-2', storeIdTo: 22,
  });
  assert.deepEqual(rewritten[0].data.item.braindump_route, {
    ...route, original_shopping_list_id: 2, original_shopping_section_id: 21, original_shopping_store_ids: [22],
  });
  assert.deepEqual(f.queued[0].data.item.braindump_route, route, 'rewriting must not mutate the original durable records');
  assert.deepEqual(rewritten[0].data.item.routing_feedback,input.routing_feedback,'target identity remapping preserves the immutable learning event');
}

for (const loseAccess of [true, false]) {
  const f = fixture();
  const gate = deferred();
  let current = true;
  f.gate = gate;
  const operation = f.controller.createManyForList({ listId: 2, items: [input], isCurrent: () => current });
  await Promise.resolve();
  if (loseAccess) f.lists = f.lists.map(list => list.id === 2 ? { ...list, can_edit: false } : list);
  else current = false;
  gate.resolve();
  assert.equal(await operation, null, 'permissions and session must be checked again inside the reserved write boundary');
  assert.equal(f.lists[1].items.length, 0);
  assert.equal(f.queued.length, 0);
}

{
  const f = fixture();
  const gate = deferred();
  f.gate = gate;
  const operation = f.controller.createManyForList({ listId: 'temp-list-2', items: [{ ...input, section_id: 'temp-section-2', store_ids: ['temp-store-2'] }] });
  await Promise.resolve();
  f.lists = f.lists.map(list => list.id === 2 ? { ...list, id: 20, sections: [{ id: 210, client_mutation_id: 'temp-section-2' }] } : list);
  f.stores = [{ id: 220, client_mutation_id: 'temp-store-2', shopping_list_id: 20, active: true }];
  gate.resolve();
  const [created] = await operation;
  assert.equal(created.shopping_list_id, 20);
  assert.equal(created.section_id, 210);
  assert.deepEqual(created.store_ids, [220]);
}

{
  const f = fixture();
  assert.equal(await f.controller.createManyForList({ listId: 2, items: [input, input] }), null, 'a batch may not reuse one mutation identity for two candidates');
  assert.equal(f.queued.length, 0);
}

console.log('✅ BrainDump Shopping durable target creation, retry, permission and remapping contracts passed');
