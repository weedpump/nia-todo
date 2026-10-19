import { acquireSyncCommitLock, projectPendingTodoChanges, queueItemReferencesTodo } from './todo-pending.js';
import { attachmentCache as defaultAttachmentCache } from '../storage/attachment-cache.js';

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
    const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
    try {
      const localTodo = await getFromDB('todos', queueItem.data.todo_id);
      if (localTodo) {
        const updatedTodo = {
          ...localTodo,
          attachments: (localTodo.attachments || []).map(attachment => (
            String(attachment.id) === String(attachmentId)
              ? { ...attachment, is_pending: true, failed_permanent: true, sync_error: syncError }
              : attachment
          )),
        };
        await dbPutStrict('todos', updatedTodo);
        setTodos(getTodos().map(todo => String(todo.id) === String(updatedTodo.id) ? updatedTodo : todo));
      }
      await dbPutStrict('syncQueue', {
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
      });
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
    const todoFields = ['title', 'description', 'priority', 'is_pinned', 'status', 'project_id', 'section_id', 'due_date', 'remind_at', 'location_reminder', 'recurring_rule', 'subtasks', 'confirm_incomplete_subtasks_completion', '_tempId'];
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
          let res = await todosApi.create(createData);
          await commitQueueItem(item, async () => {
            let localTempTodo = null;
            if (createData._tempId) {
              localTempTodo = await getFromDB('todos', createData._tempId);
              const localSectionChanged = localTempTodo && localTempTodo.section_id !== createData.section_id;
              if (localSectionChanged) {
                res = await todosApi.update(res.id, { section_id: localTempTodo.section_id });
              }
              const queueForRewrite = await dbGetAllStrict('syncQueue');
              await attachmentCache.rewriteTodoId(createData._tempId, res.id);
              await rewriteQueuedReferences({ todoIdFrom: createData._tempId, todoIdTo: res.id, queue: queueForRewrite });
              await deleteFromDBStrict('todos', createData._tempId);
              setTodos(getTodos().filter(t => t.id !== createData._tempId));
            }
            const createdTodo = localTempTodo ? { ...localTempTodo, ...res, id: res.id } : res;
            await persistTodoWithPending(createdTodo, item.id);
          }, syncInProgressRef);
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
          await commitQueueItem(item, async () => {
            if (response?.attachment?.id) {
              const queueForRewrite = await dbGetAllStrict('syncQueue');
              await rewriteQueuedReferences({
                attachmentIdFrom: item.data.temp_id,
                attachmentIdTo: response.attachment.id,
                queue: queueForRewrite,
              });
              await attachmentCache.rewrite(item.data.blob_id || item.data.temp_id, response.attachment);
            }
            await persistTodoWithPending(response?.todo, item.id);
            applyAttachmentUsage(response?.usage);
          }, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_ATTACHMENT') {
          const response = await todosApi.deleteAttachment(item.data.todo_id, item.data.attachment_id);
          await commitQueueItem(item, async () => {
            await persistTodoWithPending(response?.todo, item.id);
            await attachmentCache.remove(item.data.attachment_id);
            applyAttachmentUsage(response?.usage);
          }, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_TODO') {
          const undoGraceUntil = Number(item.data.undo_grace_until || 0);
          if (undoGraceUntil && Date.now() < undoGraceUntil) {
            continue;
          }
          await todosApi.delete(item.data.id);
          await commitQueueItem(item, async () => {
            await attachmentCache.removeForTodo(item.data.id);
            await deleteFromDBStrict('todos', item.data.id);
            setTodos(getTodos().filter(todo => String(todo.id) !== String(item.data.id)));
            await deleteQueuedTodoOperations(item.data.id);
          }, syncInProgressRef);
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
            await commitQueueItem(item, async () => {
              await attachmentCache.removeForTodo(item.data.id);
              await deleteFromDBStrict('todos', item.data.id);
              setTodos(getTodos().filter(todo => String(todo.id) !== String(item.data.id)));
              await deleteQueuedTodoOperations(item.data.id);
            }, syncInProgressRef);
            successCount++;
          } catch (commitError) {
            console.error('Failed to commit missing todo deletion', commitError);
            failCount++;
          }
          handledPermanentAbsence = true;
        } else if (item?.action === 'DELETE_ATTACHMENT' && err?.status === 404) {
          try {
            const usage = await todosApi.getAttachmentUsage();
            await commitQueueItem(item, async () => {
              await attachmentCache.remove(item.data.attachment_id);
              applyAttachmentUsage(usage);
            }, syncInProgressRef);
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
    if (pendingQueue.length) {
      await syncWithServer({ wsState, syncInProgressRef });
      const remainingQueue = await dbGetAllStrict('syncQueue');
      if (remainingQueue.length) {
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
      const queueBeforeCommit = await dbGetAllStrict('syncQueue');
      if (queueBeforeCommit.length) {
        shouldDrainQueue = true;
      } else {
        const localTodosById = new Map(getTodos().map(todo => [String(todo.id), todo]));
        for (const incomingTodo of nextTodos) {
          const localTodo = localTodosById.get(String(incomingTodo.id));
          if (!localTodo) continue;
          const incomingAttachmentIds = new Set((incomingTodo.attachments || []).map(attachment => String(attachment.id)));
          const removedAttachmentIds = (localTodo.attachments || [])
            .filter(attachment => !attachment?.is_pending && !incomingAttachmentIds.has(String(attachment.id)))
            .map(attachment => attachment.id);
          await Promise.all(removedAttachmentIds.map(attachmentId => attachmentCache.remove(attachmentId)));
        }
        const serverTodoIds = new Set(nextTodos.map(todo => String(todo.id)));
        const removedTodoIds = getTodos().map(todo => todo.id).filter(todoId => !serverTodoIds.has(String(todoId)));
        await Promise.all(removedTodoIds.map(todoId => attachmentCache.removeForTodo(todoId)));
        if (dbClearStrict) {
          await Promise.all([dbClearStrict('todos'), dbClearStrict('projects'), dbClearStrict('sections'), dbClearStrict('workspaces')]);
        }
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
