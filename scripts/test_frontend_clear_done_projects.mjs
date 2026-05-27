#!/usr/bin/env node
import assert from 'node:assert/strict';

// Minimal browser shims required by the imported frontend modules.
Object.defineProperty(globalThis, 'localStorage', {
  value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  configurable: true,
});
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'en', languages: ['en'] },
  configurable: true,
});

const { createProjectsFeature } = await import('../web/static/js/features/projects.js');

async function run() {
  let todos = [
    { id: 1, title: 'done', project_id: 42, status: 'done' },
    { id: 2, title: 'pending', project_id: 42, status: 'pending' },
    { id: 3, title: 'other done', project_id: 7, status: 'done' },
  ];
  const deletedFromDb = [];
  const toasts = [];
  let renderStatsCount = 0;
  let renderTodosCount = 0;

  const feature = createProjectsFeature({
    getProjects: () => [{ id: 42, name: 'Project 42' }, { id: 7, name: 'Other' }],
    getTodos: () => todos,
    setTodos: (next) => { todos = next; },
    getCurrentProjectId: () => 42,
    getCurrentWorkspaceId: () => null,
    getWorkspaces: () => [],
    setProjects: () => {},
    dbPut: async () => {},
    addToSyncQueue: async () => {},
    deleteFromDB: async (store, id) => { deletedFromDb.push([store, id]); },
    isOnlineForSync: () => true,
    syncWithServer: async () => {},
    renderProjects: () => {},
    renderStats: () => { renderStatsCount += 1; },
    renderTodos: () => { renderTodosCount += 1; },
    closeModal: () => {},
    confirmDanger: async () => true,
    showToast: (message) => { toasts.push(message); },
    showBatchToast: () => { throw new Error('clearDoneInProject must not use optimistic batch undo after server-side deletion'); },
    projectsApi: {
      clearDone: async (projectId) => {
        assert.equal(projectId, 42);
        return { deleted_count: 1, deleted_ids: [1] };
      },
    },
    sharingFeature: {},
    getCurrentUser: () => ({ id: 1 }),
  });

  await feature.clearDoneInProject();

  assert.deepEqual(deletedFromDb, [['todos', 1]]);
  assert.deepEqual(todos.map(todo => todo.id), [2, 3]);
  assert.equal(renderStatsCount, 1);
  assert.equal(renderTodosCount, 1);
  assert.equal(toasts.length, 1);
  assert.notEqual(toasts[0], 'project.done.deleteFailed');
}

await run();
console.log('✅ Frontend clear-done project test passed');
