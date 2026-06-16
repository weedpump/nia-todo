#!/usr/bin/env node
import { createSyncFeature } from '../web/static/js/features/sync.js';

async function run() {
  console.log('🔁 Running sync feature race guard test...');

  const stores = {
    syncQueue: [{ id: 1, action: 'UPDATE_TODO', data: { id: 42, changes: { title: 'Queued title' } } }],
    todos: [{ id: 42, title: 'Local queued title', updated_at: '2026-06-16T17:00:00Z' }],
    projects: [],
    sections: [],
    workspaces: [],
  };
  const syncInProgressRef = { value: true };
  let listCalledWhileSyncActive = false;
  let listCalls = 0;
  let clearedBeforeQueueDrain = false;

  const feature = createSyncFeature({
    getDb: () => ({}),
    dbGetAll: async store => [...(stores[store] || [])],
    dbPut: async (store, item) => {
      stores[store] = [...(stores[store] || []).filter(existing => existing.id !== item.id), item];
    },
    dbClear: async store => {
      if (stores.syncQueue.length) clearedBeforeQueueDrain = true;
      stores[store] = [];
    },
    getFromDB: async (store, id) => (stores[store] || []).find(item => item.id === id) || null,
    deleteFromDB: async (store, id) => {
      stores[store] = (stores[store] || []).filter(item => item.id !== id);
    },
    getTodos: () => stores.todos,
    setTodos: next => { stores.todos = next; },
    getProjects: () => stores.projects,
    setProjects: next => { stores.projects = next; },
    getSections: () => stores.sections,
    setSections: next => { stores.sections = next; },
    getWorkspaces: () => stores.workspaces,
    setWorkspaces: next => { stores.workspaces = next; },
    todosApi: {
      list: async () => {
        listCalls += 1;
        if (syncInProgressRef.value) listCalledWhileSyncActive = true;
        return { todos: [{ id: 42, title: 'Server title', updated_at: '2026-06-16T17:01:00Z' }] };
      },
      update: async (id, changes) => ({ id, ...changes, updated_at: '2026-06-16T17:00:30Z' }),
    },
    projectsApi: { list: async () => ({ projects: [] }) },
    sectionsApi: { listAll: async () => ({ sections: [] }) },
    workspacesApi: { list: async () => ({ workspaces: [] }) },
    renderStats: () => {},
    renderTodos: () => {},
  });

  setTimeout(() => {
    stores.syncQueue = [];
    syncInProgressRef.value = false;
  }, 100);

  await feature.refreshFromServer({ wsState: 'connected', syncInProgressRef });

  if (listCalledWhileSyncActive) {
    throw new Error('refreshFromServer performed authoritative pull while local sync was active');
  }
  if (clearedBeforeQueueDrain) {
    throw new Error('refreshFromServer cleared local stores before syncQueue was drained');
  }
  if (listCalls !== 1) {
    throw new Error(`Expected one authoritative pull after active sync completed, got ${listCalls}`);
  }
  if (stores.todos[0]?.title !== 'Server title') {
    throw new Error(`Expected server refresh after sync completion, got ${JSON.stringify(stores.todos)}`);
  }

  console.log('✅ Sync feature race guard test passed');
}

await run();
