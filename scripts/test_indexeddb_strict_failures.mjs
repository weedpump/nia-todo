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
const records = new Map();
const database = {
  objectStoreNames: { contains: () => true },
  close() {},
  transaction() {
    const tx = { error: new Error('transaction failed') };
    tx.objectStore = () => ({
      put(item) { records.set(item.id, item); },
      delete(id) { records.delete(id); },
      clear() { records.clear(); },
      getAll() {
        const request = {};
        queueMicrotask(() => {
          if (transactionOutcome === 'request-error') request.onerror?.();
          else {
            request.result = [...records.values()];
            request.onsuccess?.();
          }
        });
        return request;
      },
    });
    queueMicrotask(() => {
      if (transactionOutcome === 'complete') tx.oncomplete?.();
      else if (transactionOutcome === 'abort') tx.onabort?.();
      else if (transactionOutcome === 'error') tx.onerror?.();
    });
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

const appStorage = createAppStorage({ setDb() {} });
assert.equal(typeof appStorage.dbPutStrict, 'function');
assert.equal(typeof appStorage.dbGetAllStrict, 'function');
assert.equal(typeof appStorage.deleteFromDBStrict, 'function');
assert.equal(typeof appStorage.dbClearStrict, 'function');

deleteOutcome = 'error';
await assert.rejects(indexedDb.closeAndDeleteDatabase(), /delete failed|delete error/i);
deleteOutcome = 'blocked';
await assert.rejects(indexedDb.closeAndDeleteDatabase(), /blocked/i);

console.log('✅ Strict IndexedDB wrappers reject transaction and deletion failures');
