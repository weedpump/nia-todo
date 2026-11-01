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
}) {
  const commitQueuedMutation = runSyncQueueMutation || (operation => operation(addToSyncQueue));
  let undoAction = null;
  let undoTimer = null;
  let pendingUndoBatch = null;

  function showToast(message, action) {
    const container = document.getElementById('toast-container');
    const msgEl = document.getElementById('toast-message');
    const undoBtn = document.getElementById('toast-undo');
    if (!container || !msgEl) return;
    msgEl.textContent = message;
    undoAction = action || null;
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
    const updatedTodo = await runCurrentEntityMutation(id, {
      getEntities: getTodos,
      commit: commitQueuedMutation,
      mutate: async (current, enqueue) => {
        const updated = { ...current, ...changes, updated_at: new Date().toISOString() };
        await dbPut('todos', updated);
        setTodos(getTodos().map(todo => String(todo.id) === String(id) ? updated : todo));
        await enqueue('UPDATE_TODO', { id: current.id, changes });
        return updated;
      },
    });
    if (!updatedTodo) return;
    renderStats();
    renderTodos();

    if (isOnlineForSync()) await syncWithServer();
  }

  async function restoreBatchTodos() {
    if (!pendingUndoBatch || !getDb()) return;
    const { todos: deletedTodos } = pendingUndoBatch;
    await commitQueuedMutation(async enqueue => {
      let todos = getTodos();
      const accessibleProjects = new Set((getProjects() || []).map(project => String(project.id)));
      for (const todoData of deletedTodos) {
        if (todoData.project_id != null && !accessibleProjects.has(String(todoData.project_id))) continue;
        await dbPut('todos', todoData);
        const existing = todos.find(t => t.id === todoData.id);
        if (!existing) {
          todos = [...todos, todoData];
        } else {
          todos = todos.map(t => t.id === todoData.id ? todoData : t);
        }
        if (isOnlineForSync()) await enqueue('UPDATE_TODO', { id: todoData.id, changes: { status: todoData.status } });
      }
      setTodos(todos);
    });
    renderStats();
    renderTodos();
    pendingUndoBatch = null;
    if (isOnlineForSync()) {
      await syncWithServer();
    }
  }

  async function restoreTodo(id, data) {
    if (!getDb()) return;
    const restored = await commitQueuedMutation(async enqueue => {
      const projectAccessible = data.project_id == null
        || (getProjects() || []).some(project => String(project.id) === String(data.project_id));
      if (!projectAccessible) return false;
      await dbPut('todos', data);
      const todos = getTodos();
      const existing = todos.find(t => t.id === data.id);
      setTodos(existing ? todos.map(t => t.id === data.id ? data : t) : [...todos, data]);
      const canceledPendingDelete = await cancelPendingTodoDelete(id);
      if (isOnlineForSync() && !canceledPendingDelete) await enqueue('CREATE_TODO', { ...data, _tempId: data.id });
      return true;
    });
    if (!restored) return;
    renderStats();
    renderTodos();
    if (isOnlineForSync()) {
      await syncWithServer();
    }
  }

  async function undoDuplicatedTodo(id) {
    if (!getDb()) return;
    const removed = await runCurrentEntityMutation(id, {
      getEntities: getTodos,
      commit: commitQueuedMutation,
      mutate: async (current, enqueue) => {
      await deleteFromDB('todos', current.id);
      setTodos(getTodos().filter(todo => String(todo.id) !== String(current.id)));
      const canceledPendingCreate = await cancelPendingTodoCreate(id);
      if (isOnlineForSync() && !canceledPendingCreate) await enqueue('DELETE_TODO', { id: current.id });
      return true;
      },
    });
    if (!removed) return;
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

  async function cancelPendingTodoDelete(id) {
    if (!dbGetAll || !deleteFromDB) return false;
    const queue = await dbGetAll('syncQueue');
    const pendingDeletes = queue.filter(item => item?.action === 'DELETE_TODO' && String(item?.data?.id) === String(id));
    await Promise.all(pendingDeletes.map(item => deleteFromDB('syncQueue', item.id)));
    return pendingDeletes.length > 0;
  }

  async function cancelPendingTodoCreate(id) {
    if (!dbGetAll || !deleteFromDB) return false;
    const queue = await dbGetAll('syncQueue');
    const pendingEntries = queue.filter(item => queueItemReferencesTodo(item, id));
    const canceledCreate = pendingEntries.some(item => item?.action === 'CREATE_TODO' && String(item?.data?._tempId) === String(id));
    await Promise.all(pendingEntries.map(item => deleteFromDB('syncQueue', item.id)));
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
  };
}
