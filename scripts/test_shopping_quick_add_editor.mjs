#!/usr/bin/env node
import assert from 'node:assert/strict';
import * as editor from '../web/static/js/features/shopping-item-editor.js';
import { parseShoppingQuickAdd } from '../web/static/js/features/shopping-quick-add.js';
import { createShoppingItemsController } from '../web/static/js/features/shopping-items.js';

assert.equal(typeof editor.resolveShoppingQuickAddState, 'function', 'the item editor must resolve explicit fields over parsed Quick Add defaults');
const parsed = {
  title: 'Milch',
  changes: { quantity_value: 2, quantity_unit: 'l', store_ids: ['temp-store'], section_id: 'temp-section' },
};
const empty = { name: '2 l Milch @REWE /Kühlung', quantity: '', unit: '', storeId: null, sectionId: null };
assert.deepEqual(editor.resolveShoppingQuickAddState(empty, parsed), {
  name: 'Milch', quantity: 2, unit: 'l', storeId: 'temp-store', sectionId: 'temp-section',
});
assert.deepEqual(editor.resolveShoppingQuickAddState({ ...empty, quantity: '0', unit: 'Packungen', storeId: 'chosen', sectionId: 'chosen-section' }, parsed), {
  name: 'Milch', quantity: '0', unit: 'Packungen', storeId: 'chosen', sectionId: 'chosen-section',
}, 'explicit details win, including quantity zero');
assert.deepEqual(editor.resolveShoppingQuickAddState(empty, null), empty, 'edit mode must keep the literal title');
assert.deepEqual(editor.resolveShoppingQuickAddState(empty, { title: 'Milch', changes: {} }), { ...empty, name: 'Milch' }, 'omitted syntax preserves unspecified form values');
const bulkDefaults = { storeId: 'default-market', sectionId: 'default-section' };
assert.equal(typeof editor.resolveShoppingBulkQuickAddState, 'function', 'bulk defaults must use a separate precedence contract with the same field resolver');
assert.deepEqual(editor.resolveShoppingBulkQuickAddState({ title: 'Milch', changes: {} }, bulkDefaults), {
  name: 'Milch', quantity: '', unit: '', storeId: 'default-market', sectionId: 'default-section',
});
assert.deepEqual(editor.resolveShoppingBulkQuickAddState(parsed, bulkDefaults), {
  name: 'Milch', quantity: 2, unit: 'l', storeId: 'temp-store', sectionId: 'temp-section',
}, 'explicit per-row syntax wins over shared bulk defaults');
assert.equal(editor.resolveShoppingBulkQuickAddState({ title: 'Milch', changes: { quantity_value: 0 } }, bulkDefaults).quantity, 0);
let lists = [{ id: 'list-local', can_edit: true, sections: [{ id: 'favorites-local', name: "Tobi's Favoriten" }], items: [] }];
const stores = [{ id: 'trader-local', shopping_list_id: 'list-local', name: "Trader Joe's", active: true }];
const commits = [];
let sequence = 0;
const controller = createShoppingItemsController({
  getLists: () => lists,
  setLists: next => { lists = next; },
  getActiveListId: () => 'list-local',
  getStores: () => stores,
  createTempId: () => `temp-quote-${++sequence}`,
  commitMutation: async build => {
    const mutation = build();
    if (mutation) commits.push(mutation);
    return mutation;
  },
});
for (const raw of [`Ben & Jerry's Eis @"Trader Joe's" /Tobi's Favoriten`, `Ben & Jerry's Eis @Trader Joe's /"Tobi's Favoriten"`]) {
  const parsed = parseShoppingQuickAdd(raw, { list: lists[0], stores });
  assert.deepEqual(parsed.errors, []);
  const state = editor.resolveShoppingQuickAddState({ ...empty, name: raw }, parsed);
  await controller.create(state);
  const payload = commits.at(-1).data.item;
  assert.equal(payload.name, "Ben & Jerry's Eis");
  assert.deepEqual(payload.store_ids, ['trader-local'], 'recognized quoted and apostrophe names reach the durable create payload');
  assert.equal(payload.section_id, 'favorites-local');
}
console.log('✅ Shopping Quick Add effective editor state and apostrophe create payload passed');
