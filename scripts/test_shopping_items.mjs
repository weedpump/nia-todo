#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createShoppingItemsController,
  formatShoppingQuantity,
  renderShoppingItem,
} from '../web/static/js/features/shopping-items.js';

const labels = { markCompleted: 'Milch als gekauft markieren', markOpen: 'Milch wieder als offen markieren' };

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
assert.match(openHtml, /class="ui-item-card shopping-item-card is-pending"/);
assert.match(openHtml, /class="shopping-item-title"/);
assert.match(openHtml, /class="ui-badge shopping-item-quantity"/);
assert(openHtml.indexOf('shopping-item-title') < openHtml.indexOf('shopping-item-quantity'), 'title must precede the right-side quantity badge');
assert.match(openHtml, /data-shopping-item-action="toggle-completed"/);
assert.match(openHtml, /data-shopping-item-id="temp-shopping-item-1"/);
assert.match(openHtml, /role="checkbox"/);
assert.match(openHtml, /aria-checked="false"/);
assert.match(openHtml, /aria-label="Milch als gekauft markieren"/);
assert(!openHtml.includes('<img src=x'), 'item title must be escaped');
assert(!openHtml.includes('<b>kg</b>'), 'free quantity unit must be escaped');
assert.match(openHtml, /&lt;img src=x onerror=alert\(1\)&gt; Milch/);
assert.match(openHtml, /2,5 &lt;b&gt;kg&lt;\/b&gt;/);
for (const forbidden of ['todo-item', 'todo-check', 'todo-title', 'data-todo-action', ' data-id=', ' draggable=', 'data-touch-dnd']) {
  assert(!openHtml.includes(forbidden), `shopping item markup must not expose ${forbidden}`);
}

const completedHtml = renderShoppingItem({
  item: { id: 7, name: 'Brot', quantity_value: 0, quantity_unit: '', completed: true },
  canEdit: true,
  locale: 'en-US',
  labels,
});
assert.match(completedHtml, /shopping-item-card is-completed/);
assert.match(completedHtml, /aria-checked="true"/);
assert.match(completedHtml, /aria-label="Milch wieder als offen markieren"/);
assert.match(completedHtml, /shopping-item-check-icon/);
assert.match(completedHtml, />0<\/span>/, 'zero quantity must remain visible');

for (const canEdit of [false, undefined, null, 'true', 1]) {
  const html = renderShoppingItem({ item: { id: 8, name: 'Read only', completed: false }, canEdit, labels });
  assert.match(html, /disabled/, `canEdit=${String(canEdit)} must fail closed`);
  assert(!html.includes('data-shopping-item-action='), `canEdit=${String(canEdit)} must not expose a mutating action`);
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

const todoRenderingSource = readFileSync(new URL('../web/static/js/features/todo-rendering.js', import.meta.url), 'utf8');
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

for (const locale of ['cs', 'de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'zh-CN']) {
  const dictionary = JSON.parse(readFileSync(new URL(`../web/static/i18n/${locale}.json`, import.meta.url), 'utf8'));
  for (const key of ['shopping.item.markCompleted', 'shopping.item.markOpen']) {
    assert.equal(typeof dictionary[key], 'string', `${locale} must contain ${key}`);
    assert(dictionary[key].trim(), `${locale} ${key} must not be empty`);
    assert(dictionary[key].includes('{name}'), `${locale} ${key} must identify the affected item`);
  }
}

console.log('✅ Shopping item renderer and durable completion controller passed');
