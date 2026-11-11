import { TRANSFER_RECIPE_TO_SHOPPING, isRecipeShoppingTransfer, sanitizeRecipeShoppingTransfer, transferReferencesCookbook } from '../features/recipe-shopping-pending.js';
import { DB_NAME, DB_VERSION } from '../core/config.js';
import { queueItemReferencesShoppingList } from '../features/shopping-pending.js';
import { queueItemReferencesTodo } from '../features/todo-pending.js';
import { mergeRecipeStepIngredients, recipeActions, recipeBookId, recipeReferences, sanitizeRecipeEntry } from '../features/recipe-pending.js';
import { cookbookMetadata } from '../features/cookbooks.js';
import { commitEntityReplay, commitMetadataMutation, evictEntityMetadata, markMetadataMutationAttempt } from './entity-metadata.js';

let db = null;
let dbReady = false;
let dbGeneration = 0;
const pendingCacheOperations = [];

function cancelPendingCacheOperations() {
  const operations = pendingCacheOperations.splice(0);
  for (const operation of operations) operation.cancel();
}

async function flushPendingCacheOperations(generation) {
  while (dbReady && generation === dbGeneration && pendingCacheOperations.length) {
    const operation = pendingCacheOperations.shift();
    if (operation.generation !== dbGeneration) {
      operation.cancel();
      continue;
    }
    await operation.run();
  }
}

export function getDb() {
  return db;
}

export function getDatabaseGeneration() {
  return dbGeneration;
}

export async function closeAndDeleteDatabase() {
  return new Promise((resolve) => {
    dbGeneration += 1;
    dbReady = false;
    cancelPendingCacheOperations();
    if (db) {
      db.close();
      db = null;
    }
    const deleteRequest = indexedDB.deleteDatabase(DB_NAME);
    deleteRequest.onsuccess = () => { console.log('IndexedDB deleted'); resolve(); };
    deleteRequest.onerror = () => { console.log('IndexedDB delete error'); resolve(); };
    deleteRequest.onblocked = () => { console.log('IndexedDB delete blocked'); resolve(); };
  });
}

export function openDatabase() {
  const generation = dbGeneration;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      db = event.target.result;
      if (!db.objectStoreNames.contains('todos')) {
        db.createObjectStore('todos', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('workspaces')) {
        db.createObjectStore('workspaces', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('sections')) {
        db.createObjectStore('sections', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('syncQueue')) {
        db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('avatars')) {
        db.createObjectStore('avatars', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('shoppingLists')) {
        db.createObjectStore('shoppingLists', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('shoppingStores')) {
        db.createObjectStore('shoppingStores', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('entityImages')) db.createObjectStore('entityImages', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('cookbooks')) {
        db.createObjectStore('cookbooks', { keyPath: 'id' });
      }
      if (Number(event.oldVersion || 0) > 0 && Number(event.oldVersion || 0) < 8) {
        const upgradeTransaction = event.target.transaction;
        upgradeTransaction?.objectStore?.('shoppingLists')?.clear?.();
        upgradeTransaction?.objectStore?.('shoppingStores')?.clear?.();
        const queueCursor = upgradeTransaction?.objectStore?.('syncQueue')?.openCursor?.();
        if (queueCursor) {
          queueCursor.onsuccess = cursorEvent => {
            const cursor = cursorEvent.target.result;
            if (!cursor) return;
            if (String(cursor.value?.action || '').includes('SHOPPING')) cursor.delete();
            cursor.continue();
          };
        }
      }
    };

    request.onsuccess = async (event) => {
      if (generation !== dbGeneration) {
        event.target.result.close();
        resolve(null);
        return;
      }
      db = event.target.result;
      dbReady = true;
      console.log('IndexedDB opened');
      await flushPendingCacheOperations(generation);
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

export function getAll(storeName) {
  return new Promise((resolve) => {
    if (!db) { resolve([]); return; }
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => resolve([]);
  });
}

export function put(storeName, item) {
  return new Promise((resolve) => {
    if (!db) { resolve(); return; }
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export function commitTodoUpdatesWithQueue(updates, {
  database = db,
  timestamp = Date.now(),
  localUpdatedAt = new Date().toISOString(),
} = {}) {
  if (!database) return Promise.reject(new Error('IndexedDB is not open'));
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = database.transaction(['todos', 'syncQueue'], 'readwrite');
      const todosStore = tx.objectStore('todos');
      const queueStore = tx.objectStore('syncQueue');
      for (const update of updates) {
        todosStore.put(update.todo);
        queueStore.put({
          action: 'UPDATE_TODO',
          data: update.queueData || {
            id: update.todo.id,
            project_id: update.todo.project_id,
            project_boundary_ids: update.todo.project_id == null ? [] : [update.todo.project_id],
            changes: update.changes,
          },
          timestamp,
          localUpdatedAt,
        });
      }
    } catch (error) {
      tx?.abort?.();
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to commit todo updates'));
    tx.onabort = () => reject(tx.error || new Error('Todo update transaction was aborted'));
  });
}

/** Atomically acknowledge a Tasks parent and its already-computed remappings. */
export function commitTaskParentReplay({
  projects = [],
  sections = [],
  todos = [],
  removeProjectIds = [],
  removeSectionIds = [],
  queueRecords = [],
  queueDeleteId,
} = {}, { database = db } = {}) {
  if (!database) return Promise.reject(new Error('IndexedDB is not open'));
  if (queueDeleteId === undefined || queueDeleteId === null) {
    return Promise.reject(new Error('Task parent replay requires an acknowledged queue ID'));
  }
  return new Promise((resolve, reject) => {
    let tx;
    let failure;
    let applied = false;
    const abort = error => {
      failure = error;
      try { tx.abort(); } catch { reject(error); }
    };
    try {
      tx = database.transaction(['projects', 'sections', 'todos', 'syncQueue'], 'readwrite');
      tx.oncomplete = () => resolve(applied);
      tx.onerror = () => reject(failure || tx.error || new Error('Failed to commit Task parent replay'));
      tx.onabort = () => reject(failure || tx.error || new Error('Task parent replay transaction was aborted'));
      const projectStore = tx.objectStore('projects');
      const sectionStore = tx.objectStore('sections');
      const todoStore = tx.objectStore('todos');
      const queueStore = tx.objectStore('syncQueue');
      const receipt = queueStore.get(queueDeleteId);
      receipt.onerror = () => { failure = receipt.error; };
      receipt.onsuccess = () => {
        if (!receipt.result) return;
        try {
          for (const id of removeProjectIds) projectStore.delete(id);
          for (const id of removeSectionIds) sectionStore.delete(id);
          for (const project of projects) projectStore.put(project);
          for (const section of sections) sectionStore.put(section);
          for (const todo of todos) todoStore.put(todo);
          for (const record of queueRecords) queueStore.put(record);
          queueStore.delete(queueDeleteId);
          applied = true;
        } catch (error) {
          abort(error);
        }
      };
    } catch (error) {
      if (tx) abort(error);
      else reject(error);
    }
  });
}

export function commitShoppingMutation({
  list,
  lists = [],
  deleteListId,
  store,
  deleteStoreId,
  action,
  data,
  mutations = null,
  database = db,
  timestamp = Date.now(),
  localUpdatedAt = new Date().toISOString(),
} = {}) {
  if (!database) return Promise.reject(new Error('IndexedDB is not open'));
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = database.transaction(['shoppingLists', 'shoppingStores', 'syncQueue'], 'readwrite');
      const listStore = tx.objectStore('shoppingLists');
      const storeStore = tx.objectStore('shoppingStores');
      const queueStore = tx.objectStore('syncQueue');
      if (deleteListId !== undefined && deleteListId !== null) listStore.delete(deleteListId);
      if (list) listStore.put(list);
      for (const shoppingList of lists) listStore.put(shoppingList);
      if (deleteStoreId !== undefined && deleteStoreId !== null) storeStore.delete(deleteStoreId);
      if (store) storeStore.put(store);
      const queueMutations = mutations ?? [{ action, data }];
      for (const mutation of queueMutations) {
        queueStore.put({ action: mutation.action, data: mutation.data, timestamp, localUpdatedAt });
      }
    } catch (error) {
      tx?.abort?.();
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to commit shopping mutation'));
    tx.onabort = () => reject(tx.error || new Error('Shopping mutation transaction was aborted'));
  });
}

/** Cache eviction and the acknowledged create's dependent queue settle together. */
export function commitCreationTombstoneReplay({ writes = {}, remove = {}, queueRecords = [],
  queueDeleteIds = [], requireQueueId, database = db } = {}) {
  if (requireQueueId == null) return Promise.reject(new Error('Creation tombstone requires an acknowledged queue ID'));
  const allowed = ['todos', 'shoppingLists', 'shoppingStores'];
  const scoped = records => Object.fromEntries(allowed.filter(key => Array.isArray(records[key])).map(key => [key, records[key]]));
  return commitEntityReplay({ writes: scoped(writes), remove: scoped(remove),
    queueRecords, queueDeleteIds, requireQueueId, database });
}

export function commitShoppingReplay({
  list, removeListIds = [], store, stores = [], removeStoreIds = [],
  queueDeleteId, queueDeleteIds = [], queueRecords = [], requireQueueId, database = db,
} = {}) {
  return commitEntityReplay({
    writes: { shoppingLists: list ? [list] : [], shoppingStores: [...(store ? [store] : []), ...stores] },
    remove: { shoppingLists: removeListIds, shoppingStores: removeStoreIds },
    queueDeleteId, queueDeleteIds, queueRecords, requireQueueId, database,
  });
}

export function evictPendingShoppingEntities(listIds, { database = db, signal } = {}) {
  const ids = [...new Set((listIds || []).filter(id => id != null))];
  if (!ids.length) return Promise.resolve();
  const blocked = new Set(ids.map(String));
  return evictEntityMetadata({ database, signal,
    remove: { shoppingLists: ids }, scan: { shoppingStores: store => blocked.has(String(store.shopping_list_id)) },
    references: (entry, records) => ids.some(id => queueItemReferencesShoppingList(entry, id, records.shoppingStores)),
  });
}

export function commitCookbookMutation({ cookbook, deleteCookbookId, action, data,
  database = db, timestamp, localUpdatedAt } = {}) {
  return commitMetadataMutation({ contract: cookbookMetadata, entity: cookbook, deleteId: deleteCookbookId,
    action, data, database, timestamp, localUpdatedAt, extraStores: ['entityImages'],
    onMutation: deleteCookbookId == null ? null : (tx, queue) => {
      if (queue.some(entry => transferReferencesCookbook(entry, deleteCookbookId) && !entry.blocked)) {
        const error = new Error('Recipe Shopping transfer must settle before its cookbook can be deleted');
        error.code = 'recipe.transfer.pendingSource';
        throw error;
      }
      queue.filter(entry => String(recipeBookId(entry)) === String(deleteCookbookId)).forEach(entry => tx.objectStore('syncQueue').delete(entry.id));
      const request = tx.objectStore('entityImages').openCursor();
      request.onsuccess = () => { const cursor = request.result; if (!cursor) return;
        if (String(cursor.value.cookbook_id) === String(deleteCookbookId)) cursor.delete(); cursor.continue(); };
    } });
}

export function commitCookbookReplay({ entity, entities = [], removeIds = [], queueRecords = [],
  queueDeleteId, queueDeleteIds = [], requireQueueId, removeRecipeIds = [], authoritativeCookbookIds = null, database = db } = {}) {
  return commitEntityReplay({ writes: { cookbooks: [...entities, ...(entity ? [entity] : [])] },
    remove: { cookbooks: removeIds }, scanRemove: { entityImages: row => (Array.isArray(authoritativeCookbookIds) && !authoritativeCookbookIds.some(id => String(id) === String(row.cookbook_id)))
      || removeIds.some(id => String(row.cookbook_id) === String(id))
      || removeRecipeIds.some(id => String(row.recipe_id) === String(id))
      || [...entities, ...(entity ? [entity] : [])].some(book => String(book.id) === String(row.cookbook_id)
        && !(book.recipes || []).some(recipe => String(recipe.id) === String(row.recipe_id))) },
    queueRecords, queueDeleteId, queueDeleteIds, requireQueueId, database });
}

export function markCookbookMutationAttempt(queueId, { database = db } = {}) {
  return markMetadataMutationAttempt({ contract: cookbookMetadata, queueId, database });
}

export function evictPendingCookbookEntities(entityIds, { database = db, signal, accessibleCookbookIds = [] } = {}) {
  const accessible = new Set(accessibleCookbookIds.map(String));
  const ids = [...new Set((entityIds || []).filter(id => id != null && !accessible.has(String(id))))];
  if (!ids.length) return Promise.resolve();
  return evictEntityMetadata({ database, signal, remove: { cookbooks: ids },
    scan: { entityImages: row => ids.some(id => String(row.cookbook_id) === String(id)) },
    references: entry => ids.some(id => cookbookMetadata.references(entry, id) || String(recipeBookId(entry)) === String(id) || transferReferencesCookbook(entry, id)) });
}

export function evictPendingProjectEntities(projectIds, {
  database = db,
  signal,
  projects: projectedProjects = [],
  sections: projectedSections = [],
  todos: projectedTodos = [],
  accessibleProjectIds = [],
  accessibleTodoIds = [],
  accessibleSectionIds = [],
} = {}) {
  if (!database) return Promise.reject(new Error('IndexedDB is not open'));
  const accessible = new Set(accessibleProjectIds.filter(id => id != null).map(String));
  const accessibleTodos = new Set(accessibleTodoIds.filter(id => id != null).map(String));
  const accessibleSections = new Set(accessibleSectionIds.filter(id => id != null).map(String));
  const roots = [...new Set((projectIds || []).filter(id => id !== undefined && id !== null)
    .map(String).filter(id => !accessible.has(id)))];
  if (!roots.length) return Promise.resolve({ projectIds: [], sectionIds: [], todoIds: [] });
  if (signal?.aborted) return Promise.reject(new DOMException('Pending project eviction was aborted', 'AbortError'));

  return new Promise((resolve, reject) => {
    let tx;
    const records = {};
    try {
      tx = database.transaction(['projects', 'sections', 'todos', 'syncQueue'], 'readwrite');
      signal?.addEventListener?.('abort', () => {
        try { tx.abort(); } catch {}
      }, { once: true });
      const stores = Object.fromEntries(['projects', 'sections', 'todos', 'syncQueue']
        .map(name => [name, tx.objectStore(name)]));
      let pendingReads = 4;

      const mergeRecords = (stored, projected) => {
        const merged = new Map();
        for (const record of [...(stored || []), ...(projected || [])]) {
          if (record?.id !== undefined && record?.id !== null) merged.set(String(record.id), record);
        }
        return [...merged.values()];
      };
      const deleteTypedKey = (store, id) => {
        store.delete(id);
        if (typeof id === 'number' && Number.isInteger(id)) store.delete(String(id));
        if (typeof id === 'string' && /^\d+$/.test(id)) store.delete(Number(id));
      };
      const finalize = () => {
        if (--pendingReads > 0) return;
        const projects = mergeRecords(records.projects, projectedProjects);
        const sections = mergeRecords(records.sections, projectedSections);
        const todos = mergeRecords(records.todos, projectedTodos);
        const blockedProjects = new Set(roots);
        const blockedSections = new Set();
        const blockedTodos = new Set();
        const queueEntries = records.syncQueue || [];
        const hasProject = id => projects.some(project => String(project?.id) === String(id));
        const hasSection = id => sections.some(section => String(section?.id) === String(id));
        const hasTodo = id => todos.some(todo => String(todo?.id) === String(id));
        const queueEntityStillAccessible = item => {
          const data = item?.data || {};
          if (['UPDATE_SECTION', 'DELETE_SECTION'].includes(item?.action)) return accessibleSections.has(String(data.id));
          if (['UPDATE_TODO', 'DELETE_TODO'].includes(item?.action)) return accessibleTodos.has(String(data.id));
          return ['CREATE_COMMENT', 'UPDATE_COMMENT', 'DELETE_COMMENT', 'CREATE_SUBTASK', 'UPDATE_SUBTASK', 'DELETE_SUBTASK']
            .includes(item?.action) && accessibleTodos.has(String(data.todo_id));
        };
        const queueProjectBoundary = data => {
          const ids = Array.isArray(data.project_boundary_ids) && data.project_boundary_ids.length
            ? data.project_boundary_ids : [data.project_id];
          const boundary = [];
          for (const id of ids) {
            // A separately authorized child cuts off the revoked ancestor's
            // boundary, including pending local descendants of that child.
            if (id != null && accessible.has(String(id))) break;
            if (id != null) boundary.push(id);
          }
          return boundary;
        };
        const queueBoundaryTouchesRevokedRoot = item => {
          const data = item?.data || {};
          return queueProjectBoundary(data).some(id => roots.includes(String(id)));
        };
        for (const item of queueEntries) {
          if (queueEntityStillAccessible(item)) continue;
          if (!queueBoundaryTouchesRevokedRoot(item)) continue;
          const action = String(item?.action || '');
          const data = item?.data || {};
          if (action === 'CREATE_PROJECT' && data._tempId != null && !accessible.has(String(data._tempId)) && hasProject(data._tempId)) blockedProjects.add(String(data._tempId));
          if (['UPDATE_PROJECT', 'DELETE_PROJECT'].includes(action) && data.id != null && !accessible.has(String(data.id)) && hasProject(data.id)) blockedProjects.add(String(data.id));
          if (action === 'CREATE_SECTION' && data._tempId != null && hasSection(data._tempId)) blockedSections.add(String(data._tempId));
          if (['UPDATE_SECTION', 'DELETE_SECTION'].includes(action) && data.id != null && hasSection(data.id)) blockedSections.add(String(data.id));
          if (action === 'CREATE_TODO' && data._tempId != null && hasTodo(data._tempId)) blockedTodos.add(String(data._tempId));
          if (['UPDATE_TODO', 'DELETE_TODO'].includes(action) && data.id != null && hasTodo(data.id)) blockedTodos.add(String(data.id));
          if (data.todo_id != null && hasTodo(data.todo_id)) blockedTodos.add(String(data.todo_id));
        }
        let changed = true;
        while (changed) {
          changed = false;
          for (const project of projects) {
            if (project?.id == null || project?.parent_id == null) continue;
            const id = String(project.id);
            if (!accessible.has(id) && !blockedProjects.has(id) && blockedProjects.has(String(project.parent_id))) {
              blockedProjects.add(id);
              changed = true;
            }
          }
          for (const section of sections) {
            if (section?.id == null || accessibleSections.has(String(section.id)) || !blockedProjects.has(String(section.project_id))) continue;
            const id = String(section.id);
            if (!blockedSections.has(id)) {
              blockedSections.add(id);
              changed = true;
            }
          }
          for (const todo of todos) {
            if (todo?.id == null || accessibleTodos.has(String(todo.id)) || (!blockedProjects.has(String(todo.project_id)) && !blockedSections.has(String(todo.section_id)))) continue;
            const id = String(todo.id);
            if (!blockedTodos.has(id)) {
              blockedTodos.add(id);
              changed = true;
            }
          }
        }

        const knownProjectIds = new Set(projects.filter(project => project?.id != null).map(project => String(project.id)));
        const knownSectionIds = new Set(sections.filter(section => section?.id != null).map(section => String(section.id)));
        const knownTodoIds = new Set(todos.filter(todo => todo?.id != null).map(todo => String(todo.id)));
        const queueReferencesBoundary = item => {
          if (queueEntityStillAccessible(item)) return false;
          const action = String(item?.action || '');
          const data = item?.data || {};
          const changes = data.changes || {};
          const explicitProjectId = data.project_id ?? changes.project_id;
          const boundaryProjectIds = [...queueProjectBoundary(data), changes.project_id]
            .filter(id => id !== undefined && id !== null);
          if (boundaryProjectIds.some(id => blockedProjects.has(String(id)))) return true;
          if (action === 'CREATE_PROJECT') {
            return blockedProjects.has(String(data._tempId)) || blockedProjects.has(String(data.parent_id));
          }
          if (action === 'UPDATE_PROJECT' || action === 'DELETE_PROJECT') {
            if (blockedProjects.has(String(data.id))) return true;
            return action === 'UPDATE_PROJECT' && data.id != null && !knownProjectIds.has(String(data.id));
          }
          if (action === 'CREATE_SECTION') {
            return blockedSections.has(String(data._tempId)) || blockedProjects.has(String(data.project_id));
          }
          if (action === 'UPDATE_SECTION' || action === 'DELETE_SECTION') {
            if (blockedSections.has(String(data.id))) return true;
            return action === 'UPDATE_SECTION'
              && explicitProjectId == null
              && data.id != null
              && !knownSectionIds.has(String(data.id));
          }
          if (action === 'CREATE_TODO') {
            return blockedTodos.has(String(data._tempId))
              || blockedProjects.has(String(data.project_id))
              || blockedSections.has(String(data.section_id));
          }
          if (action === 'UPDATE_TODO' || action === 'DELETE_TODO') {
            if (blockedTodos.has(String(data.id))
              || blockedProjects.has(String(changes.project_id))
              || blockedSections.has(String(changes.section_id))) return true;
            return action === 'UPDATE_TODO'
              && explicitProjectId == null
              && data.id != null
              && !knownTodoIds.has(String(data.id));
          }
          const todoId = data.todo_id;
          if (todoId != null && blockedTodos.has(String(todoId))) return true;
          if (['CREATE_COMMENT', 'UPDATE_COMMENT', 'CREATE_SUBTASK', 'UPDATE_SUBTASK'].includes(action)) {
            return explicitProjectId == null && todoId != null && !knownTodoIds.has(String(todoId));
          }
          return [...blockedTodos].some(blockedTodoId => queueItemReferencesTodo(item, blockedTodoId));
        };

        for (const project of projects) {
          if (project?.id != null && blockedProjects.has(String(project.id))) deleteTypedKey(stores.projects, project.id);
        }
        for (const section of sections) {
          if (section?.id != null && blockedSections.has(String(section.id))) deleteTypedKey(stores.sections, section.id);
        }
        for (const todo of todos) {
          if (todo?.id != null && blockedTodos.has(String(todo.id))) deleteTypedKey(stores.todos, todo.id);
        }
        for (const item of records.syncQueue || []) {
          if (queueReferencesBoundary(item)) stores.syncQueue.delete(item.id);
        }
        records.result = {
          projectIds: [...blockedProjects],
          sectionIds: [...blockedSections],
          todoIds: [...blockedTodos],
        };
      };

      for (const [name, store] of Object.entries(stores)) {
        const request = store.getAll();
        request.onsuccess = () => {
          records[name] = request.result || [];
          finalize();
        };
        request.onerror = () => tx.abort();
      }
    } catch (error) {
      tx?.abort?.();
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(records.result || { projectIds: [], sectionIds: [], todoIds: [] });
    tx.onerror = () => reject(tx.error || new Error('Failed to evict pending project data'));
    tx.onabort = () => reject(signal?.aborted
      ? new DOMException('Pending project eviction was aborted', 'AbortError')
      : (tx.error || new Error('Pending project eviction was aborted')));
  });
}

export function clear(storeName) {
  return new Promise((resolve) => {
    if (!db) { resolve(); return; }
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export function get(storeName, id) {
  return new Promise((resolve) => {
    if (!db) { resolve(null); return; }
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
}

export function remove(storeName, id) {
  return new Promise((resolve) => {
    if (!db) { resolve(); return; }
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** One generation-fenced readiness queue for private binary caches. */
function createReadyCache(storeName) {
  const putWhenReady = (item, isCurrent = () => true, generation = dbGeneration) => {
    const operation = () => generation === dbGeneration && isCurrent() ? put(storeName, item) : Promise.resolve();
    if (generation !== dbGeneration) return Promise.resolve();
    if (dbReady) return operation();
    pendingCacheOperations.push({ generation, run: operation, cancel() {} });
    return Promise.resolve();
  };
  const removeWhenReady = id => {
    const generation = dbGeneration;
    const operation = () => generation === dbGeneration ? remove(storeName, id) : Promise.resolve();
    if (dbReady) return operation();
    pendingCacheOperations.push({ generation, run: operation, cancel() {} });
    return Promise.resolve();
  };
  const getIfReady = id => dbReady ? get(storeName, id) : Promise.resolve(null);
  const getWhenReady = id => dbReady ? get(storeName, id) : new Promise((resolve, reject) => {
    pendingCacheOperations.push({ generation: dbGeneration,
      run: async () => { try { resolve(await get(storeName, id)); } catch (error) { reject(error); throw error; } },
      cancel: () => resolve(null) });
  });
  return { putWhenReady, removeWhenReady, getIfReady, getWhenReady };
}
const avatarCache = createReadyCache('avatars');
export const putAvatarWhenReady = avatarCache.putWhenReady;
export const removeAvatarWhenReady = avatarCache.removeWhenReady;
export const getAvatarIfReady = avatarCache.getIfReady;
export const getAvatarWhenReady = avatarCache.getWhenReady;
const entityImageCache = createReadyCache('entityImages');
export const putEntityImageWhenReady = entityImageCache.putWhenReady;
export const removeEntityImageWhenReady = entityImageCache.removeWhenReady;
export const getEntityImageIfReady = entityImageCache.getIfReady;
export const getEntityImageWhenReady = entityImageCache.getWhenReady;

export function hasDb() {
  return Boolean(db);
}

/** Nested recipe cache and intent share one durable transaction. */
export function commitRecipeMutation({ cookbook, recipe, deleteRecipeId, clearRecipeQueueId, action, data, actor_id, result,
  database = db, timestamp = Date.now() } = {}) {
  if (!database) return Promise.reject(new Error('IndexedDB is not open'));
  if (action && !recipeActions.has(action)) return Promise.reject(new Error('Unknown recipe mutation'));
  return new Promise((resolve, reject) => {
    let tx; let failure;
    try {
      tx = database.transaction(['cookbooks', 'syncQueue', 'entityImages'], 'readwrite');
      const store = tx.objectStore('syncQueue');
      const request = store.getAll();
      request.onsuccess = () => {
        try {
          const queue = request.result || [];
          const target = data?.id ?? data?.temp_id ?? clearRecipeQueueId;
          let related = queue.filter(entry => recipeActions.has(entry.action) && recipeReferences(entry, target));
          if (clearRecipeQueueId != null) {
            related.forEach(entry => store.delete(entry.id));
            related = [];
          }
          tx.objectStore('cookbooks').put(cookbook);
          if (deleteRecipeId != null) {
            const images = tx.objectStore('entityImages').openCursor();
            images.onsuccess = () => { const cursor = images.result; if (!cursor) return;
              if (String(cursor.value.recipe_id) === String(deleteRecipeId) && String(cursor.value.cookbook_id) === String(cookbook.id)) cursor.delete(); cursor.continue(); };
          }
          if (!action) return;
          if (action === 'UPDATE_RECIPE' && related.some(entry => entry.action === 'DELETE_RECIPE')) throw new Error('Recipe is pending deletion');
          const create = related.find(entry => entry.action === 'CREATE_RECIPE');
          const last = related.at(-1);
          // A queued copy refers to this exact source receipt, even before HTTP.
          // Later source edits must get a new receipt rather than changing it.
          const sealed = entry => queue.some(transfer => isRecipeShoppingTransfer(transfer)
            && String(transfer.actor_id) === String(entry.actor_id)
            && transfer.data.source_mutation_id != null
            && transfer.data.source_mutation_id === entry.data.client_mutation_id);
          const record = { ...sanitizeRecipeEntry({ action, data }), actor_id, timestamp, localRecipe: recipe || result };
          const coalesceChanges = previous => {
            const changes = { ...previous, ...record.data.changes };
            // Replacing an unsent steps array must retain the effective PATCH
            // defaults from preceding edits, without widening unrelated fields.
            if (Object.hasOwn(changes, 'steps')) {
              const current = record.localRecipe || cookbook.recipes?.find(row => String(row.id) === String(target)) || previous;
              changes.steps = mergeRecipeStepIngredients(current, record.data.changes).steps;
            }
            return changes;
          };
          if (action === 'DELETE_RECIPE' && create && related.every(entry => !entry.attempted && !sealed(entry))) related.forEach(entry => store.delete(entry.id));
          else if (action === 'UPDATE_RECIPE' && create && !create.attempted && !sealed(create)) store.put({ ...create, data: coalesceChanges(create.data) });
          else if (action === 'UPDATE_RECIPE' && last?.action === 'UPDATE_RECIPE' && !last.attempted && !sealed(last)) store.put({ ...last,
            data: { ...last.data, changes: coalesceChanges(last.data.changes) } });
          else if (action === 'CREATE_RECIPE' && create || action === 'DELETE_RECIPE' && last?.action === 'DELETE_RECIPE') { /* Already queued. */ }
          else {
            if (action === 'DELETE_RECIPE') related.filter(entry => entry.action === 'UPDATE_RECIPE' && !entry.attempted && !sealed(entry)).forEach(entry => store.delete(entry.id));
            store.put(record);
          }
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('Recipe mutation failed'));
    } catch (error) { tx?.abort?.(); reject(error); }
  });
}
export const commitRecipeReplay = replay => commitCookbookReplay(replay);
export function markRecipeMutationAttempt(queueId, { database = db } = {}) {
  return markMetadataMutationAttempt({ contract: { actions: recipeActions }, queueId, database });
}

/** One actor-scoped durable intent; no guessed Shopping merge or cached preview. */
export function commitRecipeShoppingTransfer(mutation, { database = db } = {}) {
  if (!database) return Promise.reject(new Error('IndexedDB is not open'));
  if (!mutation || mutation.actor_id == null) return Promise.reject(new Error('Recipe transfer actor is required'));
  return new Promise((resolve, reject) => {
    let tx, result = null, failure;
    try {
      tx = database.transaction(['syncQueue'], 'readwrite');
      const store = tx.objectStore('syncQueue'), request = store.getAll();
      request.onsuccess = () => {
        try {
          const records = (request.result || []).filter(row => isRecipeShoppingTransfer(row) && String(row.actor_id) === String(mutation.actor_id));
          if (mutation.cancelMutationId != null) {
            const canceled = records.find(row => row.data.client_mutation_id === mutation.cancelMutationId);
            if (canceled && (!canceled.attempted || canceled.blocked)) { store.delete(canceled.id); result = true; }
            else result = false;
            return;
          }
          const entry = sanitizeRecipeShoppingTransfer(mutation);
          if (!entry) throw new Error('Invalid recipe Shopping transfer');
          const duplicate = records.find(row => row.data.client_mutation_id === entry.data.client_mutation_id || String(row.data.recipe_id) === String(entry.data.recipe_id));
          if (duplicate) { result = duplicate; return; }
          result = { ...entry, timestamp: Date.now(), localUpdatedAt: new Date().toISOString() };
          const added = store.add(result);
          added.onsuccess = () => { result.id = added.result; };
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('Recipe Shopping transfer commit failed'));
    } catch (error) { tx?.abort?.(); reject(error); }
  });
}
export function markRecipeShoppingTransferAttempt(queueId, { actorId, database = db } = {}) {
  return markMetadataMutationAttempt({ contract: { actions: new Set([TRANSFER_RECIPE_TO_SHOPPING]) }, queueId, database,
    validateRecord: row => actorId != null && String(row.actor_id) === String(actorId) && !row.blocked });
}
