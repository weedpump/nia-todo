import { acquireSyncCommitLock, projectPendingTodoChanges, queueItemReferencesTodo } from './todo-pending.js';
import { attachmentCache as defaultAttachmentCache, getAuthoritativeAttachmentBlobIdsToDelete, getOrphanedPermanentAttachmentQueueItems } from '../storage/attachment-cache.js';

export function createSyncFeature({
  getDb,
  dbGetAll,
  dbGetAllStrict = dbGetAll,
  dbPut,
  dbPutStrict = dbPut,
  dbClear,
  dbClearStrict = dbClear,
  getFromDB,
  deleteFromDB,
  deleteFromDBStrict = deleteFromDB,
  dbTransactionStrict = null,
  getTodos,
  setTodos,
  getProjects,
  setProjects,
  getSections,
  setSections,
  getWorkspaces,
  setWorkspaces,
  getCurrentUser = () => null,
  setCurrentUser = () => {},
  todosApi,
  projectsApi,
  sectionsApi,
  workspacesApi,
  attachmentCache = defaultAttachmentCache,
  renderStats,
  renderTodos,
}) {
  function applyAttachmentUsage(usage) {
    const currentUser = getCurrentUser?.();
    if (!usage || !currentUser) return;
    const fieldMap = {
      enabled: 'attachments_enabled',
      used_bytes: 'attachment_usage_bytes',
      quota_bytes: 'attachment_quota_bytes',
      remaining_bytes: 'attachment_remaining_bytes',
      allowed_types: 'attachments_allowed_types',
      max_upload_bytes: 'attachment_max_upload_bytes',
    };
    const next = { ...currentUser };
    for (const [source, target] of Object.entries(fieldMap)) {
      if (Object.prototype.hasOwnProperty.call(usage, source)) next[target] = usage[source];
    }
    setCurrentUser(next);
  }

  async function markAttachmentCreateFailedPermanently(queueItem, error, syncInProgressRef) {
    const attachmentId = queueItem.data.temp_id || queueItem.data.blob_id;
    const syncError = {
      code: error?.code || `attachment_upload_rejected_${Number(error?.status) || 'unknown'}`,
      status: Number(error?.status) || null,
      message: String(error?.message || 'Attachment upload was rejected'),
    };
    const failedQueueItem = {
      ...queueItem,
      data: {
        ...queueItem.data,
        upload_started: false,
        failed_permanent: true,
        sync_error: syncError,
        local_attachment: queueItem.data.local_attachment
          ? { ...queueItem.data.local_attachment, is_pending: true, failed_permanent: true, sync_error: syncError }
          : queueItem.data.local_attachment,
      },
    };
    const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
    try {
      let updatedTodo = null;
      if (dbTransactionStrict) {
        const result = await dbTransactionStrict(['todos', 'syncQueue', 'attachmentBlobs'], 'readwrite', async transaction => {
          const queue = await transaction.getAll('syncQueue');
          const dependentDeletes = queue.filter(item => item.action === 'DELETE_ATTACHMENT'
            && String(item.data?.todo_id) === String(queueItem.data.todo_id)
            && String(item.data?.attachment_id) === String(attachmentId));
          const localTodo = await transaction.get('todos', queueItem.data.todo_id);
          const nextTodo = localTodo ? {
            ...localTodo,
            attachments: dependentDeletes.length
              ? (localTodo.attachments || []).filter(attachment => String(attachment.id) !== String(attachmentId))
              : (localTodo.attachments || []).map(attachment => (
                String(attachment.id) === String(attachmentId)
                  ? { ...attachment, is_pending: true, failed_permanent: true, sync_error: syncError }
                  : attachment
              )),
          } : null;
          if (nextTodo) nextTodo.attachments_count = nextTodo.attachments.length;
          if (nextTodo) await transaction.put('todos', nextTodo);
          if (dependentDeletes.length) {
            await transaction.delete('syncQueue', queueItem.id);
            for (const dependent of dependentDeletes) await transaction.delete('syncQueue', dependent.id);
            await transaction.delete('attachmentBlobs', String(queueItem.data.blob_id || attachmentId));
            return { updatedTodo: nextTodo, cancelled: true };
          }
          await transaction.put('syncQueue', failedQueueItem);
          return { updatedTodo: nextTodo, cancelled: false };
        });
        updatedTodo = result.updatedTodo;
      } else {
        const localTodo = await getFromDB('todos', queueItem.data.todo_id);
        updatedTodo = localTodo ? {
          ...localTodo,
          attachments: (localTodo.attachments || []).map(attachment => (
            String(attachment.id) === String(attachmentId)
              ? { ...attachment, is_pending: true, failed_permanent: true, sync_error: syncError }
              : attachment
          )),
        } : null;
        if (updatedTodo) await dbPutStrict('todos', updatedTodo);
        await dbPutStrict('syncQueue', failedQueueItem);
      }
      if (updatedTodo) setTodos(getTodos().map(todo => String(todo.id) === String(updatedTodo.id) ? updatedTodo : todo));
    } finally {
      releaseCommitLock();
    }
  }
  function isOnlineForSync(wsState) {
    // Browser/native offline state must win over a stale WebSocket state.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    return wsState === 'connected' || (typeof navigator !== 'undefined' && navigator.onLine);
  }

  function pickAllowed(source, allowedFields) {
    const out = {};
    if (!source || typeof source !== 'object') return out;
    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(source, field)) out[field] = source[field];
    }
    return out;
  }

  function upsertTodo(todo) {
    if (!todo?.id) return;
    const known = getTodos().some(item => String(item.id) === String(todo.id));
    setTodos(known
      ? getTodos().map(item => String(item.id) === String(todo.id) ? todo : item)
      : [...getTodos(), todo]);
  }

  async function persistTodoWithPending(todo, processedQueueId) {
    if (!todo?.id) return;
    const queue = (await dbGetAllStrict('syncQueue')).filter(item => String(item.id) !== String(processedQueueId));
    const projected = projectPendingTodoChanges(todo, queue);
    if (!projected) {
      await deleteFromDBStrict('todos', todo.id);
      setTodos(getTodos().filter(item => String(item.id) !== String(todo.id)));
      return;
    }
    await dbPutStrict('todos', projected);
    upsertTodo(projected);
  }

  async function rewriteQueuedReferences({ todoIdFrom, todoIdTo, commentIdFrom, commentIdTo, subtaskIdFrom, subtaskIdTo, attachmentIdFrom, attachmentIdTo, queue: suppliedQueue }) {
    const queue = suppliedQueue || await dbGetAllStrict('syncQueue');
    for (const queued of queue) {
      if (!queued?.data || typeof queued.data !== 'object') continue;
      let changed = false;
      if (todoIdFrom !== undefined) {
        if (['CREATE_COMMENT', 'UPDATE_COMMENT', 'DELETE_COMMENT', 'CREATE_SUBTASK', 'UPDATE_SUBTASK', 'DELETE_SUBTASK', 'CREATE_ATTACHMENT', 'DELETE_ATTACHMENT'].includes(queued.action)
          && String(queued.data.todo_id) === String(todoIdFrom)) {
          queued.data.todo_id = todoIdTo;
          changed = true;
        }
        if (['UPDATE_TODO', 'DELETE_TODO'].includes(queued.action) && String(queued.data.id) === String(todoIdFrom)) {
          queued.data.id = todoIdTo;
          changed = true;
        }
        if (queued.action === 'CREATE_COMMENT' && queued.data.local_comment && String(queued.data.local_comment.todo_id) === String(todoIdFrom)) {
          queued.data.local_comment.todo_id = todoIdTo;
          changed = true;
        }
      }
      if (commentIdFrom !== undefined && String(queued.data.comment_id) === String(commentIdFrom)) {
        queued.data.comment_id = commentIdTo;
        changed = true;
      }
      if (subtaskIdFrom !== undefined && String(queued.data.subtask_id) === String(subtaskIdFrom)) {
        queued.data.subtask_id = subtaskIdTo;
        changed = true;
      }
      if (attachmentIdFrom !== undefined && String(queued.data.attachment_id) === String(attachmentIdFrom)) {
        queued.data.attachment_id = attachmentIdTo;
        changed = true;
      }
      if (changed) {
        await dbPutStrict('syncQueue', queued);
      }
    }
  }

  async function commitQueueItem(item, applyResult, syncInProgressRef) {
    const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
    try {
      await applyResult();
      await deleteFromDBStrict('syncQueue', item.id);
    } finally {
      releaseCommitLock();
    }
  }

  function rewriteAttachmentQueueItem(queued, attachmentIdFrom, attachmentIdTo) {
    if (!queued?.data || String(queued.data.attachment_id) !== String(attachmentIdFrom)) return queued;
    return { ...queued, data: { ...queued.data, attachment_id: attachmentIdTo } };
  }

  function rewriteTodoQueueItem(queued, todoIdFrom, todoIdTo) {
    if (!queued?.data || typeof queued.data !== 'object') return queued;
    let changed = false;
    const data = { ...queued.data };
    if (['CREATE_COMMENT', 'UPDATE_COMMENT', 'DELETE_COMMENT', 'CREATE_SUBTASK', 'UPDATE_SUBTASK', 'DELETE_SUBTASK', 'CREATE_ATTACHMENT', 'DELETE_ATTACHMENT'].includes(queued.action)
        && String(data.todo_id) === String(todoIdFrom)) {
      data.todo_id = todoIdTo;
      changed = true;
    }
    if (['UPDATE_TODO', 'DELETE_TODO'].includes(queued.action) && String(data.id) === String(todoIdFrom)) {
      data.id = todoIdTo;
      changed = true;
    }
    if (data.local_comment && String(data.local_comment.todo_id) === String(todoIdFrom)) {
      data.local_comment = { ...data.local_comment, todo_id: todoIdTo };
      changed = true;
    }
    if (data.local_attachment && String(data.local_attachment.todo_id) === String(todoIdFrom)) {
      data.local_attachment = { ...data.local_attachment, todo_id: todoIdTo };
      changed = true;
    }
    return changed ? { ...queued, data } : queued;
  }

  async function commitTodoCreate(item, createData, responseTodo, syncInProgressRef) {
    const tempId = createData._tempId;
    if (!dbTransactionStrict || !tempId) {
      await commitQueueItem(item, async () => {
        let localTempTodo = null;
        if (tempId) {
          localTempTodo = await getFromDB('todos', tempId);
          const queueForRewrite = await dbGetAllStrict('syncQueue');
          await attachmentCache.rewriteTodoId(tempId, responseTodo.id);
          await rewriteQueuedReferences({ todoIdFrom: tempId, todoIdTo: responseTodo.id, queue: queueForRewrite });
          await deleteFromDBStrict('todos', tempId);
        }
        const createdTodo = localTempTodo ? { ...localTempTodo, ...responseTodo, id: responseTodo.id } : responseTodo;
        await persistTodoWithPending(createdTodo, item.id);
      }, syncInProgressRef);
      return;
    }

    const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
    try {
      const projected = await dbTransactionStrict(['todos', 'syncQueue', 'attachmentBlobs'], 'readwrite', async transaction => {
        const [queue, blobs, localTempTodo] = await Promise.all([
          transaction.getAll('syncQueue'),
          transaction.getAll('attachmentBlobs'),
          transaction.get('todos', tempId),
        ]);
        const remainingQueue = [];
        for (const queued of queue) {
          if (String(queued.id) === String(item.id)) continue;
          const rewritten = rewriteTodoQueueItem(queued, tempId, responseTodo.id);
          remainingQueue.push(rewritten);
          if (rewritten !== queued) await transaction.put('syncQueue', rewritten);
        }
        for (const blob of blobs.filter(record => String(record.todo_id) === String(tempId))) {
          await transaction.put('attachmentBlobs', { ...blob, todo_id: responseTodo.id });
        }
        await transaction.delete('todos', tempId);
        const createdTodo = localTempTodo ? { ...localTempTodo, ...responseTodo, id: responseTodo.id } : responseTodo;
        const nextTodo = projectPendingTodoChanges(createdTodo, remainingQueue);
        if (nextTodo) await transaction.put('todos', nextTodo);
        else await transaction.delete('todos', responseTodo.id);
        await transaction.delete('syncQueue', item.id);
        return nextTodo;
      });
      setTodos(getTodos().filter(todo => String(todo.id) !== String(tempId)));
      if (projected) upsertTodo(projected);
    } finally {
      releaseCommitLock();
    }
  }

  async function commitAttachmentCreate(item, response, syncInProgressRef) {
    if (!dbTransactionStrict) {
      await commitQueueItem(item, async () => {
        if (response?.attachment?.id) {
          const queueForRewrite = await dbGetAllStrict('syncQueue');
          await rewriteQueuedReferences({ attachmentIdFrom: item.data.temp_id, attachmentIdTo: response.attachment.id, queue: queueForRewrite });
          await attachmentCache.rewrite(item.data.blob_id || item.data.temp_id, response.attachment);
        }
        await persistTodoWithPending(response?.todo, item.id);
      }, syncInProgressRef);
      return;
    }
    const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
    try {
      const committedTodo = await dbTransactionStrict(['todos', 'syncQueue', 'attachmentBlobs'], 'readwrite', async transaction => {
        const queue = await transaction.getAll('syncQueue');
        const rewrittenQueue = [];
        for (const queued of queue) {
          const rewritten = response?.attachment?.id
            ? rewriteAttachmentQueueItem(queued, item.data.temp_id, response.attachment.id)
            : queued;
          rewrittenQueue.push(rewritten);
          if (rewritten !== queued) await transaction.put('syncQueue', rewritten);
        }
        if (response?.attachment?.id) {
          const oldBlobId = String(item.data.blob_id || item.data.temp_id);
          const blobRecord = await transaction.get('attachmentBlobs', oldBlobId);
          if (blobRecord) {
            const nextBlobId = String(response.attachment.id);
            await transaction.put('attachmentBlobs', {
              ...blobRecord,
              id: nextBlobId,
              todo_id: response.attachment.todo_id ?? blobRecord.todo_id,
              attachment_id: response.attachment.id,
              pending_upload: false,
              pinned: Boolean(blobRecord.offline_explicit),
              offline_explicit: Boolean(blobRecord.offline_explicit),
              last_accessed: Date.now(),
            });
            if (nextBlobId !== oldBlobId) await transaction.delete('attachmentBlobs', oldBlobId);
          }
        }
        const remainingQueue = rewrittenQueue.filter(queued => String(queued.id) !== String(item.id));
        const projected = response?.todo ? projectPendingTodoChanges(response.todo, remainingQueue) : null;
        if (response?.todo?.id) {
          if (projected) await transaction.put('todos', projected);
          else await transaction.delete('todos', response.todo.id);
        }
        await transaction.delete('syncQueue', item.id);
        return projected;
      });
      if (response?.todo?.id) {
        if (committedTodo) upsertTodo(committedTodo);
        else setTodos(getTodos().filter(todo => String(todo.id) !== String(response.todo.id)));
      }
    } finally {
      releaseCommitLock();
    }
  }

  async function commitTodoDeletion(todoId, syncInProgressRef) {
    const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
    try {
      if (dbTransactionStrict) {
        await dbTransactionStrict(['todos', 'syncQueue', 'attachmentBlobs'], 'readwrite', async transaction => {
          const [queue, blobs] = await Promise.all([
            transaction.getAll('syncQueue'),
            transaction.getAll('attachmentBlobs'),
          ]);
          for (const queued of queue.filter(entry => queueItemReferencesTodo(entry, todoId))) {
            await transaction.delete('syncQueue', queued.id);
          }
          await transaction.delete('todos', todoId);
          for (const blob of blobs.filter(record => String(record.todo_id) === String(todoId))) {
            await transaction.delete('attachmentBlobs', blob.id);
          }
        });
      } else {
        await attachmentCache.removeForTodo(todoId);
        await deleteFromDBStrict('todos', todoId);
        await deleteQueuedTodoOperations(todoId);
      }
      setTodos(getTodos().filter(todo => String(todo.id) !== String(todoId)));
    } finally {
      releaseCommitLock();
    }
  }

  async function commitAttachmentDeletion(item, responseTodo, syncInProgressRef) {
    const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
    try {
      let committedTodo = null;
      if (dbTransactionStrict) {
        committedTodo = await dbTransactionStrict(['todos', 'syncQueue', 'attachmentBlobs'], 'readwrite', async transaction => {
          const queue = await transaction.getAll('syncQueue');
          const remainingQueue = queue.filter(queued => String(queued.id) !== String(item.id));
          const localTodo = await transaction.get('todos', item.data.todo_id);
          const baseTodo = responseTodo || localTodo;
          let projected = baseTodo ? projectPendingTodoChanges(baseTodo, remainingQueue) : null;
          if (projected) {
            projected = {
              ...projected,
              attachments: (projected.attachments || []).filter(attachment => String(attachment.id) !== String(item.data.attachment_id)),
            };
            projected.attachments_count = projected.attachments.length;
            await transaction.put('todos', projected);
          }
          await transaction.delete('attachmentBlobs', String(item.data.attachment_id));
          await transaction.delete('syncQueue', item.id);
          return projected;
        });
      } else {
        const localTodo = responseTodo || await getFromDB('todos', item.data.todo_id);
        if (localTodo) {
          committedTodo = {
            ...localTodo,
            attachments: (localTodo.attachments || []).filter(attachment => String(attachment.id) !== String(item.data.attachment_id)),
          };
          committedTodo.attachments_count = committedTodo.attachments.length;
          await dbPutStrict('todos', committedTodo);
        }
        await attachmentCache.remove(item.data.attachment_id);
        await deleteFromDBStrict('syncQueue', item.id);
      }
      if (committedTodo) upsertTodo(committedTodo);
    } finally {
      releaseCommitLock();
    }
  }

  async function recoverTodosFromServer(todoIds, syncInProgressRef) {
    if (!todoIds.size) return true;
    const response = await todosApi.list();
    const serverTodos = new Map((response?.todos || []).map(todo => [String(todo.id), todo]));
    const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
    try {
      const queue = await dbGetAllStrict('syncQueue');
      for (const todoId of todoIds) {
        const serverTodo = serverTodos.get(String(todoId));
        if (!serverTodo) {
          await deleteFromDBStrict('todos', todoId);
          setTodos(getTodos().filter(todo => String(todo.id) !== String(todoId)));
          await deleteQueuedTodoOperations(todoId);
          continue;
        }
        const projected = projectPendingTodoChanges(serverTodo, queue);
        if (projected) {
          await dbPutStrict('todos', projected);
          const exists = getTodos().some(todo => String(todo.id) === String(todoId));
          setTodos(exists
            ? getTodos().map(todo => String(todo.id) === String(todoId) ? projected : todo)
            : [...getTodos(), projected]);
        } else {
          await deleteFromDBStrict('todos', todoId);
          setTodos(getTodos().filter(todo => String(todo.id) !== String(todoId)));
        }
      }
      renderStats?.();
      renderTodos?.();
      return true;
    } finally {
      releaseCommitLock();
    }
  }

  async function deleteQueuedTodoOperations(todoId) {
    const queue = await dbGetAllStrict('syncQueue');
    const matching = queue.filter(item => queueItemReferencesTodo(item, todoId));
    await Promise.all(matching.map(item => deleteFromDBStrict('syncQueue', item.id)));
  }

  function sanitizeQueueItem(item) {
    if (!item || typeof item !== 'object' || typeof item.action !== 'string') return null;
    const data = item.data && typeof item.data === 'object' ? item.data : {};
    const changes = data.changes && typeof data.changes === 'object' ? data.changes : {};
    const todoFields = ['title', 'description', 'priority', 'is_pinned', 'status', 'project_id', 'section_id', 'due_date', 'remind_at', 'location_reminder', 'recurring_rule', 'subtasks', 'confirm_incomplete_subtasks_completion', 'client_mutation_id', '_tempId'];
    const projectFields = ['name', 'color', 'icon', 'sort_order', 'parent_id', 'workspace_id', '_tempId'];
    const sectionFields = ['name', 'sort_order', 'project_id', '_tempId'];
    const localCommentFields = ['id', 'todo_id', 'user_id', 'body', 'created_at', 'updated_at', 'author_username', 'author_display_name', 'is_pending'];
    const localSubtaskFields = ['id', 'title', 'is_done', 'sort_order', 'created_at', 'updated_at', 'is_pending'];

    switch (item.action) {
      case 'CREATE_TODO':
        return { ...item, data: { ...pickAllowed(data, todoFields), undo_grace_until: data.undo_grace_until } };
      case 'UPDATE_TODO':
        return { ...item, data: { id: data.id, changes: pickAllowed(changes, todoFields.filter(f => f !== '_tempId')) } };
      case 'DELETE_TODO':
        return { ...item, data: { id: data.id, undo_grace_until: data.undo_grace_until } };
      case 'CREATE_COMMENT':
        return { ...item, data: { todo_id: data.todo_id, temp_id: data.temp_id, body: data.body, local_comment: pickAllowed(data.local_comment, localCommentFields) } };
      case 'UPDATE_COMMENT':
        return { ...item, data: { todo_id: data.todo_id, comment_id: data.comment_id, changes: pickAllowed(changes, ['body']) } };
      case 'DELETE_COMMENT':
        return { ...item, data: { todo_id: data.todo_id, comment_id: data.comment_id } };
      case 'CREATE_SUBTASK':
        return { ...item, data: { todo_id: data.todo_id, temp_id: data.temp_id, subtask: pickAllowed(data.subtask, ['title', 'is_done', 'sort_order']), local_subtask: pickAllowed(data.local_subtask, localSubtaskFields) } };
      case 'UPDATE_SUBTASK':
        return { ...item, data: { todo_id: data.todo_id, subtask_id: data.subtask_id, changes: pickAllowed(changes, ['title', 'is_done', 'sort_order']) } };
      case 'DELETE_SUBTASK':
        return { ...item, data: { todo_id: data.todo_id, subtask_id: data.subtask_id } };
      case 'CREATE_ATTACHMENT':
        return { ...item, data: { todo_id: data.todo_id, temp_id: data.temp_id, blob_id: data.blob_id, client_mutation_id: data.client_mutation_id, filename: data.filename, content_type: data.content_type, size_bytes: data.size_bytes, local_attachment: data.local_attachment, upload_started: Boolean(data.upload_started), failed_permanent: Boolean(data.failed_permanent), sync_error: data.sync_error } };
      case 'DELETE_ATTACHMENT':
        return { ...item, data: { todo_id: data.todo_id, attachment_id: data.attachment_id } };
      case 'CREATE_PROJECT':
        return { ...item, data: pickAllowed(data, projectFields) };
      case 'UPDATE_PROJECT':
        return { ...item, data: { id: data.id, changes: pickAllowed(changes, projectFields.filter(f => f !== '_tempId')) } };
      case 'DELETE_PROJECT':
        return { ...item, data: { id: data.id } };
      case 'CREATE_SECTION':
        return { ...item, data: pickAllowed(data, sectionFields) };
      case 'UPDATE_SECTION':
        return { ...item, data: { id: data.id, changes: pickAllowed(changes, sectionFields.filter(f => !['_tempId', 'project_id'].includes(f))) } };
      case 'DELETE_SECTION':
        return { ...item, data: { id: data.id } };
      default:
        return null;
    }
  }

  async function syncWithServer({ wsState, syncInProgressRef }) {
    if (!isOnlineForSync(wsState) || !getDb()) {
      return { successCount: 0, failCount: 0, skipped: true };
    }
    if (syncInProgressRef.value) {
      syncInProgressRef.requested = true;
      return { successCount: 0, failCount: 0, skipped: true };
    }
    syncInProgressRef.value = true;
    syncInProgressRef.requested = false;
    let successCount = 0;
    let failCount = 0;
    let needsAuthoritativeRefresh = false;
    const todoIdsNeedingRecovery = new Set();
    const attemptedQueueIds = new Set();
    const blockedTodoIds = new Set();
    const blockedAttachmentIds = new Set();
    try {
      while (true) {
      syncInProgressRef.requested = false;
      const queue = (await dbGetAllStrict('syncQueue')).filter(item => !attemptedQueueIds.has(String(item.id)));
      if (!queue.length) break;

      for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const queuedItem = queue[queueIndex];
      attemptedQueueIds.add(String(queuedItem.id));
      const currentQueuedItem = (await dbGetAllStrict('syncQueue')).find(item => String(item.id) === String(queuedItem.id));
      if (!currentQueuedItem) continue;
      const item = sanitizeQueueItem(currentQueuedItem);
      try {
        if (!item) {
          await deleteFromDBStrict('syncQueue', queuedItem.id);
          continue;
        }
        if ([...blockedTodoIds].some(todoId => queueItemReferencesTodo(item, todoId))) continue;
        if (item.action === 'DELETE_ATTACHMENT' && blockedAttachmentIds.has(String(item.data.attachment_id))) continue;
        if (item.action === 'CREATE_ATTACHMENT' && item.data.failed_permanent) continue;
        if (item.action === 'CREATE_TODO') {
          const undoGraceUntil = Number(item.data.undo_grace_until || 0);
          if (undoGraceUntil && Date.now() < undoGraceUntil) {
            continue;
          }
          const createData = { ...item.data };
          delete createData.undo_grace_until;
          const createPayload = { ...createData };
          delete createPayload._tempId;
          let res = await todosApi.create(createPayload);
          const localTempTodo = createData._tempId ? await getFromDB('todos', createData._tempId) : null;
          const localSectionChanged = localTempTodo && localTempTodo.section_id !== createData.section_id;
          if (localSectionChanged) res = await todosApi.update(res.id, { section_id: localTempTodo.section_id });
          await commitTodoCreate(item, createData, res, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'UPDATE_TODO') {
          const serverTodo = await todosApi.update(item.data.id, item.data.changes);
          await commitQueueItem(item, async () => {
            const recurrenceCreatedTodo = serverTodo?.recurrence_created_todo;
            const cleanServerTodo = serverTodo ? { ...serverTodo } : null;
            if (cleanServerTodo) delete cleanServerTodo.recurrence_created_todo;
            const localTodo = await getFromDB('todos', item.data.id);
            const nextTodo = cleanServerTodo || (localTodo ? { ...localTodo, ...item.data.changes, updated_at: new Date().toISOString() } : null);
            if (nextTodo) await persistTodoWithPending(nextTodo, item.id);
            if (recurrenceCreatedTodo?.id) {
              await dbPut('todos', recurrenceCreatedTodo);
              const known = getTodos().some(todo => String(todo.id) === String(recurrenceCreatedTodo.id));
              setTodos(known ? getTodos().map(todo => String(todo.id) === String(recurrenceCreatedTodo.id) ? recurrenceCreatedTodo : todo) : [...getTodos(), recurrenceCreatedTodo]);
              renderStats?.();
              renderTodos?.();
            }
          }, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'CREATE_COMMENT') {
          const response = await todosApi.createComment(item.data.todo_id, { body: item.data.body, client_mutation_id: item.data.temp_id });
          await commitQueueItem(item, async () => {
            if (item.data.temp_id && response?.comment?.id) {
              await rewriteQueuedReferences({
                commentIdFrom: item.data.temp_id,
                commentIdTo: response.comment.id,
              });
            }
            await persistTodoWithPending(response?.todo, item.id);
          }, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'UPDATE_COMMENT') {
          const response = await todosApi.updateComment(item.data.todo_id, item.data.comment_id, item.data.changes);
          await commitQueueItem(item, () => persistTodoWithPending(response?.todo, item.id), syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_COMMENT') {
          const response = await todosApi.deleteComment(item.data.todo_id, item.data.comment_id);
          await commitQueueItem(item, () => persistTodoWithPending(response?.todo, item.id), syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'CREATE_SUBTASK') {
          const response = await todosApi.createSubtask(item.data.todo_id, { ...item.data.subtask, client_mutation_id: item.data.temp_id });
          await commitQueueItem(item, async () => {
            if (item.data.temp_id && response?.subtask?.id) {
              await rewriteQueuedReferences({
                subtaskIdFrom: item.data.temp_id,
                subtaskIdTo: response.subtask.id,
              });
            }
            await persistTodoWithPending(response?.todo, item.id);
          }, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'UPDATE_SUBTASK') {
          const response = await todosApi.updateSubtask(item.data.todo_id, item.data.subtask_id, item.data.changes);
          await commitQueueItem(item, () => persistTodoWithPending(response?.todo, item.id), syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_SUBTASK') {
          const response = await todosApi.deleteSubtask(item.data.todo_id, item.data.subtask_id);
          await commitQueueItem(item, () => persistTodoWithPending(response?.todo, item.id), syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'CREATE_ATTACHMENT') {
          await dbPutStrict('syncQueue', {
            ...currentQueuedItem,
            data: { ...currentQueuedItem.data, upload_started: true },
          });
          const cached = await attachmentCache.get(item.data.blob_id || item.data.temp_id, { todoId: item.data.todo_id });
          if (!cached?.blob) {
            const error = new Error('Pending attachment bytes are unavailable');
            error.code = 'pending_attachment_blob_missing';
            throw error;
          }
          const response = await todosApi.uploadAttachment(item.data.todo_id, cached.blob, {
            filename: item.data.filename,
            contentType: item.data.content_type,
            clientMutationId: item.data.client_mutation_id || item.data.temp_id,
          });
          await commitAttachmentCreate(item, response, syncInProgressRef);
          applyAttachmentUsage(response?.usage);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_ATTACHMENT') {
          const response = await todosApi.deleteAttachment(item.data.todo_id, item.data.attachment_id);
          await commitAttachmentDeletion(item, response?.todo, syncInProgressRef);
          applyAttachmentUsage(response?.usage);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_TODO') {
          const undoGraceUntil = Number(item.data.undo_grace_until || 0);
          if (undoGraceUntil && Date.now() < undoGraceUntil) {
            continue;
          }
          await todosApi.delete(item.data.id);
          await commitTodoDeletion(item.data.id, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'CREATE_PROJECT') {
          const res = await projectsApi.create(item.data);
          if (item.data._tempId) {
            await deleteFromDB('projects', item.data._tempId);
            setProjects(getProjects().filter(p => p.id !== item.data._tempId));
          }
          await dbPut('projects', res);
          if (!getProjects().find(p => p.id === res.id)) setProjects([...getProjects(), res]);
          successCount++;
        } else if (item.action === 'DELETE_PROJECT') {
          const res = await projectsApi.delete(item.data.id);
          const deletedIds = res.deleted_ids || [item.data.id];
          await Promise.all(deletedIds.map(projectId => deleteFromDB('projects', projectId)));
          needsAuthoritativeRefresh = true;
          successCount++;
        } else if (item.action === 'UPDATE_PROJECT') {
          const serverProject = await projectsApi.update(item.data.id, item.data.changes);
          const updatedProjects = Array.isArray(serverProject?.updated_projects) ? serverProject.updated_projects : (serverProject ? [serverProject] : []);
          if (updatedProjects.length) {
            await Promise.all(updatedProjects.map(project => dbPut('projects', project)));
            const byId = new Map(updatedProjects.map(project => [String(project.id), project]));
            const existingIds = new Set(getProjects().map(project => String(project.id)));
            const mergedProjects = getProjects().map(project => byId.get(String(project.id)) || project);
            for (const project of updatedProjects) {
              if (!existingIds.has(String(project.id))) mergedProjects.push(project);
            }
            setProjects(mergedProjects);
          } else {
            const localProject = await getFromDB('projects', item.data.id);
            if (localProject) await dbPut('projects', { ...localProject, ...item.data.changes, updated_at: new Date().toISOString() });
          }
          if (item.data.changes && Object.prototype.hasOwnProperty.call(item.data.changes, 'workspace_id')) {
            needsAuthoritativeRefresh = true;
          }
          successCount++;
        } else if (item.action === 'CREATE_SECTION') {
          const res = await sectionsApi.create(item.data.project_id, item.data);
          if (item.data._tempId) {
            await deleteFromDB('sections', item.data._tempId);
            setSections(getSections().filter(s => s.id !== item.data._tempId));
          }
          await dbPut('sections', res);
          if (!getSections().find(s => s.id === res.id)) setSections([...getSections(), res]);
          successCount++;
        } else if (item.action === 'UPDATE_SECTION') {
          await sectionsApi.update(item.data.id, item.data.changes);
          const localSection = await getFromDB('sections', item.data.id);
          if (localSection) await dbPut('sections', { ...localSection, ...item.data.changes, updated_at: new Date().toISOString() });
          successCount++;
        } else if (item.action === 'DELETE_SECTION') {
          await sectionsApi.delete(item.data.id);
          await deleteFromDB('sections', item.data.id);
          successCount++;
        }
        await deleteFromDBStrict('syncQueue', item.id);
      } catch (err) {
        console.error('Sync failed for action', item?.action || 'INVALID_QUEUE_ITEM', err);
        if (item?.action === 'CREATE_TODO' && item.data?._tempId) blockedTodoIds.add(String(item.data._tempId));
        if (item?.action === 'CREATE_ATTACHMENT' && item.data?.temp_id) blockedAttachmentIds.add(String(item.data.temp_id));
        let handledPermanentAbsence = false;
        if (item?.action === 'DELETE_TODO' && err?.status === 404) {
          try {
            await commitTodoDeletion(item.data.id, syncInProgressRef);
            successCount++;
          } catch (commitError) {
            console.error('Failed to commit missing todo deletion', commitError);
            failCount++;
          }
          handledPermanentAbsence = true;
        } else if (item?.action === 'DELETE_ATTACHMENT' && err?.status === 404) {
          try {
            const usage = await todosApi.getAttachmentUsage();
            applyAttachmentUsage(usage);
            await commitAttachmentDeletion(item, null, syncInProgressRef);
            successCount++;
          } catch (commitError) {
            console.error('Failed to commit missing attachment deletion', commitError);
            failCount++;
          }
          handledPermanentAbsence = true;
        } else if (item?.action === 'CREATE_ATTACHMENT' && err?.code === 'pending_attachment_blob_missing') {
          await commitQueueItem(item, async () => {
            const localTodo = await getFromDB('todos', item.data.todo_id);
            if (localTodo) {
              const attachmentId = item.data.temp_id || item.data.blob_id;
              const updatedTodo = {
                ...localTodo,
                attachments: (localTodo.attachments || []).filter(attachment => String(attachment.id) !== String(attachmentId)),
                attachments_count: Math.max(0, Number(localTodo.attachments_count ?? localTodo.attachments?.length ?? 0) - 1),
              };
              await dbPutStrict('todos', updatedTodo);
              setTodos(getTodos().map(todo => String(todo.id) === String(updatedTodo.id) ? updatedTodo : todo));
            }
            await attachmentCache.remove(item.data.blob_id || item.data.temp_id);
          }, syncInProgressRef);
          successCount++;
          handledPermanentAbsence = true;
        } else if (['CREATE_COMMENT', 'CREATE_SUBTASK'].includes(item?.action) && err?.status === 404) {
          await commitQueueItem(item, async () => {
            await deleteFromDBStrict('todos', item.data.todo_id);
            setTodos(getTodos().filter(todo => String(todo.id) !== String(item.data.todo_id)));
            await deleteQueuedTodoOperations(item.data.todo_id);
          }, syncInProgressRef);
          needsAuthoritativeRefresh = true;
          handledPermanentAbsence = true;
        } else if (['UPDATE_COMMENT', 'DELETE_COMMENT', 'UPDATE_SUBTASK', 'DELETE_SUBTASK'].includes(item?.action) && err?.status === 404) {
          await deleteFromDBStrict('syncQueue', item.id);
          todoIdsNeedingRecovery.add(item.data.todo_id);
          handledPermanentAbsence = true;
        } else if (
          item?.action === 'CREATE_ATTACHMENT'
          && Number(err?.status) >= 400
          && Number(err?.status) < 500
          && ![401, 408, 429].includes(Number(err?.status))
        ) {
          try {
            await markAttachmentCreateFailedPermanently(currentQueuedItem, err, syncInProgressRef);
          } catch (persistError) {
            console.error('Failed to persist permanent attachment upload error', persistError);
            failCount++;
          }
          handledPermanentAbsence = true;
        } else if (
          ['CREATE_COMMENT', 'UPDATE_COMMENT', 'DELETE_COMMENT', 'CREATE_SUBTASK', 'UPDATE_SUBTASK', 'DELETE_SUBTASK', 'CREATE_ATTACHMENT', 'DELETE_ATTACHMENT'].includes(item?.action)
          && Number(err?.status) >= 400
          && Number(err?.status) < 500
          && ![401, 408, 429].includes(Number(err?.status))
        ) {
          const removeQueueItem = ['CREATE_ATTACHMENT', 'DELETE_ATTACHMENT'].includes(item.action) ? deleteFromDBStrict : deleteFromDB;
          await removeQueueItem('syncQueue', item.id);
          if (item.action === 'CREATE_ATTACHMENT') await attachmentCache.remove(item.data.blob_id || item.data.temp_id);
          todoIdsNeedingRecovery.add(item.data.todo_id);
          handledPermanentAbsence = true;
        } else if (item?.action === 'CREATE_PROJECT' && item.data?._tempId && err?.status && err.status < 500) {
          await deleteFromDB('projects', item.data._tempId);
          setProjects(getProjects().filter(p => p.id !== item.data._tempId));
          await deleteFromDBStrict('syncQueue', item.id);
        }
        if (!handledPermanentAbsence) failCount++;
      }
      }
      }
    } finally {
      syncInProgressRef.value = false;
    }
    if (todoIdsNeedingRecovery.size) {
      try {
        await recoverTodosFromServer(todoIdsNeedingRecovery, syncInProgressRef);
      } catch (err) {
        console.error('Authoritative todo recovery failed', err);
        failCount++;
      }
    }
    if (needsAuthoritativeRefresh && !failCount) {
      await refreshFromServer({ wsState, syncInProgressRef });
    }
    const followUpRequested = syncInProgressRef.requested;
    syncInProgressRef.requested = false;
    if (followUpRequested && isOnlineForSync(wsState)) {
      const followUp = await syncWithServer({ wsState, syncInProgressRef });
      successCount += followUp.successCount || 0;
      failCount += followUp.failCount || 0;
    }
    console.log(`Sync complete: ${successCount} success, ${failCount} failed`);
    return { successCount, failCount, skipped: false };
  }

  async function waitForActiveSync(syncInProgressRef, timeoutMs = 5000) {
    if (!syncInProgressRef?.value) return true;
    const deadline = Date.now() + timeoutMs;
    while (syncInProgressRef.value && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return !syncInProgressRef.value;
  }

  async function refreshFromServer({ wsState, syncInProgressRef }) {
    if (!isOnlineForSync(wsState) || !getDb()) return;

    if (syncInProgressRef.value) {
      const completed = await waitForActiveSync(syncInProgressRef);
      if (!completed) {
        console.warn('Skipping server refresh while local sync is still in progress');
        return;
      }
    }

    const pendingQueue = await dbGetAllStrict('syncQueue');
    const activePendingQueue = pendingQueue.filter(item => !(item.action === 'CREATE_ATTACHMENT' && item.data?.failed_permanent));
    if (activePendingQueue.length) {
      await syncWithServer({ wsState, syncInProgressRef });
      const remainingQueue = await dbGetAllStrict('syncQueue');
      if (remainingQueue.some(item => !(item.action === 'CREATE_ATTACHMENT' && item.data?.failed_permanent))) {
        console.warn('Skipping server refresh while local sync queue still has pending changes');
        return;
      }
    }

    syncInProgressRef.value = true;
    syncInProgressRef.refreshing = true;
    syncInProgressRef.requested = false;
    let releaseCommitLock = null;
    let shouldDrainQueue = false;
    try {
      const [todosData, projectsData, sectionsData, workspacesData] = await Promise.all([
        todosApi.list(), projectsApi.list(), sectionsApi.listAll(), workspacesApi.list(),
      ]);
      const nextTodos = todosData.todos || [];
      const nextProjects = projectsData.projects || [];
      const nextSections = sectionsData.sections || [];
      const nextWorkspaces = workspacesData.workspaces || [];

      releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
      if (dbTransactionStrict) {
        const commit = await dbTransactionStrict(
          ['todos', 'projects', 'sections', 'workspaces', 'syncQueue', 'attachmentBlobs'],
          'readwrite',
          async transaction => {
            const queueBeforeCommit = await transaction.getAll('syncQueue');
            const activeQueueBeforeCommit = queueBeforeCommit.filter(item => !(item.action === 'CREATE_ATTACHMENT' && item.data?.failed_permanent));
            if (activeQueueBeforeCommit.length) return { shouldDrainQueue: true };
            const blobRecords = await transaction.getAll('attachmentBlobs');
            const orphanedPermanentItems = getOrphanedPermanentAttachmentQueueItems(queueBeforeCommit, nextTodos);
            const orphanedPermanentIds = new Set(orphanedPermanentItems.map(item => String(item.id)));
            const queueForProjection = queueBeforeCommit.filter(item => !orphanedPermanentIds.has(String(item.id)));
            for (const orphaned of orphanedPermanentItems) {
              await transaction.delete('syncQueue', orphaned.id);
              await transaction.delete('attachmentBlobs', String(orphaned.data?.blob_id || orphaned.data?.temp_id));
            }
            const projectedTodos = nextTodos.map(todo => projectPendingTodoChanges(todo, queueForProjection)).filter(Boolean);
            for (const storeName of ['todos', 'projects', 'sections', 'workspaces']) await transaction.clear(storeName);
            for (const todo of projectedTodos) await transaction.put('todos', todo);
            for (const project of nextProjects) await transaction.put('projects', project);
            for (const section of nextSections) await transaction.put('sections', section);
            for (const workspace of nextWorkspaces) await transaction.put('workspaces', workspace);
            for (const blobId of getAuthoritativeAttachmentBlobIdsToDelete(blobRecords, projectedTodos, queueForProjection)) {
              await transaction.delete('attachmentBlobs', blobId);
            }
            return { shouldDrainQueue: false, projectedTodos };
          },
        );
        shouldDrainQueue = commit.shouldDrainQueue;
        if (!shouldDrainQueue) {
          setTodos(commit.projectedTodos || nextTodos);
          setProjects(nextProjects);
          setSections(nextSections);
          setWorkspaces(nextWorkspaces);
        }
      } else {
        const queueBeforeCommit = await dbGetAllStrict('syncQueue');
        if (queueBeforeCommit.length) {
          shouldDrainQueue = true;
        } else {
          const localTodosById = new Map(getTodos().map(todo => [String(todo.id), todo]));
          const cleanup = { attachmentIds: [], todoIds: [] };
          for (const incomingTodo of nextTodos) {
            const localTodo = localTodosById.get(String(incomingTodo.id));
            if (!localTodo) continue;
            const incomingAttachmentIds = new Set((incomingTodo.attachments || []).map(attachment => String(attachment.id)));
            cleanup.attachmentIds.push(...(localTodo.attachments || [])
              .filter(attachment => !attachment?.is_pending && !incomingAttachmentIds.has(String(attachment.id)))
              .map(attachment => attachment.id));
          }
          const serverTodoIds = new Set(nextTodos.map(todo => String(todo.id)));
          cleanup.todoIds = getTodos().map(todo => todo.id).filter(todoId => !serverTodoIds.has(String(todoId)));
          if (dbClearStrict) await Promise.all([dbClearStrict('todos'), dbClearStrict('projects'), dbClearStrict('sections'), dbClearStrict('workspaces')]);
          await Promise.all([
            ...nextTodos.map(todo => dbPutStrict('todos', todo)),
            ...nextProjects.map(project => dbPutStrict('projects', project)),
            ...nextSections.map(section => dbPutStrict('sections', section)),
            ...nextWorkspaces.map(workspace => dbPutStrict('workspaces', workspace)),
          ]);
          setTodos(nextTodos);
          setProjects(nextProjects);
          setSections(nextSections);
          setWorkspaces(nextWorkspaces);
          await Promise.all([
            ...cleanup.attachmentIds.map(attachmentId => attachmentCache.remove(attachmentId)),
            ...cleanup.todoIds.map(todoId => attachmentCache.removeForTodo(todoId)),
          ]);
        }
      }
    } finally {
      releaseCommitLock?.();
      syncInProgressRef.refreshing = false;
      syncInProgressRef.value = false;
    }

    if (shouldDrainQueue || syncInProgressRef.requested) {
      syncInProgressRef.requested = false;
      await syncWithServer({ wsState, syncInProgressRef });
    }
  }

  return { isOnlineForSync, syncWithServer, refreshFromServer };
}
