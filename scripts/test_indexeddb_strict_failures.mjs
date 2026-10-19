#!/usr/bin/env node
import assert from 'node:assert/strict';

globalThis.window = {};
globalThis.location = { origin: 'https://todo.example', search: '' };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'Mozilla/5.0', platform: 'Linux', maxTouchPoints: 0 },
});

let deleteOutcome = 'success';
let transactionOutcome = 'complete';
const stores = new Map([
  ['todos', new Map()],
  ['syncQueue', new Map()],
  ['attachmentBlobs', new Map()],
]);
const database = {
  objectStoreNames: { contains: () => true },
  close() {},
  transaction(storeNames) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const staged = new Map(names.map(name => [name, new Map(stores.get(name) || [])]));
    let active = true;
    let aborted = false;
    let pendingRequests = 0;
    let finishScheduled = false;
    const scheduleFinish = () => {
      if (finishScheduled) return;
      finishScheduled = true;
      setTimeout(() => {
        finishScheduled = false;
        if (!active || aborted || pendingRequests) return;
        active = false;
        if (transactionOutcome === 'complete') {
          for (const [name, records] of staged) stores.set(name, records);
          tx.oncomplete?.();
        } else if (transactionOutcome === 'abort') tx.onabort?.();
        else if (transactionOutcome === 'error') tx.onerror?.();
      }, 0);
    };
    const runRequest = callback => {
      pendingRequests += 1;
      setTimeout(() => {
        try {
          if (active) callback();
        } finally {
          pendingRequests -= 1;
          scheduleFinish();
        }
      }, 0);
    };
    const assertActive = () => {
      if (!active) {
        const error = new Error('The transaction is inactive');
        error.name = 'TransactionInactiveError';
        throw error;
      }
    };
    const tx = {
      error: new Error('transaction failed'),
      abort() {
        if (!active) throw new Error('The transaction has already finished');
        aborted = true;
        active = false;
        queueMicrotask(() => tx.onabort?.());
      },
    };
    tx.objectStore = name => ({
      put(item) {
        assertActive();
        const request = {};
        runRequest(() => {
          staged.get(name).set(item.id, structuredClone(item));
          request.result = item.id;
          request.onsuccess?.();
        });
        return request;
      },
      delete(id) {
        assertActive();
        const request = {};
        runRequest(() => { staged.get(name).delete(id); request.onsuccess?.(); });
        return request;
      },
      clear() {
        assertActive();
        const request = {};
        runRequest(() => { staged.get(name).clear(); request.onsuccess?.(); });
        return request;
      },
      get(id) {
        assertActive();
        const request = {};
        runRequest(() => { request.result = staged.get(name).get(id); request.onsuccess?.(); });
        return request;
      },
      getAll() {
        assertActive();
        const request = {};
        runRequest(() => {
          if (transactionOutcome === 'request-error') request.onerror?.();
          else {
            request.result = [...staged.get(name).values()];
            request.onsuccess?.();
          }
        });
        return request;
      },
    });
    scheduleFinish();
    return tx;
  },
};
let openRequest;
globalThis.indexedDB = {
  open() {
    openRequest = {};
    queueMicrotask(() => openRequest.onsuccess?.({ target: { result: database } }));
    return openRequest;
  },
  deleteDatabase() {
    const request = { error: new Error('delete failed') };
    queueMicrotask(() => {
      if (deleteOutcome === 'success') request.onsuccess?.();
      else if (deleteOutcome === 'blocked') request.onblocked?.();
      else request.onerror?.();
    });
    return request;
  },
};

const indexedDb = await import('../web/static/js/storage/indexed-db.js');
const { createAppStorage } = await import('../web/static/js/storage/app-storage.js');
await indexedDb.openDatabase();

transactionOutcome = 'abort';
await assert.rejects(indexedDb.putStrict('attachmentBlobs', { id: 'put-failure' }), /transaction failed|Failed to write/);
await assert.rejects(indexedDb.removeStrict('attachmentBlobs', 'remove-failure'), /transaction failed|Failed to delete/);
await assert.rejects(indexedDb.clearStrict('attachmentBlobs'), /transaction failed|Failed to clear/);
transactionOutcome = 'request-error';
await assert.rejects(indexedDb.getAllStrict('syncQueue'), /transaction failed|Failed to read/);
transactionOutcome = 'complete';

stores.get('todos').set(1, { id: 1, title: 'Before' });
stores.get('syncQueue').set(1, { id: 1, action: 'CREATE_ATTACHMENT' });
transactionOutcome = 'abort';
await assert.rejects(
  indexedDb.transactionStrict(['todos', 'syncQueue'], 'readwrite', async transaction => {
    await transaction.put('todos', { id: 1, title: 'After' });
    await transaction.delete('syncQueue', 1);
  }),
  /transaction failed|aborted/i,
);
assert.equal(stores.get('todos').get(1).title, 'Before', 'an aborted multi-store transaction must roll back todo writes');
assert.equal(stores.get('syncQueue').has(1), true, 'an aborted multi-store transaction must roll back queue deletes');
transactionOutcome = 'complete';
await indexedDb.transactionStrict(['todos', 'syncQueue'], 'readwrite', async transaction => {
  await transaction.put('todos', { id: 1, title: 'Committed' });
  await transaction.delete('syncQueue', 1);
});
assert.equal(stores.get('todos').get(1).title, 'Committed');
assert.equal(stores.get('syncQueue').has(1), false);

stores.get('todos').set(2, { id: 2, title: 'Before delayed rejection' });
await assert.rejects(
  indexedDb.transactionStrict(['todos'], 'readwrite', async transaction => {
    await transaction.put('todos', { id: 2, title: 'Must roll back' });
    await new Promise((_, reject) => setTimeout(() => reject(new Error('late operation failure')), 20));
  }),
  /late operation failure/,
);
assert.equal(stores.get('todos').get(2).title, 'Before delayed rejection', 'a delayed operation rejection must abort before writes commit');

stores.get('todos').set(3, { id: 3, title: 'Before delayed commit' });
await indexedDb.transactionStrict(['todos'], 'readwrite', async transaction => {
  await transaction.put('todos', { id: 3, title: 'First write' });
  await new Promise(resolve => setTimeout(resolve, 20));
  await transaction.put('todos', { id: 3, title: 'Committed after await' });
});
assert.equal(stores.get('todos').get(3).title, 'Committed after await', 'the transaction must remain active for requests issued after an asynchronous await');

const appStorage = createAppStorage({ setDb() {} });
assert.equal(typeof appStorage.dbPutStrict, 'function');
assert.equal(typeof appStorage.dbGetAllStrict, 'function');
assert.equal(typeof appStorage.deleteFromDBStrict, 'function');
assert.equal(typeof appStorage.dbClearStrict, 'function');
assert.equal(typeof appStorage.dbTransactionStrict, 'function');

deleteOutcome = 'error';
await assert.rejects(indexedDb.closeAndDeleteDatabase(), /delete failed|delete error/i);
deleteOutcome = 'blocked';
await assert.rejects(indexedDb.closeAndDeleteDatabase(), /blocked/i);

console.log('✅ Strict IndexedDB wrappers reject transaction and deletion failures');
