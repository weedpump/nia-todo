#!/usr/bin/env node
import assert from 'node:assert/strict';

globalThis.location = { origin: 'https://todo.example', search: '' };
globalThis.window = {};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { onLine: true, userAgent: 'Mozilla/5.0', platform: 'Linux', maxTouchPoints: 0, storage: {} },
});

const { createAttachmentCache, DEFAULT_ATTACHMENT_CACHE_MAX_BYTES } = await import('../web/static/js/storage/attachment-cache.js');
const { createTodoAttachmentsFeature } = await import('../web/static/js/features/todo-attachments.js');
const { createSyncFeature } = await import('../web/static/js/features/sync.js');
const { createWebSocketClient } = await import('../web/static/js/features/websocket-client.js');
const { projectPendingTodoChanges, queueItemReferencesTodo } = await import('../web/static/js/features/todo-pending.js');

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

function syncHarness({ queue, todos, blobs, api, attachmentCache = null, currentUser = null, dbPutStrict = null, deleteFromDBStrict = null }) {
  const stores = {
    syncQueue: structuredClone(queue),
    todos: structuredClone(todos),
    projects: [], sections: [], workspaces: [],
  };
  const cacheState = memoryCache(blobs);
  const userState = { current: currentUser ? structuredClone(currentUser) : null };
  const feature = createSyncFeature({
    getDb: () => ({}),
    dbGetAll: async store => structuredClone(stores[store] || []),
    dbPut: async (store, item) => {
      stores[store] = [...(stores[store] || []).filter(existing => String(existing.id) !== String(item.id)), structuredClone(item)];
    },
    dbPutStrict: dbPutStrict || (async (store, item) => {
      stores[store] = [...(stores[store] || []).filter(existing => String(existing.id) !== String(item.id)), structuredClone(item)];
    }),
    dbClear: async store => { stores[store] = []; },
    getFromDB: async (store, id) => structuredClone((stores[store] || []).find(item => String(item.id) === String(id)) || null),
    deleteFromDB: async (store, id) => { stores[store] = (stores[store] || []).filter(item => String(item.id) !== String(id)); },
    deleteFromDBStrict: deleteFromDBStrict || (async (store, id) => { stores[store] = (stores[store] || []).filter(item => String(item.id) !== String(id)); }),
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

const missingBlobHarness = syncHarness({
  queue: [{ id: 12, action: 'CREATE_ATTACHMENT', data: { todo_id: 7, temp_id: 'temp-missing', blob_id: 'temp-missing', filename: 'missing.txt', content_type: 'text/plain' } }],
  todos: [{ id: 7, attachments: [{ id: 'temp-missing', is_pending: true }], attachments_count: 1 }],
  blobs: [],
  api: { uploadAttachment: async () => assert.fail('upload must not run without pending bytes') },
});
const missingBlobResult = await missingBlobHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(missingBlobResult.failCount, 0, 'a confirmed missing pending blob is a permanent recoverable-data failure');
assert.equal(missingBlobHarness.stores.syncQueue.length, 0, 'a confirmed missing pending blob must not retry forever');

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
  },
});
const deleteResult = await deleteHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(deleteResult.failCount, 0, 'authenticated attachment delete 404 is terminal during replay');
assert.equal(deleteHarness.stores.syncQueue.length, 0);
assert.equal(deleteHarness.cacheState.records.has('81'), false);

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

const refreshCache = memoryCache([
  { id: '500', todo_id: 50, attachment_id: 500, blob: uploadBlob, pinned: true, offline_explicit: true },
]);
const refreshHarness = syncHarness({
  queue: [],
  todos: [{ id: 50, attachments: [{ id: 500 }], attachments_count: 1, updated_at: '2026-10-18T10:00:00Z' }],
  blobs: [],
  attachmentCache: refreshCache.cache,
  api: { list: async () => ({ todos: [{ id: 50, attachments: [], attachments_count: 0, updated_at: '2026-10-18T11:00:00Z' }] }) },
});
await refreshHarness.feature.refreshFromServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(refreshCache.records.has('500'), false, 'REST refresh must purge cached bytes for server attachments removed from an existing todo');

const websocketStores = {
  syncQueue: [{ action: 'CREATE_ATTACHMENT', data: { todo_id: 23, temp_id: 'temp-230', local_attachment: { id: 'temp-230', todo_id: 23, is_pending: true } } }],
  todos: [
    { id: 21, attachments: [{ id: 210 }], attachments_count: 1, updated_at: '2026-10-18T10:00:00Z' },
    { id: 22, attachments: [{ id: 220 }], attachments_count: 1, updated_at: '2026-10-18T10:00:00Z' },
    { id: 23, attachments: [{ id: 230 }, { id: 'temp-230', is_pending: true }], attachments_count: 2, updated_at: '2026-10-18T10:00:00Z' },
  ],
  projects: [], sections: [], workspaces: [],
};
const websocketCache = memoryCache([
  { id: '210', todo_id: 21, attachment_id: 210, blob: uploadBlob, pinned: true, offline_explicit: true },
  { id: '220', todo_id: 22, attachment_id: 220, blob: uploadBlob, pinned: true, offline_explicit: true },
  { id: '230', todo_id: 23, attachment_id: 230, blob: uploadBlob, pinned: true, offline_explicit: true },
  { id: 'temp-230', todo_id: 23, attachment_id: 'temp-230', blob: uploadBlob, pinned: true, pending_upload: true },
]);
const websocketClient = createWebSocketClient({
  wsUrl: 'ws://unused.invalid', getAuthToken: () => null, syncWithServer: async () => {}, syncInProgressRef: { value: false }, renderConnectionStatus: () => {},
  dbGetAll: async store => structuredClone(websocketStores[store] || []),
  dbPut: async (store, item) => { websocketStores[store] = [...(websocketStores[store] || []).filter(existing => String(existing.id) !== String(item.id)), structuredClone(item)]; },
  getFromDB: async (store, id) => structuredClone((websocketStores[store] || []).find(item => String(item.id) === String(id)) || null),
  deleteFromDB: async (store, id) => { websocketStores[store] = (websocketStores[store] || []).filter(item => String(item.id) !== String(id)); },
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

const uiStores = {
  todos: [{ id: 9, title: 'Existing', attachments: [] }],
  queue: [],
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
  dbGetAll: async store => store === 'syncQueue' ? structuredClone(uiStores.queue) : [],
  deleteFromDB: async (store, id) => { if (store === 'syncQueue') uiStores.queue = uiStores.queue.filter(item => item.id !== id); },
  runSyncQueueMutation: async operation => operation(async (action, data) => { uiStores.queue.push({ id: uiStores.queue.length + 1, action, data: structuredClone(data) }); }),
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
assert.equal(uiStores.queue[0].action, 'CREATE_ATTACHMENT');
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
  dbGetAll: async store => store === 'syncQueue' ? structuredClone(uiStores.queue) : [],
  dbGetAllStrict: async store => store === 'syncQueue' ? structuredClone(uiStores.queue) : [],
  deleteFromDB: async () => {}, deleteFromDBStrict: async () => { throw new Error('queue delete failed'); },
  runSyncQueueMutation: async operation => operation(async () => {}), isOnlineForSync: () => false, syncWithServer: async () => {}, todosApi: {}, attachmentCache: uiCache.cache,
  renderStats: () => {}, renderTodos: () => {}, closeModal: () => {}, confirmDanger: async () => true,
  showToast: message => failedDeleteToasts.push(message), t: key => key, iconSvg: () => '', escapeHtmlAttr: String,
  setTodoCollapsibleOpen: () => {}, refreshTodoActionButtonState: () => {}, refreshTodoSaveButtonState: () => {},
});
await failedDeleteFeature.deleteTodoAttachment(9, tempAttachment.id);
assert.equal(uiStores.queue.length, 1, 'failed strict cancellation must retain the queued create');
assert.equal(uiStores.todos[0].attachments.length, 1, 'failed strict cancellation must retain the optimistic pending attachment');
assert.notEqual(await uiCache.cache.get(tempAttachment.id), null, 'failed strict cancellation must retain pending bytes');
assert.equal(failedDeleteToasts.at(-1), 'todo.attachments.uploadPending');
await feature.deleteTodoAttachment(9, tempAttachment.id);
assert.equal(uiStores.queue.length, 0, 'deleting a temporary attachment should cancel its create operation');
assert.equal(uiStores.todos[0].attachments.length, 0);
assert.equal(await uiCache.cache.get(tempAttachment.id), null);

const rollbackStores = {
  todos: [{ id: 12, title: 'Rollback', attachments: [], attachments_count: 0 }],
  queue: [],
};
const rollbackCache = memoryCache();
const rollbackFeature = createTodoAttachmentsFeature({
  getTodos: () => rollbackStores.todos,
  setTodos: next => { rollbackStores.todos = structuredClone(next); },
  getProjects: () => [],
  getCurrentUser: () => ({ id: 1, attachments_enabled: true, attachment_remaining_bytes: 1024 * 1024 }),
  setCurrentUser: () => {},
  getAppInitialized: () => true,
  getDb: () => ({}),
  dbPut: async (_store, todo) => { rollbackStores.todos = rollbackStores.todos.map(item => item.id === todo.id ? structuredClone(todo) : item); },
  dbGetAll: async store => store === 'syncQueue' ? structuredClone(rollbackStores.queue) : [],
  deleteFromDB: async (store, id) => { if (store === 'syncQueue') rollbackStores.queue = rollbackStores.queue.filter(item => item.id !== id); },
  runSyncQueueMutation: async operation => operation(async (action, data) => {
    if (rollbackStores.queue.length) throw new Error('queue write failed');
    rollbackStores.queue.push({ id: 1, action, data: structuredClone(data) });
  }),
  isOnlineForSync: () => false,
  todosApi: {},
  attachmentCache: rollbackCache.cache,
  renderStats: () => {}, renderTodos: () => {}, closeModal: () => {},
  confirmDanger: async () => true,
  showToast: () => {}, t: key => key, iconSvg: () => '', escapeHtmlAttr: String,
  setTodoCollapsibleOpen: () => {}, refreshTodoActionButtonState: () => {}, refreshTodoSaveButtonState: () => {},
});
const rollbackFile = new Blob(['rollback'], { type: 'text/plain' });
rollbackFile.name = 'rollback.txt';
const rollbackFileTwo = new Blob(['rollback two'], { type: 'text/plain' });
rollbackFileTwo.name = 'rollback-two.txt';
assert.equal(await rollbackFeature.queueAttachmentFiles(12, [rollbackFile, rollbackFileTwo]), false, 'failed queue persistence must reject the optimistic upload');
assert.deepEqual(rollbackStores.todos[0].attachments, [], 'failed queue persistence must restore the previous todo state');
assert.equal(rollbackStores.todos[0].attachments_count, 0, 'failed queue persistence must restore the previous attachment count');
assert.equal(rollbackStores.queue.length, 0, 'failed multi-file queue persistence must remove already-written attachment operations');
assert.equal(rollbackCache.records.size, 0, 'failed queue persistence must remove staged attachment bytes');

const uncertainRollbackStores = {
  todos: [{ id: 13, title: 'Uncertain rollback', attachments: [], attachments_count: 0 }],
  queue: [],
};
const uncertainRollbackCache = memoryCache();
const uncertainToasts = [];
const uncertainRollbackFeature = createTodoAttachmentsFeature({
  getTodos: () => uncertainRollbackStores.todos,
  setTodos: next => { uncertainRollbackStores.todos = structuredClone(next); },
  getProjects: () => [],
  getCurrentUser: () => ({ id: 1, attachments_enabled: true, attachment_remaining_bytes: 1024 * 1024 }), setCurrentUser: () => {},
  getAppInitialized: () => true, getDb: () => ({}),
  dbPut: async (_store, todo) => { uncertainRollbackStores.todos = uncertainRollbackStores.todos.map(item => item.id === todo.id ? structuredClone(todo) : item); },
  dbPutStrict: async (_store, todo) => { uncertainRollbackStores.todos = uncertainRollbackStores.todos.map(item => item.id === todo.id ? structuredClone(todo) : item); },
  dbGetAll: async store => store === 'syncQueue' ? structuredClone(uncertainRollbackStores.queue) : [],
  dbGetAllStrict: async store => store === 'syncQueue' ? structuredClone(uncertainRollbackStores.queue) : [],
  deleteFromDB: async () => {},
  deleteFromDBStrict: async (store) => { if (store === 'syncQueue') throw new Error('queue delete transaction failed'); },
  runSyncQueueMutation: async operation => operation(async (action, data) => {
    if (uncertainRollbackStores.queue.length) throw new Error('second queue write failed');
    uncertainRollbackStores.queue.push({ id: 1, action, data: structuredClone(data) });
  }),
  isOnlineForSync: () => false, syncWithServer: async () => {}, todosApi: {}, attachmentCache: uncertainRollbackCache.cache,
  renderStats: () => {}, renderTodos: () => {}, closeModal: () => {}, confirmDanger: async () => true,
  showToast: message => uncertainToasts.push(message), t: key => key, iconSvg: () => '', escapeHtmlAttr: String,
  setTodoCollapsibleOpen: () => {}, refreshTodoActionButtonState: () => {}, refreshTodoSaveButtonState: () => {},
});
const uncertainFileA = new Blob(['uncertain a'], { type: 'text/plain' }); uncertainFileA.name = 'uncertain-a.txt';
const uncertainFileB = new Blob(['uncertain b'], { type: 'text/plain' }); uncertainFileB.name = 'uncertain-b.txt';
assert.equal(await uncertainRollbackFeature.queueAttachmentFiles(13, [uncertainFileA, uncertainFileB]), true, 'unproven cleanup must report surviving work as pending');
assert.equal(uncertainRollbackStores.queue.length, 1, 'a queue record whose deletion failed must remain live');
assert.equal(uncertainRollbackStores.todos[0].attachments.length, 1, 'the live queue record must keep its optimistic pending attachment');
assert.equal(uncertainRollbackCache.records.size, 1, 'bytes for the live queue record must be preserved while unqueued bytes are cleaned');
assert.equal(uncertainToasts.at(-1), 'todo.attachments.uploadPending');

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
  deleteFromDB: async (store, id) => { racingStores[store] = (racingStores[store] || []).filter(item => String(item.id) !== String(id)); },
  runSyncQueueMutation: async operation => operation(async (action, data) => { racingStores.syncQueue.push({ id: Math.max(0, ...racingStores.syncQueue.map(item => Number(item.id) || 0)) + 1, action, data: structuredClone(data) }); }),
  isOnlineForSync: () => true, syncWithServer: async () => {}, todosApi: racingApi, attachmentCache: racingCache.cache,
  renderStats: () => {}, renderTodos: () => {}, closeModal: () => {}, confirmDanger: async () => true, showToast: () => {}, t: key => key, iconSvg: () => '', escapeHtmlAttr: String,
  setTodoCollapsibleOpen: () => {}, refreshTodoActionButtonState: () => {}, refreshTodoSaveButtonState: () => {},
});
await racingUi.deleteTodoAttachment(10, 'temp-racing-attachment');
releaseRacingUpload();
await activeRacingSync;
assert.deepEqual(racingStores.todos[0].attachments, [], 'deleting while an upload request is in flight must not resurrect the attachment');
assert.equal(racingStores.syncQueue.length, 0, 'the dependent delete must replay after the in-flight upload resolves');
assert.equal(await racingCache.cache.get('101'), null, 'the uploaded-then-deleted bytes must be removed from the cache');

console.log('✅ Offline todo attachment tests passed');
