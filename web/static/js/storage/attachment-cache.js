import { getAllStrict, getStrict, putStrict, removeStrict } from './indexed-db.js';

export const DEFAULT_ATTACHMENT_CACHE_MAX_BYTES = 250 * 1024 * 1024;
const STORE = 'attachmentBlobs';

function cacheId(value) {
  return String(value);
}

export function getOrphanedPermanentAttachmentQueueItems(queue = [], todos = []) {
  const authoritativeTodoIds = new Set(todos.map(todo => String(todo.id)));
  const locallyCreatedTodoIds = new Set(queue
    .filter(item => item?.action === 'CREATE_TODO')
    .map(item => String(item.data?._tempId)));
  return queue.filter(item => item?.action === 'CREATE_ATTACHMENT'
    && item.data?.failed_permanent
    && !authoritativeTodoIds.has(String(item.data?.todo_id))
    && !locallyCreatedTodoIds.has(String(item.data?.todo_id)));
}

export function getAuthoritativeAttachmentBlobIdsToDelete(records = [], todos = [], queue = []) {
  const attachmentPairs = new Set(todos.flatMap(todo => (todo.attachments || []).map(attachment => `${String(todo.id)}\u0000${cacheId(attachment.id)}`)));
  const orphanedPermanentIds = new Set(getOrphanedPermanentAttachmentQueueItems(queue, todos).map(item => String(item.id)));
  const pendingPairs = new Set(queue
    .filter(item => item?.action === 'CREATE_ATTACHMENT' && !orphanedPermanentIds.has(String(item.id)))
    .map(item => `${String(item.data?.todo_id)}\u0000${cacheId(item.data?.blob_id || item.data?.temp_id)}`));
  return records
    .filter((item) => {
      const todoId = String(item?.todo_id);
      if (item?.pending_upload) return !pendingPairs.has(`${todoId}\u0000${cacheId(item.id)}`);
      const attachmentId = cacheId(item?.attachment_id ?? item?.id);
      return !attachmentPairs.has(`${todoId}\u0000${attachmentId}`);
    })
    .map(item => item.id);
}

function recordSize(record) {
  return Number(record?.size_bytes ?? record?.blob?.size ?? 0) || 0;
}

function isQuotaError(error) {
  return error?.name === 'QuotaExceededError' || /quota/i.test(String(error?.message || ''));
}

export function createAttachmentCache({
  getAll: readAll = () => getAllStrict(STORE),
  get: read = id => getStrict(STORE, id),
  put: write = item => putStrict(STORE, item),
  remove: discard = id => removeStrict(STORE, id),
  estimateStorage = () => globalThis.navigator?.storage?.estimate?.(),
  requestPersistence = () => globalThis.navigator?.storage?.persist?.(),
  now = () => Date.now(),
} = {}) {
  let persistenceRequested = false;

  async function requestPersistentStorage() {
    if (persistenceRequested) return false;
    persistenceRequested = true;
    try {
      return Boolean(await requestPersistence?.());
    } catch (_error) {
      return false;
    }
  }

  async function prune({ maxBytes = DEFAULT_ATTACHMENT_CACHE_MAX_BYTES, bytesNeeded = 0 } = {}) {
    const records = await readAll();
    let total = records.reduce((sum, item) => sum + recordSize(item), 0);
    const target = Math.max(0, Number(maxBytes) - Number(bytesNeeded || 0));
    const evictable = records
      .filter(item => !item?.pinned && !item?.pending_upload)
      .sort((a, b) => Number(a.last_accessed || 0) - Number(b.last_accessed || 0));
    const removed = [];
    for (const item of evictable) {
      if (total <= target) break;
      await discard(item.id);
      total -= recordSize(item);
      removed.push(item.id);
    }
    return { totalBytes: Math.max(total, 0), removed };
  }

  async function put(record, { maxBytes = DEFAULT_ATTACHMENT_CACHE_MAX_BYTES, isCurrent = null } = {}) {
    if (!record?.blob) throw new TypeError('Attachment cache record requires a blob');
    const item = {
      ...record,
      id: cacheId(record.id ?? record.attachment_id),
      attachment_id: record.attachment_id ?? record.id,
      size_bytes: recordSize(record),
      pinned: Boolean(record.pinned || record.pending_upload),
      pending_upload: Boolean(record.pending_upload),
      last_accessed: Number(record.last_accessed || now()),
    };
    await requestPersistentStorage();
    const existing = await read(item.id);
    const existingSize = recordSize(existing);
    await prune({ maxBytes, bytesNeeded: Math.max(0, item.size_bytes - existingSize) });
    try {
      isCurrent?.();
      await write(item);
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      await prune({ maxBytes: 0 });
      try {
        isCurrent?.();
        await write(item);
      } catch (retryError) {
        let storage = null;
        try {
          storage = await estimateStorage?.();
        } catch (_error) {
          storage = null;
        }
        const wrapped = new Error('Attachment storage quota exceeded');
        wrapped.name = 'AttachmentStorageError';
        wrapped.cause = retryError;
        wrapped.storage = storage || null;
        throw wrapped;
      }
    }
    await prune({ maxBytes });
    return item;
  }

  async function getRecord(attachmentId, { touch = true, todoId = undefined, isCurrent = null } = {}) {
    const id = cacheId(attachmentId);
    const item = await read(id);
    if (!item) return null;
    if (todoId !== undefined && String(item.todo_id) !== String(todoId)) return null;
    if (touch) {
      item.last_accessed = now();
      isCurrent?.();
      await write(item).catch(() => {});
    }
    return item;
  }

  async function removeRecord(attachmentId) {
    await discard(cacheId(attachmentId));
  }

  async function rewrite(tempId, serverAttachment, { pendingUpload = false } = {}) {
    const oldId = cacheId(tempId);
    const current = await read(oldId);
    if (!current || !serverAttachment?.id) return null;
    const next = {
      ...current,
      id: cacheId(serverAttachment.id),
      todo_id: serverAttachment.todo_id ?? current.todo_id,
      attachment_id: serverAttachment.id,
      pending_upload: Boolean(pendingUpload),
      pinned: pendingUpload ? true : Boolean(current.offline_explicit),
      offline_explicit: Boolean(current.offline_explicit),
      last_accessed: now(),
    };
    await write(next);
    if (next.id !== oldId) await discard(oldId);
    return next;
  }

  async function setPinned(attachmentId, pinned = true, { isCurrent = null } = {}) {
    const item = await getRecord(attachmentId, { touch: false, isCurrent });
    if (!item) return null;
    item.offline_explicit = Boolean(pinned);
    item.pinned = Boolean(pinned || item.pending_upload);
    item.last_accessed = now();
    isCurrent?.();
    await write(item);
    return item;
  }

  async function removeForTodo(todoId) {
    const records = await readAll();
    await Promise.all(records
      .filter(item => String(item.todo_id) === String(todoId))
      .map(item => discard(item.id)));
  }

  async function rewriteTodoId(fromTodoId, toTodoId) {
    const records = await readAll();
    await Promise.all(records
      .filter(item => String(item.todo_id) === String(fromTodoId))
      .map(item => write({ ...item, todo_id: toTodoId })));
  }

  async function reconcileAuthoritative(todos = [], queue = []) {
    const records = await readAll();
    const orphanIds = getAuthoritativeAttachmentBlobIdsToDelete(records, todos, queue);
    for (const id of orphanIds) await discard(id);
    return orphanIds;
  }

  return {
    get: getRecord,
    put,
    remove: removeRecord,
    rewrite,
    setPinned,
    prune,
    removeForTodo,
    rewriteTodoId,
    reconcileAuthoritative,
    requestPersistentStorage,
  };
}

export const attachmentCache = createAttachmentCache();
