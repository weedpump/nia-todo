#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createSyncFeature } from '../web/static/js/features/sync.js';
import { createWebSocketClient } from '../web/static/js/features/websocket-client.js';
import { acquireSyncCommitLock, beginSyncQueueWrite, projectPendingTodoChanges, queueItemReferencesTodo } from '../web/static/js/features/todo-pending.js';

function createHarness({ queue, todos, api, projectApi = {}, sectionApi = {}, projects = [], sections = [] }) {
  const stores = {
    syncQueue: structuredClone(queue),
    todos: structuredClone(todos),
    projects: structuredClone(projects),
    sections: structuredClone(sections),
    workspaces: [],
  };
  const feature = createSyncFeature({
    getDb: () => ({}),
    dbGetAll: async store => structuredClone(stores[store] || []),
    dbPut: async (store, item) => {
      stores[store] = [...(stores[store] || []).filter(existing => existing.id !== item.id), structuredClone(item)];
    },
    dbClear: async store => { stores[store] = []; },
    getFromDB: async (store, id) => structuredClone((stores[store] || []).find(item => String(item.id) === String(id)) || null),
    deleteFromDB: async (store, id) => {
      stores[store] = (stores[store] || []).filter(item => String(item.id) !== String(id));
    },
    getTodos: () => stores.todos,
    setTodos: next => { stores.todos = structuredClone(next); },
    getProjects: () => stores.projects,
    setProjects: next => { stores.projects = structuredClone(next); },
    getSections: () => stores.sections,
    setSections: next => { stores.sections = structuredClone(next); },
    getWorkspaces: () => stores.workspaces,
    setWorkspaces: next => { stores.workspaces = structuredClone(next); },
    todosApi: { list: async () => ({ todos: structuredClone(stores.todos) }), ...api },
    projectsApi: { list: async () => ({ projects: [] }), ...projectApi },
    sectionsApi: { listAll: async () => ({ sections: [] }), ...sectionApi },
    workspacesApi: { list: async () => ({ workspaces: [] }) },
    renderStats: () => {},
    renderTodos: () => {},
  });
  return { feature, stores };
}

console.log('🔁 Running offline todo child sync test...');

const calls = [];
let serverTodo = {
  id: 101,
  title: 'Offline parent',
  subtasks: [],
  comments: [],
  comments_count: 0,
};
const api = {
  create: async data => {
    calls.push(['createTodo', data]);
    return structuredClone(serverTodo);
  },
  update: async (todoId, changes) => {
    calls.push(['updateTodo', todoId, changes]);
    serverTodo = { ...serverTodo, ...structuredClone(changes) };
    return structuredClone(serverTodo);
  },
  createComment: async (todoId, data) => {
    calls.push(['createComment', todoId, data]);
    const comment = { id: 201, todo_id: todoId, user_id: 1, body: data.body, author_display_name: 'Tobi' };
    serverTodo = { ...serverTodo, comments: [...serverTodo.comments, comment], comments_count: serverTodo.comments.length + 1 };
    return { comment: structuredClone(comment), todo: structuredClone(serverTodo) };
  },
  updateComment: async (todoId, commentId, changes) => {
    calls.push(['updateComment', todoId, commentId, changes]);
    serverTodo = {
      ...serverTodo,
      comments: serverTodo.comments.map(comment => comment.id === commentId ? { ...comment, ...changes } : comment),
    };
    return { comment: structuredClone(serverTodo.comments[0]), todo: structuredClone(serverTodo) };
  },
  deleteComment: async (todoId, commentId) => {
    calls.push(['deleteComment', todoId, commentId]);
    serverTodo = { ...serverTodo, comments: serverTodo.comments.filter(comment => comment.id !== commentId), comments_count: 0 };
    return { deleted: commentId, todo: structuredClone(serverTodo) };
  },
};

const { feature, stores } = createHarness({
  queue: [
    { id: 1, action: 'CREATE_TODO', data: { title: 'Offline parent', _tempId: 'temp-todo-1' } },
    {
      id: 2,
      action: 'CREATE_COMMENT',
      data: {
        todo_id: 'temp-todo-1',
        temp_id: 'temp-comment-1',
        body: 'Offline draft',
        local_comment: { id: 'temp-comment-1', todo_id: 'temp-todo-1', user_id: 1, body: 'Offline draft', author_display_name: 'Tobi' },
      },
    },
    { id: 3, action: 'UPDATE_COMMENT', data: { todo_id: 'temp-todo-1', comment_id: 'temp-comment-1', changes: { body: 'Offline edited' } } },
  ],
  todos: [{
    id: 'temp-todo-1',
    title: 'Offline parent',
    subtasks: [],
    comments: [{ id: 'temp-comment-1', todo_id: 'temp-todo-1', user_id: 1, body: 'Offline edited', author_display_name: 'Tobi' }],
    comments_count: 1,
  }],
  api,
});

const result = await feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(result.failCount, 0);
assert.equal(result.successCount, 3);
assert.deepEqual(calls.map(call => call.slice(0, 3)), [
  ['createTodo', { title: 'Offline parent', _tempId: 'temp-todo-1', client_mutation_id: 'temp-todo-1' }],
  ['createComment', 101, { body: 'Offline draft', client_mutation_id: 'temp-comment-1' }],
  ['updateComment', 101, 201],
]);
assert.equal(stores.syncQueue.length, 0, 'all child mutations must leave the queue after successful replay');
assert.equal(stores.todos.length, 1);
assert.equal(stores.todos[0].id, 101, 'dependent child operations must follow the server todo id');
assert.equal(stores.todos[0].comments[0].id, 201, 'dependent comment updates must follow the server comment id');
assert.equal(stores.todos[0].comments[0].body, 'Offline edited');

const stableSubtaskCalls = [];
let subtaskServerTodo = {
  id: 301,
  title: 'Stable subtasks',
  subtasks: [{ id: 10, title: 'Existing', is_done: false, sort_order: 0 }],
  comments: [],
};
const stableSubtaskApi = {
  createSubtask: async (todoId, data) => {
    stableSubtaskCalls.push(['createSubtask', todoId, data]);
    const subtask = { id: 11, ...data };
    subtaskServerTodo = { ...subtaskServerTodo, subtasks: [...subtaskServerTodo.subtasks, subtask] };
    return { subtask: structuredClone(subtask), todo: structuredClone(subtaskServerTodo) };
  },
  updateSubtask: async (todoId, subtaskId, changes) => {
    stableSubtaskCalls.push(['updateSubtask', todoId, subtaskId, changes]);
    subtaskServerTodo = {
      ...subtaskServerTodo,
      subtasks: subtaskServerTodo.subtasks.map(subtask => subtask.id === subtaskId ? { ...subtask, ...changes } : subtask),
    };
    return { subtask: structuredClone(subtaskServerTodo.subtasks.find(subtask => subtask.id === subtaskId)), todo: structuredClone(subtaskServerTodo) };
  },
};
const stableSubtaskHarness = createHarness({
  queue: [
    {
      id: 10,
      action: 'CREATE_SUBTASK',
      data: {
        todo_id: 301,
        temp_id: 'temp-subtask-1',
        subtask: { title: 'Created offline', is_done: false, sort_order: 1 },
        local_subtask: { id: 'temp-subtask-1', title: 'Created offline', is_done: false, sort_order: 1 },
      },
    },
    { id: 11, action: 'UPDATE_SUBTASK', data: { todo_id: 301, subtask_id: 'temp-subtask-1', changes: { is_done: true } } },
  ],
  todos: [{
    ...subtaskServerTodo,
    subtasks: [...subtaskServerTodo.subtasks, { id: 'temp-subtask-1', title: 'Created offline', is_done: true, sort_order: 1 }],
  }],
  api: stableSubtaskApi,
});
const stableSubtaskResult = await stableSubtaskHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(stableSubtaskResult.failCount, 0);
assert.deepEqual(stableSubtaskCalls.map(call => call.slice(0, 3)), [
  ['createSubtask', 301, { title: 'Created offline', is_done: false, sort_order: 1, client_mutation_id: 'temp-subtask-1' }],
  ['updateSubtask', 301, 11],
]);
assert.deepEqual(stableSubtaskHarness.stores.todos[0].subtasks.map(subtask => subtask.id), [10, 11], 'subtask replay must preserve existing IDs and map only the temporary child ID');
assert.equal(stableSubtaskHarness.stores.todos[0].subtasks[1].is_done, true);

let releaseCreateTodo;
let createTodoStarted;
const createTodoGate = new Promise(resolve => { releaseCreateTodo = resolve; });
const createTodoSignal = new Promise(resolve => { createTodoStarted = resolve; });
let concurrentServerTodo = { id: 401, title: 'Concurrent parent', comments: [], subtasks: [] };
const concurrentApi = {
  create: async () => {
    createTodoStarted();
    await createTodoGate;
    return structuredClone(concurrentServerTodo);
  },
  createComment: async (todoId, data) => {
    assert.equal(todoId, 401, 'a child queued during CREATE_TODO must be rewritten to the server todo ID');
    const comment = { id: 402, todo_id: todoId, body: data.body };
    concurrentServerTodo = { ...concurrentServerTodo, comments: [comment], comments_count: 1 };
    return { comment, todo: structuredClone(concurrentServerTodo) };
  },
};
const concurrentHarness = createHarness({
  queue: [{ id: 20, action: 'CREATE_TODO', data: { title: 'Concurrent parent', _tempId: 'temp-concurrent' } }],
  todos: [{ id: 'temp-concurrent', title: 'Concurrent parent', comments: [], subtasks: [] }],
  api: concurrentApi,
});
const concurrentSyncRef = { value: false };
const concurrentSync = concurrentHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: concurrentSyncRef });
await createTodoSignal;
concurrentHarness.stores.syncQueue.push({
  id: 21,
  action: 'CREATE_COMMENT',
  data: {
    todo_id: 'temp-concurrent',
    temp_id: 'temp-concurrent-comment',
    body: 'Queued during sync',
    local_comment: { id: 'temp-concurrent-comment', todo_id: 'temp-concurrent', body: 'Queued during sync' },
  },
});
concurrentHarness.stores.todos[0].comments.push({ id: 'temp-concurrent-comment', todo_id: 'temp-concurrent', body: 'Queued during sync' });
const overlappingSync = await concurrentHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: concurrentSyncRef });
assert.equal(overlappingSync.skipped, true, 'an overlapping sync request must be coalesced instead of racing the active drain');
releaseCreateTodo();
const concurrentResult = await concurrentSync;
assert.equal(concurrentResult.failCount, 0);
assert.equal(concurrentHarness.stores.syncQueue.length, 0, 'mutations queued during a running sync must be drained');
assert.equal(concurrentHarness.stores.todos[0].comments[0].id, 402);

const tombstoneApi = {
  createComment: async (todoId, data) => ({
    comment: { id: 502, todo_id: todoId, body: data.body },
    todo: { id: todoId, title: 'Deleted locally', comments: [{ id: 502, todo_id: todoId, body: data.body }], subtasks: [] },
  }),
};
const tombstoneHarness = createHarness({
  queue: [
    { id: 30, action: 'CREATE_COMMENT', data: { todo_id: 501, temp_id: 'temp-comment-delete', body: 'Before delete', local_comment: { id: 'temp-comment-delete', todo_id: 501, body: 'Before delete' } } },
    { id: 31, action: 'DELETE_TODO', data: { id: 501, undo_grace_until: Date.now() + 60000 } },
  ],
  todos: [],
  api: tombstoneApi,
});
await tombstoneHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(tombstoneHarness.stores.todos.length, 0, 'a pending todo deletion must remain a local tombstone during child replay');
assert.deepEqual(tombstoneHarness.stores.syncQueue.map(item => item.action), ['DELETE_TODO']);

const projectedRealtimeTodo = projectPendingTodoChanges(
  { id: 601, comments: [{ id: 1, body: 'Server stale' }], subtasks: [{ id: 2, title: 'Server stale', is_done: false }] },
  [
    { action: 'UPDATE_COMMENT', data: { todo_id: 601, comment_id: 1, changes: { body: 'Local newer' } } },
    { action: 'UPDATE_SUBTASK', data: { todo_id: 601, subtask_id: 2, changes: { title: 'Local newer', is_done: true } } },
  ],
);
assert.equal(projectedRealtimeTodo.comments[0].body, 'Local newer', 'realtime payloads must retain queued comment changes');
assert.equal(projectedRealtimeTodo.subtasks[0].title, 'Local newer', 'realtime payloads must retain queued subtask changes');
assert.equal(projectedRealtimeTodo.subtasks[0].is_done, true);

const duplicateUndoEntries = [
  { action: 'CREATE_TODO', data: { _tempId: 'temp-duplicate' } },
  { action: 'CREATE_COMMENT', data: { todo_id: 'temp-duplicate' } },
  { action: 'UPDATE_SUBTASK', data: { todo_id: 'temp-duplicate', subtask_id: 'temp-subtask' } },
  { action: 'UPDATE_TODO', data: { id: 'other-todo' } },
  { action: 'DELETE_PROJECT', data: { id: 'temp-duplicate' } },
];
assert.deepEqual(
  duplicateUndoEntries.filter(item => queueItemReferencesTodo(item, 'temp-duplicate')).map(item => item.action),
  ['CREATE_TODO', 'CREATE_COMMENT', 'UPDATE_SUBTASK'],
  'undoing a temporary duplicate must identify every dependent child queue entry',
);

let signalParentCreate;
let releaseParentCreate;
const parentCreateStarted = new Promise(resolve => { signalParentCreate = resolve; });
const parentCreateGate = new Promise(resolve => { releaseParentCreate = resolve; });
const parentCreateCalls = [];
const parentCreateHarness = createHarness({
  queue: [{ id: 35, action: 'CREATE_TODO', data: { title: 'Offline parent', _tempId: 'temp-parent' } }],
  todos: [{ id: 'temp-parent', title: 'Offline parent', comments: [{ id: 'temp-late-comment', todo_id: 'temp-parent', body: 'Late child' }], subtasks: [] }],
  api: {
    create: async () => {
      signalParentCreate();
      await parentCreateGate;
      return { id: 735, title: 'Offline parent', comments: [], subtasks: [] };
    },
    createComment: async (todoId, data) => {
      parentCreateCalls.push([todoId, data]);
      const comment = { id: 736, todo_id: todoId, body: data.body };
      return { comment, todo: { id: todoId, title: 'Offline parent', comments: [comment], subtasks: [] } };
    },
  },
});
const parentCreateRef = { value: false };
const parentCreateSync = parentCreateHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: parentCreateRef });
await parentCreateStarted;
const finishLateChildWrite = await beginSyncQueueWrite(parentCreateRef);
parentCreateHarness.stores.syncQueue.push({
  id: 36,
  action: 'CREATE_COMMENT',
  data: { todo_id: 'temp-parent', temp_id: 'temp-late-comment', body: 'Late child', local_comment: { id: 'temp-late-comment', todo_id: 'temp-parent', body: 'Late child' } },
});
finishLateChildWrite();
releaseParentCreate();
await parentCreateSync;
assert.equal(parentCreateCalls[0][0], 735, 'a child queued during parent creation must use the rewritten server todo ID');
assert.equal(parentCreateHarness.stores.syncQueue.length, 0);

const projectDeleteCalls = [];
const entityCollisionHarness = createHarness({
  queue: [
    { id: 37, action: 'CREATE_TODO', data: { title: 'Collision parent', _tempId: 'temp-collision' } },
    { id: 38, action: 'DELETE_PROJECT', data: { id: 'temp-collision' } },
  ],
  todos: [{ id: 'temp-collision', title: 'Collision parent', comments: [], subtasks: [] }],
  api: { create: async () => ({ id: 737, title: 'Collision parent', comments: [], subtasks: [] }) },
  projectApi: {
    delete: async projectId => {
      projectDeleteCalls.push(projectId);
      return { deleted_ids: [projectId] };
    },
  },
});
await entityCollisionHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.deepEqual(projectDeleteCalls, ['temp-collision'], 'todo ID rewrites must not modify project queue actions with a colliding ID');

let signalTodoUpdate;
let releaseTodoUpdate;
const todoUpdateStarted = new Promise(resolve => { signalTodoUpdate = resolve; });
const todoUpdateGate = new Promise(resolve => { releaseTodoUpdate = resolve; });
const updateReplayHarness = createHarness({
  queue: [{ id: 39, action: 'UPDATE_TODO', data: { id: 739, changes: { title: 'Server update' } } }],
  todos: [{ id: 739, title: 'Optimistic title', comments: [], subtasks: [] }],
  api: {
    update: async () => {
      signalTodoUpdate();
      await todoUpdateGate;
      return { id: 739, title: 'Server update', comments: [], subtasks: [] };
    },
    createComment: async () => {
      const error = new Error('simulated transient child failure');
      error.status = 500;
      throw error;
    },
  },
});
const updateReplayRef = { value: false };
const updateReplay = updateReplayHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: updateReplayRef });
await todoUpdateStarted;
const finishUpdateChildWrite = await beginSyncQueueWrite(updateReplayRef);
updateReplayHarness.stores.syncQueue.push({ id: 40, action: 'CREATE_COMMENT', data: { todo_id: 739, temp_id: 'temp-update-child', body: 'Must survive', local_comment: { id: 'temp-update-child', todo_id: 739, body: 'Must survive' } } });
updateReplayHarness.stores.todos[0].comments.push({ id: 'temp-update-child', todo_id: 739, body: 'Must survive' });
finishUpdateChildWrite();
releaseTodoUpdate();
await updateReplay;
assert.deepEqual(updateReplayHarness.stores.syncQueue.map(item => item.action), ['CREATE_COMMENT']);
assert.equal(updateReplayHarness.stores.todos[0].comments[0].body, 'Must survive', 'todo replay must project a child queued while the request was active');

let signalTodoDelete;
let releaseTodoDelete;
const todoDeleteStarted = new Promise(resolve => { signalTodoDelete = resolve; });
const todoDeleteGate = new Promise(resolve => { releaseTodoDelete = resolve; });
const deleteReplayHarness = createHarness({
  queue: [{ id: 41, action: 'DELETE_TODO', data: { id: 741 } }],
  todos: [{ id: 741, title: 'Delete me', comments: [], subtasks: [] }],
  api: {
    delete: async () => {
      signalTodoDelete();
      await todoDeleteGate;
      return { deleted: 741 };
    },
  },
});
const deleteReplayRef = { value: false };
const deleteReplay = deleteReplayHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: deleteReplayRef });
await todoDeleteStarted;
const finishDeleteChildWrite = await beginSyncQueueWrite(deleteReplayRef);
deleteReplayHarness.stores.syncQueue.push({ id: 42, action: 'UPDATE_COMMENT', data: { todo_id: 741, comment_id: 99, changes: { body: 'Late mutation' } } });
finishDeleteChildWrite();
releaseTodoDelete();
await deleteReplay;
assert.equal(deleteReplayHarness.stores.todos.length, 0);
assert.equal(deleteReplayHarness.stores.syncQueue.length, 0, 'confirmed parent deletion must remove children queued while the delete request was active');

const poisonedHarness = createHarness({
  queue: [
    { id: 40, action: 'CREATE_COMMENT', data: { todo_id: 701, temp_id: 'temp-poison', body: 'Will fail', local_comment: { id: 'temp-poison', todo_id: 701, body: 'Will fail' } } },
    { id: 41, action: 'DELETE_TODO', data: { id: 701 } },
  ],
  todos: [],
  api: {
    createComment: async () => {
      const error = new Error('simulated child failure');
      error.status = 500;
      throw error;
    },
    delete: async () => ({ deleted: 701 }),
  },
});
await poisonedHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(poisonedHarness.stores.syncQueue.length, 0, 'a confirmed parent deletion must remove failed child work for that todo');

const permanentFailureHarness = createHarness({
  queue: [
    { id: 42, action: 'UPDATE_COMMENT', data: { todo_id: 702, comment_id: 88, changes: { body: 'Rejected' } } },
    { id: 43, action: 'UPDATE_SUBTASK', data: { todo_id: 702, subtask_id: 89, changes: { is_done: true } } },
  ],
  todos: [{ id: 702, title: 'Server authoritative', comments: [{ id: 88, body: 'Optimistic' }], subtasks: [{ id: 89, title: 'Pending retry', is_done: true }] }],
  api: {
    updateComment: async () => {
      const error = new Error('simulated authorization loss');
      error.status = 403;
      throw error;
    },
    updateSubtask: async () => {
      const error = new Error('simulated transient server failure');
      error.status = 500;
      throw error;
    },
    list: async () => ({ todos: [{ id: 702, title: 'Server authoritative', comments: [{ id: 88, body: 'Original' }], subtasks: [{ id: 89, title: 'Pending retry', is_done: false }] }] }),
  },
});
await permanentFailureHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.deepEqual(permanentFailureHarness.stores.syncQueue.map(item => item.action), ['UPDATE_SUBTASK'], 'only the transient child mutation should remain queued');
assert.equal(permanentFailureHarness.stores.todos[0].comments[0].body, 'Original', 'a permanent child 4xx must restore authoritative server state even when another replay fails transiently');
assert.equal(permanentFailureHarness.stores.todos[0].subtasks[0].is_done, true, 'authoritative recovery must project remaining retryable work');

let skippedRefreshFetches = 0;
const skippedRefreshHarness = createHarness({
  queue: [{ id: 420, action: 'UPDATE_SUBTASK', data: { todo_id: 702, subtask_id: 89, changes: { is_done: true } } }],
  todos: [{ id: 702, title: 'Queued', subtasks: [{ id: 89, title: 'Still pending', is_done: true }] }],
  api: {
    updateSubtask: async () => {
      const error = new Error('still offline');
      error.status = 503;
      throw error;
    },
    list: async () => { skippedRefreshFetches += 1; return { todos: [] }; },
  },
});
const skippedRefresh = await skippedRefreshHarness.feature.refreshFromServer({
  wsState: 'connected',
  syncInProgressRef: { value: false },
});
assert.equal(skippedRefresh.refreshed, false, 'a refresh skipped for pending queue work must report non-authoritative state');
assert.equal(skippedRefreshFetches, 0);

const missingParentRecoveryHarness = createHarness({
  queue: [
    { id: 44, action: 'UPDATE_COMMENT', data: { todo_id: 703, comment_id: 90, changes: { body: 'Rejected' } } },
    { id: 45, action: 'UPDATE_SUBTASK', data: { todo_id: 703, subtask_id: 91, changes: { is_done: true } } },
  ],
  todos: [{ id: 703, title: 'Deleted remotely', comments: [{ id: 90, body: 'Optimistic' }], subtasks: [{ id: 91, title: 'Retry', is_done: true }] }],
  api: {
    updateComment: async () => {
      const error = new Error('simulated permanent failure');
      error.status = 403;
      throw error;
    },
    updateSubtask: async () => {
      const error = new Error('simulated transient failure');
      error.status = 500;
      throw error;
    },
    list: async () => ({ todos: [] }),
  },
});
await missingParentRecoveryHarness.feature.syncWithServer({ wsState: 'connected', syncInProgressRef: { value: false } });
assert.equal(missingParentRecoveryHarness.stores.todos.length, 0);
assert.equal(missingParentRecoveryHarness.stores.syncQueue.length, 0, 'authoritative parent absence must remove all remaining child work');

let releaseRefreshList;
let refreshListStarted;
const refreshListGate = new Promise(resolve => { releaseRefreshList = resolve; });
const refreshListSignal = new Promise(resolve => { refreshListStarted = resolve; });
const refreshRaceHarness = createHarness({
  queue: [],
  todos: [],
  api: {
    list: async () => {
      refreshListStarted();
      await refreshListGate;
      return { todos: [{ id: 801, title: 'Stale server todo', comments: [], subtasks: [] }] };
    },
  },
});
const refreshRaceRef = { value: false };
const refreshRace = refreshRaceHarness.feature.refreshFromServer({ wsState: 'connected', syncInProgressRef: refreshRaceRef });
await refreshListSignal;
refreshRaceHarness.stores.syncQueue.push({ id: 50, action: 'DELETE_TODO', data: { id: 801, undo_grace_until: Date.now() + 60000 } });
releaseRefreshList();
await refreshRace;
assert.equal(refreshRaceHarness.stores.todos.length, 0, 'a full refresh must not restore a todo deleted while its REST snapshot was loading');
assert.deepEqual(refreshRaceHarness.stores.syncQueue.map(item => item.action), ['DELETE_TODO']);

let releasePrivacyRefresh;
let signalPrivacyRefresh;
const privacyRefreshGate = new Promise(resolve => { releasePrivacyRefresh = resolve; });
const privacyRefreshStarted = new Promise(resolve => { signalPrivacyRefresh = resolve; });
const privacyRefreshHarness = createHarness({
  queue: [],
  todos: [],
  api: {
    list: async () => {
      signalPrivacyRefresh();
      await privacyRefreshGate;
      return { todos: [{ id: 802, project_id: 82, title: 'Stale private refresh' }] };
    },
  },
  projects: [{ id: 82, name: 'Private project' }],
  sections: [],
  projectApi: { list: async () => ({ projects: [{ id: 82, name: 'Private project' }] }) },
});
const privacyRefreshRef = { value: false, privacyGeneration: 0 };
const stalePrivacyRefresh = privacyRefreshHarness.feature.refreshFromServer({ wsState: 'connected', syncInProgressRef: privacyRefreshRef });
await privacyRefreshStarted;
privacyRefreshHarness.stores.todos = [];
privacyRefreshHarness.stores.projects = [];
privacyRefreshRef.privacyGeneration += 1;
releasePrivacyRefresh();
const stalePrivacyRefreshResult = await stalePrivacyRefresh;
assert.equal(stalePrivacyRefreshResult.refreshed, false, 'a REST full refresh started before privacy eviction must report a discarded response');
assert.deepEqual(privacyRefreshHarness.stores.todos, [], 'a stale REST full refresh must not restore evicted todos');
assert.deepEqual(privacyRefreshHarness.stores.projects, [], 'a stale REST full refresh must not restore evicted projects');

const commitLockRef = {};
const releaseCommitLock = await acquireSyncCommitLock(commitLockRef);
let queueWriteStarted = false;
const blockedQueueWrite = beginSyncQueueWrite(commitLockRef).then(finish => {
  queueWriteStarted = true;
  finish();
});
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(queueWriteStarted, false, 'queue writes must wait while a full-sync commit lock is held');
releaseCommitLock();
await blockedQueueWrite;
assert.equal(queueWriteStarted, true);

const originalWebSocket = globalThis.WebSocket;
const websocketMessages = [];
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  constructor() {
    this.readyState = FakeWebSocket.CONNECTING;
    FakeWebSocket.instance = this;
  }

  send(payload) {
    websocketMessages.push(JSON.parse(payload));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}
globalThis.WebSocket = FakeWebSocket;

const websocketStores = {
  syncQueue: [],
  todos: [{ id: 901, title: 'Committed server todo', comments: [{ id: 99, body: 'Saved' }], subtasks: [], updated_at: '2026-10-18T00:00:01Z' }],
  projects: [],
  sections: [],
  workspaces: [],
};
const websocketSyncRef = { value: true };
const websocketClient = createWebSocketClient({
  wsUrl: 'ws://unused.invalid',
  getAuthToken: () => 'test-token',
  syncWithServer: async () => {},
  syncInProgressRef: websocketSyncRef,
  renderConnectionStatus: () => {},
  dbGetAll: async store => structuredClone(websocketStores[store] || []),
  dbPut: async (store, item) => {
    websocketStores[store] = [...(websocketStores[store] || []).filter(existing => String(existing.id) !== String(item.id)), structuredClone(item)];
  },
  getFromDB: async (store, id) => structuredClone((websocketStores[store] || []).find(item => String(item.id) === String(id)) || null),
  deleteFromDB: async (store, id) => { websocketStores[store] = (websocketStores[store] || []).filter(item => String(item.id) !== String(id)); },
  getTodos: () => websocketStores.todos,
  setTodos: next => { websocketStores.todos = structuredClone(next); },
  getProjects: () => websocketStores.projects,
  setProjects: next => { websocketStores.projects = structuredClone(next); },
  getSections: () => websocketStores.sections,
  setSections: next => { websocketStores.sections = structuredClone(next); },
  getWorkspaces: () => websocketStores.workspaces,
  setWorkspaces: next => { websocketStores.workspaces = structuredClone(next); },
  renderWorkspaces: () => {},
  renderProjects: () => {},
  renderStats: () => {},
  renderTodos: () => {},
});
websocketClient.connectWebSocket();
FakeWebSocket.instance.readyState = FakeWebSocket.OPEN;
const staleSyncResponse = websocketClient.handleWsMessage({
  type: 'sync_response',
  todos: [{ id: 901, title: 'Stale server todo', comments: [{ id: 'temp-c', body: 'Saved', is_pending: true }], subtasks: [], updated_at: '2026-10-18T00:00:00Z' }],
  projects: [],
  sections: [],
  workspaces: [],
});
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(websocketMessages.length, 0, 'a full-sync payload received during replay must wait for the queue drain');
websocketSyncRef.value = false;
await staleSyncResponse;
assert.deepEqual(websocketMessages, [{ type: 'sync_request' }], 'a stale full-sync payload must request a fresh WebSocket snapshot');
assert.equal(websocketStores.todos[0].comments[0].id, 99, 'the stale payload must not restore a temporary child ID');

websocketSyncRef.value = true;
websocketSyncRef.refreshing = true;
const staleDuringRefresh = websocketClient.handleWsMessage({
  type: 'sync_response',
  todos: [{ id: 901, title: 'Older refresh snapshot', comments: [], subtasks: [], updated_at: '2026-10-17T23:59:59Z' }],
  projects: [],
  sections: [],
  workspaces: [],
});
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(websocketMessages.length, 1, 'a full-sync payload received during REST refresh must wait');
websocketSyncRef.value = false;
websocketSyncRef.refreshing = false;
await staleDuringRefresh;
assert.deepEqual(
  websocketMessages,
  [{ type: 'sync_request' }, { type: 'sync_request' }],
  'a stale payload received during REST refresh must request a newer WebSocket snapshot',
);
assert.equal(websocketStores.todos[0].comments[0].id, 99);

websocketStores.syncQueue = [{ id: 60, action: 'CREATE_TODO', data: { title: 'Local create', _tempId: 'temp-own-create' } }];
websocketStores.todos = [{ id: 'temp-own-create', title: 'Local create', comments: [], subtasks: [] }];
websocketSyncRef.value = true;
const realtimeOwnCreate = websocketClient.handleWsMessage({
  type: 'todo_create',
  payload: { id: 902, title: 'Local create', comments: [], subtasks: [] },
});
await new Promise(resolve => setTimeout(resolve, 20));
assert.deepEqual(
  websocketStores.todos.map(todo => todo.id),
  ['temp-own-create'],
  'a realtime echo received during local create sync must not render beside its temporary todo',
);
websocketStores.syncQueue = [];
websocketStores.todos = [{ id: 902, title: 'Local create', comments: [], subtasks: [] }];
websocketSyncRef.value = false;
await realtimeOwnCreate;
assert.deepEqual(websocketStores.todos.map(todo => todo.id), [902]);

websocketStores.todos = [];
websocketStores.syncQueue = [{ id: 61, action: 'DELETE_TODO', data: { id: 902, undo_grace_until: Date.now() + 5000 } }];
await websocketClient.handleWsMessage({
  type: 'todo_create', payload: { id: 902, title: 'Create echo after optimistic deletion', comments: [], subtasks: [] },
});
assert.deepEqual(websocketStores.todos, [], 'a create echo must keep a pending-deleted Todo out of cache and UI');
assert.equal(websocketStores.syncQueue[0].action, 'DELETE_TODO', 'the create echo must retain the server deletion intent');
websocketStores.syncQueue = [];

websocketSyncRef.value = false;
websocketSyncRef.privacyGeneration = 0;
websocketStores.projects = [{ id: 980, name: 'Private project' }];
websocketStores.sections = [{ id: 981, project_id: 980, name: 'Private section' }];
websocketStores.todos = [{ id: 982, project_id: 980, section_id: 981, title: 'Private todo', attachments: [] }];
const releaseRealtimeEvictionLock = await acquireSyncCommitLock(websocketSyncRef);
const staleProjectDelta = websocketClient.handleWsMessage({
  type: 'project_update',
  payload: { id: 980, name: 'Stale private project' },
});
const staleSectionDelta = websocketClient.handleWsMessage({
  type: 'section_update',
  payload: { id: 981, project_id: 980, name: 'Stale private section', updated_at: '2026-10-18T00:00:00Z' },
});
const staleAttachmentDelta = websocketClient.handleWsMessage({
  type: 'todo_attachment_create',
  payload: { todo_id: 982, attachment: { id: 983, filename: 'private.txt' }, attachments_count: 1 },
});
await new Promise(resolve => setTimeout(resolve, 10));
websocketStores.projects = [];
websocketStores.sections = [];
websocketStores.todos = [];
websocketSyncRef.privacyGeneration += 1;
releaseRealtimeEvictionLock();
await Promise.all([staleProjectDelta, staleSectionDelta, staleAttachmentDelta]);
assert.deepEqual(websocketStores.projects, [], 'a stale project delta must not reinsert data after privacy eviction');
assert.deepEqual(websocketStores.sections, [], 'a stale section delta must not reinsert data after privacy eviction');
assert.deepEqual(websocketStores.todos, [], 'a stale attachment delta must not reinsert todo data after privacy eviction');

await websocketClient.handleWsMessage({ type: 'project_update', payload: { id: 980, name: 'Post-eviction delta' } });
await websocketClient.handleWsMessage({ type: 'project_update_many', payload: { projects: [{ id: 980, name: 'Post-eviction batch delta' }] } });
await websocketClient.handleWsMessage({ type: 'project_create', payload: { id: 984, parent_id: 980, name: 'Missing-parent child' } });
await websocketClient.handleWsMessage({ type: 'project_create', payload: { id: 985, parent_id: null, name: 'Root access gain' } });
assert.deepEqual(
  websocketStores.projects,
  [],
  'project deltas after completed eviction must require an existing local project/parent and root access gains must wait for a snapshot',
);

let releaseRevokedReplay;
let signalRevokedReplay;
const revokedReplayGate = new Promise(resolve => { releaseRevokedReplay = resolve; });
const revokedReplayStarted = new Promise(resolve => { signalRevokedReplay = resolve; });
const revokedReplayHarness = createHarness({
  queue: [{ id: 70, action: 'UPDATE_TODO', data: { id: 970, changes: { title: 'Private edit' } } }],
  todos: [{ id: 970, title: 'Private old', comments: [], subtasks: [] }],
  api: {
    update: async () => {
      signalRevokedReplay();
      await revokedReplayGate;
      return { id: 970, title: 'Private edit', comments: [], subtasks: [] };
    },
  },
});
const revokedReplaySync = revokedReplayHarness.feature.syncWithServer({
  wsState: 'connected',
  syncInProgressRef: { value: false },
});
await revokedReplayStarted;
revokedReplayHarness.stores.syncQueue = [];
revokedReplayHarness.stores.todos = [];
releaseRevokedReplay();
await revokedReplaySync;
assert.deepEqual(
  revokedReplayHarness.stores.todos,
  [],
  'a replay response must not reinsert a todo after privacy eviction removed its queue entry',
);

let releaseRevokedProjectReplay;
let signalRevokedProjectReplay;
const revokedProjectReplayGate = new Promise(resolve => { releaseRevokedProjectReplay = resolve; });
const revokedProjectReplayStarted = new Promise(resolve => { signalRevokedProjectReplay = resolve; });
const revokedProjectReplayHarness = createHarness({
  queue: [{ id: 71, action: 'UPDATE_PROJECT', data: { id: 971, changes: { name: 'Private project' } } }],
  todos: [],
  projects: [{ id: 971, name: 'Private old' }],
  api: {},
  projectApi: {
    update: async () => {
      signalRevokedProjectReplay();
      await revokedProjectReplayGate;
      return { id: 971, name: 'Private project' };
    },
  },
});
const revokedProjectReplaySync = revokedProjectReplayHarness.feature.syncWithServer({
  wsState: 'connected',
  syncInProgressRef: { value: false },
});
await revokedProjectReplayStarted;
revokedProjectReplayHarness.stores.syncQueue = [];
revokedProjectReplayHarness.stores.projects = [];
releaseRevokedProjectReplay();
await revokedProjectReplaySync;
assert.deepEqual(
  revokedProjectReplayHarness.stores.projects,
  [],
  'a project replay response must not reinsert a project after privacy eviction removed its queue entry',
);

await websocketClient.disconnectWebSocket();
globalThis.WebSocket = originalWebSocket;

// An in-flight create keeps its original target; the queued move follows its real ID.
let signalMovedCreate,releaseMovedCreate;
const movedCreateStarted=new Promise(resolve=>{signalMovedCreate=resolve;});
const movedCreateGate=new Promise(resolve=>{releaseMovedCreate=resolve;});
const movedWrites=[];
const movedCreateHarness=createHarness({
  projects:[{id:801},{id:802}],sections:[{id:811,project_id:801},{id:812,project_id:802}],
  todos:[{id:'temp-moved-memory',title:'Wäsche waschen',project_id:801,section_id:811,comments:[],subtasks:[]}],
  queue:[{id:810,action:'CREATE_TODO',data:{_tempId:'temp-moved-memory',title:'Wäsche waschen',project_id:801,section_id:811}}],
  api:{
    create:async data=>{movedWrites.push(structuredClone(data));signalMovedCreate();await movedCreateGate;return {id:820,title:data.title,project_id:801,section_id:811,comments:[],subtasks:[]};},
    update:async(id,changes)=>{assert.equal(id,820);assert.equal(changes.project_id,802,'a post-create section assignment includes its new project');movedWrites.push(structuredClone(changes));return {id,title:'Wäsche waschen',project_id:changes.project_id,section_id:changes.section_id,comments:[],subtasks:[]};},
  },
});
const movedCreateSync=movedCreateHarness.feature.syncWithServer({wsState:'connected',syncInProgressRef:{value:false}});
await movedCreateStarted;
assert.equal(movedCreateHarness.stores.syncQueue[0].attempted,true,'attempt is durable before transport');
const attemptedCreate=structuredClone(movedCreateHarness.stores.syncQueue[0]);
movedCreateHarness.stores.todos[0]={...movedCreateHarness.stores.todos[0],project_id:802,section_id:812};
movedCreateHarness.stores.syncQueue.push({id:813,action:'UPDATE_TODO',data:{id:'temp-moved-memory',changes:{project_id:802,section_id:812,routing_feedback:{event_id:'move-after-send',generation:0,fields:['list','section']}}}});
assert.deepEqual(movedCreateHarness.stores.syncQueue[0],attemptedCreate);
releaseMovedCreate();
const movedCreateResult=await movedCreateSync;
assert.equal(movedCreateResult.failCount,0);
assert.equal(movedCreateHarness.stores.syncQueue.length,0);
assert.equal(movedWrites.length,2,'one create plus its durable move; no ad-hoc section-only PATCH');
assert.equal(movedCreateHarness.stores.todos[0].project_id,802);
assert.equal(movedCreateHarness.stores.todos[0].section_id,812);

// Personal memory intent survives durable replay but never becomes shared content.
const memoryFeedback = {event_id:'offline-memory-choice',generation:7,fields:['list','section']};
const memoryWrites=[];
const memoryHarness=createHarness({
  projects:[{id:42}],sections:[{id:43,project_id:42}],
  todos:[{id:'temp-memory',title:'Wäsche waschen',project_id:42,section_id:43,comments:[],subtasks:[]}],
  queue:[
    {id:901,action:'CREATE_TODO',data:{_tempId:'temp-memory',title:'Wäsche waschen',project_id:42,section_id:43,routing_feedback:memoryFeedback}},
    {id:902,action:'UPDATE_TODO',data:{id:'temp-memory',changes:{section_id:null,routing_feedback:{...memoryFeedback,event_id:'offline-memory-move',fields:['section']}}}},
  ],
  api:{
    create:async data=>{memoryWrites.push(structuredClone(data));return {id:903,title:data.title,project_id:42,section_id:43,comments:[],subtasks:[]};},
    update:async(id,changes)=>{memoryWrites.push(structuredClone(changes));return {id,title:'Wäsche waschen',project_id:42,section_id:null,comments:[],subtasks:[]};},
  },
});
await memoryHarness.feature.syncWithServer({wsState:'connected',syncInProgressRef:{value:false}});
assert.deepEqual(memoryWrites[0].routing_feedback,memoryFeedback,'create sanitizer preserves stable versioned memory intent');
assert.equal(memoryWrites[1].routing_feedback.event_id,'offline-memory-move','move receipt survives temporary todo ID remapping');
assert.equal(memoryHarness.stores.syncQueue.length,0);
assert.equal(Object.hasOwn(memoryHarness.stores.todos[0],'routing_feedback'),false,'authoritative todo content does not retain personal feedback');
const projectedMemory=projectPendingTodoChanges({id:903,title:'Wäsche waschen'},[{action:'UPDATE_TODO',data:{id:903,changes:{section_id:43,routing_feedback:memoryFeedback}}}]);
assert.equal(projectedMemory.section_id,43);
assert.equal(Object.hasOwn(projectedMemory,'routing_feedback'),false,'pending projection excludes personal learning intent');

console.log('✅ Offline todo child sync test passed');
