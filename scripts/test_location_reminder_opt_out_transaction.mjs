#!/usr/bin/env node
import assert from 'node:assert/strict';

globalThis.location = { origin: 'http://localhost' };
const { commitTodoUpdatesWithQueue } = await import('../web/static/js/storage/indexed-db.js');

function createFakeDatabase() {
  const calls = { stores: null, mode: null, todos: [], syncQueue: [] };
  return {
    calls,
    transaction(stores, mode) {
      calls.stores = stores;
      calls.mode = mode;
      const tx = {
        error: null,
        objectStore(name) {
          return {
            put(value) { calls[name].push(value); },
            add(value) { calls[name].push(value); },
          };
        },
      };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  };
}

const database = createFakeDatabase();
const updates = [
  {
    todo: { id: 1, title: 'One', location_reminder: null, location_reminders: [] },
    changes: { location_reminder: null },
  },
  {
    todo: { id: 2, title: 'Two', location_reminder: null, location_reminders: [] },
    changes: { location_reminder: null },
  },
];

await commitTodoUpdatesWithQueue(updates, {
  database,
  timestamp: 123,
  localUpdatedAt: '2026-10-24T12:00:00.000Z',
});

assert.deepEqual(database.calls.stores, ['todos', 'syncQueue']);
assert.equal(database.calls.mode, 'readwrite');
assert.deepEqual(database.calls.todos, updates.map(update => update.todo));
assert.deepEqual(database.calls.syncQueue, [
  {
    action: 'UPDATE_TODO',
    data: { id: 1, changes: { location_reminder: null } },
    timestamp: 123,
    localUpdatedAt: '2026-10-24T12:00:00.000Z',
  },
  {
    action: 'UPDATE_TODO',
    data: { id: 2, changes: { location_reminder: null } },
    timestamp: 123,
    localUpdatedAt: '2026-10-24T12:00:00.000Z',
  },
]);

await assert.rejects(
  commitTodoUpdatesWithQueue(updates, { database: null }),
  /IndexedDB is not open/,
);

const abortingDatabase = {
  transaction() {
    const tx = {
      error: new Error('transaction failed'),
      objectStore() {
        return { put() {} };
      },
    };
    queueMicrotask(() => tx.onabort?.());
    return tx;
  },
};
await assert.rejects(
  commitTodoUpdatesWithQueue(updates, { database: abortingDatabase }),
  /transaction failed/,
);

console.log('✅ Location reminder opt-out transaction test passed');
