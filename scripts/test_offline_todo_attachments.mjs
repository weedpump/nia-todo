#!/usr/bin/env node
import assert from 'node:assert/strict';

globalThis.location = { origin: 'https://todo.example', search: '' };
globalThis.window = {};
globalThis.localStorage = { getItem: () => null };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { onLine: true, userAgent: 'Mozilla/5.0', platform: 'Linux', maxTouchPoints: 0, storage: {} },
});

const { createAttachmentCache, DEFAULT_ATTACHMENT_CACHE_MAX_BYTES } = await import('../web/static/js/storage/attachment-cache.js');
const { createTodoAttachmentsFeature, getAttachmentAvailability } = await import('../web/static/js/features/todo-attachments.js');
const { commitLocalTodoDeletion } = await import('../web/static/js/features/todos.js');
const { createSyncFeature } = await import('../web/static/js/features/sync.js');
const { createWebSocketClient } = await import('../web/static/js/features/websocket-client.js');
const { projectPendingTodoChanges, queueItemReferencesTodo } = await import('../web/static/js/features/todo-pending.js');
const { todosApi } = await import('../web/static/js/api/todos.js');
const { resumeAuthenticatedRequests, suspendAuthenticatedRequests, waitForAuthenticatedSideEffects } = await import('../web/static/js/api/http.js');

function memoryCache(initial = []) {
  const records = new Map(initial.map(item => [item.id, structuredClone(item)]));
  return {
    records,
    cache: createAttachmentCache({
      getAll: async () => [...records.values()],
      get: async id => records.get(id) || null,
      put: async item => { records.set(item.id, item); },
      remove: async id => { records.delete(id); },
      estimateStorage: async () => ({ usage: 0, quota: 1024 * 1024 * 1024 }),
      requestPersistence: async () => true,
    }),
  };
}

function createMemoryTransaction(stores, { fail = null } = {}) {
  return async (storeNames, _mode, operation) => {
    const staged = Object.fromEntries(storeNames.map(name => [name, structuredClone(stores[name] || [])]));
    let operationCount = 0;
    const maybeFail = () => {
      operationCount += 1;
      if (fail?.(operationCount)) throw new Error('injected metadata transaction failure');
    };
    const transaction = {
      getAll: async store => structuredClone(staged[store] || []),
      get: async (store, id) => structuredClone((staged[store] || []).find(item => String(item.id) === String(id)) || null),
      put: async (store, item) => {
        maybeFail();
        const next = structuredClone(item);
        if (store === 'syncQueue' && next.id == null) {
          next.id = Math.max(0, ...(staged[store] || []).map(existing => Number(existing.id) || 0)) + 1;
        }
        staged[store] = [...(staged[store] || []).filter(existing => String(existing.id) !== String(next.id)), next];
        return next;
      },
      delete: async (store, id) => {
        maybeFail();
        staged[store] = (staged[store] || []).filter(item => String(item.id) !== String(id));
      },
      clear: async store => { maybeFail(); staged[store] = []; },
    };
    const result = await operation(transaction);
    for (const name of storeNames) stores[name] = staged[name];
    return result;
  };
}

function createMemoryTransactionWithCache(stores, cacheState, options = {}) {
  const transaction = createMemoryTransaction(stores, options);
  return async (storeNames, mode, operation) => {
    const result = await transaction(storeNames, mode, operation);
    if (storeNames.includes('attachmentBlobs')) {
      cacheState.records.clear();
      for (const record of stores.attachmentBlobs || []) cacheState.records.set(record.id, structuredClone(record));
    }
    return result;
  };
}

for (const failureStep of [1, 2]) {
  const stores = { todos: [{ id: 501, title: 'Atomic delete' }], syncQueue: [] };
  await assert.rejects(commitLocalTodoDeletion({
    todoId: 501,
    dbTransactionStrict: createMemoryTransaction(stores, { fail: count => count === failureStep }),
    runSyncQueueMutation: operation => operation(),
  }), /injected metadata transaction failure/);
  assert.equal(stores.todos.length, 1, `todo deletion step ${failureStep} must roll back the todo projection`);
  assert.equal(stores.syncQueue.length, 0, `todo deletion step ${failureStep} must roll back the queue record`);
}
const localDeleteStores = { todos: [{ id: 502, title: 'Atomic delete success' }], syncQueue: [] };
await commitLocalTodoDeletion({
  todoId: 502,
  dbTransactionStrict: createMemoryTransaction(localDeleteStores),
  runSyncQueueMutation: operation => operation(),
});
assert.equal(localDeleteStores.todos.length, 0);
assert.equal(localDeleteStores.syncQueue[0].action, 'DELETE_TODO');

function syncHarness({ queue, todos, blobs, api, attachmentCache = null, currentUser = null, dbGetAllStrict = null, dbPutStrict = null, dbClearStrict = null, deleteFromDBStrict = null, dbTransactionStrict = null, transactionFail = null }) {
  const stores = {
    syncQueue: structuredClone(queue),
    todos: structuredClone(todos),
    attachmentBlobs: structuredClone(blobs),
    projects: [], sections: [], workspaces: [],
  };
  const cacheState = memoryCache(blobs);
  const transactionImpl = dbTransactionStrict || createMemoryTransaction(stores, { fail: transactionFail });
  const transactionWithCacheMirror = async (storeNames, mode, operation) => {
    const result = await transactionImpl(storeNames, mode, operation);
    if (storeNames.includes('attachmentBlobs')) {
      cacheState.records.clear();
      for (const record of stores.attachmentBlobs || []) cacheState.records.set(record.id, structuredClone(record));
    }
    return result;
  };
  const userState = { current: currentUser ? structuredClone(currentUser) : null };
  const feature = createSyncFeature({
    getDb: () => ({}),
    dbGetAll: async store => structuredClone(stores[store] || []),
    dbGetAllStrict: dbGetAllStrict || (async store => structuredClone(stores[store] || [])),
    dbPut: async (store, item) => {
      stores[store] = [...(stores[store] || []).filter(existing => String(existing.id) !== String(item.id)), structuredClone(item)];
    },
    dbPutStrict: dbPutStrict || (async (store, item) => {
      stores[store] = [...(stores[store] || []).filter(existing => String(existing.id) !== String(item.id)), structuredClone(item)];
    }),
    dbClear: async store => { stores[store] = []; },
    dbClearStrict: dbClearStrict || (async store => { stores[store] = []; }),
    getFromDB: async (store, id) => structuredClone((stores[store] || []).find(item => String(item.id) === String(id)) || null),
    deleteFromDB: async (store, id) => { stores[store] = (stores[store] || []).filter(item => String(item.id) !== String(id)); },
    deleteFromDBStrict: deleteFromDBStrict || (async (store, id) => { stores[store] = (stores[store] || []).filter(item => String(item.id) !== String(id)); }),
    dbTransactionStrict: transactionWithCacheMirror,
    getTodos: () => stores.todos,
    setTodos: next => { stores.todos = structuredClone(next); },
    getProjects: () => stores.projects,
    setProjects: next => { stores.projects = structuredClone(next); },
    getSections: () => stores.sections,
    setSections: next => { stores.sections = structuredClone(next); },
    getWorkspaces: () => stores.workspaces,
    setWorkspaces: next => { stores.workspaces = structuredClone(next); },
    getCurrentUser: () => userState.current,
    setCurrentUser: next => { userState.current = structuredClone(next); },
    todosApi: { list: async () => ({ todos: structuredClone(stores.todos) }), ...api },
    projectsApi: { list: async () => ({ projects: [] }) },
    sectionsApi: { listAll: async () => ({ sections: [] }) },
    workspacesApi: { list: async () => ({ workspaces: [] }) },
    attachmentCache: attachmentCache || cacheState.cache,
    renderStats: () => {},
    renderTodos: () => {},
  });
  return { stores, cacheState, userState, feature };
}

console.log('📎 Running offline todo attachment tests...');

const originalFetch = globalThis.fetch;
let usageRequest = null;
globalThis.fetch = async (url, options) => {
  usageRequest = { url, options };
  return { ok: true, json: async () => ({ used_bytes: 1 }) };
};
assert.deepEqual(await todosApi.getAttachmentUsage(), { used_bytes: 1 });
assert.equal(usageRequest.url, '/api/todos/attachments/usage');
assert.equal(usageRequest.options.method, 'GET');
globalThis.fetch = originalFetch;

assert.equal(DEFAULT_ATTACHMENT_CACHE_MAX_BYTES, 250 * 1024 * 1024);
const eviction = memoryCache([
  { id: 'old', todo_id: 1, attachment_id: 1, blob: new Blob(['1234']), size_bytes: 4, last_accessed: 1, pinned: false, pending_upload: false },
  { id: 'pinned', todo_id: 1, attachment_id: 2, blob: new Blob(['1234']), size_bytes: 4, last_accessed: 2, pinned: true, pending_upload: false },
  { id: 'pending', todo_id: 1, attachment_id: 'temp-pending', blob: new Blob(['1234']), size_bytes: 4, last_accessed: 3, pinned: false, pending_upload: true },
]);
await eviction.cache.put({ id: 'new', todo_id: 1, attachment_id: 3, blob: new Blob(['123456']), size_bytes: 6, pinned: false, pending_upload: false }, { maxBytes: 14 });
assert.equal(eviction.records.has('old'), false, 'LRU downloaded entries should be evicted first');
assert.equal(eviction.records.has('pinned'), true, 'explicit offline entries must never be evicted automatically');
assert.equal(eviction.records.has('pending'), true, 'pending uploads are user data and must never be evicted');

let failedScanWrites = 0;
let failedScanRemovals = 0;
const failedScanCache = createAttachmentCache({
  getAll: async () => { throw new Error('transient attachment enumeration failure'); },
  get: async () => null,
  put: async () => { failedScanWrites += 1; },
  remove: async () => { failedScanRemovals += 1; },
});
await assert.rejects(failedScanCache.prune(), /enumeration failure/, 'prune must reject transient bulk-read failures');
await assert.rejects(failedScanCache.removeForTodo(1), /enumeration failure/, 'todo cleanup must reject transient bulk-read failures');
await assert.rejects(failedScanCache.rewriteTodoId('temp-1', 1), /enumeration failure/, 'todo-id rewrites must reject transient bulk-read failures');
await assert.rejects(
  failedScanCache.put({ id: 'new-pending', todo_id: 1, blob: new Blob(['pending']), pending_upload: true }),
  /enumeration failure/,
  'a failed prune scan must reject before claiming a pending blob was stored',
);
assert.equal(failedScanWrites, 0, 'failed enumeration must not rewrite attachment records');
assert.equal(failedScanRemovals, 0, 'failed enumeration must not delete attachment records');

const projected = projectPendingTodoChanges(
  { id: 7, attachments: [{ id: 70, original_filename: 'server.txt' }] },
  [
    { action: 'CREATE_ATTACHMENT', data: { todo_id: 7, local_attachment: { id: 'temp-a', original_filename: 'offline.txt', is_pending: true } } },
    { action: 'DELETE_ATTACHMENT', data: { todo_id: 7, attachment_id: 70 } },
  ],
);
assert.deepEqual(projected.attachments.map(item => item.id), ['temp-a']);
assert.equal(projected.attachments_count, 1);
const projectedRealtimeEcho = projectPendingTodoChanges(
  { id: 7, attachments: [{ id: 82, client_mutation_id: 'temp-echo', original_filename: 'echo.txt' }] },
  [{ action: 'CREATE_ATTACHMENT', data: { todo_id: 7, temp_id: 'temp-echo', client_mutation_id: 'temp-echo', local_attachment: { id: 'temp-echo', original_filename: 'echo.txt', is_pending: true } } }],
);
assert.deepEqual(projectedRealtimeEcho.attachments.map(item => item.id), ['temp-echo'], 'realtime upload echoes must not duplicate the optimistic attachment');
assert.equal(queueItemReferencesTodo({ action: 'CREATE_ATTACHMENT', data: { todo_id: 'temp-parent' } }, 'temp-parent'), true);

const uploadBlob = new Blob(['offline bytes'], { type: 'text/plain' });
const uploadCalls = [];
const uploadHarness = syncHarness({
  queue: [{
    id: 1,
    action: 'CREATE_ATTACHMENT',
    data: {
      todo_id: 7,
      temp_id: 'temp-attachment-1',
      blob_id: 'temp-attachment-1',
      client_mutation_id: 'mutation-1',
      filename: 'offline.txt',
      content_type: 'text/plain',
      size_bytes: uploadBlob.size,
      local_attachment: { id: 'temp-attachment-1', todo_id: 7, original_filename: 'offline.txt', content_type: 'text/plain', size_bytes: uploadBlob.size, is_pending: true },
    },
  }],
  todos: [{ id: 7, title: 'Offline', attachments: [{ id: 'temp-attachment-1', original_filename: 'offline.txt', is_pending: true }] }],
  blobs: [{ id: 'temp-attachment-1', todo_id: 7, attachment_id: 'temp-attachment-1', blob: uploadBlob, size_bytes: uploadBlob.size, pending_upload: true, pinned: true, last_accessed: 1 }],
  api: {
    uploadAttachment: async (todoId, blob, options) => {
      uploadCalls.push({ todoId, blob, options });
      const attachment = { id: 81, todo_id: todoId, user_id: 1, original_filename: 'offline.txt', content_type: 'text/plain', size_bytes: blob.size };
      return { attachment, todo: { id: todoId, title: 'Offline', attachments: [attachment], attachments_count: 1 } };
    },
  },
});
const uploadResult = await uploadHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(uploadResult.failCount, 0);
assert.equal(uploadCalls[0].options.clientMutationId, 'mutation-1');
assert.equal(await uploadCalls[0].blob.text(), 'offline bytes');
assert.deepEqual(uploadHarness.stores.todos[0].attachments.map(item => item.id), [81]);
assert.equal(uploadHarness.stores.syncQueue.length, 0);
assert.equal(uploadHarness.cacheState.records.has('temp-attachment-1'), false);
assert.equal(uploadHarness.cacheState.records.get('81')?.pending_upload, false, 'uploaded bytes should remain as normal cached content');

for (const failureStep of [1, 2, 3, 4, 5]) {
  let injectedUploadCalls = 0;
  const tempId = `temp-post-upload-${failureStep}`;
  const failureHarness = syncHarness({
    queue: [
      { id: 100 + failureStep, action: 'CREATE_ATTACHMENT', data: { todo_id: 7, temp_id: tempId, blob_id: tempId, client_mutation_id: tempId, filename: 'atomic.txt', content_type: 'text/plain' } },
      { id: 200 + failureStep, action: 'DELETE_ATTACHMENT', data: { todo_id: 7, attachment_id: tempId } },
    ],
    todos: [{ id: 7, attachments: [], attachments_count: 0 }],
    blobs: [{ id: tempId, todo_id: 7, attachment_id: tempId, blob: uploadBlob, pending_upload: true, pinned: true }],
    transactionFail: count => count === failureStep,
    api: {
      uploadAttachment: async () => {
        injectedUploadCalls += 1;
        return { attachment: { id: 900 + failureStep, todo_id: 7 }, todo: { id: 7, attachments: [{ id: 900 + failureStep }], attachments_count: 1 } };
      },
    },
  });
  const result = await failureHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
  assert.equal(result.failCount, 1, `post-upload transaction step ${failureStep} must propagate as a replay failure`);
  assert.equal(injectedUploadCalls, 1, 'the HTTP upload should complete before persistence failure injection');
  assert.equal(failureHarness.stores.syncQueue.some(item => item.action === 'CREATE_ATTACHMENT' && item.data.temp_id === tempId), true, `step ${failureStep} must retain the idempotent create for retry`);
  assert.equal(failureHarness.stores.syncQueue.find(item => item.action === 'DELETE_ATTACHMENT')?.data.attachment_id, tempId, `step ${failureStep} must not partially rewrite dependent queue IDs`);
  assert.equal(failureHarness.cacheState.records.has(tempId), true, `step ${failureStep} must retain the original pending blob`);
  assert.equal(failureHarness.cacheState.records.has(String(900 + failureStep)), false, `step ${failureStep} must not expose a partially rewritten blob`);
  assert.deepEqual(failureHarness.stores.todos[0].attachments, [], `step ${failureStep} must retain the pre-commit todo projection`);
}

let markerFailureUploadCalls = 0;
const markerFailureHarness = syncHarness({
  queue: [{ id: 2, action: 'CREATE_ATTACHMENT', data: { todo_id: 7, temp_id: 'temp-marker-failure', blob_id: 'temp-marker-failure', filename: 'marker.txt', content_type: 'text/plain' } }],
  todos: [{ id: 7, attachments: [{ id: 'temp-marker-failure', is_pending: true }], attachments_count: 1 }],
  blobs: [{ id: 'temp-marker-failure', todo_id: 7, attachment_id: 'temp-marker-failure', blob: uploadBlob, pending_upload: true, pinned: true }],
  dbPutStrict: async (store) => {
    if (store === 'syncQueue') throw new Error('marker transaction failed');
  },
  api: { uploadAttachment: async () => { markerFailureUploadCalls += 1; } },
});
const markerFailureResult = await markerFailureHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(markerFailureResult.failCount, 1, 'failed durable upload markers must remain retryable');
assert.equal(markerFailureUploadCalls, 0, 'HTTP upload must not start until upload_started is durable');
assert.equal(markerFailureHarness.stores.syncQueue.length, 1, 'marker failures must preserve the queued create');
const markerFailureDeleteUi = createTodoAttachmentsFeature({
  getTodos: () => markerFailureHarness.stores.todos,
  setTodos: next => { markerFailureHarness.stores.todos = structuredClone(next); },
  getProjects: () => [], getCurrentUser: () => ({ id: 1 }), setCurrentUser: () => {},
  getAppInitialized: () => true, getDb: () => ({}),
  dbPut: async (store, item) => { markerFailureHarness.stores[store] = [...markerFailureHarness.stores[store].filter(existing => String(existing.id) !== String(item.id)), structuredClone(item)]; },
  dbPutStrict: async (store, item) => { markerFailureHarness.stores[store] = [...markerFailureHarness.stores[store].filter(existing => String(existing.id) !== String(item.id)), structuredClone(item)]; },
  dbGetAll: async store => structuredClone(markerFailureHarness.stores[store] || []),
  dbGetAllStrict: async store => structuredClone(markerFailureHarness.stores[store] || []),
  deleteFromDB: async (store, id) => { markerFailureHarness.stores[store] = markerFailureHarness.stores[store].filter(item => String(item.id) !== String(id)); },
  deleteFromDBStrict: async (store, id) => { markerFailureHarness.stores[store] = markerFailureHarness.stores[store].filter(item => String(item.id) !== String(id)); },
  dbTransactionStrict: createMemoryTransactionWithCache(markerFailureHarness.stores, markerFailureHarness.cacheState),
  runSyncQueueMutation: async operation => operation(async () => assert.fail('a failed upload marker must be treated as not started')),
  isOnlineForSync: () => true, syncWithServer: async () => {}, todosApi: {}, attachmentCache: markerFailureHarness.cacheState.cache,
  renderStats: () => {}, renderTodos: () => {}, closeModal: () => {}, confirmDanger: async () => true, showToast: () => {}, t: key => key, iconSvg: () => '', escapeHtmlAttr: String,
  setTodoCollapsibleOpen: () => {}, refreshTodoActionButtonState: () => {}, refreshTodoSaveButtonState: () => {},
});
await markerFailureDeleteUi.deleteTodoAttachment(7, 'temp-marker-failure');
assert.equal(markerFailureHarness.stores.syncQueue.length, 0, 'delete after marker failure must cancel the queued create');
assert.equal(markerFailureHarness.cacheState.records.has('temp-marker-failure'), false, 'delete after marker failure must remove pending bytes');

let sequentialUploadCount = 0;
const sequentialBlobA = new Blob(['aaaa']);
const sequentialBlobB = new Blob(['bbbb']);
const sequentialHarness = syncHarness({
  queue: [
    { id: 31, action: 'CREATE_ATTACHMENT', data: { todo_id: 7, temp_id: 'temp-a', blob_id: 'temp-a', filename: 'a.txt', content_type: 'text/plain' } },
    { id: 32, action: 'CREATE_ATTACHMENT', data: { todo_id: 7, temp_id: 'temp-b', blob_id: 'temp-b', filename: 'b.txt', content_type: 'text/plain' } },
  ],
  todos: [{ id: 7, attachments: [{ id: 'temp-a', is_pending: true }, { id: 'temp-b', is_pending: true }], attachments_count: 2 }],
  blobs: [
    { id: 'temp-a', todo_id: 7, attachment_id: 'temp-a', blob: sequentialBlobA, pending_upload: true, pinned: true },
    { id: 'temp-b', todo_id: 7, attachment_id: 'temp-b', blob: sequentialBlobB, pending_upload: true, pinned: true },
  ],
  currentUser: { id: 1, attachment_usage_bytes: 0, attachment_quota_bytes: 10, attachment_remaining_bytes: 10 },
  api: {
    uploadAttachment: async (todoId, blob) => {
      sequentialUploadCount += 1;
      if (sequentialUploadCount === 2) assert.equal(sequentialHarness.userState.current.attachment_remaining_bytes, 6, 'the next upload must observe quota usage from the previous replay');
      const id = 300 + sequentialUploadCount;
      const attachment = { id, todo_id: todoId, size_bytes: blob.size };
      const remaining = 10 - (sequentialUploadCount * blob.size);
      return {
        attachment,
        todo: { id: todoId, attachments: sequentialUploadCount === 1 ? [attachment, { id: 'temp-b', is_pending: true }] : [{ id: 301 }, attachment], attachments_count: 2 },
        usage: { enabled: true, used_bytes: 10 - remaining, quota_bytes: 10, remaining_bytes: remaining, allowed_types: ['text/plain'], max_upload_bytes: 25 },
      };
    },
  },
});
const sequentialResult = await sequentialHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(sequentialResult.failCount, 0);
assert.equal(sequentialHarness.userState.current.attachment_usage_bytes, 8);
assert.equal(sequentialHarness.userState.current.attachment_remaining_bytes, 2);
assert.deepEqual(sequentialHarness.userState.current.attachments_allowed_types, ['text/plain']);

let rewrittenDeleteAttachmentId = null;
const uploadDeleteHarness = syncHarness({
  queue: [
    { id: 41, action: 'CREATE_ATTACHMENT', data: { todo_id: 7, temp_id: 'temp-upload-delete', blob_id: 'temp-upload-delete', client_mutation_id: 'temp-upload-delete', filename: 'cycle.txt', content_type: 'text/plain' } },
    { id: 42, action: 'DELETE_ATTACHMENT', data: { todo_id: 7, attachment_id: 'temp-upload-delete' } },
  ],
  todos: [{ id: 7, attachments: [], attachments_count: 0 }],
  blobs: [{ id: 'temp-upload-delete', todo_id: 7, attachment_id: 'temp-upload-delete', blob: sequentialBlobA, pending_upload: true, pinned: true }],
  currentUser: { id: 1, attachment_usage_bytes: 0, attachment_quota_bytes: 10, attachment_remaining_bytes: 10 },
  api: {
    uploadAttachment: async () => ({
      attachment: { id: 410, todo_id: 7, size_bytes: 4 },
      todo: { id: 7, attachments: [{ id: 410, size_bytes: 4 }], attachments_count: 1 },
      usage: { used_bytes: 4, quota_bytes: 10, remaining_bytes: 6 },
    }),
    deleteAttachment: async (_todoId, attachmentId) => {
      rewrittenDeleteAttachmentId = attachmentId;
      assert.equal(uploadDeleteHarness.userState.current.attachment_remaining_bytes, 6, 'delete replay must observe quota from the preceding upload');
      return { todo: { id: 7, attachments: [], attachments_count: 0 }, usage: { used_bytes: 0, quota_bytes: 10, remaining_bytes: 10 } };
    },
  },
});
const uploadDeleteResult = await uploadDeleteHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(uploadDeleteResult.failCount, 0);
assert.equal(rewrittenDeleteAttachmentId, 410, 'dependent attachment delete must use the uploaded server ID');
assert.equal(uploadDeleteHarness.userState.current.attachment_remaining_bytes, 10, 'delete replay must restore quota state');

const readFailureCache = memoryCache([{ id: 'temp-read-failure', todo_id: 7, attachment_id: 'temp-read-failure', blob: uploadBlob, size_bytes: uploadBlob.size, pending_upload: true, pinned: true }]);
const readFailureHarness = syncHarness({
  queue: [{ id: 11, action: 'CREATE_ATTACHMENT', data: { todo_id: 7, temp_id: 'temp-read-failure', blob_id: 'temp-read-failure', filename: 'retry.txt', content_type: 'text/plain' } }],
  todos: [{ id: 7, attachments: [{ id: 'temp-read-failure', is_pending: true }], attachments_count: 1 }],
  blobs: [],
  attachmentCache: { ...readFailureCache.cache, get: async () => { throw new Error('transient IndexedDB read failure'); } },
  api: { uploadAttachment: async () => assert.fail('upload must not run when attachment storage cannot be read') },
});
const readFailureResult = await readFailureHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(readFailureResult.failCount, 1, 'attachment storage I/O failures must remain retryable');
assert.equal(readFailureHarness.stores.syncQueue.length, 1, 'attachment storage I/O failures must retain the queue item');
assert.equal(readFailureCache.records.has('temp-read-failure'), true, 'attachment storage I/O failures must retain pending bytes');

for (const failureStep of [1, 2, 3, 4, 5]) {
  const todoRewriteHarness = syncHarness({
    queue: [
      { id: 61, action: 'CREATE_TODO', data: { _tempId: 'temp-parent', title: 'Temp parent', client_mutation_id: 'temp-parent' } },
      { id: 62, action: 'CREATE_ATTACHMENT', data: { todo_id: 'temp-parent', temp_id: 'temp-parent-attachment', blob_id: 'temp-parent-attachment', filename: 'pending.txt', content_type: 'text/plain', local_attachment: { id: 'temp-parent-attachment', todo_id: 'temp-parent', is_pending: true } } },
    ],
    todos: [{ id: 'temp-parent', title: 'Temp parent', attachments: [{ id: 'temp-parent-attachment', todo_id: 'temp-parent', is_pending: true }], attachments_count: 1 }],
    blobs: [{ id: 'temp-parent-attachment', todo_id: 'temp-parent', attachment_id: 'temp-parent-attachment', blob: uploadBlob, pending_upload: true, pinned: true }],
    transactionFail: count => count === failureStep,
    api: {
      create: async () => ({ id: 70, title: 'Temp parent', attachments: [], attachments_count: 0 }),
      uploadAttachment: async () => { const error = new Error('retry later'); error.status = 503; throw error; },
    },
  });
  const result = await todoRewriteHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
  assert.ok(result.failCount >= 1, `todo rewrite transaction step ${failureStep} must fail closed`);
  assert.equal(todoRewriteHarness.stores.todos.some(todo => todo.id === 'temp-parent'), true);
  assert.equal(todoRewriteHarness.stores.todos.some(todo => todo.id === 70), false);
  assert.equal(todoRewriteHarness.stores.syncQueue.some(item => item.action === 'CREATE_TODO'), true);
  assert.equal(todoRewriteHarness.stores.syncQueue.find(item => item.action === 'CREATE_ATTACHMENT').data.todo_id, 'temp-parent');
  assert.equal(todoRewriteHarness.cacheState.records.get('temp-parent-attachment').todo_id, 'temp-parent');
}

const todoRewriteSuccessHarness = syncHarness({
  queue: [
    { id: 63, action: 'CREATE_TODO', data: { _tempId: 'temp-parent-ok', title: 'Temp parent', client_mutation_id: 'temp-parent-ok' } },
    { id: 64, action: 'CREATE_ATTACHMENT', data: { todo_id: 'temp-parent-ok', temp_id: 'temp-child-ok', blob_id: 'temp-child-ok', filename: 'pending.txt', content_type: 'text/plain', local_attachment: { id: 'temp-child-ok', todo_id: 'temp-parent-ok', is_pending: true } } },
  ],
  todos: [{ id: 'temp-parent-ok', title: 'Temp parent', attachments: [{ id: 'temp-child-ok', todo_id: 'temp-parent-ok', is_pending: true }], attachments_count: 1 }],
  blobs: [{ id: 'temp-child-ok', todo_id: 'temp-parent-ok', attachment_id: 'temp-child-ok', blob: uploadBlob, pending_upload: true, pinned: true }],
  api: {
    create: async () => ({ id: 72, title: 'Temp parent', attachments: [], attachments_count: 0 }),
    uploadAttachment: async () => { const error = new Error('retry later'); error.status = 503; throw error; },
  },
});
await todoRewriteSuccessHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(todoRewriteSuccessHarness.stores.todos.some(todo => todo.id === 'temp-parent-ok'), false);
assert.equal(todoRewriteSuccessHarness.stores.todos.some(todo => todo.id === 72), true);
assert.equal(todoRewriteSuccessHarness.stores.syncQueue.some(item => item.action === 'CREATE_TODO'), false);
assert.equal(todoRewriteSuccessHarness.stores.syncQueue.find(item => item.action === 'CREATE_ATTACHMENT').data.todo_id, 72);
assert.equal(todoRewriteSuccessHarness.cacheState.records.get('temp-child-ok').todo_id, 72);

const attachmentRewriteReadFailureHarness = syncHarness({
  queue: [
    { id: 65, action: 'CREATE_ATTACHMENT', data: { todo_id: 7, temp_id: 'temp-strict-upload', blob_id: 'temp-strict-upload', filename: 'strict-upload.txt', content_type: 'text/plain' } },
    { id: 66, action: 'DELETE_ATTACHMENT', data: { todo_id: 7, attachment_id: 'temp-strict-upload' } },
  ],
  todos: [{ id: 7, attachments: [], attachments_count: 0 }],
  blobs: [{ id: 'temp-strict-upload', todo_id: 7, attachment_id: 'temp-strict-upload', blob: uploadBlob, pending_upload: true, pinned: true }],
  transactionFail: count => count === 1,
  api: { uploadAttachment: async () => ({ attachment: { id: 730, todo_id: 7 }, todo: { id: 7, attachments: [{ id: 730 }], attachments_count: 1 } }) },
});
const attachmentRewriteReadFailureResult = await attachmentRewriteReadFailureHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(attachmentRewriteReadFailureResult.failCount, 1, 'dependent attachment ID rewrites must fail atomically on transaction errors');
assert.equal(attachmentRewriteReadFailureHarness.stores.syncQueue.find(item => item.action === 'DELETE_ATTACHMENT').data.attachment_id, 'temp-strict-upload');
assert.equal(attachmentRewriteReadFailureHarness.cacheState.records.has('temp-strict-upload'), true, 'failed strict queue reads must not rewrite pending bytes');

const removeForTodoFailureHarness = syncHarness({
  queue: [{ id: 71, action: 'DELETE_TODO', data: { id: 71 } }],
  todos: [{ id: 71, title: 'Delete me', attachments: [{ id: 710 }], attachments_count: 1 }],
  blobs: [{ id: 'delete-todo-attachment', todo_id: 71, attachment_id: 710, blob: uploadBlob, pinned: true }],
  transactionFail: count => count === 3,
  api: { delete: async () => ({}) },
});
const removeForTodoFailureResult = await removeForTodoFailureHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(removeForTodoFailureResult.failCount, 1);
assert.equal(removeForTodoFailureHarness.stores.todos.length, 1, 'failed blob deletion must not commit authoritative local todo deletion');
assert.equal(removeForTodoFailureHarness.stores.syncQueue.length, 1, 'failed blob deletion must retain the todo delete queue item');
assert.equal(removeForTodoFailureHarness.cacheState.records.has('delete-todo-attachment'), true);

const deleteTodo404Harness = syncHarness({
  queue: [
    { id: 72, action: 'DELETE_TODO', data: { id: 72 } },
    { id: 73, action: 'CREATE_ATTACHMENT', data: { todo_id: 72, temp_id: 'temp-delete-404', blob_id: 'temp-delete-404' } },
  ],
  todos: [{ id: 72, title: 'Already gone', attachments: [{ id: 'temp-delete-404', is_pending: true }], attachments_count: 1 }],
  blobs: [{ id: 'temp-delete-404', todo_id: 72, attachment_id: 'temp-delete-404', blob: uploadBlob, pending_upload: true, pinned: true }],
  api: { delete: async () => { const error = new Error('already gone'); error.status = 404; throw error; } },
});
const deleteTodo404Result = await deleteTodo404Harness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(deleteTodo404Result.failCount, 0, 'DELETE_TODO 404 recovery must commit as terminal success');
assert.equal(deleteTodo404Harness.stores.todos.length, 0);
assert.equal(deleteTodo404Harness.stores.syncQueue.length, 0, 'DELETE_TODO 404 recovery must remove all referencing queue entries');
assert.equal(deleteTodo404Harness.cacheState.records.size, 0, 'DELETE_TODO 404 recovery must remove all todo blobs atomically');

const missingBlobHarness = syncHarness({
  queue: [{ id: 12, action: 'CREATE_ATTACHMENT', data: { todo_id: 7, temp_id: 'temp-missing', blob_id: 'temp-missing', filename: 'missing.txt', content_type: 'text/plain' } }],
  todos: [{ id: 7, attachments: [{ id: 'temp-missing', is_pending: true }], attachments_count: 1 }],
  blobs: [],
  api: { uploadAttachment: async () => assert.fail('upload must not run without pending bytes') },
});
const missingBlobResult = await missingBlobHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(missingBlobResult.failCount, 0, 'a confirmed missing pending blob is a permanent recoverable-data failure');
assert.equal(missingBlobHarness.stores.syncQueue.length, 0, 'a confirmed missing pending blob must not retry forever');
assert.deepEqual(missingBlobHarness.stores.todos[0].attachments, [], 'a confirmed missing pending blob must remove the unrecoverable local projection');

let permanentUploadCalls = 0;
const permanentUploadHarness = syncHarness({
  queue: [{ id: 13, action: 'CREATE_ATTACHMENT', data: { todo_id: 7, temp_id: 'temp-too-large', blob_id: 'temp-too-large', filename: 'large.bin', content_type: 'application/octet-stream', upload_started: false } }],
  todos: [{ id: 7, attachments: [{ id: 'temp-too-large', is_pending: true }], attachments_count: 1 }],
  blobs: [{ id: 'temp-too-large', todo_id: 7, attachment_id: 'temp-too-large', blob: uploadBlob, pending_upload: true, pinned: true }],
  api: {
    uploadAttachment: async () => {
      permanentUploadCalls += 1;
      const error = new Error('payload too large');
      error.status = 413;
      error.code = 'attachment_too_large';
      throw error;
    },
  },
});
const permanentUploadResult = await permanentUploadHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(permanentUploadResult.failCount, 0, 'permanent attachment upload rejection must become durable local failure state');
assert.equal(permanentUploadHarness.stores.syncQueue.length, 1, 'permanent attachment upload rejection must retain its queue item for local cancellation');
assert.equal(permanentUploadHarness.stores.syncQueue[0].data.failed_permanent, true);
assert.equal(permanentUploadHarness.stores.syncQueue[0].data.upload_started, false, 'permanent failure must no longer look in-flight');
assert.equal(permanentUploadHarness.stores.syncQueue[0].data.sync_error.code, 'attachment_too_large');
assert.equal(permanentUploadHarness.stores.todos[0].attachments[0].failed_permanent, true, 'permanent failure must be projected durably on the local attachment');
assert.equal(permanentUploadHarness.cacheState.records.has('temp-too-large'), true, 'permanent server rejection must retain pending bytes');
await permanentUploadHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(permanentUploadCalls, 1, 'durably failed attachment creates must be skipped by automatic retries');

let permanentRefreshTodoCalls = 0;
let permanentRefreshProjectCalls = 0;
const permanentRefreshHarness = syncHarness({
  queue: [{ id: 131, action: 'CREATE_ATTACHMENT', data: {
    todo_id: 7, temp_id: 'temp-permanent-refresh', blob_id: 'temp-permanent-refresh',
    failed_permanent: true,
    local_attachment: { id: 'temp-permanent-refresh', todo_id: 7, is_pending: true, failed_permanent: true },
  } }],
  todos: [{ id: 7, title: 'Old local title', attachments: [{ id: 'temp-permanent-refresh', is_pending: true, failed_permanent: true }], attachments_count: 1 }],
  blobs: [{ id: 'temp-permanent-refresh', todo_id: 7, attachment_id: 'temp-permanent-refresh', blob: uploadBlob, pending_upload: true, pinned: true }],
  api: { list: async () => { permanentRefreshTodoCalls += 1; return { todos: [{ id: 7, title: 'Fresh server title', attachments: [], attachments_count: 0 }] }; } },
});
permanentRefreshHarness.feature = createSyncFeature({
  getDb: () => ({}),
  dbGetAll: async store => structuredClone(permanentRefreshHarness.stores[store] || []),
  dbGetAllStrict: async store => structuredClone(permanentRefreshHarness.stores[store] || []),
  dbPut: async () => {}, dbPutStrict: async () => {}, dbClear: async () => {}, dbClearStrict: async () => {},
  getFromDB: async (store, id) => structuredClone((permanentRefreshHarness.stores[store] || []).find(item => String(item.id) === String(id)) || null),
  deleteFromDB: async () => {}, deleteFromDBStrict: async () => {},
  dbTransactionStrict: createMemoryTransaction(permanentRefreshHarness.stores),
  getTodos: () => permanentRefreshHarness.stores.todos, setTodos: next => { permanentRefreshHarness.stores.todos = structuredClone(next); },
  getProjects: () => permanentRefreshHarness.stores.projects, setProjects: next => { permanentRefreshHarness.stores.projects = structuredClone(next); },
  getSections: () => permanentRefreshHarness.stores.sections, setSections: next => { permanentRefreshHarness.stores.sections = structuredClone(next); },
  getWorkspaces: () => permanentRefreshHarness.stores.workspaces, setWorkspaces: next => { permanentRefreshHarness.stores.workspaces = structuredClone(next); },
  todosApi: { list: async () => { permanentRefreshTodoCalls += 1; return { todos: [{ id: 7, title: 'Fresh server title', attachments: [], attachments_count: 0 }] }; } },
  projectsApi: { list: async () => { permanentRefreshProjectCalls += 1; return { projects: [{ id: 9, name: 'Fresh project' }] }; } },
  sectionsApi: { listAll: async () => ({ sections: [{ id: 10, project_id: 9 }] }) },
  workspacesApi: { list: async () => ({ workspaces: [{ id: 11, name: 'Fresh workspace' }] }) },
  attachmentCache: permanentRefreshHarness.cacheState.cache, renderStats: () => {}, renderTodos: () => {},
});
await permanentRefreshHarness.feature.refreshFromServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(permanentRefreshTodoCalls, 1, 'permanent attachment failures must not block REST full sync');
assert.equal(permanentRefreshProjectCalls, 1, 'permanent attachment failures must not block project refresh');
assert.equal(permanentRefreshHarness.stores.todos[0].title, 'Fresh server title');
assert.deepEqual(permanentRefreshHarness.stores.todos[0].attachments.map(item => item.id), ['temp-permanent-refresh'], 'full sync must preserve the failed local attachment projection');
assert.equal(permanentRefreshHarness.stores.projects[0].name, 'Fresh project');

const deletedPermanentRefreshHarness = syncHarness({
  queue: [{ id: 132, action: 'CREATE_ATTACHMENT', data: {
    todo_id: 8, temp_id: 'temp-permanent-deleted', blob_id: 'temp-permanent-deleted', failed_permanent: true,
    local_attachment: { id: 'temp-permanent-deleted', todo_id: 8, is_pending: true, failed_permanent: true },
  } }],
  todos: [{ id: 8, title: 'Deleted elsewhere', attachments: [{ id: 'temp-permanent-deleted', is_pending: true, failed_permanent: true }], attachments_count: 1 }],
  blobs: [{ id: 'temp-permanent-deleted', todo_id: 8, attachment_id: 'temp-permanent-deleted', blob: uploadBlob, pending_upload: true, pinned: true }],
  api: { list: async () => ({ todos: [] }) },
});
deletedPermanentRefreshHarness.feature = createSyncFeature({
  getDb: () => ({}),
  dbGetAll: async store => structuredClone(deletedPermanentRefreshHarness.stores[store] || []),
  dbGetAllStrict: async store => structuredClone(deletedPermanentRefreshHarness.stores[store] || []),
  dbPut: async () => {}, dbPutStrict: async () => {}, dbClear: async () => {}, dbClearStrict: async () => {},
  getFromDB: async (store, id) => structuredClone((deletedPermanentRefreshHarness.stores[store] || []).find(item => String(item.id) === String(id)) || null),
  deleteFromDB: async () => {}, deleteFromDBStrict: async () => {},
  dbTransactionStrict: createMemoryTransactionWithCache(deletedPermanentRefreshHarness.stores, deletedPermanentRefreshHarness.cacheState),
  getTodos: () => deletedPermanentRefreshHarness.stores.todos, setTodos: next => { deletedPermanentRefreshHarness.stores.todos = structuredClone(next); },
  getProjects: () => [], setProjects: () => {}, getSections: () => [], setSections: () => {}, getWorkspaces: () => [], setWorkspaces: () => {},
  todosApi: { list: async () => ({ todos: [] }) }, projectsApi: { list: async () => ({ projects: [] }) },
  sectionsApi: { listAll: async () => ({ sections: [] }) }, workspacesApi: { list: async () => ({ workspaces: [] }) },
  attachmentCache: deletedPermanentRefreshHarness.cacheState.cache, renderStats: () => {}, renderTodos: () => {},
});
await deletedPermanentRefreshHarness.feature.refreshFromServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(deletedPermanentRefreshHarness.stores.todos.length, 0, 'authoritative REST deletion must remove a todo with only a permanent attachment failure');
assert.equal(deletedPermanentRefreshHarness.stores.syncQueue.length, 0, 'authoritative REST deletion must remove the orphaned permanent queue entry');
assert.equal(deletedPermanentRefreshHarness.cacheState.records.size, 0, 'authoritative REST deletion must remove orphaned failed upload bytes');

const permanentCancellationHarness = syncHarness({
  queue: [
    { id: 141, action: 'CREATE_ATTACHMENT', data: { todo_id: 7, temp_id: 'temp-permanent-cancel', blob_id: 'temp-permanent-cancel', filename: 'cancel.bin', content_type: 'application/octet-stream' } },
    { id: 142, action: 'DELETE_ATTACHMENT', data: { todo_id: 7, attachment_id: 'temp-permanent-cancel' } },
  ],
  todos: [{ id: 7, attachments: [{ id: 'temp-permanent-cancel', is_pending: true }], attachments_count: 1 }],
  blobs: [{ id: 'temp-permanent-cancel', todo_id: 7, attachment_id: 'temp-permanent-cancel', blob: uploadBlob, pending_upload: true, pinned: true }],
  api: { uploadAttachment: async () => { const error = new Error('rejected'); error.status = 413; throw error; } },
});
const permanentCancellationResult = await permanentCancellationHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(permanentCancellationResult.failCount, 0);
assert.equal(permanentCancellationHarness.stores.syncQueue.length, 0, 'permanent upload rejection with dependent delete must cancel both queue records');
assert.deepEqual(permanentCancellationHarness.stores.todos[0].attachments, [], 'permanent upload cancellation must remove the optimistic metadata');
assert.equal(permanentCancellationHarness.stores.todos[0].attachments_count, 0);
assert.equal(permanentCancellationHarness.cacheState.records.size, 0, 'permanent upload cancellation must remove pending bytes atomically');

for (const failureStep of [1, 2]) {
  const tempId = `temp-permanent-marker-${failureStep}`;
  const permanentMarkerFailureHarness = syncHarness({
    queue: [{ id: 130 + failureStep, action: 'CREATE_ATTACHMENT', data: { todo_id: 7, temp_id: tempId, blob_id: tempId, filename: 'rejected.bin', content_type: 'application/octet-stream', upload_started: false } }],
    todos: [{ id: 7, attachments: [{ id: tempId, is_pending: true }], attachments_count: 1 }],
    blobs: [{ id: tempId, todo_id: 7, attachment_id: tempId, blob: uploadBlob, pending_upload: true, pinned: true }],
    transactionFail: count => count === failureStep,
    api: { uploadAttachment: async () => { const error = new Error('rejected'); error.status = 413; throw error; } },
  });
  const result = await permanentMarkerFailureHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
  assert.equal(result.failCount, 1, `permanent marker transaction step ${failureStep} must propagate persistence failure`);
  assert.equal(permanentMarkerFailureHarness.stores.syncQueue[0].data.failed_permanent, undefined, `step ${failureStep} must not partially persist the permanent queue marker`);
  assert.equal(permanentMarkerFailureHarness.stores.syncQueue[0].data.upload_started, true, `step ${failureStep} must retain the retry-safe started marker`);
  assert.equal(permanentMarkerFailureHarness.stores.todos[0].attachments[0].failed_permanent, undefined, `step ${failureStep} must not partially persist the todo failure projection`);
  assert.equal(permanentMarkerFailureHarness.cacheState.records.has(tempId), true);
}
let permanentDeleteServerCalls = 0;
const permanentDeleteFeature = createTodoAttachmentsFeature({
  getTodos: () => permanentUploadHarness.stores.todos,
  setTodos: next => { permanentUploadHarness.stores.todos = structuredClone(next); },
  getProjects: () => [], getCurrentUser: () => ({ id: 1 }), setCurrentUser: () => {},
  getAppInitialized: () => true, getDb: () => ({}),
  dbPut: async (store, item) => { permanentUploadHarness.stores[store] = [...permanentUploadHarness.stores[store].filter(existing => String(existing.id) !== String(item.id)), structuredClone(item)]; },
  dbPutStrict: async (store, item) => { permanentUploadHarness.stores[store] = [...permanentUploadHarness.stores[store].filter(existing => String(existing.id) !== String(item.id)), structuredClone(item)]; },
  dbGetAll: async store => structuredClone(permanentUploadHarness.stores[store] || []),
  dbGetAllStrict: async store => structuredClone(permanentUploadHarness.stores[store] || []),
  deleteFromDB: async (store, id) => { permanentUploadHarness.stores[store] = permanentUploadHarness.stores[store].filter(item => String(item.id) !== String(id)); },
  deleteFromDBStrict: async (store, id) => { permanentUploadHarness.stores[store] = permanentUploadHarness.stores[store].filter(item => String(item.id) !== String(id)); },
  dbTransactionStrict: createMemoryTransactionWithCache(permanentUploadHarness.stores, permanentUploadHarness.cacheState),
  runSyncQueueMutation: async operation => operation(async () => { permanentDeleteServerCalls += 1; }),
  isOnlineForSync: () => true, syncWithServer: async () => {}, todosApi: { deleteAttachment: async () => { permanentDeleteServerCalls += 1; } },
  attachmentCache: permanentUploadHarness.cacheState.cache,
  renderStats: () => {}, renderTodos: () => {}, closeModal: () => {}, confirmDanger: async () => true, showToast: () => {}, t: key => key, iconSvg: () => '', escapeHtmlAttr: String,
  setTodoCollapsibleOpen: () => {}, refreshTodoActionButtonState: () => {}, refreshTodoSaveButtonState: () => {},
});
await permanentDeleteFeature.deleteTodoAttachment(7, 'temp-too-large');
assert.equal(permanentDeleteServerCalls, 0, 'deleting a permanently failed pending upload must not enqueue or call server delete');
assert.equal(permanentUploadHarness.stores.syncQueue.length, 0);
assert.equal(permanentUploadHarness.stores.todos[0].attachments.length, 0);
assert.equal(permanentUploadHarness.cacheState.records.has('temp-too-large'), false);

const deleteHarness = syncHarness({
  queue: [{ id: 2, action: 'DELETE_ATTACHMENT', data: { todo_id: 7, attachment_id: 81 } }],
  todos: [{ id: 7, attachments: [] }],
  blobs: [{ id: '81', todo_id: 7, attachment_id: 81, blob: uploadBlob, size_bytes: uploadBlob.size, pinned: true, pending_upload: false }],
  api: {
    deleteAttachment: async () => {
      const error = new Error('already deleted');
      error.status = 404;
      throw error;
    },
    getAttachmentUsage: async () => ({}),
  },
});
const deleteResult = await deleteHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(deleteResult.failCount, 0, 'authenticated attachment delete 404 is terminal during replay');
assert.equal(deleteHarness.stores.syncQueue.length, 0);
assert.equal(deleteHarness.cacheState.records.has('81'), false);

let delete404UsageCalls = 0;
const delete404UsageHarness = syncHarness({
  queue: [{ id: 21, action: 'DELETE_ATTACHMENT', data: { todo_id: 7, attachment_id: 83 } }],
  todos: [{ id: 7, attachments: [], attachments_count: 0 }],
  blobs: [{ id: '83', todo_id: 7, attachment_id: 83, blob: uploadBlob, pinned: true }],
  currentUser: { id: 1, attachment_usage_bytes: 12, attachment_quota_bytes: 20, attachment_remaining_bytes: 8 },
  deleteFromDBStrict: async (store, id) => {
    assert.equal(delete404UsageHarness.userState.current.attachment_remaining_bytes, 20, 'usage must be applied before the delete queue record is committed');
    delete404UsageHarness.stores[store] = delete404UsageHarness.stores[store].filter(item => String(item.id) !== String(id));
  },
  api: {
    deleteAttachment: async () => { const error = new Error('already deleted'); error.status = 404; throw error; },
    getAttachmentUsage: async () => {
      delete404UsageCalls += 1;
      return { used_bytes: 0, quota_bytes: 20, remaining_bytes: 20 };
    },
  },
});
await delete404UsageHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(delete404UsageCalls, 1, 'delete 404 replay must refresh authoritative attachment usage');
assert.equal(delete404UsageHarness.userState.current.attachment_remaining_bytes, 20, 'delete 404 usage refresh must be applied before queue removal');
assert.equal(delete404UsageHarness.stores.syncQueue.length, 0);

const deleteQuotaHarness = syncHarness({
  queue: [{ id: 3, action: 'DELETE_ATTACHMENT', data: { todo_id: 7, attachment_id: 82 } }],
  todos: [{ id: 7, attachments: [], attachments_count: 0 }],
  blobs: [{ id: '82', todo_id: 7, attachment_id: 82, blob: uploadBlob, pinned: true }],
  currentUser: { id: 1, attachment_usage_bytes: 12, attachment_quota_bytes: 20, attachment_remaining_bytes: 8 },
  api: { deleteAttachment: async () => ({ todo: { id: 7, attachments: [], attachments_count: 0 }, usage: { used_bytes: 0, quota_bytes: 20, remaining_bytes: 20 } }) },
});
await deleteQuotaHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(deleteQuotaHarness.userState.current.attachment_usage_bytes, 0, 'successful delete replay must update attachment usage');
assert.equal(deleteQuotaHarness.userState.current.attachment_remaining_bytes, 20);

for (const failureStep of [1, 2, 3]) {
  const atomicDeleteHarness = syncHarness({
    queue: [{ id: 300 + failureStep, action: 'DELETE_ATTACHMENT', data: { todo_id: 7, attachment_id: 82 } }],
    todos: [{ id: 7, attachments: [{ id: 82 }], attachments_count: 1 }],
    blobs: [{ id: '82', todo_id: 7, attachment_id: 82, blob: uploadBlob, pinned: true }],
    transactionFail: count => count === failureStep,
    api: { deleteAttachment: async () => ({ todo: { id: 7, attachments: [], attachments_count: 0 }, usage: { used_bytes: 0 } }) },
  });
  const result = await atomicDeleteHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
  assert.equal(result.failCount, 1, `attachment delete transaction step ${failureStep} must fail retryably`);
  assert.equal(atomicDeleteHarness.stores.syncQueue.length, 1);
  assert.equal(atomicDeleteHarness.stores.todos[0].attachments_count, 1);
  assert.equal(atomicDeleteHarness.cacheState.records.has('82'), true);
}

const refreshHarness = syncHarness({
  queue: [],
  todos: [{ id: 50, attachments: [{ id: 500 }], attachments_count: 1, updated_at: '2026-10-18T10:00:00Z' }],
  blobs: [{ id: '500', todo_id: 50, attachment_id: 500, blob: uploadBlob, pinned: true, offline_explicit: true }],
  api: { list: async () => ({ todos: [{ id: 50, attachments: [], attachments_count: 0, updated_at: '2026-10-18T11:00:00Z' }] }) },
});
await refreshHarness.feature.refreshFromServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(refreshHarness.cacheState.records.has('500'), false, 'REST refresh must purge cached bytes for server attachments removed from an existing todo');

const crossTodoCache = memoryCache([
  { id: 'shared-id-a', todo_id: 61, attachment_id: 900, blob: uploadBlob, pinned: true },
  { id: 'shared-id-b', todo_id: 62, attachment_id: 900, blob: uploadBlob, pinned: true },
  { id: 'shared-temp-a', todo_id: 61, attachment_id: 'same-temp', blob: uploadBlob, pending_upload: true, pinned: true },
  { id: 'shared-temp-b', todo_id: 62, attachment_id: 'same-temp', blob: uploadBlob, pending_upload: true, pinned: true },
]);
await crossTodoCache.cache.reconcileAuthoritative(
  [{ id: 61, attachments: [{ id: 900 }] }, { id: 62, attachments: [] }],
  [{ action: 'CREATE_ATTACHMENT', data: { todo_id: 61, blob_id: 'shared-temp-a', temp_id: 'same-temp' } }],
);
assert.equal(crossTodoCache.records.has('shared-id-a'), true, 'authoritative blob reconciliation must retain the referenced todo/attachment pair');
assert.equal(crossTodoCache.records.has('shared-id-b'), false, 'same attachment ID on another todo must not retain an unreferenced blob');
assert.equal(crossTodoCache.records.has('shared-temp-a'), true, 'pending reconciliation must use the todo/blob pair');
assert.equal(crossTodoCache.records.has('shared-temp-b'), false, 'same temp ID on another todo must not retain an unqueued blob');

const refreshMetadataFailureCache = memoryCache([
  { id: '520', todo_id: 52, attachment_id: 520, blob: uploadBlob, pinned: true, offline_explicit: true },
]);
const refreshMetadataFailureStores = {
  syncQueue: [],
  todos: [{ id: 52, attachments: [{ id: 520 }], attachments_count: 1 }],
  attachmentBlobs: [{ id: '520', todo_id: 52, attachment_id: 520, blob: uploadBlob, pinned: true, offline_explicit: true }],
  projects: [], sections: [], workspaces: [],
};
const refreshMetadataFailureFeature = createSyncFeature({
  getDb: () => ({}),
  dbGetAll: async store => structuredClone(refreshMetadataFailureStores[store] || []),
  dbGetAllStrict: async store => structuredClone(refreshMetadataFailureStores[store] || []),
  dbPut: async () => {}, dbPutStrict: async () => {}, dbClear: async () => {}, dbClearStrict: async () => {},
  getFromDB: async (store, id) => structuredClone((refreshMetadataFailureStores[store] || []).find(item => String(item.id) === String(id)) || null),
  deleteFromDB: async () => {}, deleteFromDBStrict: async () => {},
  dbTransactionStrict: createMemoryTransaction(refreshMetadataFailureStores, { fail: count => count === 1 }),
  getTodos: () => refreshMetadataFailureStores.todos, setTodos: next => { refreshMetadataFailureStores.todos = structuredClone(next); },
  getProjects: () => [], setProjects: () => {}, getSections: () => [], setSections: () => {}, getWorkspaces: () => [], setWorkspaces: () => {},
  todosApi: { list: async () => ({ todos: [] }) }, projectsApi: { list: async () => ({ projects: [] }) }, sectionsApi: { listAll: async () => ({ sections: [] }) }, workspacesApi: { list: async () => ({ workspaces: [] }) },
  attachmentCache: refreshMetadataFailureCache.cache, renderStats: () => {}, renderTodos: () => {},
});
await assert.rejects(refreshMetadataFailureFeature.refreshFromServer({ wsState: 'connected', syncInProgressRef: { value: false } }), /injected metadata transaction failure/);
assert.equal(refreshMetadataFailureStores.todos.length, 1, 'failed REST metadata replacement must roll back the previous todo state');
assert.equal(refreshMetadataFailureCache.records.has('520'), true, 'failed REST metadata replacement must not delete attachment bytes');

const refreshCleanupFailureHarness = syncHarness({
  queue: [],
  todos: [{ id: 53, attachments: [{ id: 530 }], attachments_count: 1 }],
  blobs: [{ id: '530', todo_id: 53, attachment_id: 530, blob: uploadBlob, pinned: true, offline_explicit: true }],
  transactionFail: count => count === 5,
  api: { list: async () => ({ todos: [] }) },
});
await assert.rejects(refreshCleanupFailureHarness.feature.refreshFromServer({ wsState: 'connected', syncInProgressRef: { value: false } }), /injected metadata transaction failure/);
assert.equal(refreshCleanupFailureHarness.stores.todos.length, 1, 'blob deletion failure must roll back authoritative REST metadata');
assert.equal(refreshCleanupFailureHarness.cacheState.records.has('530'), true, 'blob deletion failure must retain the pre-commit blob state');

let refreshListCalls = 0;
const refreshReadFailureHarness = syncHarness({
  queue: [],
  todos: [{ id: 51, attachments: [{ id: 510 }], attachments_count: 1 }],
  blobs: [{ id: '510', todo_id: 51, attachment_id: 510, blob: uploadBlob, pending_upload: false, pinned: true }],
  dbGetAllStrict: async store => {
    if (store === 'syncQueue') throw new Error('refresh queue read failed');
    return structuredClone(refreshReadFailureHarness.stores[store] || []);
  },
  api: { list: async () => { refreshListCalls += 1; return { todos: [] }; } },
});
await assert.rejects(
  refreshReadFailureHarness.feature.refreshFromServer({ wsState: 'connected', syncInProgressRef: { value: false } }),
  /refresh queue read failed/,
);
assert.equal(refreshListCalls, 0, 'refresh must fail before fetching or replacing authoritative state when queue reads fail');
assert.equal(refreshReadFailureHarness.stores.todos.length, 1);
assert.equal(refreshReadFailureHarness.cacheState.records.has('510'), true);

const websocketStores = {
  syncQueue: [{ action: 'CREATE_ATTACHMENT', data: { todo_id: 23, temp_id: 'temp-230', local_attachment: { id: 'temp-230', todo_id: 23, is_pending: true } } }],
  todos: [
    { id: 21, attachments: [{ id: 210 }], attachments_count: 1, updated_at: '2026-10-18T10:00:00Z' },
    { id: 22, attachments: [{ id: 220 }], attachments_count: 1, updated_at: '2026-10-18T10:00:00Z' },
    { id: 23, attachments: [{ id: 230 }, { id: 'temp-230', is_pending: true }], attachments_count: 2, updated_at: '2026-10-18T10:00:00Z' },
  ],
  projects: [], sections: [], workspaces: [], attachmentBlobs: [],
};
const websocketCache = memoryCache([
  { id: '210', todo_id: 21, attachment_id: 210, blob: uploadBlob, pinned: true, offline_explicit: true },
  { id: '220', todo_id: 22, attachment_id: 220, blob: uploadBlob, pinned: true, offline_explicit: true },
  { id: '230', todo_id: 23, attachment_id: 230, blob: uploadBlob, pinned: true, offline_explicit: true },
  { id: 'temp-230', todo_id: 23, attachment_id: 'temp-230', blob: uploadBlob, pinned: true, pending_upload: true },
]);
websocketStores.attachmentBlobs = [...websocketCache.records.values()].map(record => structuredClone(record));
const websocketTransaction = createMemoryTransaction(websocketStores);
const websocketClient = createWebSocketClient({
  wsUrl: 'ws://unused.invalid', getAuthToken: () => null, syncWithServer: async () => {}, syncInProgressRef: { value: false }, renderConnectionStatus: () => {},
  dbGetAll: async store => structuredClone(websocketStores[store] || []),
  dbGetAllStrict: async store => structuredClone(websocketStores[store] || []),
  dbPut: async (store, item) => { websocketStores[store] = [...(websocketStores[store] || []).filter(existing => String(existing.id) !== String(item.id)), structuredClone(item)]; },
  dbPutStrict: async (store, item) => { websocketStores[store] = [...(websocketStores[store] || []).filter(existing => String(existing.id) !== String(item.id)), structuredClone(item)]; },
  getFromDB: async (store, id) => structuredClone((websocketStores[store] || []).find(item => String(item.id) === String(id)) || null),
  deleteFromDB: async (store, id) => { websocketStores[store] = (websocketStores[store] || []).filter(item => String(item.id) !== String(id)); },
  deleteFromDBStrict: async (store, id) => { websocketStores[store] = (websocketStores[store] || []).filter(item => String(item.id) !== String(id)); },
  dbTransactionStrict: async (storeNames, mode, operation) => {
    const result = await websocketTransaction(storeNames, mode, operation);
    websocketCache.records.clear();
    for (const record of websocketStores.attachmentBlobs) websocketCache.records.set(record.id, structuredClone(record));
    return result;
  },
  getTodos: () => websocketStores.todos, setTodos: next => { websocketStores.todos = structuredClone(next); },
  getProjects: () => websocketStores.projects, setProjects: next => { websocketStores.projects = structuredClone(next); },
  getSections: () => websocketStores.sections, setSections: next => { websocketStores.sections = structuredClone(next); },
  getWorkspaces: () => websocketStores.workspaces, setWorkspaces: next => { websocketStores.workspaces = structuredClone(next); },
  renderWorkspaces: () => {}, renderProjects: () => {}, renderStats: () => {}, renderTodos: () => {},
  attachmentCache: websocketCache.cache,
});
await websocketClient.handleWsMessage({ type: 'todo_attachment_delete', payload: { todo_id: 21, attachment_id: 210, attachments_count: 0 } });
assert.equal(websocketCache.records.has('210'), false, 'websocket attachment deletes must remove pinned cached bytes');
await websocketClient.handleWsMessage({ type: 'sync_response', todos: [
  { id: 21, attachments: [], attachments_count: 0, updated_at: '2026-10-18T11:00:00Z' },
  { id: 23, attachments: [], attachments_count: 0, updated_at: '2026-10-18T11:00:00Z' },
], projects: [], sections: [], workspaces: [] });
assert.equal(websocketCache.records.has('220'), false, 'full websocket sync must remove pinned cached bytes for todos absent from the server');
assert.equal(websocketCache.records.has('230'), false, 'full websocket sync must remove cached bytes for server attachments removed from an existing todo');
assert.equal(websocketCache.records.has('temp-230'), true, 'full websocket sync must preserve pending attachment bytes');
assert.deepEqual(websocketStores.todos.find(todo => todo.id === 23).attachments.map(item => item.id), ['temp-230'], 'pending attachment projection must survive server removal reconciliation');

websocketStores.syncQueue.push({ id: 89, action: 'CREATE_ATTACHMENT', data: {
  todo_id: 25, temp_id: 'temp-ws-permanent', blob_id: 'temp-ws-permanent', failed_permanent: true,
  local_attachment: { id: 'temp-ws-permanent', todo_id: 25, is_pending: true, failed_permanent: true },
} });
websocketStores.todos.push({ id: 25, attachments: [{ id: 'temp-ws-permanent', is_pending: true, failed_permanent: true }], attachments_count: 1 });
websocketStores.attachmentBlobs.push({ id: 'temp-ws-permanent', todo_id: 25, attachment_id: 'temp-ws-permanent', blob: uploadBlob, pending_upload: true, pinned: true });
websocketCache.records.set('temp-ws-permanent', structuredClone(websocketStores.attachmentBlobs.at(-1)));
await websocketClient.handleWsMessage({ type: 'sync_response', todos: [
  { id: 21, attachments: [], attachments_count: 0, updated_at: '2026-10-18T12:00:00Z' },
  { id: 23, attachments: [], attachments_count: 0, updated_at: '2026-10-18T12:00:00Z' },
], projects: [], sections: [], workspaces: [] });
assert.equal(websocketStores.todos.some(todo => todo.id === 25), false, 'authoritative websocket deletion must remove a todo with only a permanent attachment failure');
assert.equal(websocketStores.syncQueue.some(item => item.id === 89), false, 'websocket reconciliation must remove the orphaned permanent queue entry');
assert.equal(websocketCache.records.has('temp-ws-permanent'), false, 'websocket reconciliation must remove orphaned failed upload bytes');

for (const message of [
  { type: 'sync_response', todos: [], projects: [], sections: [], workspaces: [] },
  { type: 'todo_delete', payload: { id: 23 } },
]) {
  const strictFailureStores = {
    syncQueue: [{ id: 90, action: 'CREATE_ATTACHMENT', data: { todo_id: 23, temp_id: 'temp-ws-strict' } }],
    todos: [{ id: 23, attachments: [{ id: 'temp-ws-strict', is_pending: true }], attachments_count: 1 }],
    projects: [], sections: [], workspaces: [],
  };
  const strictFailureCache = memoryCache([{ id: 'temp-ws-strict', todo_id: 23, attachment_id: 'temp-ws-strict', blob: uploadBlob, pending_upload: true, pinned: true }]);
  const strictFailureClient = createWebSocketClient({
    wsUrl: 'ws://unused.invalid', getAuthToken: () => null, syncWithServer: async () => {}, syncInProgressRef: { value: false }, renderConnectionStatus: () => {},
    dbGetAll: async store => structuredClone(strictFailureStores[store] || []),
    dbGetAllStrict: async store => { if (store === 'syncQueue') throw new Error(`websocket ${message.type} queue read failed`); return structuredClone(strictFailureStores[store] || []); },
    dbPut: async () => assert.fail('websocket strict queue read failures must not write todos'),
    dbPutStrict: async () => assert.fail('websocket strict queue read failures must not write todos'),
    getFromDB: async (store, id) => structuredClone((strictFailureStores[store] || []).find(item => String(item.id) === String(id)) || null),
    deleteFromDB: async () => assert.fail('websocket strict queue read failures must not delete records'),
    deleteFromDBStrict: async () => assert.fail('websocket strict queue read failures must not delete records'),
    getTodos: () => strictFailureStores.todos, setTodos: next => { strictFailureStores.todos = structuredClone(next); },
    getProjects: () => [], setProjects: () => {}, getSections: () => [], setSections: () => {}, getWorkspaces: () => [], setWorkspaces: () => {},
    renderWorkspaces: () => {}, renderProjects: () => {}, renderStats: () => {}, renderTodos: () => {}, attachmentCache: strictFailureCache.cache,
  });
  await assert.rejects(strictFailureClient.handleWsMessage(message), new RegExp(`websocket ${message.type} queue read failed`));
  assert.equal(strictFailureStores.todos.length, 1, `${message.type} must retain todos when strict queue reads fail`);
  assert.equal(strictFailureStores.syncQueue.length, 1, `${message.type} must retain queue entries when strict queue reads fail`);
  assert.equal(strictFailureCache.records.has('temp-ws-strict'), true, `${message.type} must retain pending blobs when strict queue reads fail`);
}

for (const message of [
  { type: 'sync_response', todos: [{ id: 24, attachments: [], attachments_count: 0, updated_at: '2026-10-18T11:00:00Z' }], projects: [], sections: [], workspaces: [] },
  { type: 'todo_delete', payload: { id: 24 } },
]) {
  const atomicFailureStores = {
    syncQueue: [{ id: 91, action: 'CREATE_ATTACHMENT', data: { todo_id: 24, temp_id: 'temp-ws-atomic' } }],
    todos: [{ id: 24, attachments: [{ id: 240 }, { id: 'temp-ws-atomic', is_pending: true }], attachments_count: 2 }],
    projects: [], sections: [], workspaces: [],
    attachmentBlobs: [
      { id: '240', todo_id: 24, attachment_id: 240, blob: uploadBlob, pinned: true },
      { id: 'temp-ws-atomic', todo_id: 24, attachment_id: 'temp-ws-atomic', blob: uploadBlob, pending_upload: true, pinned: true },
    ],
  };
  let blobCleanupCalls = 0;
  const atomicFailureCache = memoryCache([{ id: 'temp-ws-atomic', todo_id: 24, attachment_id: 'temp-ws-atomic', blob: uploadBlob, pending_upload: true, pinned: true }]);
  const atomicFailureClient = createWebSocketClient({
    wsUrl: 'ws://unused.invalid', getAuthToken: () => null, syncWithServer: async () => {}, syncInProgressRef: { value: false }, renderConnectionStatus: () => {},
    dbGetAll: async store => structuredClone(atomicFailureStores[store] || []), dbGetAllStrict: async store => structuredClone(atomicFailureStores[store] || []),
    dbPut: async () => {}, dbPutStrict: async () => {}, getFromDB: async (store, id) => structuredClone((atomicFailureStores[store] || []).find(item => String(item.id) === String(id)) || null),
    deleteFromDB: async () => {}, deleteFromDBStrict: async () => {},
    dbTransactionStrict: createMemoryTransaction(atomicFailureStores, { fail: count => count === (message.type === 'sync_response' ? 6 : 3) }),
    getTodos: () => atomicFailureStores.todos, setTodos: next => { atomicFailureStores.todos = structuredClone(next); },
    getProjects: () => [], setProjects: () => {}, getSections: () => [], setSections: () => {}, getWorkspaces: () => [], setWorkspaces: () => {},
    renderWorkspaces: () => {}, renderProjects: () => {}, renderStats: () => {}, renderTodos: () => {},
    attachmentCache: { ...atomicFailureCache.cache, remove: async () => { blobCleanupCalls += 1; }, removeForTodo: async () => { blobCleanupCalls += 1; } },
  });
  await assert.rejects(atomicFailureClient.handleWsMessage(message), /injected metadata transaction failure/);
  assert.equal(atomicFailureStores.todos.length, 1, `${message.type} metadata failure must retain the todo`);
  assert.equal(atomicFailureStores.syncQueue.length, 1, `${message.type} metadata failure must retain the queue reference`);
  assert.equal(blobCleanupCalls, 0, `${message.type} metadata failure must not start blob cleanup`);
  assert.equal(atomicFailureCache.records.has('temp-ws-atomic'), true, `${message.type} metadata failure must retain pending bytes`);
  assert.equal(atomicFailureStores.attachmentBlobs.length, 2, `${message.type} blob failure must roll back all metadata and blob deletes`);
}

assert.deepEqual(
  getAttachmentAvailability({ failed_permanent: true, sync_error: { message: 'Payload too large' }, is_pending: true }),
  { key: 'todo.attachments.statusPermanentFailure', error: 'Payload too large', failed: true },
  'permanently failed uploads must render as durable failures with their sync error',
);

const uiStores = {
  todos: [{ id: 9, title: 'Existing', attachments: [] }],
  syncQueue: [],
  attachmentBlobs: [],
};
const uiCache = memoryCache();
let directResponseUser = { id: 1, attachment_usage_bytes: 9, attachment_quota_bytes: 10, attachment_remaining_bytes: 1 };
const feature = createTodoAttachmentsFeature({
  getTodos: () => uiStores.todos,
  setTodos: next => { uiStores.todos = structuredClone(next); },
  getProjects: () => [],
  getCurrentUser: () => directResponseUser,
  setCurrentUser: next => { directResponseUser = structuredClone(next); },
  getAppInitialized: () => true,
  getDb: () => ({}),
  dbPut: async (_store, todo) => { uiStores.todos = uiStores.todos.map(item => item.id === todo.id ? structuredClone(todo) : item); },
  dbGetAll: async store => structuredClone(uiStores[store] || []),
  deleteFromDB: async (store, id) => { uiStores[store] = (uiStores[store] || []).filter(item => item.id !== id); },
  dbTransactionStrict: createMemoryTransactionWithCache(uiStores, uiCache),
  runSyncQueueMutation: async operation => operation(async (action, data) => { uiStores.syncQueue.push({ id: uiStores.syncQueue.length + 1, action, data: structuredClone(data) }); }),
  isOnlineForSync: () => false,
  syncWithServer: async () => {},
  todosApi: {},
  attachmentCache: uiCache.cache,
  renderStats: () => {}, renderTodos: () => {}, closeModal: () => {},
  confirmDanger: async () => true,
  showToast: () => {}, t: key => key, iconSvg: () => '', escapeHtmlAttr: String,
  setTodoCollapsibleOpen: () => {}, refreshTodoActionButtonState: () => {}, refreshTodoSaveButtonState: () => {},
});
await feature.applyAttachmentTodoResponse({ usage: { used_bytes: 4, quota_bytes: 10, remaining_bytes: 6 } });
assert.equal(directResponseUser.attachment_usage_bytes, 4, 'direct attachment responses must update current-user usage');
assert.equal(directResponseUser.attachment_remaining_bytes, 6);
const offlineFile = new Blob(['queued'], { type: 'text/plain' });
offlineFile.name = 'queued.txt';
offlineFile.lastModified = 1;
assert.equal(await feature.queueAttachmentFiles(9, [offlineFile]), true);
assert.equal(uiStores.syncQueue[0].action, 'CREATE_ATTACHMENT');
const tempAttachment = uiStores.todos[0].attachments[0];
assert.equal(tempAttachment.is_pending, true);
assert.equal((await uiCache.cache.get(tempAttachment.id)).pending_upload, true);
const failedDeleteToasts = [];
const failedDeleteFeature = createTodoAttachmentsFeature({
  getTodos: () => uiStores.todos, setTodos: next => { uiStores.todos = structuredClone(next); }, getProjects: () => [],
  getCurrentUser: () => directResponseUser, setCurrentUser: next => { directResponseUser = structuredClone(next); },
  getAppInitialized: () => true, getDb: () => ({}),
  dbPut: async (_store, todo) => { uiStores.todos = uiStores.todos.map(item => item.id === todo.id ? structuredClone(todo) : item); },
  dbPutStrict: async (_store, todo) => { uiStores.todos = uiStores.todos.map(item => item.id === todo.id ? structuredClone(todo) : item); },
  dbGetAll: async store => structuredClone(uiStores[store] || []),
  dbGetAllStrict: async store => structuredClone(uiStores[store] || []),
  dbTransactionStrict: createMemoryTransactionWithCache(uiStores, uiCache, { fail: count => count === 1 }),
  deleteFromDB: async () => {}, deleteFromDBStrict: async () => { throw new Error('queue delete failed'); },
  runSyncQueueMutation: async operation => operation(async () => {}), isOnlineForSync: () => false, syncWithServer: async () => {}, todosApi: {}, attachmentCache: uiCache.cache,
  renderStats: () => {}, renderTodos: () => {}, closeModal: () => {}, confirmDanger: async () => true,
  showToast: message => failedDeleteToasts.push(message), t: key => key, iconSvg: () => '', escapeHtmlAttr: String,
  setTodoCollapsibleOpen: () => {}, refreshTodoActionButtonState: () => {}, refreshTodoSaveButtonState: () => {},
});
await failedDeleteFeature.deleteTodoAttachment(9, tempAttachment.id);
assert.equal(uiStores.syncQueue.length, 1, 'failed strict cancellation must retain the queued create');
assert.equal(uiStores.todos[0].attachments.length, 1, 'failed strict cancellation must retain the optimistic pending attachment');
assert.notEqual(await uiCache.cache.get(tempAttachment.id), null, 'failed strict cancellation must retain pending bytes');
assert.equal(failedDeleteToasts.at(-1), 'todo.attachments.deleteFailed');

const startedDeleteStores = {
  syncQueue: [{ id: 98, action: 'CREATE_ATTACHMENT', data: {
    todo_id: 9, temp_id: 'temp-started-delete', blob_id: 'temp-started-delete', upload_started: true,
    filename: 'started.txt', content_type: 'text/plain', client_mutation_id: 'temp-started-delete',
    local_attachment: { id: 'temp-started-delete', todo_id: 9, is_pending: true },
  } }],
  todos: [{ id: 9, attachments: [{ id: 'temp-started-delete', todo_id: 9, is_pending: true }], attachments_count: 1 }],
  attachmentBlobs: [{ id: 'temp-started-delete', todo_id: 9, attachment_id: 'temp-started-delete', blob: uploadBlob, pending_upload: true, pinned: true }],
};
const startedDeleteCache = memoryCache(startedDeleteStores.attachmentBlobs);
const startedDeleteFeature = createTodoAttachmentsFeature({
  getTodos: () => startedDeleteStores.todos, setTodos: next => { startedDeleteStores.todos = structuredClone(next); }, getProjects: () => [],
  getCurrentUser: () => ({ id: 1 }), setCurrentUser: () => {}, getAppInitialized: () => true, getDb: () => ({}),
  dbGetAll: async store => structuredClone(startedDeleteStores[store] || []), dbGetAllStrict: async store => structuredClone(startedDeleteStores[store] || []),
  dbTransactionStrict: createMemoryTransactionWithCache(startedDeleteStores, startedDeleteCache),
  runSyncQueueMutation: async operation => operation(async () => {}), isOnlineForSync: () => false, syncWithServer: async () => {}, todosApi: {}, attachmentCache: startedDeleteCache.cache,
  renderStats: () => {}, renderTodos: () => {}, closeModal: () => {}, confirmDanger: async () => true,
  showToast: () => {}, t: key => key, iconSvg: () => '', escapeHtmlAttr: String,
  setTodoCollapsibleOpen: () => {}, refreshTodoActionButtonState: () => {}, refreshTodoSaveButtonState: () => {},
});
await startedDeleteFeature.deleteTodoAttachment(9, 'temp-started-delete');
assert.equal(startedDeleteStores.syncQueue.some(item => item.action === 'CREATE_ATTACHMENT'), true, 'started upload delete must retain the idempotent create');
assert.equal(startedDeleteStores.syncQueue.some(item => item.action === 'DELETE_ATTACHMENT'), true, 'started upload delete must queue a dependent delete');
assert.equal(startedDeleteCache.records.has('temp-started-delete'), true, 'started upload delete must retain retryable bytes');

let startedDeleteUploadCalls = 0;
let startedDeleteServerCalls = 0;
const startedDeleteReplay = syncHarness({
  queue: startedDeleteStores.syncQueue,
  todos: startedDeleteStores.todos,
  blobs: [...startedDeleteCache.records.values()],
  api: {
    uploadAttachment: async () => {
      startedDeleteUploadCalls += 1;
      return { attachment: { id: 901, todo_id: 9 }, todo: { id: 9, attachments: [{ id: 901, todo_id: 9 }], attachments_count: 1 } };
    },
    deleteAttachment: async (_todoId, attachmentId) => {
      startedDeleteServerCalls += 1;
      assert.equal(attachmentId, 901, 'dependent delete must be rewritten to the idempotently recovered server attachment ID');
      assert.equal(startedDeleteReplay.cacheState.records.has('901'), true, 'recovered upload bytes must survive until the dependent delete request');
      return { todo: { id: 9, attachments: [], attachments_count: 0 }, usage: { used_bytes: 0 } };
    },
  },
});
await startedDeleteReplay.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(startedDeleteUploadCalls, 1);
assert.equal(startedDeleteServerCalls, 1);
assert.equal(startedDeleteReplay.stores.syncQueue.length, 0);
assert.equal(startedDeleteReplay.cacheState.records.size, 0, 'successful dependent delete must remove the recovered bytes');
assert.deepEqual(startedDeleteReplay.stores.todos[0].attachments, []);

let resolveStaleDeleteConfirmation;
const staleDeleteConfirmation = new Promise(resolve => { resolveStaleDeleteConfirmation = resolve; });
const staleDeleteStores = {
  syncQueue: [{ id: 198, action: 'CREATE_ATTACHMENT', data: {
    todo_id: 9, temp_id: 'temp-dialog-race', blob_id: 'temp-dialog-race', upload_started: true,
    client_mutation_id: 'temp-dialog-race', filename: 'race.txt', content_type: 'text/plain',
  } }],
  todos: [{ id: 9, attachments: [{ id: 'temp-dialog-race', todo_id: 9, client_mutation_id: 'temp-dialog-race', is_pending: true }], attachments_count: 1 }],
  attachmentBlobs: [{ id: 'temp-dialog-race', todo_id: 9, attachment_id: 'temp-dialog-race', blob: uploadBlob, pending_upload: true, pinned: true }],
};
const staleDeleteCache = memoryCache(staleDeleteStores.attachmentBlobs);
const staleDeleteFeature = createTodoAttachmentsFeature({
  getTodos: () => staleDeleteStores.todos, setTodos: next => { staleDeleteStores.todos = structuredClone(next); }, getProjects: () => [],
  getCurrentUser: () => ({ id: 1 }), setCurrentUser: () => {}, getAppInitialized: () => true, getDb: () => ({}),
  dbGetAll: async store => structuredClone(staleDeleteStores[store] || []), dbGetAllStrict: async store => structuredClone(staleDeleteStores[store] || []),
  dbTransactionStrict: createMemoryTransactionWithCache(staleDeleteStores, staleDeleteCache),
  runSyncQueueMutation: async operation => operation(async () => {}), isOnlineForSync: () => false, syncWithServer: async () => {}, todosApi: {}, attachmentCache: staleDeleteCache.cache,
  renderStats: () => {}, renderTodos: () => {}, closeModal: () => {}, confirmDanger: async () => staleDeleteConfirmation,
  showToast: () => {}, t: key => key, iconSvg: () => '', escapeHtmlAttr: String,
  setTodoCollapsibleOpen: () => {}, refreshTodoActionButtonState: () => {}, refreshTodoSaveButtonState: () => {},
});
const staleDeletePromise = staleDeleteFeature.deleteTodoAttachment(9, 'temp-dialog-race');
await Promise.resolve();
staleDeleteStores.syncQueue = [];
staleDeleteStores.todos = [{ id: 9, attachments: [{ id: 902, todo_id: 9, client_mutation_id: 'temp-dialog-race' }], attachments_count: 1 }];
staleDeleteCache.records.delete('temp-dialog-race');
staleDeleteCache.records.set('902', { id: '902', todo_id: 9, attachment_id: 902, blob: uploadBlob, pending_upload: false, pinned: false });
resolveStaleDeleteConfirmation(true);
await staleDeletePromise;
assert.deepEqual(staleDeleteStores.todos[0].attachments, [], 'delete confirmation must remove an attachment rewritten while the dialog was open');
assert.equal(staleDeleteStores.syncQueue.length, 1);
assert.equal(staleDeleteStores.syncQueue[0].data.attachment_id, 902, 'delete confirmation must queue the current server attachment ID');

const combinedDeleteStores = {
  syncQueue: [{ id: 99, action: 'CREATE_ATTACHMENT', data: { todo_id: 9, temp_id: 'temp-combined-delete', blob_id: 'temp-combined-delete', local_attachment: { id: 'temp-combined-delete', is_pending: true } } }],
  todos: [{ id: 9, attachments: [{ id: 'temp-combined-delete', is_pending: true }], attachments_count: 1 }],
};
const combinedDeleteCache = memoryCache([{ id: 'temp-combined-delete', todo_id: 9, attachment_id: 'temp-combined-delete', blob: uploadBlob, pending_upload: true, pinned: true }]);
const combinedDeleteToasts = [];
let combinedDeleteQueueMutationAttempts = 0;
const combinedDeleteFeature = createTodoAttachmentsFeature({
  getTodos: () => combinedDeleteStores.todos, setTodos: next => { combinedDeleteStores.todos = structuredClone(next); }, getProjects: () => [],
  getCurrentUser: () => ({ id: 1 }), setCurrentUser: () => {}, getAppInitialized: () => true, getDb: () => ({}),
  dbPut: async () => {}, dbPutStrict: async () => { throw new Error('todo projection write failed'); },
  dbGetAll: async store => structuredClone(combinedDeleteStores[store] || []), dbGetAllStrict: async store => structuredClone(combinedDeleteStores[store] || []),
  deleteFromDB: async () => {}, deleteFromDBStrict: async (store, id) => { combinedDeleteStores[store] = combinedDeleteStores[store].filter(item => String(item.id) !== String(id)); },
  dbTransactionStrict: createMemoryTransaction(combinedDeleteStores, { fail: count => count === 1 }),
  runSyncQueueMutation: async operation => operation(async () => { combinedDeleteQueueMutationAttempts += 1; throw new Error('queue reconstruction failed'); }),
  isOnlineForSync: () => false, syncWithServer: async () => {}, todosApi: {}, attachmentCache: combinedDeleteCache.cache,
  renderStats: () => {}, renderTodos: () => {}, closeModal: () => {}, confirmDanger: async () => true,
  showToast: message => combinedDeleteToasts.push(message), t: key => key, iconSvg: () => '', escapeHtmlAttr: String,
  setTodoCollapsibleOpen: () => {}, refreshTodoActionButtonState: () => {}, refreshTodoSaveButtonState: () => {},
});
await combinedDeleteFeature.deleteTodoAttachment(9, 'temp-combined-delete');
assert.equal(combinedDeleteQueueMutationAttempts, 0, 'a failed todo projection write must leave the original queue untouched');
assert.equal(combinedDeleteToasts.at(-1), 'todo.attachments.deleteFailed', 'failed atomic cancellation must surface a deletion failure');
assert.equal(combinedDeleteStores.syncQueue.length, 1);
assert.equal(combinedDeleteStores.todos[0].attachments.length, 1);
assert.equal(combinedDeleteCache.records.has('temp-combined-delete'), true, 'a failed cancellation must preserve pending bytes when its queue remains intact');

const cleanupFailureStores = {
  syncQueue: [{ id: 100, action: 'CREATE_ATTACHMENT', data: { todo_id: 9, temp_id: 'temp-cleanup-failure', blob_id: 'temp-cleanup-failure' } }],
  todos: [{ id: 9, attachments: [{ id: 'temp-cleanup-failure', is_pending: true }], attachments_count: 1 }],
  attachmentBlobs: [{ id: 'temp-cleanup-failure', todo_id: 9, attachment_id: 'temp-cleanup-failure', blob: uploadBlob, pending_upload: true, pinned: true }],
};
let postCommitReads = 0;
const cleanupFailureToasts = [];
const cleanupFailureFeature = createTodoAttachmentsFeature({
  getTodos: () => cleanupFailureStores.todos, setTodos: next => { cleanupFailureStores.todos = structuredClone(next); }, getProjects: () => [],
  getCurrentUser: () => ({ id: 1 }), setCurrentUser: () => {}, getAppInitialized: () => true, getDb: () => ({}),
  dbPut: async () => {}, dbPutStrict: async () => {}, dbGetAll: async store => structuredClone(cleanupFailureStores[store] || []),
  dbGetAllStrict: async () => { postCommitReads += 1; throw new Error('post-commit reads are forbidden'); },
  deleteFromDB: async () => {}, deleteFromDBStrict: async () => {}, dbTransactionStrict: createMemoryTransaction(cleanupFailureStores, { fail: count => count === 3 }),
  runSyncQueueMutation: async operation => operation(async () => {}), isOnlineForSync: () => false, syncWithServer: async () => {}, todosApi: {},
  attachmentCache: memoryCache().cache,
  renderStats: () => {}, renderTodos: () => {}, closeModal: () => {}, confirmDanger: async () => true,
  showToast: message => cleanupFailureToasts.push(message), t: key => key, iconSvg: () => '', escapeHtmlAttr: String,
  setTodoCollapsibleOpen: () => {}, refreshTodoActionButtonState: () => {}, refreshTodoSaveButtonState: () => {},
});
await cleanupFailureFeature.deleteTodoAttachment(9, 'temp-cleanup-failure');
assert.equal(cleanupFailureStores.syncQueue.length, 1, 'failed atomic blob deletion must retain the queued create');
assert.equal(cleanupFailureStores.todos[0].attachments.length, 1, 'failed atomic blob deletion must retain the optimistic projection');
assert.equal(cleanupFailureStores.attachmentBlobs.length, 1, 'failed atomic blob deletion must retain pending bytes without an orphan');
assert.equal(postCommitReads, 0, 'failed atomic cancellation must not require post-commit verification reads');
assert.equal(cleanupFailureToasts.at(-1), 'todo.attachments.deleteFailed');
await feature.deleteTodoAttachment(9, tempAttachment.id);
assert.equal(uiStores.syncQueue.length, 0, 'deleting a temporary attachment should cancel its create operation');
assert.equal(uiStores.todos[0].attachments.length, 0);
assert.equal(await uiCache.cache.get(tempAttachment.id), null);

for (const failureStep of [1, 2, 3, 4, 5, 6, 7]) {
  const stores = {
    todos: [],
    syncQueue: [],
    attachmentBlobs: [],
  };
  const cacheState = memoryCache();
  const toasts = [];
  const atomicQueueFeature = createTodoAttachmentsFeature({
    getTodos: () => stores.todos,
    setTodos: next => { stores.todos = structuredClone(next); },
    getProjects: () => [],
    getCurrentUser: () => ({ id: 1, attachments_enabled: true, attachment_remaining_bytes: 1024 * 1024 }),
    setCurrentUser: () => {}, getAppInitialized: () => true, getDb: () => ({}),
    dbTransactionStrict: createMemoryTransactionWithCache(stores, cacheState, { fail: count => count === failureStep }),
    runSyncQueueMutation: async operation => operation(async () => {}),
    isOnlineForSync: () => false, syncWithServer: async () => {}, todosApi: {}, attachmentCache: cacheState.cache,
    renderStats: () => {}, renderTodos: () => {}, closeModal: () => {}, confirmDanger: async () => true,
    showToast: message => toasts.push(message), t: key => key, iconSvg: () => '', escapeHtmlAttr: String,
    setTodoCollapsibleOpen: () => {}, refreshTodoActionButtonState: () => {}, refreshTodoSaveButtonState: () => {},
  });
  const first = new Blob(['first'], { type: 'text/plain' }); first.name = 'first.txt';
  const second = new Blob(['second'], { type: 'text/plain' }); second.name = 'second.txt';
  const suppliedTodo = { id: 'temp-12', title: 'Atomic queue', attachments: [], attachments_count: 0 };
  const initialQueueEntries = [
    { action: 'CREATE_TODO', data: { title: suppliedTodo.title, _tempId: suppliedTodo.id, client_mutation_id: suppliedTodo.id } },
    { action: 'CREATE_COMMENT', data: { todo_id: suppliedTodo.id, temp_id: 'temp-comment-12', body: 'Pending child' } },
  ];
  assert.equal(await atomicQueueFeature.queueAttachmentFiles(suppliedTodo.id, [first, second], { todo: suppliedTodo, queueEntries: initialQueueEntries }), false, `draft todo attachment transaction step ${failureStep} must fail atomically`);
  assert.equal(stores.todos.length, 0);
  assert.equal(stores.syncQueue.length, 0);
  assert.equal(stores.attachmentBlobs.length, 0);
  assert.equal(cacheState.records.size, 0);
  assert.equal(toasts.at(-1), 'todo.attachments.uploadFailed');
}

const draftStores = { todos: [], syncQueue: [], attachmentBlobs: [] };
const draftCache = memoryCache();
const draftTodos = [];
const draftFeature = createTodoAttachmentsFeature({
  getTodos: () => draftTodos,
  setTodos: next => { draftTodos.splice(0, draftTodos.length, ...structuredClone(next)); },
  getProjects: () => [],
  getCurrentUser: () => ({ id: 1, attachments_enabled: true, attachment_remaining_bytes: 1024 * 1024 }),
  setCurrentUser: () => {}, getAppInitialized: () => true, getDb: () => ({}),
  dbTransactionStrict: createMemoryTransactionWithCache(draftStores, draftCache),
  runSyncQueueMutation: async operation => operation(async () => {}),
  isOnlineForSync: () => false, syncWithServer: async () => {}, todosApi: {}, attachmentCache: draftCache.cache,
  renderStats: () => {}, renderTodos: () => {}, closeModal: () => {}, confirmDanger: async () => true,
  showToast: () => {}, t: key => key, iconSvg: () => '', escapeHtmlAttr: String,
  setTodoCollapsibleOpen: () => {}, refreshTodoActionButtonState: () => {}, refreshTodoSaveButtonState: () => {},
});
const draftFile = new Blob(['draft'], { type: 'text/plain' }); draftFile.name = 'draft.txt';
const draftTodo = { id: 'temp-draft', title: 'Draft with children', attachments: [], attachments_count: 0, comments: [{ id: 'temp-comment', body: 'Pending' }] };
assert.equal(await draftFeature.queueAttachmentFiles(draftTodo.id, [draftFile], {
  todo: draftTodo,
  queueEntries: [
    { action: 'CREATE_TODO', data: { title: draftTodo.title, _tempId: draftTodo.id, client_mutation_id: draftTodo.id } },
    { action: 'CREATE_COMMENT', data: { todo_id: draftTodo.id, temp_id: 'temp-comment', body: 'Pending' } },
  ],
}), true);
assert.equal(draftStores.todos.length, 1);
assert.deepEqual(draftStores.syncQueue.map(item => item.action), ['CREATE_TODO', 'CREATE_COMMENT', 'CREATE_ATTACHMENT']);
assert.equal(draftStores.attachmentBlobs.length, 1);
assert.equal(draftTodos.length, 1, 'a newly-created draft todo must become visible only after the atomic commit');

const cachedBlob = new Blob(['cached'], { type: 'text/plain' });
await uiCache.cache.put({ id: '90', todo_id: 9, attachment_id: 90, blob: cachedBlob, size_bytes: cachedBlob.size, pinned: true, pending_upload: false });
assert.equal(await (await feature.loadAttachmentBlob(9, { id: 90 })).text(), 'cached', 'preview/download must use cached bytes while offline');
await uiCache.cache.put({ id: '91', todo_id: 999, attachment_id: 91, blob: new Blob(['other todo']), pinned: true, pending_upload: false });
assert.equal(await uiCache.cache.get('91', { todoId: 9, touch: false }), null, 'cache lookup must reject a record owned by another todo');
await assert.rejects(
  feature.loadAttachmentBlob(9, { id: 91 }),
  /not available offline/,
  'cached attachment bytes must not cross todo ownership boundaries',
);

let releasePinCommit;
let pinCommitReached = false;
let pinWrites = 0;
const pausedPinCache = {
  get: async () => ({ id: '93', todo_id: 9, attachment_id: 93, blob: cachedBlob, pinned: false }),
  setPinned: async (_id, _pinned, { isCurrent } = {}) => {
    pinCommitReached = true;
    await new Promise(resolve => { releasePinCommit = resolve; });
    isCurrent?.();
    pinWrites += 1;
  },
};
const pausedPinFeature = createTodoAttachmentsFeature({
  getTodos: () => [{ id: 9, attachments: [{ id: 93, size_bytes: cachedBlob.size }] }], setTodos: () => {}, getProjects: () => [],
  getCurrentUser: () => ({ id: 1 }), setCurrentUser: () => {}, getAppInitialized: () => true, getDb: () => ({}),
  dbPut: async () => {}, dbPutStrict: async () => {}, dbGetAll: async () => [], dbGetAllStrict: async () => [],
  deleteFromDB: async () => {}, deleteFromDBStrict: async () => {}, runSyncQueueMutation: async operation => operation(async () => {}),
  isOnlineForSync: () => false, syncWithServer: async () => {}, todosApi: {}, attachmentCache: pausedPinCache,
  renderStats: () => {}, renderTodos: () => {}, closeModal: () => {}, confirmDanger: async () => true,
  showToast: () => {}, t: key => key, iconSvg: () => '', escapeHtmlAttr: String,
  setTodoCollapsibleOpen: () => {}, refreshTodoActionButtonState: () => {}, refreshTodoSaveButtonState: () => {},
});
resumeAuthenticatedRequests();
const pausedPin = pausedPinFeature.makeAttachmentAvailableOffline(9, { id: 93, size_bytes: cachedBlob.size });
for (let attempt = 0; attempt < 5 && !pinCommitReached; attempt += 1) await new Promise(resolve => setImmediate(resolve));
assert.equal(pinCommitReached, true, 'offline pin must reach the deferred storage commit');
suspendAuthenticatedRequests();
let pinDrainFinished = false;
const pinDrain = waitForAuthenticatedSideEffects().then(() => { pinDrainFinished = true; });
await Promise.resolve();
assert.equal(pinDrainFinished, false, 'privacy drain must include the complete offline pin operation');
releasePinCommit();
assert.equal(await pausedPin, false, 'a generation change at the storage commit must cancel the pin');
await pinDrain;
assert.equal(pinWrites, 0, 'stale offline pin must not mutate attachment storage');
resumeAuthenticatedRequests();

let resolveOldAttachmentBody;
let staleAttachmentCacheWrites = 0;
const staleAttachmentFeature = createTodoAttachmentsFeature({
  getTodos: () => [{ id: 9, attachments: [{ id: 92, size_bytes: 6 }] }], setTodos: () => {}, getProjects: () => [],
  getCurrentUser: () => ({ id: 1 }), setCurrentUser: () => {}, getAppInitialized: () => true, getDb: () => ({}),
  dbPut: async () => {}, dbPutStrict: async () => {}, dbGetAll: async () => [], dbGetAllStrict: async () => [],
  deleteFromDB: async () => {}, deleteFromDBStrict: async () => {}, runSyncQueueMutation: async operation => operation(async () => {}),
  isOnlineForSync: () => true, syncWithServer: async () => {},
  todosApi: { getAttachmentBlob: () => new Promise(resolve => { resolveOldAttachmentBody = resolve; }) },
  attachmentCache: { get: async () => null, put: async () => { staleAttachmentCacheWrites += 1; } },
  renderStats: () => {}, renderTodos: () => {}, closeModal: () => {}, confirmDanger: async () => true,
  showToast: () => {}, t: key => key, iconSvg: () => '', escapeHtmlAttr: String,
  setTodoCollapsibleOpen: () => {}, refreshTodoActionButtonState: () => {}, refreshTodoSaveButtonState: () => {},
});
resumeAuthenticatedRequests();
const staleAttachmentLoad = staleAttachmentFeature.loadAttachmentBlob(9, { id: 92, size_bytes: 6 });
for (let attempt = 0; attempt < 5 && !resolveOldAttachmentBody; attempt += 1) await new Promise(resolve => setImmediate(resolve));
suspendAuthenticatedRequests();
resolveOldAttachmentBody(new Blob(['secret']));
await assert.rejects(staleAttachmentLoad, error => error?.code === 'authenticated_runtime_changed', 'old attachment bytes must be rejected before a post-boundary cache commit');
assert.equal(staleAttachmentCacheWrites, 0, 'old attachment bytes must not be written into the post-boundary cache');
resumeAuthenticatedRequests();

let releaseRacingUpload;
let signalRacingUpload;
const racingUploadGate = new Promise(resolve => { releaseRacingUpload = resolve; });
const racingUploadStarted = new Promise(resolve => { signalRacingUpload = resolve; });
const racingStores = {
  syncQueue: [{
    id: 10,
    action: 'CREATE_ATTACHMENT',
    data: {
      todo_id: 10,
      temp_id: 'temp-racing-attachment',
      blob_id: 'temp-racing-attachment',
      client_mutation_id: 'temp-racing-attachment',
      filename: 'racing.txt',
      content_type: 'text/plain',
      size_bytes: uploadBlob.size,
      local_attachment: { id: 'temp-racing-attachment', todo_id: 10, original_filename: 'racing.txt', content_type: 'text/plain', size_bytes: uploadBlob.size, is_pending: true },
    },
  }],
  todos: [{ id: 10, title: 'Racing delete', attachments: [{ id: 'temp-racing-attachment', todo_id: 10, original_filename: 'racing.txt', is_pending: true }], attachments_count: 1 }],
  attachmentBlobs: [{ id: 'temp-racing-attachment', todo_id: 10, attachment_id: 'temp-racing-attachment', blob: uploadBlob, size_bytes: uploadBlob.size, pending_upload: true, pinned: true }],
  projects: [], sections: [], workspaces: [],
};
const racingCache = memoryCache([{ id: 'temp-racing-attachment', todo_id: 10, attachment_id: 'temp-racing-attachment', blob: uploadBlob, size_bytes: uploadBlob.size, pending_upload: true, pinned: true }]);
const racingApi = {
  uploadAttachment: async (todoId) => {
    signalRacingUpload();
    await racingUploadGate;
    const attachment = { id: 101, todo_id: todoId, user_id: 1, original_filename: 'racing.txt', content_type: 'text/plain', size_bytes: uploadBlob.size };
    return { attachment, todo: { id: todoId, title: 'Racing delete', attachments: [attachment], attachments_count: 1 } };
  },
  deleteAttachment: async (todoId, attachmentId) => ({ deleted: attachmentId, todo: { id: todoId, title: 'Racing delete', attachments: [], attachments_count: 0 } }),
  list: async () => ({ todos: structuredClone(racingStores.todos) }),
};
const racingSync = createSyncFeature({
  getDb: () => ({}),
  dbGetAll: async store => structuredClone(racingStores[store] || []),
  dbPut: async (store, item) => { racingStores[store] = [...(racingStores[store] || []).filter(existing => String(existing.id) !== String(item.id)), structuredClone(item)]; },
  dbClear: async store => { racingStores[store] = []; },
  dbTransactionStrict: createMemoryTransactionWithCache(racingStores, racingCache),
  getFromDB: async (store, id) => structuredClone((racingStores[store] || []).find(item => String(item.id) === String(id)) || null),
  deleteFromDB: async (store, id) => { racingStores[store] = (racingStores[store] || []).filter(item => String(item.id) !== String(id)); },
  getTodos: () => racingStores.todos,
  setTodos: next => { racingStores.todos = structuredClone(next); },
  getProjects: () => [], setProjects: () => {}, getSections: () => [], setSections: () => {}, getWorkspaces: () => [], setWorkspaces: () => {},
  todosApi: racingApi,
  projectsApi: { list: async () => ({ projects: [] }) }, sectionsApi: { listAll: async () => ({ sections: [] }) }, workspacesApi: { list: async () => ({ workspaces: [] }) },
  attachmentCache: racingCache.cache,
  renderStats: () => {}, renderTodos: () => {},
});
const racingSyncRef = { value: false };
const activeRacingSync = racingSync.syncWithServer({ wsState: 'connected', syncInProgressRef: racingSyncRef });
await racingUploadStarted;
const racingUi = createTodoAttachmentsFeature({
  getTodos: () => racingStores.todos,
  setTodos: next => { racingStores.todos = structuredClone(next); },
  getProjects: () => [], getCurrentUser: () => ({ id: 1, attachments_enabled: true }), setCurrentUser: () => {},
  getAppInitialized: () => true, getDb: () => ({}),
  dbPut: async (store, item) => { racingStores[store] = [...(racingStores[store] || []).filter(existing => String(existing.id) !== String(item.id)), structuredClone(item)]; },
  dbGetAll: async store => structuredClone(racingStores[store] || []),
  dbTransactionStrict: createMemoryTransactionWithCache(racingStores, racingCache),
  deleteFromDB: async (store, id) => { racingStores[store] = (racingStores[store] || []).filter(item => String(item.id) !== String(id)); },
  runSyncQueueMutation: async operation => operation(async (action, data) => { racingStores.syncQueue.push({ id: Math.max(0, ...racingStores.syncQueue.map(item => Number(item.id) || 0)) + 1, action, data: structuredClone(data) }); }),
  isOnlineForSync: () => true, syncWithServer: async () => {}, todosApi: racingApi, attachmentCache: racingCache.cache,
  renderStats: () => {}, renderTodos: () => {}, closeModal: () => {}, confirmDanger: async () => true, showToast: () => {}, t: key => key, iconSvg: () => '', escapeHtmlAttr: String,
  setTodoCollapsibleOpen: () => {}, refreshTodoActionButtonState: () => {}, refreshTodoSaveButtonState: () => {},
});
await racingUi.deleteTodoAttachment(10, 'temp-racing-attachment');
releaseRacingUpload();
await activeRacingSync;
await racingSync.syncWithServer({ wsState: 'connected', syncInProgressRef: racingSyncRef });
assert.deepEqual(racingStores.todos[0].attachments, [], 'deleting while an upload request is in flight must not resurrect the attachment');
assert.equal(racingStores.syncQueue.length, 0, 'the dependent delete must replay after the in-flight upload resolves');
assert.equal(await racingCache.cache.get('101'), null, 'the uploaded-then-deleted bytes must be removed from the cache');

console.log('✅ Offline todo attachment tests passed');
