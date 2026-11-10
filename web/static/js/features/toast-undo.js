import { queueItemReferencesTodo, runCurrentEntityMutation } from './todo-pending.js';

export function createToastUndoFeature({
  getDb,
  getTodos,
  getProjects = () => [],
  setTodos,
  dbPut,
  dbGetAll,
  deleteFromDB,
  addToSyncQueue,
  runSyncQueueMutation,
  isOnlineForSync,
  syncWithServer,
  renderStats,
  renderTodos,
  toggleTodo,
  onUndoLeaveProject,
  onUndoRemoveMember,
  onUndoInvite,
  getSessionIdentity = () => null,
}) {
  const commitQueuedMutation = runSyncQueueMutation || (operation => operation(addToSyncQueue));
  let undoAction = null;
  let undoTimer = null;
  let pendingUndoBatch = null;
  let undoSession = null;
  const activeTargets = new Set();

  function remapTodoId(from, to) {
    const remap = target => {
      if (String(target?.id) === String(from)) target.id = to;
      if (String(target?.data?.id) === String(from)) target.data.id = to;
    };
    remap(undoAction);
    for (const target of activeTargets) remap(target);
    for (const todo of pendingUndoBatch?.todos || []) remap(todo);
  }

  function showToast(message, action) {
    const container = document.getElementById('toast-container');
    const msgEl = document.getElementById('toast-message');
    const undoBtn = document.getElementById('toast-undo');
    if (!container || !msgEl) return;
    msgEl.textContent = message;
    undoAction = action || null;
    undoSession = getSessionIdentity();
    if (undoBtn) undoBtn.style.display = action ? '' : 'none';
    container.style.display = 'flex';
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(hideToast, 5000);
  }

  function showBatchToast(message, batchData) {
    const container = document.getElementById('toast-container');
    const msgEl = document.getElementById('toast-message');
    const undoBtn = document.getElementById('toast-undo');
    if (!container || !msgEl) return;
    msgEl.textContent = message;
    pendingUndoBatch = batchData;
    undoAction = { type: 'batch_delete' };
    undoSession = getSessionIdentity();
    if (undoBtn) undoBtn.style.display = '';
    container.style.display = 'flex';
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(() => {
      pendingUndoBatch = null;
      hideToast();
    }, 5000);
  }

  function hideToast() {
    const container = document.getElementById('toast-container');
    if (container) container.style.display = 'none';
    undoAction = null;
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
  }

  function undoLastAction() {
    if (!undoAction) return;
    if (undoSession !== getSessionIdentity()) { hideToast(); return; }
    if (undoAction.type === 'status') {
      if (undoAction.previousStatus) restoreTodoStatus(undoAction.id, undoAction.previousStatus);
      else toggleTodo(undoAction.id);
    } else if (undoAction.type === 'delete') {
      restoreTodo(undoAction.id, undoAction.data);
    } else if (undoAction.type === 'duplicate') {
      undoDuplicatedTodo(undoAction.id);
    } else if (undoAction.type === 'fields') {
      restoreTodoFields(undoAction.id, undoAction.changes);
    } else if (undoAction.type === 'batch_delete' && pendingUndoBatch) {
      restoreBatchTodos();
    } else if (undoAction.type === 'member_invite' && onUndoInvite) {
      onUndoInvite(undoAction.data);
    } else if (undoAction.type === 'project_leave' && onUndoLeaveProject) {
      onUndoLeaveProject(undoAction.data);
    } else if (undoAction.type === 'member_remove' && onUndoRemoveMember) {
      onUndoRemoveMember(undoAction.data);
    }
    hideToast();
  }

  async function restoreTodoStatus(id, status) {
    await restoreTodoFields(id, { status });
  }

  async function restoreTodoFields(id, changes) {
    if (!getDb()) return;
    const target = { id }, session = getSessionIdentity();
    activeTargets.add(target);
    let updatedTodo;
    try {
      updatedTodo = await runCurrentEntityMutation(() => target.id, {
        getEntities: getTodos,
        commit: commitQueuedMutation,
        mutate: async (current, enqueue) => {
          if (session !== getSessionIdentity()) return null;
          const updated = { ...current, ...changes, updated_at: new Date().toISOString() };
          await dbPut('todos', updated);
          if (session !== getSessionIdentity()) return null;
          await enqueue('UPDATE_TODO', { id: current.id, changes });
          if (session !== getSessionIdentity()) return null;
          setTodos(getTodos().map(todo => String(todo.id) === String(current.id) ? updated : todo));
          return updated;
        },
      });
    } finally { activeTargets.delete(target); }
    if (!updatedTodo || session !== getSessionIdentity()) return;
    renderStats();
    renderTodos();

    if (isOnlineForSync()) await syncWithServer();
  }

  async function restoreBatchTodos() {
    if (!pendingUndoBatch || !getDb()) return;
    const session = getSessionIdentity();
    const { todos: deletedTodos } = pendingUndoBatch;
    await commitQueuedMutation(async enqueue => {
      if (session !== getSessionIdentity()) return;
      let todos = getTodos();
      const accessibleProjects = new Set((getProjects() || []).map(project => String(project.id)));
      for (const todoData of deletedTodos) {
        if (todoData.project_id != null && !accessibleProjects.has(String(todoData.project_id))) continue;
        await dbPut('todos', todoData);
        if (session !== getSessionIdentity()) return;
        const existing = todos.find(t => t.id === todoData.id);
        if (!existing) {
          todos = [...todos, todoData];
        } else {
          todos = todos.map(t => t.id === todoData.id ? todoData : t);
        }
        if (isOnlineForSync()) await enqueue('UPDATE_TODO', { id: todoData.id, changes: { status: todoData.status } });
        if (session !== getSessionIdentity()) return;
      }
      setTodos(todos);
    });
    if (session !== getSessionIdentity()) return;
    renderStats();
    renderTodos();
    pendingUndoBatch = null;
    if (isOnlineForSync()) {
      await syncWithServer();
    }
  }

  async function restoreTodo(id, data) {
    if (!getDb()) return;
    const target = { id, data }, session = getSessionIdentity();
    activeTargets.add(target);
    let restored;
    try {
      restored = await commitQueuedMutation(async enqueue => {
        if (session !== getSessionIdentity()) return false;
        const queue = await dbGetAll('syncQueue');
        if (session !== getSessionIdentity()) return false;
        const deletion = queue.find(item => item?.action === 'DELETE_TODO'
          && (String(item?.data?.id) === String(target.id) || String(item?.data?.original_todo_id) === String(target.id)));
        // The durable delete snapshot may have been remapped before its UI
        // callback, while this Undo was already waiting for the commit lock.
        const originalData = deletion?.data?.local_todo || target.data;
        const pendingCreate = queue.some(item => item.action === 'CREATE_TODO'
          && String(item.data?._tempId) === String(originalData.id));
        const recreate = deletion ? deletion.data.delete_attempted === true : !pendingCreate;
        const existingRestore = queue.find(item => item.action === 'CREATE_TODO'
          && String(item.data?.restore_after_delete_id) === String(originalData.id));
        const temporaryId = existingRestore?.data._tempId
          || `temp-undo-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
        // A dispatched/completed hard-delete cannot be canceled. Restore its
        // editable content as a new task, without phantom deleted attachments.
        const restoredData = recreate ? { ...originalData, id: temporaryId,
          comments: [], comments_count: 0, attachments: [], attachments_count: 0 } : originalData;
        const restoredId = restoredData.id;
        const projectAccessible = restoredData.project_id == null
          || (getProjects() || []).some(project => String(project.id) === String(restoredData.project_id));
        if (!projectAccessible) return false;
        await dbPut('todos', restoredData);
        if (session !== getSessionIdentity()) return false;
        if (recreate) {
          if (!existingRestore) await enqueue('CREATE_TODO', { ...restoredData, _tempId: restoredId,
            restore_after_delete_id: originalData.id });
        } else {
          await cancelPendingTodoDelete(restoredId, () => session === getSessionIdentity());
        }
        if (session !== getSessionIdentity()) return false;
        const todos = getTodos();
        const existing = todos.find(t => String(t.id) === String(restoredId));
        setTodos(existing ? todos.map(t => String(t.id) === String(restoredId) ? restoredData : t) : [...todos, restoredData]);
        return true;
      });
    } finally { activeTargets.delete(target); }
    if (!restored || session !== getSessionIdentity()) return;
    renderStats();
    renderTodos();
    if (isOnlineForSync()) {
      await syncWithServer();
    }
  }

  async function undoDuplicatedTodo(id) {
    if (!getDb()) return;
    const target = { id }, session = getSessionIdentity();
    activeTargets.add(target);
    let removed;
    try {
      removed = await runCurrentEntityMutation(() => target.id, {
        getEntities: getTodos,
        commit: commitQueuedMutation,
        mutate: async (current, enqueue) => {
          if (session !== getSessionIdentity()) return false;
          await deleteFromDB('todos', current.id);
          if (session !== getSessionIdentity()) return false;
          const canceledPendingCreate = await cancelPendingTodoCreate(current.id, () => session === getSessionIdentity());
          if (session !== getSessionIdentity()) return false;
          if (!canceledPendingCreate) await enqueue('DELETE_TODO', { id: current.id,
            project_id: current.project_id ?? null, local_todo: { ...current } });
          if (session !== getSessionIdentity()) return false;
          setTodos(getTodos().filter(todo => String(todo.id) !== String(current.id)));
          return true;
        },
      });
    } finally { activeTargets.delete(target); }
    if (!removed || session !== getSessionIdentity()) return;
    renderStats();
    renderTodos();
    if (isOnlineForSync()) {
      await syncWithServer();
    }
  }

  let toastControlsBound = false;
  function bindToastControls() {
    if (toastControlsBound) return;
    toastControlsBound = true;
    document.getElementById('toast-undo')?.addEventListener('click', undoLastAction);
    document.getElementById('toast-close')?.addEventListener('click', hideToast);
  }

  async function cancelPendingTodoDelete(id, isCurrent = () => true) {
    if (!dbGetAll || !deleteFromDB) return false;
    const queue = await dbGetAll('syncQueue');
    if (!isCurrent()) return false;
    const pendingDeletes = queue.filter(item => item?.action === 'DELETE_TODO' && String(item?.data?.id) === String(id));
    if (pendingDeletes.some(item => item.data?.delete_attempted)) return false;
    for (const item of pendingDeletes) {
      if (!isCurrent()) return false;
      await deleteFromDB('syncQueue', item.id);
    }
    return pendingDeletes.length > 0;
  }

  async function cancelPendingTodoCreate(id, isCurrent = () => true) {
    if (!dbGetAll || !deleteFromDB) return false;
    const queue = await dbGetAll('syncQueue');
    if (!isCurrent()) return false;
    const pendingEntries = queue.filter(item => queueItemReferencesTodo(item, id));
    if (pendingEntries.some(item => item.action === 'CREATE_TODO' && (item.data?.create_attempted || item.data?.create_receipt))) return false;
    const canceledCreate = pendingEntries.some(item => item?.action === 'CREATE_TODO' && String(item?.data?._tempId) === String(id));
    for (const item of pendingEntries) {
      if (!isCurrent()) return false;
      await deleteFromDB('syncQueue', item.id);
    }
    return canceledCreate;
  }

  return {
    showToast,
    showBatchToast,
    hideToast,
    undoLastAction,
    bindToastControls,
    restoreBatchTodos,
    restoreTodo,
    restoreTodoFields,
    remapTodoId,
  };
}
