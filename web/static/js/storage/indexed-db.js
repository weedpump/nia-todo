import { DB_NAME, DB_VERSION } from '../core/config.js';
import { queueItemReferencesShoppingList } from '../features/shopping-pending.js';
import { queueItemReferencesTodo } from '../features/todo-pending.js';

let db = null;
let dbReady = false;
let dbGeneration = 0;
const pendingAvatarOperations = [];

function cancelPendingAvatarOperations() {
  const operations = pendingAvatarOperations.splice(0);
  for (const operation of operations) operation.cancel();
}

async function flushPendingAvatarOperations(generation) {
  while (dbReady && generation === dbGeneration && pendingAvatarOperations.length) {
    const operation = pendingAvatarOperations.shift();
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
    cancelPendingAvatarOperations();
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
      await flushPendingAvatarOperations(generation);
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

export function commitShoppingReplay({
  list,
  removeListIds = [],
  store,
  stores = [],
  removeStoreIds = [],
  queueDeleteId,
  queueDeleteIds = [],
  queueRecords = [],
  database = db,
} = {}) {
  if (!database) return Promise.reject(new Error('IndexedDB is not open'));
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = database.transaction(['shoppingLists', 'shoppingStores', 'syncQueue'], 'readwrite');
      const listStore = tx.objectStore('shoppingLists');
      const storeStore = tx.objectStore('shoppingStores');
      const queueStore = tx.objectStore('syncQueue');
      for (const listId of removeListIds) listStore.delete(listId);
      if (list) listStore.put(list);
      for (const storeId of removeStoreIds) storeStore.delete(storeId);
      if (store) storeStore.put(store);
      for (const shoppingStore of stores) storeStore.put(shoppingStore);
      for (const record of queueRecords) queueStore.put(record);
      for (const recordId of queueDeleteIds) queueStore.delete(recordId);
      if (queueDeleteId !== undefined && queueDeleteId !== null) queueStore.delete(queueDeleteId);
    } catch (error) {
      tx?.abort?.();
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to commit shopping replay'));
    tx.onabort = () => reject(tx.error || new Error('Shopping replay transaction was aborted'));
  });
}

export function evictPendingShoppingEntities(listIds, { database = db, signal } = {}) {
  if (!database) return Promise.reject(new Error('IndexedDB is not open'));
  const ids = [...new Set((listIds || []).filter(id => id != null))];
  if (!ids.length) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new DOMException('Pending shopping eviction was aborted', 'AbortError'));
  const blocked = new Set(ids.map(id => String(id)));
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = database.transaction(['shoppingLists', 'shoppingStores', 'syncQueue'], 'readwrite');
      signal?.addEventListener?.('abort', () => {
        try { tx.abort(); } catch {}
      }, { once: true });
      const listsStore = tx.objectStore('shoppingLists');
      const storesStore = tx.objectStore('shoppingStores');
      const queueStore = tx.objectStore('syncQueue');
      for (const id of ids) {
        listsStore.delete(id);
        if (typeof id === 'number' && Number.isInteger(id)) listsStore.delete(String(id));
        if (typeof id === 'string' && /^\d+$/.test(id)) listsStore.delete(Number(id));
      }

      const storesRequest = storesStore.getAll();
      storesRequest.onsuccess = () => {
        for (const store of storesRequest.result || []) {
          if (blocked.has(String(store.shopping_list_id))) storesStore.delete(store.id);
        }
      };
      storesRequest.onerror = () => tx.abort();

      const queueRequest = queueStore.getAll();
      queueRequest.onsuccess = () => {
        const stores = storesRequest.result || [];
        for (const entry of queueRequest.result || []) {
          if (ids.some(id => queueItemReferencesShoppingList(entry, id, stores))) queueStore.delete(entry.id);
        }
      };
      queueRequest.onerror = () => tx.abort();
    } catch (error) {
      tx?.abort?.();
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to evict pending shopping entities'));
    tx.onabort = () => reject(signal?.aborted
      ? new DOMException('Pending shopping eviction was aborted', 'AbortError')
      : (tx.error || new Error('Pending shopping eviction was aborted')));
  });
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

export function putAvatarWhenReady(item, isCurrent = () => true, expectedGeneration = dbGeneration) {
  const operation = () => (
    expectedGeneration === dbGeneration && isCurrent()
      ? put('avatars', item)
      : Promise.resolve()
  );
  if (expectedGeneration !== dbGeneration) return Promise.resolve();
  if (dbReady) return operation();
  pendingAvatarOperations.push({ generation: expectedGeneration, run: operation, cancel() {} });
  return Promise.resolve();
}

export function removeAvatarWhenReady(id) {
  const operation = () => remove('avatars', id);
  if (dbReady) return operation();
  pendingAvatarOperations.push({ generation: dbGeneration, run: operation, cancel() {} });
  return Promise.resolve();
}

export function getAvatarIfReady(id) {
  return dbReady ? get('avatars', id) : Promise.resolve(null);
}

export function getAvatarWhenReady(id) {
  if (dbReady) return get('avatars', id);
  return new Promise((resolve) => {
    pendingAvatarOperations.push({
      generation: dbGeneration,
      run: async () => resolve(await get('avatars', id)),
      cancel: () => resolve(null),
    });
  });
}

export function hasDb() {
  return Boolean(db);
}
