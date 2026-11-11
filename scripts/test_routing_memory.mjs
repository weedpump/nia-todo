#!/usr/bin/env node
// Pure client proposals/cache lifecycle. No service, browser profile or DB.
import assert from 'node:assert/strict';
const values = new Map();
const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
  removeItem: key => values.delete(key), key: index => [...values.keys()][index], get length() { return values.size; } };
globalThis.location = { origin: 'http://memory.test', search: '' };
globalThis.window = {};
globalThis.localStorage = storage;
const { createRoutingMemoryFeature, normalizeRoutingName } = await import('../web/static/js/features/routing-memory.js');
let actor = 1, session = '1:first', server = 'first-server', enabled = true, fail = false, gate = null;
let lists = [{ id: 10, can_edit: true, sections: [{ id: 20 }] }, { id: 11, can_edit: true, sections: [] }];
let stores = [{ id: 30, shopping_list_id: 10, active: true }, { id: 31, shopping_list_id: 10, active: true }];
let remote = { enabled: true, generation: 0, learned_routes: 2, entries: [
  { name_key: 'butter', shopping_list_id: 10, section_id: 20, section_known: true, store_ids: [30, 31], stores_known: true, preferred: true },
  { name_key: 'butter', shopping_list_id: 11, section_id: null, section_known: true, store_ids: [], stores_known: true },
  { name_key: 'öl', shopping_list_id: 10, section_id: 20, section_known: true, store_ids: [], stores_known: false, list_known: false },
] };
const api = { read: async () => { const result = structuredClone(remote); if (gate) await gate; if (fail) throw Error('offline'); return result; },
  update: async value => { remote = { enabled: value, generation: remote.generation + 1, learned_routes: 0, entries: [] }; return remote; },
  reset: async () => { remote = { ...remote, generation: remote.generation + 1, learned_routes: 0, entries: [] }; return remote; } };
const options = { getActorId: () => actor, getSessionIdentity: () => session, getEnabled: () => enabled,
  onEnabledChange: value => { enabled = value; },
  getServerIdentity: () => server,
  getLists: () => lists, getStores: () => stores, storage, api, eventTarget: new EventTarget(), createEventId: () => 'event-1' };
const memory = createRoutingMemoryFeature(options);
assert.deepEqual(memory.feedback(['section']).fields, [], 'uninitialized memory never teaches an unversioned choice');
await memory.refresh();
assert.equal(memory.suggest('  BUTTER  ').shopping_list_id, 10);
assert.deepEqual(memory.suggest('Butter', 10).store_ids, [30, 31]);
server = 'other-server';
assert.equal(memory.suggest('Butter', 10), null, 'native servers with identical actor/entity IDs never share memories');
server = 'first-server';
assert.equal(memory.suggest('Butter', 10).section_id, 20);
assert.equal(memory.suggest('Butter', 11).section_id, null, 'explicit none is distinct from an unknown route');
assert.equal(memory.suggest('Butter', 11).section_known, true);
assert.equal(memory.suggest('Buter', 10), null, 'no fuzzy/typo matching');
assert.equal(memory.suggest('Unbekannter Zusatz Butter', 10).section_id, 20, 'a complete personal word works without a predefined qualifier list');
assert.equal(memory.suggest('Öl'), null, 'a section-only observation is not an explicit list preference');
assert.equal(memory.suggest('Öl', 10).section_id, 20, 'section-only memory still applies inside the chosen list');
const catalogMemory = createRoutingMemoryFeature({ ...options, storage: null, eventTarget: new EventTarget(),
  api: { ...api, read: async () => ({enabled:true,generation:0,revision:1,learned_routes:4001,
    entries:Array.from({length:4001},(_,index)=>({name_key:`catalog identity ${index}`,shopping_list_id:10,
      list_known:true,preferred:true,section_known:true,section_id:20,history_fields:['list','section']}))}) } });
await catalogMemory.refresh();
assert.equal(catalogMemory.snapshot().entries.length,4000,'the shared recent/modern model pool fits the bounded offline cache');
assert.equal(catalogMemory.suggest('catalog identity 3999').section_id,20,'the modern part of the exported model is never silently truncated to the old 2000-row bound');
catalogMemory.clear();
const initial = structuredClone(remote);
remote = { ...remote, revision: 2, entries: remote.entries.map(row => ({ ...row, section_id: null })) };
await memory.refresh();
remote = initial;
await memory.refresh();
assert.equal(memory.suggest('Butter', 10).section_id, null, 'a stale same-generation reply cannot overwrite a newer confirmed choice');
remote = { ...initial, revision: 3 }; await memory.refresh();
assert.deepEqual(memory.feedback(['section', 'section', 'other'], { eventId: 'stable' }), { event_id: 'stable', generation: 0, fields: ['section'] });
assert.deepEqual(memory.feedback([]).fields, [], 'predicted routes have no learning intent');
let releaseAuthRead;
gate = new Promise(resolve => { releaseAuthRead = resolve; });
const staleAuthRead = memory.refresh(); await Promise.resolve();
enabled = false;
assert.equal(memory.suggest('Butter', 10), null, 'an authenticated opt-out is immediate within the same session');
assert.deepEqual(memory.feedback(['section']).fields, [], 'a new account flag fences feedback while offline');
releaseAuthRead(); gate = null; await staleAuthRead;
assert.equal(memory.snapshot().enabled, false, 'an earlier GET cannot undo the newly observed opt-out');
await memory.refresh();
assert.equal(enabled, true, 'a later authoritative memory state updates the account flag on reenable');
assert.equal(memory.suggest('Butter', 10).section_id, 20);
for (const name of ['Öl', '盐', '米', '牛奶', ' Crème   fraîche ', 'Straße']) assert.ok(normalizeRoutingName(name));
assert.equal(normalizeRoutingName('ＳＡＬＺ'), 'salz');
assert.equal(normalizeRoutingName('Straße'), 'strasse');
stores[0].active = false;
assert.equal(memory.suggest('Butter', 10).stores_known, false, 'deactivated store sets are not proposed');
assert.equal(memory.suggest('Butter', 10).section_known, true, 'an invalid store does not erase an independent section');
stores[0].active = true; lists[0].sections = [];
assert.equal(memory.suggest('Butter', 10).section_known, false);
assert.deepEqual(memory.suggest('Butter', 10).store_ids, [30, 31]);
lists[0].can_edit = false;
assert.equal(memory.suggest('Butter', 10), null, 'revoked access filters an otherwise cached route');
lists[0].can_edit = true; lists[0].sections = [{ id: 20 }];
fail = true;
const offline = createRoutingMemoryFeature(options);
await offline.refresh();
assert.equal(offline.suggest('Butter', 10).section_id, 20, 'same-account offline cache remains usable');
actor = 2; session = '2:first';
assert.equal(memory.suggest('Butter', 10), null, 'another account never inherits cached choices');
actor = 1; session = '1:new'; fail = false;
assert.equal(memory.suggest('Butter', 10).section_id, 20);
let release;
gate = new Promise(resolve => { release = resolve; });
const pending = memory.refresh(); await Promise.resolve();
await memory.reset();
release(); gate = null; await pending;
assert.equal(memory.snapshot().generation, 1);
assert.equal(memory.suggest('Butter', 10), null, 'a late pre-reset reply cannot recreate forgotten entries');
assert.equal(memory.feedback(['stores']).generation, 1);
await memory.setEnabled(false);
assert.deepEqual(memory.feedback(['section']).fields, [], 'opt-out stops feedback as well as proposals');
assert.equal(memory.suggest('Butter', 10), null);
memory.clear();
assert.equal(values.size, 0, 'logout removes persisted personal route caches');
assert.equal(memory.suggest('Butter', 10), null);
console.log('PASS shared routing proposals, explicit fields, Unicode, offline cache, access, account and reset isolation');
