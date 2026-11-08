import { acquireSyncCommitLock, projectPendingProjectChanges, projectPendingSectionChanges, projectPendingTodoChanges, queueItemReferencesTodo } from './todo-pending.js';
import { projectPendingShoppingChanges, projectPendingShoppingStores, projectShoppingSnapshot, projectShoppingStoresSnapshot, queueItemReferencesShoppingList, rewriteShoppingQueueReferences } from './shopping-pending.js';
import { cookbookMetadata } from './cookbooks.js';
import { createMetadataSyncAdapter } from './entity-metadata-sync.js';

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
  onProjectIdRemap = () => {},
  onSectionIdRemap = () => {},
  evictPendingProjectEntities = null,
  commitTaskParentReplay = null,
  getCookbooks = () => [],
  setCookbooks = () => {},
  recipesApi = null,
  commitCookbookReplay = null,
  markCookbookMutationAttempt = null,
  onCookbookIdRemap = () => {},
  renderCookbooks = () => {},
  getActorId = () => null,
  onCookbookSnapshotCommitted = () => {},
}) {
  const cookbookSync = createMetadataSyncAdapter({ contract: cookbookMetadata,
    api: recipesApi ? { create: recipesApi.createCookbook, update: recipesApi.updateCookbook, remove: recipesApi.deleteCookbook, read: recipesApi.getCookbook } : null,
    getEntities: getCookbooks, setEntities: setCookbooks, readQueue: () => dbGetAll('syncQueue'),
    markAttempt: markCookbookMutationAttempt, commitReplay: commitCookbookReplay,
    onIdRemap: onCookbookIdRemap, render: renderCookbooks,
  });
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

  function sameId(left, right) {
    return left !== undefined && left !== null && right !== undefined && right !== null && String(left) === String(right);
  }

  function shoppingQueueListIdentity(item) {
    if (!String(item?.action || '').includes('SHOPPING')) return null;
    const data = item.data || {};
    const listId = ['CREATE_SHOPPING_LIST', 'UPDATE_SHOPPING_LIST', 'DELETE_SHOPPING_LIST'].includes(item.action)
      ? data.id ?? data.temp_id
      : data.shopping_list_id ?? data.store?.shopping_list_id
        ?? getShoppingStores().find(store => sameId(store.id, data.store_id ?? data.temp_id))?.shopping_list_id;
    if (listId == null) return null;
    const list = getShoppingLists().find(candidate => sameId(candidate.id, listId) || sameId(candidate.client_mutation_id, listId));
    return String(list?.client_mutation_id ?? list?.id ?? listId);
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
  } = {}, syncInProgressRef, privacyGeneration = Number(syncInProgressRef?.privacyGeneration || 0)) {
    const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
    try {
      if (Number(syncInProgressRef?.privacyGeneration || 0) !== privacyGeneration) return false;
      const queue = await dbGetAll('syncQueue');
      if (!queue.some(entry => String(entry.id) === String(item.id))) return false;
      const currentQueue = queue.filter(entry => String(entry.id) !== String(item.id));
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
        ? projectedStores.find(store => String(store.id) === String(serverStore.id)) || null
        : null;
      const projectedRemoveStoreIds = serverStore && !projectedStore
        ? [...new Set([...removeStoreIds, serverStore.id].map(String))]
        : removeStoreIds;
      await commitShoppingReplay({
        store: projectedStore,
        removeStoreIds: projectedRemoveStoreIds,
        queueDeleteId: item.id,
        queueRecords: rewrittenQueue,
      });
      replaceShoppingStores(projectedStores);
      return true;
    } finally {
      releaseCommitLock();
    }
  }

  async function commitShoppingServerState(item, serverList, {
    removeListIds = [],
    rewrite = {},
  } = {}, syncInProgressRef, privacyGeneration = Number(syncInProgressRef?.privacyGeneration || 0)) {
    const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
    try {
      if (Number(syncInProgressRef?.privacyGeneration || 0) !== privacyGeneration) return false;
      const queue = await dbGetAll('syncQueue');
      if (!queue.some(entry => String(entry.id) === String(item.id))) return false;
      const currentQueue = queue.filter(entry => String(entry.id) !== String(item.id));
      const rewrittenQueue = rewriteShoppingQueueReferences(currentQueue, rewrite);
      const projected = projectPendingShoppingChanges(serverList, rewrittenQueue);
      const idsToRemove = [...removeListIds];
      if (!projected && serverList?.id != null) idsToRemove.push(serverList.id);
      const remappedStores = rewrite.listIdFrom === undefined
        ? []
        : getShoppingStores().map(store => sameId(store.shopping_list_id, rewrite.listIdFrom)
          ? { ...store, shopping_list_id: rewrite.listIdTo }
          : store);
      await commitShoppingReplay({
        list: projected,
        stores: remappedStores,
        removeListIds: idsToRemove,
        queueDeleteId: item.id,
        queueRecords: rewrittenQueue,
      });
      replaceShoppingList(projected, idsToRemove);
      if (remappedStores.length) replaceShoppingStores(projectPendingShoppingStores(remappedStores, rewrittenQueue));
      return true;
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

  async function rewriteQueuedReferences({ projectIdFrom, projectIdTo, sectionIdFrom, sectionIdTo, todoIdFrom, todoIdTo, commentIdFrom, commentIdTo, subtaskIdFrom, subtaskIdTo }, { persist = true } = {}) {
    const queue = await dbGetAll('syncQueue');
    const rewrittenRecords = [];
    for (const queued of queue) {
      if (!queued?.data || typeof queued.data !== 'object') continue;
      let changed = false;
      if (projectIdFrom !== undefined && !String(queued.action).includes('SHOPPING')) {
        for (const field of ['project_id', 'parent_id']) {
          if (sameId(queued.data[field], projectIdFrom)) { queued.data[field] = projectIdTo; changed = true; }
          if (sameId(queued.data.changes?.[field], projectIdFrom)) { queued.data.changes[field] = projectIdTo; changed = true; }
        }
        if (['UPDATE_PROJECT', 'DELETE_PROJECT'].includes(queued.action) && sameId(queued.data.id, projectIdFrom)) {
          queued.data.id = projectIdTo;
          changed = true;
        }
        if (Array.isArray(queued.data.project_boundary_ids) && queued.data.project_boundary_ids.some(id => sameId(id, projectIdFrom))) {
          queued.data.project_boundary_ids = queued.data.project_boundary_ids.map(id => sameId(id, projectIdFrom) ? projectIdTo : id);
          changed = true;
        }
      }
      if (sectionIdFrom !== undefined && !String(queued.action).includes('SHOPPING')) {
        if (sameId(queued.data.section_id, sectionIdFrom)) { queued.data.section_id = sectionIdTo; changed = true; }
        if (sameId(queued.data.changes?.section_id, sectionIdFrom)) { queued.data.changes.section_id = sectionIdTo; changed = true; }
        if (['UPDATE_SECTION', 'DELETE_SECTION'].includes(queued.action) && sameId(queued.data.id, sectionIdFrom)) {
          queued.data.id = sectionIdTo;
          changed = true;
        }
      }
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
      if (changed) {
        rewrittenRecords.push(queued);
        if (persist) await dbPut('syncQueue', queued);
      }
    }
    return rewrittenRecords;
  }

  async function commitTaskParentReceipt(item, entity, kind, syncInProgressRef, privacyGeneration) {
    return commitQueueItem(item, async () => {
      const temporaryId = item.data._tempId;
      const field = kind === 'project' ? 'project_id' : 'section_id';
      const rewrite = kind === 'project'
        ? { projectIdFrom: temporaryId, projectIdTo: entity.id }
        : { sectionIdFrom: temporaryId, sectionIdTo: entity.id };
      const queueRecords = temporaryId == null ? [] : await rewriteQueuedReferences(rewrite, { persist: false });
      const rewritten = new Map(queueRecords.map(entry => [String(entry.id), entry]));
      const pending = (await dbGetAll('syncQueue')).filter(entry => !sameId(entry.id, item.id))
        .map(entry => rewritten.get(String(entry.id)) || entry);
      const projectedEntity = kind === 'project'
        ? projectPendingProjectChanges(entity, pending) : projectPendingSectionChanges(entity, pending);
      const remap = (row, key) => temporaryId != null && sameId(row[key], temporaryId) ? { ...row, [key]: entity.id } : row;
      const projects = kind === 'project' && temporaryId != null
        ? (await dbGetAll('projects')).filter(project => sameId(project.parent_id, temporaryId)).map(project => remap(project, 'parent_id')) : [];
      const sections = kind === 'project' && temporaryId != null
        ? (await dbGetAll('sections')).filter(section => sameId(section.project_id, temporaryId)).map(section => remap(section, 'project_id')) : [];
      const todos = temporaryId == null ? [] : (await dbGetAll('todos'))
        .filter(todo => sameId(todo[field], temporaryId)).map(todo => remap(todo, field));
      if (projectedEntity) (kind === 'project' ? projects : sections).push(projectedEntity);
      const receipt = {
        projects, sections, todos, queueRecords, queueDeleteId: item.id,
        removeProjectIds: kind === 'project' ? [temporaryId, ...(!projectedEntity ? [entity.id] : [])].filter(id => id != null) : [],
        removeSectionIds: kind === 'section' ? [temporaryId, ...(!projectedEntity ? [entity.id] : [])].filter(id => id != null) : [],
      };
      if (commitTaskParentReplay) {
        if (await commitTaskParentReplay(receipt) === false) return false;
      } else {
        // Compatibility for embedders without the atomic storage adapter.
        for (const id of receipt.removeProjectIds) await deleteFromDB('projects', id);
        for (const id of receipt.removeSectionIds) await deleteFromDB('sections', id);
        for (const [store, rows] of [['projects', projects], ['sections', sections], ['todos', todos], ['syncQueue', queueRecords]]) {
          for (const row of rows) await dbPut(store, row);
        }
      }
      const replace = (rows, changes, removed) => {
        const byId = new Map(changes.map(row => [String(row.id), row]));
        const next = rows.filter(row => !removed.some(id => sameId(id, row.id))).map(row => byId.get(String(row.id)) || row);
        const existing = new Set(next.map(row => String(row.id)));
        return [...next, ...changes.filter(row => !existing.has(String(row.id)))];
      };
      setProjects(replace(getProjects(), projects, receipt.removeProjectIds));
      const currentSections = getSections().map(section => kind === 'project' ? remap(section, 'project_id') : section);
      setSections(kind === 'section' ? replace(currentSections, projectedEntity ? [projectedEntity] : [], receipt.removeSectionIds) : currentSections);
      setTodos(getTodos().map(todo => remap(todo, field)));
    }, syncInProgressRef, privacyGeneration);
  }

  async function commitQueueItem(item, applyResult, syncInProgressRef, privacyGeneration = Number(syncInProgressRef?.privacyGeneration || 0)) {
    const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
    try {
      if (Number(syncInProgressRef?.privacyGeneration || 0) !== privacyGeneration) return false;
      const currentQueueItem = await getFromDB('syncQueue', item.id);
      if (!currentQueueItem) return false;
      if (await applyResult() === false) return false;
      await deleteFromDB('syncQueue', item.id);
      return true;
    } finally {
      releaseCommitLock();
    }
  }

  async function recoverTodosFromServer(todoIds, syncInProgressRef) {
    if (!todoIds.size) return true;
    const privacyGeneration = Number(syncInProgressRef?.privacyGeneration || 0);
    const response = await todosApi.list();
    const serverTodos = new Map((response?.todos || []).map(todo => [String(todo.id), todo]));
    const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
    try {
      if (Number(syncInProgressRef?.privacyGeneration || 0) !== privacyGeneration) return false;
      const queue = await dbGetAll('syncQueue');
      for (const todoId of todoIds) {
        const serverTodo = serverTodos.get(String(todoId));
        if (!serverTodo) {
          await deleteFromDB('todos', todoId);
          setTodos(getTodos().filter(todo => String(todo.id) !== String(todoId)));
          await deleteQueuedTodoOperations(todoId);
          continue;
        }
        if (serverTodo.project_id != null
          && !getProjects().some(project => String(project.id) === String(serverTodo.project_id))) continue;
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
    if (cookbookMetadata.actions.has(item?.action)) return cookbookMetadata.sanitize(item);
    if (!item || typeof item !== 'object' || typeof item.action !== 'string') return null;
    const data = item.data && typeof item.data === 'object' ? item.data : {};
    const changes = data.changes && typeof data.changes === 'object' ? data.changes : {};
    const todoFields = ['title', 'description', 'priority', 'is_pinned', 'status', 'project_id', 'section_id', 'due_date', 'remind_at', 'location_reminder', 'recurring_rule', 'subtasks', 'confirm_incomplete_subtasks_completion', '_tempId'];
    const projectFields = ['name', 'color', 'icon', 'sort_order', 'parent_id', 'workspace_id', 'household_id', '_tempId'];
    const sectionFields = ['name', 'sort_order', 'project_id', '_tempId'];
    const shoppingListFields = ['name', 'color', 'icon', 'sort_order', 'household_id', 'client_mutation_id'];
    const shoppingStoreFields = ['shopping_list_id', 'name', 'sort_order', 'client_mutation_id'];
    const shoppingSectionFields = ['name', 'sort_order', 'client_mutation_id'];
    const shoppingItemFields = ['name', 'section_id', 'quantity_value', 'quantity_unit', 'store_ids', 'sort_order', 'client_mutation_id'];
    const localCommentFields = ['id', 'todo_id', 'user_id', 'body', 'created_at', 'updated_at', 'author_username', 'author_display_name', 'is_pending'];
    const localSubtaskFields = ['id', 'title', 'is_done', 'sort_order', 'created_at', 'updated_at', 'is_pending'];
    const withProjectBoundary = sanitizedData => {
      const boundary = {};
      if (data.project_id !== undefined && data.project_id !== null) boundary.project_id = data.project_id;
      if (Array.isArray(data.project_boundary_ids) && data.project_boundary_ids.length) {
        boundary.project_boundary_ids = [...data.project_boundary_ids];
      }
      return Object.keys(boundary).length ? { ...sanitizedData, ...boundary } : sanitizedData;
    };

    switch (item.action) {
      case 'CREATE_TODO':
        return { ...item, data: { ...pickAllowed(data, todoFields), undo_grace_until: data.undo_grace_until } };
      case 'UPDATE_TODO':
        return { ...item, data: withProjectBoundary({ id: data.id, changes: pickAllowed(changes, todoFields.filter(f => f !== '_tempId')) }) };
      case 'DELETE_TODO':
        return { ...item, data: withProjectBoundary({ id: data.id, undo_grace_until: data.undo_grace_until }) };
      case 'CREATE_COMMENT':
        return { ...item, data: withProjectBoundary({ todo_id: data.todo_id, temp_id: data.temp_id, body: data.body, local_comment: pickAllowed(data.local_comment, localCommentFields) }) };
      case 'UPDATE_COMMENT':
        return { ...item, data: withProjectBoundary({ todo_id: data.todo_id, comment_id: data.comment_id, changes: pickAllowed(changes, ['body']) }) };
      case 'DELETE_COMMENT':
        return { ...item, data: withProjectBoundary({ todo_id: data.todo_id, comment_id: data.comment_id }) };
      case 'CREATE_SUBTASK':
        return { ...item, data: withProjectBoundary({ todo_id: data.todo_id, temp_id: data.temp_id, subtask: pickAllowed(data.subtask, ['title', 'is_done', 'sort_order']), local_subtask: pickAllowed(data.local_subtask, localSubtaskFields) }) };
      case 'UPDATE_SUBTASK':
        return { ...item, data: withProjectBoundary({ todo_id: data.todo_id, subtask_id: data.subtask_id, changes: pickAllowed(changes, ['title', 'is_done', 'sort_order']) }) };
      case 'DELETE_SUBTASK':
        return { ...item, data: withProjectBoundary({ todo_id: data.todo_id, subtask_id: data.subtask_id }) };
      case 'CREATE_PROJECT':
        return { ...item, data: pickAllowed(data, projectFields) };
      case 'UPDATE_PROJECT':
        return { ...item, data: withProjectBoundary({ id: data.id, changes: pickAllowed(changes, projectFields.filter(f => f !== '_tempId')) }) };
      case 'DELETE_PROJECT':
        return { ...item, data: withProjectBoundary({ id: data.id }) };
      case 'CREATE_SECTION':
        return { ...item, data: pickAllowed(data, sectionFields) };
      case 'UPDATE_SECTION':
        return { ...item, data: withProjectBoundary({ id: data.id, changes: pickAllowed(changes, sectionFields.filter(f => !['_tempId', 'project_id'].includes(f))) }) };
      case 'DELETE_SECTION':
        return { ...item, data: withProjectBoundary({ id: data.id }) };
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
        return { ...item, data: { shopping_list_id: data.shopping_list_id, temp_id: data.temp_id, item: pickAllowed(data.item, shoppingItemFields.concat('braindump_route')), client_mutation_id: data.client_mutation_id } };
      case 'UPDATE_SHOPPING_ITEM':
        return { ...item, data: { shopping_list_id: data.shopping_list_id, item_id: data.item_id, changes: pickAllowed(changes, shoppingItemFields.filter(field => field !== 'client_mutation_id').concat('completed')) } };
      case 'DELETE_SHOPPING_ITEM':
        return { ...item, data: { shopping_list_id: data.shopping_list_id, item_id: data.item_id } };
      case 'DELETE_COMPLETED_SHOPPING_ITEMS':
        return { ...item, data: { shopping_list_id: data.shopping_list_id } };
      case 'UPDATE_SHOPPING_PREFERENCES': {
        const preferenceChanges = pickAllowed(changes, ['hide_empty_sections']);
        return Object.keys(preferenceChanges).length
          ? { ...item, data: { shopping_list_id: data.shopping_list_id, changes: preferenceChanges } }
          : null;
      }
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
    const failedShoppingLists = new Set();
    try {
      while (true) {
      syncInProgressRef.requested = false;
      const queue = (await dbGetAll('syncQueue')).filter(item => !attemptedQueueIds.has(String(item.id)));
      if (!queue.length) break;

      for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const queuedItem = queue[queueIndex];
      attemptedQueueIds.add(String(queuedItem.id));
      const currentQueue = await dbGetAll('syncQueue');
      const currentQueuedItem = currentQueue.find(item => String(item.id) === String(queuedItem.id));
      if (!currentQueuedItem) continue;
      if (cookbookMetadata.actions.has(currentQueuedItem.action)) {
        const id = cookbookMetadata.idFor(currentQueuedItem);
        if (currentQueue.some(previous => !sameId(previous.id, currentQueuedItem.id)
          && attemptedQueueIds.has(String(previous.id)) && cookbookMetadata.references(previous, id))) continue;
      }
      const shoppingListIdentity = shoppingQueueListIdentity(currentQueuedItem);
      // A successful HTTP response can still be fenced out by an access change.
      // Its durable predecessor must settle before dependent writes may replay.
      if (shoppingListIdentity !== null && (failedShoppingLists.has(shoppingListIdentity)
        || currentQueue.some(previous => String(previous.id) !== String(currentQueuedItem.id)
          && attemptedQueueIds.has(String(previous.id))
          && shoppingQueueListIdentity(previous) === shoppingListIdentity))) continue;
      let item = sanitizeQueueItem(currentQueuedItem);
      if (item && !item.action.includes('SHOPPING')) {
        const targets = [
          ['PROJECT', item.data.project_id], ['PROJECT', item.data.parent_id], ['PROJECT', item.data.changes?.project_id], ['PROJECT', item.data.changes?.parent_id],
          ['SECTION', item.data.section_id], ['SECTION', item.data.changes?.section_id],
          ['TODO', item.data.todo_id], ['COMMENT', item.data.comment_id], ['SUBTASK', item.data.subtask_id],
        ];
        for (const entity of ['PROJECT', 'SECTION', 'TODO']) {
          if ([`UPDATE_${entity}`, `DELETE_${entity}`].includes(item.action)) targets.push([entity, item.data.id]);
        }
        // Pending parent creates must settle and rewrite these references first.
        // A failed or privacy-fenced parent must never send opaque IDs to the API.
        if (targets.some(([entity, id]) => String(id || '').startsWith('temp-')
          && currentQueue.some(parent => parent.action === `CREATE_${entity}` && sameId(parent.data?._tempId ?? parent.data?.temp_id, id)))) continue;
      }
      let requestPrivacyGeneration = Number(syncInProgressRef?.privacyGeneration || 0);
      const failuresBeforeRequest = failCount;
      try {
        if (!item) {
          await deleteFromDB('syncQueue', queuedItem.id);
          continue;
        }
        if (cookbookMetadata.actions.has(item.action)) {
          if (await cookbookSync.replay(item, syncInProgressRef, requestPrivacyGeneration)) successCount++;
          continue;
        }
        if (item.action === 'CREATE_TODO') {
          const releaseRequestLock = await acquireSyncCommitLock(syncInProgressRef);
          try {
            const currentQueueItem = await getFromDB('syncQueue', item.id);
            const currentItem = sanitizeQueueItem(currentQueueItem);
            if (!currentItem || currentItem.action !== 'CREATE_TODO') continue;
            const currentTempTodo = currentItem.data._tempId
              ? await getFromDB('todos', currentItem.data._tempId)
              : null;
            if (currentItem.data._tempId && !currentTempTodo) continue;
            const projectId = currentTempTodo?.project_id ?? currentItem.data.project_id;
            const sectionId = currentTempTodo?.section_id ?? currentItem.data.section_id;
            if (projectId != null
              && !getProjects().some(project => String(project.id) === String(projectId))) continue;
            if (sectionId != null) {
              const targetSection = getSections().find(section => String(section.id) === String(sectionId));
              if (!targetSection || String(targetSection.project_id) !== String(projectId)) continue;
            }
            item = currentItem;
            requestPrivacyGeneration = Number(syncInProgressRef?.privacyGeneration || 0);
          } finally {
            releaseRequestLock();
          }
          const undoGraceUntil = Number(item.data.undo_grace_until || 0);
          if (undoGraceUntil && Date.now() < undoGraceUntil) {
            continue;
          }
          const createData = { ...item.data };
          delete createData.undo_grace_until;
          let res = await todosApi.create(createData);
          let capturedTempTodo = null;
          if (createData._tempId) {
            const releaseCaptureLock = await acquireSyncCommitLock(syncInProgressRef);
            try {
              if (Number(syncInProgressRef?.privacyGeneration || 0) !== requestPrivacyGeneration) continue;
              const currentQueueItem = await getFromDB('syncQueue', item.id);
              capturedTempTodo = await getFromDB('todos', createData._tempId);
              if (!currentQueueItem || !capturedTempTodo) continue;
              if (capturedTempTodo.project_id != null
                && !getProjects().some(project => String(project.id) === String(capturedTempTodo.project_id))) continue;
              if (capturedTempTodo.section_id != null) {
                const targetSection = getSections().find(section => String(section.id) === String(capturedTempTodo.section_id));
                if (!targetSection || String(targetSection.project_id) !== String(capturedTempTodo.project_id)) continue;
              }
            } finally {
              releaseCaptureLock();
            }
            if (String(capturedTempTodo.section_id ?? '') !== String(createData.section_id ?? '')) {
              res = await todosApi.update(res.id, { section_id: capturedTempTodo.section_id });
            }
          }
          const committed = await commitQueueItem(item, async () => {
            let localTempTodo = null;
            if (createData._tempId) {
              localTempTodo = await getFromDB('todos', createData._tempId);
              if (!localTempTodo) return false;
              if (localTempTodo.project_id != null
                && !getProjects().some(project => String(project.id) === String(localTempTodo.project_id))) return false;
              if (localTempTodo.section_id != null) {
                const targetSection = getSections().find(section => String(section.id) === String(localTempTodo.section_id));
                if (!targetSection || String(targetSection.project_id) !== String(localTempTodo.project_id)) return false;
              }
            }
            const createdTodo = localTempTodo ? { ...localTempTodo, ...res, id: res.id } : res;
            if (createdTodo.project_id != null
              && !getProjects().some(project => String(project.id) === String(createdTodo.project_id))) return false;
            if (createdTodo.section_id != null) {
              const targetSection = getSections().find(section => String(section.id) === String(createdTodo.section_id));
              if (!targetSection || String(targetSection.project_id) !== String(createdTodo.project_id)) return false;
            }
            if (createData._tempId) {
              await deleteFromDB('todos', createData._tempId);
              setTodos(getTodos().filter(t => t.id !== createData._tempId));
              await rewriteQueuedReferences({ todoIdFrom: createData._tempId, todoIdTo: res.id });
            }
            await persistTodoWithPending(createdTodo, item.id);
            return true;
          }, syncInProgressRef, requestPrivacyGeneration);
          if (!committed) continue;
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
          }, syncInProgressRef, requestPrivacyGeneration);
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
          }, syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
        } else if (item.action === 'UPDATE_COMMENT') {
          const response = await todosApi.updateComment(item.data.todo_id, item.data.comment_id, item.data.changes);
          await commitQueueItem(item, () => persistTodoWithPending(response?.todo, item.id), syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_COMMENT') {
          const response = await todosApi.deleteComment(item.data.todo_id, item.data.comment_id);
          await commitQueueItem(item, () => persistTodoWithPending(response?.todo, item.id), syncInProgressRef, requestPrivacyGeneration);
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
          }, syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
        } else if (item.action === 'UPDATE_SUBTASK') {
          const response = await todosApi.updateSubtask(item.data.todo_id, item.data.subtask_id, item.data.changes);
          await commitQueueItem(item, () => persistTodoWithPending(response?.todo, item.id), syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_SUBTASK') {
          const response = await todosApi.deleteSubtask(item.data.todo_id, item.data.subtask_id);
          await commitQueueItem(item, () => persistTodoWithPending(response?.todo, item.id), syncInProgressRef, requestPrivacyGeneration);
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
          }, syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
        } else if (item.action === 'CREATE_SHOPPING_STORE') {
          const created = await shoppingApi.createStore(pickAllowed(item.data, ['shopping_list_id', 'name', 'sort_order', 'client_mutation_id']));
          await commitShoppingStoreState(item, created, {
            removeStoreIds: [item.data.temp_id],
            rewrite: { storeIdFrom: item.data.temp_id, storeIdTo: created.id },
          }, syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
        } else if (item.action === 'UPDATE_SHOPPING_STORE') {
          const updated = await shoppingApi.updateStore(item.data.store_id, item.data.changes);
          await commitShoppingStoreState(item, updated, {}, syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_SHOPPING_STORE') {
          const updated = await shoppingApi.deleteStore(item.data.store_id);
          await commitShoppingStoreState(item, updated, {}, syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
        } else if (item.action === 'CREATE_SHOPPING_LIST') {
          const created = await shoppingApi.createList(pickAllowed(item.data, ['name', 'color', 'icon', 'sort_order', 'household_id', 'client_mutation_id']));
          const serverList = await shoppingApi.getList(created.id);
          await commitShoppingServerState(item, serverList, {
            removeListIds: [item.data.temp_id],
            rewrite: { listIdFrom: item.data.temp_id, listIdTo: created.id },
          }, syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
        } else if (item.action === 'UPDATE_SHOPPING_LIST') {
          await shoppingApi.updateList(item.data.id, item.data.changes);
          const serverList = await shoppingApi.getList(item.data.id);
          await commitShoppingServerState(item, serverList, {}, syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_SHOPPING_LIST') {
          await shoppingApi.deleteList(item.data.id);
          await commitShoppingServerState(item, null, { removeListIds: [item.data.id] }, syncInProgressRef, requestPrivacyGeneration);
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
          }, syncInProgressRef, requestPrivacyGeneration);
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
          }, syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
        } else if (item.action === 'UPDATE_SHOPPING_SECTION') {
          await shoppingApi.updateSection(item.data.section_id, item.data.changes);
          const serverList = await shoppingApi.getList(item.data.shopping_list_id);
          await commitShoppingServerState(item, serverList, {}, syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_SHOPPING_SECTION') {
          await shoppingApi.deleteSection(item.data.section_id);
          const serverList = await shoppingApi.getList(item.data.shopping_list_id);
          await commitShoppingServerState(item, serverList, {}, syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
        } else if (item.action === 'UPDATE_SHOPPING_ITEM') {
          await shoppingApi.updateItem(item.data.item_id, item.data.changes);
          const serverList = await shoppingApi.getList(item.data.shopping_list_id);
          await commitShoppingServerState(item, serverList, {}, syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_SHOPPING_ITEM') {
          await shoppingApi.deleteItem(item.data.item_id);
          const serverList = await shoppingApi.getList(item.data.shopping_list_id);
          await commitShoppingServerState(item, serverList, {}, syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_COMPLETED_SHOPPING_ITEMS') {
          await shoppingApi.deleteCompletedItems(item.data.shopping_list_id);
          const serverList = await shoppingApi.getList(item.data.shopping_list_id);
          await commitShoppingServerState(item, serverList, {}, syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
        } else if (item.action === 'UPDATE_SHOPPING_PREFERENCES') {
          await shoppingApi.updatePreferences(item.data.shopping_list_id, item.data.changes);
          const serverList = await shoppingApi.getList(item.data.shopping_list_id);
          await commitShoppingServerState(item, serverList, {}, syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
        } else if (item.action === 'CREATE_PROJECT') {
          const res = await projectsApi.create(item.data);
          const committed = await commitTaskParentReceipt(item, res, 'project', syncInProgressRef, requestPrivacyGeneration);
          if (committed && item.data._tempId) onProjectIdRemap(item.data._tempId, res.id);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_PROJECT') {
          const res = await projectsApi.delete(item.data.id);
          const deletedIds = res.deleted_ids || [item.data.id];
          const committed = await commitQueueItem(item, async () => {
            await Promise.all(deletedIds.map(projectId => deleteFromDB('projects', projectId)));
          }, syncInProgressRef, requestPrivacyGeneration);
          if (committed) needsAuthoritativeRefresh = true;
          successCount++;
          continue;
        } else if (item.action === 'UPDATE_PROJECT') {
          const serverProject = await projectsApi.update(item.data.id, item.data.changes);
          const updatedProjects = Array.isArray(serverProject?.updated_projects) ? serverProject.updated_projects : (serverProject ? [serverProject] : []);
          const committed = await commitQueueItem(item, async () => {
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
          }, syncInProgressRef, requestPrivacyGeneration);
          if (committed && item.data.changes && Object.prototype.hasOwnProperty.call(item.data.changes, 'workspace_id')) {
            needsAuthoritativeRefresh = true;
          }
          successCount++;
          continue;
        } else if (item.action === 'CREATE_SECTION') {
          const res = await sectionsApi.create(item.data.project_id, item.data);
          const committed = await commitTaskParentReceipt(item, res, 'section', syncInProgressRef, requestPrivacyGeneration);
          if (committed && item.data._tempId) onSectionIdRemap(item.data._tempId, res.id);
          successCount++;
          continue;
        } else if (item.action === 'UPDATE_SECTION') {
          await sectionsApi.update(item.data.id, item.data.changes);
          await commitQueueItem(item, async () => {
            const localSection = await getFromDB('sections', item.data.id);
            if (localSection) await dbPut('sections', { ...localSection, ...item.data.changes, updated_at: new Date().toISOString() });
          }, syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
        } else if (item.action === 'DELETE_SECTION') {
          await sectionsApi.delete(item.data.id);
          await commitQueueItem(item, () => deleteFromDB('sections', item.data.id), syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          continue;
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
          }, syncInProgressRef, requestPrivacyGeneration);
          successCount++;
          handledPermanentAbsence = true;
        } else if (['CREATE_COMMENT', 'CREATE_SUBTASK'].includes(item?.action) && err?.status === 404) {
          await commitQueueItem(item, async () => {
            await deleteFromDB('todos', item.data.todo_id);
            setTodos(getTodos().filter(todo => String(todo.id) !== String(item.data.todo_id)));
            await deleteQueuedTodoOperations(item.data.todo_id);
          }, syncInProgressRef, requestPrivacyGeneration);
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
            }, syncInProgressRef, requestPrivacyGeneration);
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
              await commitShoppingServerState(item, serverList, {}, syncInProgressRef, requestPrivacyGeneration);
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
              if (Number(syncInProgressRef?.privacyGeneration || 0) !== requestPrivacyGeneration) continue;
              const currentQueue = await dbGetAll('syncQueue');
              if (!currentQueue.some(entry => String(entry.id) === String(item.id))) continue;
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
        } else if (item?.action === 'CREATE_PROJECT' && item.data?._tempId
          && Number(err?.status) >= 400 && Number(err?.status) < 500 && ![401, 408, 429].includes(Number(err.status))
          && evictPendingProjectEntities) {
          await commitQueueItem(item, async () => {
            const evicted = await evictPendingProjectEntities([item.data._tempId], {
              projects: getProjects(), sections: getSections(), todos: getTodos(),
            });
            const projects = new Set(evicted.projectIds.map(String));
            const sections = new Set(evicted.sectionIds.map(String));
            const todos = new Set(evicted.todoIds.map(String));
            setProjects(getProjects().filter(project => !projects.has(String(project.id))));
            setSections(getSections().filter(section => !sections.has(String(section.id))));
            setTodos(getTodos().filter(todo => !todos.has(String(todo.id))));
          }, syncInProgressRef, requestPrivacyGeneration);
        }
        if (!handledPermanentAbsence) failCount++;
        if (failCount > failuresBeforeRequest && shoppingListIdentity !== null) {
          // Later writes to this list depend on this mutation's ordering and
          // temporary-ID remapping. Other lists can continue independently.
          failedShoppingLists.add(shoppingListIdentity);
        }
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
    if (!isOnlineForSync(wsState) || !getDb()) return { refreshed: false, reason: 'unavailable' };

    if (syncInProgressRef.value) {
      const completed = await waitForActiveSync(syncInProgressRef);
      if (!completed) {
        console.warn('Skipping server refresh while local sync is still in progress');
        return { refreshed: false, reason: 'sync-in-progress' };
      }
    }

    const pendingQueue = await dbGetAll('syncQueue');
    if (pendingQueue.length) {
      await syncWithServer({ wsState, syncInProgressRef });
      const remainingQueue = await dbGetAll('syncQueue');
      if (remainingQueue.length) {
        console.warn('Skipping server refresh while local sync queue still has pending changes');
        return { refreshed: false, reason: 'pending-queue' };
      }
    }

    syncInProgressRef.value = true;
    syncInProgressRef.refreshing = true;
    syncInProgressRef.requested = false;
    const privacyGeneration = Number(syncInProgressRef?.privacyGeneration || 0);
    let releaseCommitLock = null;
    let shouldDrainQueue = false;
    try {
      const [todosData, projectsData, sectionsData, workspacesData, shoppingData, recipesData] = await Promise.all([
        todosApi.list(), projectsApi.list(), sectionsApi.listAll(), workspacesApi.list(), shoppingApi.snapshot(),
        recipesApi ? recipesApi.snapshot() : Promise.resolve(null),
      ]);
      const nextProjects = projectsData.projects || [];
      const nextProjectIds = new Set(nextProjects.map(project => String(project.id)));
      const nextSections = (sectionsData.sections || []).filter(section =>
        section.project_id == null || nextProjectIds.has(String(section.project_id))
      );
      const nextSectionIds = new Set(nextSections.map(section => String(section.id)));
      const nextTodos = (todosData.todos || []).filter(todo =>
        (todo.project_id == null || nextProjectIds.has(String(todo.project_id)))
        && (todo.section_id == null || nextSectionIds.has(String(todo.section_id)))
      );
      const nextWorkspaces = workspacesData.workspaces || [];
      const nextCookbooks = recipesData?.cookbooks || [];
      const nextShoppingLists = shoppingData.shopping_lists || [];
      const nextShoppingStores = projectShoppingStoresSnapshot(
        shoppingData.shopping_stores || [],
        getShoppingStores(),
        [],
      );

      releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
      if (Number(syncInProgressRef?.privacyGeneration || 0) !== privacyGeneration) {
        return { refreshed: false, reason: 'privacy-generation' };
      }
      const queueBeforeCommit = await dbGetAll('syncQueue');
      if (queueBeforeCommit.length) {
        shouldDrainQueue = true;
      } else {
        if (recipesData && !commitCookbookReplay) throw new Error('Cookbook snapshot storage is not configured');
        const localCookbooks = recipesData ? await dbGetAll('cookbooks') : [];
        const revokedCookbookIds = recipesData
          ? cookbookMetadata.collectRevokedIds(nextCookbooks, [...getCookbooks(), ...localCookbooks], [], { actorId: getActorId() }) : [];
        if (recipesData) {
          const ids = new Set(nextCookbooks.map(book => String(book.id)));
          await commitCookbookReplay({ entities: nextCookbooks, removeIds: localCookbooks.filter(book => !ids.has(String(book.id))).map(book => book.id) });
        }
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
        setShoppingStores(nextShoppingStores);
        setShoppingLists(nextShoppingLists);
        renderShopping();
        if (recipesData) {
          setCookbooks(nextCookbooks);
          onCookbookSnapshotCommitted(nextCookbooks, revokedCookbookIds);
          renderCookbooks();
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
    return { refreshed: !shouldDrainQueue, reason: shouldDrainQueue ? 'queue-before-commit' : null };
  }

  return { isOnlineForSync, syncWithServer, refreshFromServer };
}
