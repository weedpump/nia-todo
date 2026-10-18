#!/usr/bin/env node
import assert from 'node:assert/strict';

globalThis.location = { origin: 'https://todo.example', search: '' };
globalThis.window = {};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'Mozilla/5.0', platform: 'Linux', maxTouchPoints: 0 },
});

let openRequest;
const database = {
  objectStoreNames: { contains: () => true },
  close() {},
  transaction(storeName) {
    const tx = { error: null };
    if (storeName === 'syncQueue') {
      tx.objectStore = () => ({ put() {} });
      queueMicrotask(() => {
        tx.error = new Error('sync queue write failed');
        tx.onerror?.();
      });
    } else if (storeName === 'attachmentBlobs') {
      tx.objectStore = () => ({
        get() {
          const request = {};
          queueMicrotask(() => {
            request.error = new Error('attachment cache read failed');
            request.onerror?.();
          });
          return request;
        },
      });
    } else {
      assert.fail(`Unexpected store ${storeName}`);
    }
    return tx;
  },
};

globalThis.indexedDB = {
  open() {
    openRequest = {};
    return openRequest;
  },
};

const { openDatabase } = await import('../web/static/js/storage/indexed-db.js');
const { enqueue } = await import('../web/static/js/sync/queue.js');
const { attachmentCache } = await import('../web/static/js/storage/attachment-cache.js');

const opening = openDatabase();
openRequest.onsuccess({ target: { result: database } });
await opening;

await assert.rejects(
  enqueue('CREATE_ATTACHMENT', { todo_id: 1 }),
  /sync queue write failed/,
  'sync queue persistence must reject failed IndexedDB transactions',
);

await assert.rejects(
  attachmentCache.get('pending-attachment'),
  /attachment cache read failed/,
  'attachment cache reads must distinguish storage failure from a cache miss',
);

console.log('✅ Sync queue writes and attachment cache reads preserve storage failures');
