import { acquireSyncCommitLock, projectPendingTodoChanges, queueItemReferencesTodo } from './todo-pending.js';
import { projectPendingShoppingChanges, projectPendingShoppingStores, projectShoppingSnapshot, projectShoppingStoresSnapshot, queueItemReferencesShoppingList, rewriteShoppingQueueReferences } from './shopping-pending.js';

export function createSyncFeature({
  getDb,
  dbGetAll,
  dbPut,
  dbClear,
  getFromDB,
  deleteFromDB,
  getTodos,
  setTodos,
  getProjects,
  setProjects,
  getSections,
  setSections,
  getWorkspaces,
  setWorkspaces,
  getShoppingLists = () => [],
  setShoppingLists = () => {},
  getShoppingStores = () => [],
  setShoppingStores = () => {},
  todosApi,
  projectsApi,
  sectionsApi,
  workspacesApi,
  shoppingApi = { snapshot: async () => ({ shopping_lists: [] }) },
  commitShoppingReplay = async () => {},
  renderStats,
  renderTodos,
  renderShopping = () => {},
}) {
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

  function replaceShoppingList(list, removeIds = []) {
    const removed = new Set(removeIds.map(String));
    let next = getShoppingLists().filter(item => !removed.has(String(item.id)));
    if (list) {
      const exists = next.some(item => String(item.id) === String(list.id));
      next = exists
        ? next.map(item => String(item.id) === String(list.id) ? list : item)
        : [...next, list];
    }
    setShoppingLists(next);
    renderShopping();
  }

  function replaceShoppingStores(stores) {
    setShoppingStores(stores);
    renderShopping();
  }

  async function commitShoppingStoreState(item, serverStore, {
    removeStoreIds = [],
    rewrite = {},
  } = {}, syncInProgressRef) {
    const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
    try {
      const currentQueue = (await dbGetAll('syncQueue')).filter(entry => String(entry.id) !== String(item.id));
      const rewrittenQueue = rewriteShoppingQueueReferences(currentQueue, rewrite);
      const removed = new Set(removeStoreIds.map(String));
      let authoritative = getShoppingStores().filter(store => !removed.has(String(store.id)));
      if (serverStore) {
        const exists = authoritative.some(store => String(store.id) === String(serverStore.id));
        authoritative = exists
          ? authoritative.map(store => String(store.id) === String(serverStore.id) ? serverStore : store)
          : [...authoritative, serverStore];
      }
      const projectedStores = projectPendingShoppingStores(authoritative, rewrittenQueue);
      const projectedStore = serverStore
        ? projectedStores.find(store => String(store.id) === String(serverStore.id)) || serverStore
        : null;
      await commitShoppingReplay({
        store: projectedStore,
        removeStoreIds,
        queueDeleteId: item.id,
        queueRecords: rewrittenQueue,
      });
      replaceShoppingStores(projectedStores);
    } finally {
      releaseCommitLock();
    }
  }

  async function commitShoppingServerState(item, serverList, {
    removeListIds = [],
    rewrite = {},
  } = {}, syncInProgressRef) {
    const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
    try {
      const currentQueue = (await dbGetAll('syncQueue')).filter(entry => String(entry.id) !== String(item.id));
      const rewrittenQueue = rewriteShoppingQueueReferences(currentQueue, rewrite);
      const projected = projectPendingShoppingChanges(serverList, rewrittenQueue);
      const idsToRemove = [...removeListIds];
      if (!projected && serverList?.id != null) idsToRemove.push(serverList.id);
      await commitShoppingReplay({
        list: projected,
        removeListIds: idsToRemove,
        queueDeleteId: item.id,
        queueRecords: rewrittenQueue,
      });
      replaceShoppingList(projected, idsToRemove);
    } finally {
      releaseCommitLock();
    }
  }

  async function persistTodoWithPending(todo, processedQueueId) {
    if (!todo?.id) return;
    const queue = (await dbGetAll('syncQueue')).filter(item => String(item.id) !== String(processedQueueId));
    const projected = projectPendingTodoChanges(todo, queue);
    if (!projected) {
      await deleteFromDB('todos', todo.id);
      setTodos(getTodos().filter(item => String(item.id) !== String(todo.id)));
      return;
    }
    await dbPut('todos', projected);
    upsertTodo(projected);
  }

  async function rewriteQueuedReferences({ todoIdFrom, todoIdTo, commentIdFrom, commentIdTo, subtaskIdFrom, subtaskIdTo }) {
    const queue = await dbGetAll('syncQueue');
    for (const queued of queue) {
      if (!queued?.data || typeof queued.data !== 'object') continue;
      let changed = false;
      if (todoIdFrom !== undefined) {
        if (['CREATE_COMMENT', 'UPDATE_COMMENT', 'DELETE_COMMENT', 'CREATE_SUBTASK', 'UPDATE_SUBTASK', 'DELETE_SUBTASK'].includes(queued.action)
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
      if (changed) await dbPut('syncQueue', queued);
    }
  }

  async function commitQueueItem(item, applyResult, syncInProgressRef) {
    const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
    try {
      await applyResult();
      await deleteFromDB('syncQueue', item.id);
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
      const queue = await dbGetAll('syncQueue');
      for (const todoId of todoIds) {
        const serverTodo = serverTodos.get(String(todoId));
        if (!serverTodo) {
          await deleteFromDB('todos', todoId);
          setTodos(getTodos().filter(todo => String(todo.id) !== String(todoId)));
          await deleteQueuedTodoOperations(todoId);
          continue;
        }
        const projected = projectPendingTodoChanges(serverTodo, queue);
        if (projected) {
          await dbPut('todos', projected);
          const exists = getTodos().some(todo => String(todo.id) === String(todoId));
          setTodos(exists
            ? getTodos().map(todo => String(todo.id) === String(todoId) ? projected : todo)
            : [...getTodos(), projected]);
        } else {
          await deleteFromDB('todos', todoId);
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
    const queue = await dbGetAll('syncQueue');
    const matching = queue.filter(item => queueItemReferencesTodo(item, todoId));
    await Promise.all(matching.map(item => deleteFromDB('syncQueue', item.id)));
  }

  function sanitizeQueueItem(item) {
    if (!item || typeof item !== 'object' || typeof item.action !== 'string') return null;
    const data = item.data && typeof item.data === 'object' ? item.data : {};
    const changes = data.changes && typeof data.changes === 'object' ? data.changes : {};
    const todoFields = ['title', 'description', 'priority', 'is_pinned', 'status', 'project_id', 'section_id', 'due_date', 'remind_at', 'location_reminder', 'recurring_rule', 'subtasks', 'confirm_incomplete_subtasks_completion', '_tempId'];
    const projectFields = ['name', 'color', 'icon', 'sort_order', 'parent_id', 'workspace_id', 'household_id', '_tempId'];
    const sectionFields = ['name', 'sort_order', 'project_id', '_tempId'];
    const shoppingListFields = ['name', 'color', 'icon', 'sort_order', 'household_id', 'client_mutation_id'];
    const shoppingStoreFields = ['name', 'household_id', 'sort_order', 'client_mutation_id'];
    const shoppingSectionFields = ['name', 'sort_order', 'client_mutation_id'];
    const shoppingItemFields = ['name', 'section_id', 'quantity_value', 'quantity_unit', 'store_ids', 'sort_order', 'client_mutation_id'];
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
      case 'CREATE_SHOPPING_LIST':
        return { ...item, data: { ...pickAllowed(data, shoppingListFields), temp_id: data.temp_id, list: data.list } };
      case 'UPDATE_SHOPPING_LIST':
        return { ...item, data: { id: data.id, changes: pickAllowed(changes, ['name', 'color', 'icon', 'sort_order']) } };
      case 'DELETE_SHOPPING_LIST':
        return { ...item, data: { id: data.id } };
      case 'CREATE_SHOPPING_STORE':
        return { ...item, data: { ...pickAllowed(data, shoppingStoreFields), temp_id: data.temp_id, store: data.store } };
      case 'UPDATE_SHOPPING_STORE':
        return { ...item, data: { store_id: data.store_id, changes: pickAllowed(changes, ['name', 'sort_order', 'active']) } };
      case 'DELETE_SHOPPING_STORE':
        return { ...item, data: { store_id: data.store_id } };
      case 'CREATE_SHOPPING_SECTION':
        return { ...item, data: { shopping_list_id: data.shopping_list_id, temp_id: data.temp_id, section: pickAllowed(data.section, shoppingSectionFields), client_mutation_id: data.client_mutation_id } };
      case 'UPDATE_SHOPPING_SECTION':
        return { ...item, data: { shopping_list_id: data.shopping_list_id, section_id: data.section_id, changes: pickAllowed(changes, ['name', 'sort_order']) } };
      case 'DELETE_SHOPPING_SECTION':
        return { ...item, data: { shopping_list_id: data.shopping_list_id, section_id: data.section_id } };
      case 'CREATE_SHOPPING_ITEM':
        return { ...item, data: { shopping_list_id: data.shopping_list_id, temp_id: data.temp_id, item: pickAllowed(data.item, shoppingItemFields), client_mutation_id: data.client_mutation_id } };
      case 'UPDATE_SHOPPING_ITEM':
        return { ...item, data: { shopping_list_id: data.shopping_list_id, item_id: data.item_id, changes: pickAllowed(changes, shoppingItemFields.filter(field => field !== 'client_mutation_id').concat('completed')) } };
      case 'DELETE_SHOPPING_ITEM':
        return { ...item, data: { shopping_list_id: data.shopping_list_id, item_id: data.item_id } };
      case 'DELETE_COMPLETED_SHOPPING_ITEMS':
        return { ...item, data: { shopping_list_id: data.shopping_list_id } };
      case 'UPDATE_SHOPPING_PREFERENCES':
        return { ...item, data: { shopping_list_id: data.shopping_list_id, changes: pickAllowed(changes, ['selected_store_id', 'hide_empty_sections']) } };
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
    try {
      while (true) {
      syncInProgressRef.requested = false;
      const queue = (await dbGetAll('syncQueue')).filter(item => !attemptedQueueIds.has(String(item.id)));
      if (!queue.length) break;

      for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const queuedItem = queue[queueIndex];
      attemptedQueueIds.add(String(queuedItem.id));
      const currentQueuedItem = (await dbGetAll('syncQueue')).find(item => String(item.id) === String(queuedItem.id));
      if (!currentQueuedItem) continue;
      const item = sanitizeQueueItem(currentQueuedItem);
      try {
        if (!item) {
          await deleteFromDB('syncQueue', queuedItem.id);
          continue;
        }
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
              await deleteFromDB('todos', createData._tempId);
              setTodos(getTodos().filter(t => t.id !== createData._tempId));
              await rewriteQueuedReferences({ todoIdFrom: createData._tempId, todoIdTo: res.id });
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
        } else if (item.action === 'DELETE_TODO') {
          const undoGraceUntil = Number(item.data.undo_grace_until || 0);
          if (undoGraceUntil && Date.now() < undoGraceUntil) {
            continue;
          }
          await todosApi.delete(item.data.id);
          await commitQueueItem(item, async () => {
            await deleteFromDB('todos', item.data.id);
            setTodos(getTodos().filter(todo => String(todo.id) !== String(item.data.id)));
            await deleteQueuedTodoOperations(item.data.id);
          }, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'CREATE_SHOPPING_STORE') {
          const created = await shoppingApi.createStore(pickAllowed(item.data, ['name', 'household_id', 'sort_order', 'client_mutation_id']));
          await commitShoppingStoreState(item, created, {
            removeStoreIds: [item.data.temp_id],
            rewrite: { storeIdFrom: item.data.temp_id, storeIdTo: created.id },
          }, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'UPDATE_SHOPPING_STORE') {
          const updated = await shoppingApi.updateStore(item.data.store_id, item.data.changes);
          await commitShoppingStoreState(item, updated, {}, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_SHOPPING_STORE') {
          const updated = await shoppingApi.deleteStore(item.data.store_id);
          await commitShoppingStoreState(item, updated, {}, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'CREATE_SHOPPING_LIST') {
          const created = await shoppingApi.createList(pickAllowed(item.data, ['name', 'color', 'icon', 'sort_order', 'household_id', 'client_mutation_id']));
          const serverList = await shoppingApi.getList(created.id);
          await commitShoppingServerState(item, serverList, {
            removeListIds: [item.data.temp_id],
            rewrite: { listIdFrom: item.data.temp_id, listIdTo: created.id },
          }, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'UPDATE_SHOPPING_LIST') {
          await shoppingApi.updateList(item.data.id, item.data.changes);
          const serverList = await shoppingApi.getList(item.data.id);
          await commitShoppingServerState(item, serverList, {}, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_SHOPPING_LIST') {
          await shoppingApi.deleteList(item.data.id);
          await commitShoppingServerState(item, null, { removeListIds: [item.data.id] }, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'CREATE_SHOPPING_SECTION') {
          const created = await shoppingApi.createSection(item.data.shopping_list_id, {
            ...item.data.section,
            client_mutation_id: item.data.client_mutation_id,
          });
          const serverList = await shoppingApi.getList(item.data.shopping_list_id);
          await commitShoppingServerState(item, serverList, {
            rewrite: { sectionIdFrom: item.data.temp_id, sectionIdTo: created.id },
          }, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'CREATE_SHOPPING_ITEM') {
          const created = await shoppingApi.createItem(item.data.shopping_list_id, {
            ...item.data.item,
            client_mutation_id: item.data.client_mutation_id,
          });
          const serverList = await shoppingApi.getList(item.data.shopping_list_id);
          await commitShoppingServerState(item, serverList, {
            rewrite: { itemIdFrom: item.data.temp_id, itemIdTo: created.id },
          }, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'UPDATE_SHOPPING_SECTION') {
          await shoppingApi.updateSection(item.data.section_id, item.data.changes);
          const serverList = await shoppingApi.getList(item.data.shopping_list_id);
          await commitShoppingServerState(item, serverList, {}, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_SHOPPING_SECTION') {
          await shoppingApi.deleteSection(item.data.section_id);
          const serverList = await shoppingApi.getList(item.data.shopping_list_id);
          await commitShoppingServerState(item, serverList, {}, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'UPDATE_SHOPPING_ITEM') {
          await shoppingApi.updateItem(item.data.item_id, item.data.changes);
          const serverList = await shoppingApi.getList(item.data.shopping_list_id);
          await commitShoppingServerState(item, serverList, {}, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_SHOPPING_ITEM') {
          await shoppingApi.deleteItem(item.data.item_id);
          const serverList = await shoppingApi.getList(item.data.shopping_list_id);
          await commitShoppingServerState(item, serverList, {}, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_COMPLETED_SHOPPING_ITEMS') {
          await shoppingApi.deleteCompletedItems(item.data.shopping_list_id);
          const serverList = await shoppingApi.getList(item.data.shopping_list_id);
          await commitShoppingServerState(item, serverList, {}, syncInProgressRef);
          successCount++;
          continue;
        } else if (item.action === 'UPDATE_SHOPPING_PREFERENCES') {
          await shoppingApi.updatePreferences(item.data.shopping_list_id, item.data.changes);
          const serverList = await shoppingApi.getList(item.data.shopping_list_id);
          await commitShoppingServerState(item, serverList, {}, syncInProgressRef);
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
        await deleteFromDB('syncQueue', item.id);
      } catch (err) {
        console.error('Sync failed for action', item?.action || 'INVALID_QUEUE_ITEM', err);
        let handledPermanentAbsence = false;
        if (item?.action === 'DELETE_TODO' && err?.status === 404) {
          await commitQueueItem(item, async () => {
            await deleteFromDB('todos', item.data.id);
            setTodos(getTodos().filter(todo => String(todo.id) !== String(item.data.id)));
            await deleteQueuedTodoOperations(item.data.id);
          }, syncInProgressRef);
          successCount++;
          handledPermanentAbsence = true;
        } else if (['CREATE_COMMENT', 'CREATE_SUBTASK'].includes(item?.action) && err?.status === 404) {
          await commitQueueItem(item, async () => {
            await deleteFromDB('todos', item.data.todo_id);
            setTodos(getTodos().filter(todo => String(todo.id) !== String(item.data.todo_id)));
            await deleteQueuedTodoOperations(item.data.todo_id);
          }, syncInProgressRef);
          needsAuthoritativeRefresh = true;
          handledPermanentAbsence = true;
        } else if (['UPDATE_COMMENT', 'DELETE_COMMENT', 'UPDATE_SUBTASK', 'DELETE_SUBTASK'].includes(item?.action) && err?.status === 404) {
          await deleteFromDB('syncQueue', item.id);
          todoIdsNeedingRecovery.add(item.data.todo_id);
          handledPermanentAbsence = true;
        } else if (
          ['CREATE_COMMENT', 'UPDATE_COMMENT', 'DELETE_COMMENT', 'CREATE_SUBTASK', 'UPDATE_SUBTASK', 'DELETE_SUBTASK'].includes(item?.action)
          && Number(err?.status) >= 400
          && Number(err?.status) < 500
          && ![401, 408, 429].includes(Number(err?.status))
        ) {
          await deleteFromDB('syncQueue', item.id);
          todoIdsNeedingRecovery.add(item.data.todo_id);
          handledPermanentAbsence = true;
        } else if (
          ['CREATE_SHOPPING_STORE', 'UPDATE_SHOPPING_STORE', 'DELETE_SHOPPING_STORE'].includes(item?.action)
          && Number(err?.status) >= 400
          && Number(err?.status) < 500
          && ![401, 408, 429].includes(Number(err?.status))
        ) {
          try {
            const response = await shoppingApi.listStores();
            const authoritativeStores = response?.shopping_stores || [];
            const localId = item.data.store_id ?? item.data.temp_id;
            const serverStore = authoritativeStores.find(store =>
              String(store.id) === String(localId)
              || (item.data.client_mutation_id && store.client_mutation_id === item.data.client_mutation_id)
            ) || null;
            await commitShoppingStoreState(item, serverStore, {
              removeStoreIds: serverStore ? [] : [localId],
            }, syncInProgressRef);
            successCount++;
            handledPermanentAbsence = true;
          } catch (recoveryError) {
            console.error('Authoritative shopping-store recovery failed', recoveryError);
            failCount++;
            handledPermanentAbsence = true;
          }
        } else if (
          String(item?.action || '').includes('SHOPPING')
          && Number(err?.status) >= 400
          && Number(err?.status) < 500
          && ![401, 408, 429].includes(Number(err?.status))
        ) {
          const shoppingListId = item.data.shopping_list_id ?? item.data.id ?? item.data.temp_id;
          if (item.action !== 'CREATE_SHOPPING_LIST') {
            try {
              const serverList = await shoppingApi.getList(shoppingListId);
              await commitShoppingServerState(item, serverList, {}, syncInProgressRef);
              successCount++;
              handledPermanentAbsence = true;
            } catch (recoveryError) {
              if (![403, 404].includes(Number(recoveryError?.status))) {
                console.error('Authoritative shopping-list recovery failed', recoveryError);
                failCount++;
                handledPermanentAbsence = true;
              }
            }
          }
          if (!handledPermanentAbsence) {
            const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
            try {
              const currentQueue = await dbGetAll('syncQueue');
              const related = currentQueue.filter(entry => queueItemReferencesShoppingList(entry, shoppingListId));
              await commitShoppingReplay({
                removeListIds: [shoppingListId],
                queueDeleteIds: related.map(entry => entry.id),
              });
              replaceShoppingList(null, [shoppingListId]);
            } finally {
              releaseCommitLock();
            }
            successCount++;
            handledPermanentAbsence = true;
          }
        } else if (item?.action === 'CREATE_PROJECT' && item.data?._tempId && err?.status && err.status < 500) {
          await deleteFromDB('projects', item.data._tempId);
          setProjects(getProjects().filter(p => p.id !== item.data._tempId));
          await deleteFromDB('syncQueue', item.id);
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

    const pendingQueue = await dbGetAll('syncQueue');
    if (pendingQueue.length) {
      await syncWithServer({ wsState, syncInProgressRef });
      const remainingQueue = await dbGetAll('syncQueue');
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
      const [todosData, projectsData, sectionsData, workspacesData, shoppingData] = await Promise.all([
        todosApi.list(), projectsApi.list(), sectionsApi.listAll(), workspacesApi.list(), shoppingApi.snapshot(),
      ]);
      const nextTodos = todosData.todos || [];
      const nextProjects = projectsData.projects || [];
      const nextSections = sectionsData.sections || [];
      const nextWorkspaces = workspacesData.workspaces || [];
      const nextShoppingLists = shoppingData.shopping_lists || [];
      const nextShoppingStores = projectShoppingStoresSnapshot(
        shoppingData.shopping_stores || [],
        getShoppingStores(),
        [],
      );

      releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
      const queueBeforeCommit = await dbGetAll('syncQueue');
      if (queueBeforeCommit.length) {
        shouldDrainQueue = true;
      } else {
        if (dbClear) {
          await Promise.all([dbClear('todos'), dbClear('projects'), dbClear('sections'), dbClear('workspaces'), dbClear('shoppingLists'), dbClear('shoppingStores')]);
        }
        await Promise.all([
          ...nextTodos.map(todo => dbPut('todos', todo)),
          ...nextProjects.map(project => dbPut('projects', project)),
          ...nextSections.map(section => dbPut('sections', section)),
          ...nextWorkspaces.map(workspace => dbPut('workspaces', workspace)),
          ...nextShoppingLists.map(list => dbPut('shoppingLists', list)),
          ...nextShoppingStores.map(store => dbPut('shoppingStores', store)),
        ]);

        setTodos(nextTodos);
        setProjects(nextProjects);
        setSections(nextSections);
        setWorkspaces(nextWorkspaces);
        setShoppingLists(nextShoppingLists);
        setShoppingStores(nextShoppingStores);
        renderShopping();
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
