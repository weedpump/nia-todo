#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.location = { origin: 'http://localhost' };

const { createEntityAccessPrivacyController, runAccessFencedCommit, runEntityPrivacyEviction } = await import('../web/static/js/features/entity-access-privacy.js');
const { acquireSyncCommitLock, beginSyncQueueWrite, enrichTaskQueueBoundary, projectPendingProjectChanges, projectPendingTodoChanges, runCurrentEntityMutation } = await import('../web/static/js/features/todo-pending.js');
const { evictPendingProjectEntities } = await import('../web/static/js/storage/indexed-db.js');
const { createSyncFeature } = await import('../web/static/js/features/sync.js');
const { createNavigationFeature } = await import('../web/static/js/features/navigation.js');
const { createMetadataCollection } = await import('../web/static/js/features/entity-metadata.js');

// Snapshot receipts require an actual temporary create from the current actor.
// A visible shared record's arbitrary CMI must never alias a canonical ID.
{
  const metadata = createMetadataCollection({ storeName:'testEntities', createAction:'CREATE_ENTITY', updateAction:'UPDATE_ENTITY', deleteAction:'DELETE_ENTITY' });
  const privateEntity = {id:10,name:'Private',created_by_user_id:1};
  const pendingEdit = {id:1,action:'UPDATE_ENTITY',data:{id:10,changes:{name:'Private pending edit'}}};
  for (const created_by_user_id of [1,2]) {
    const shadow = {id:99,name:'Other visible entity',created_by_user_id,client_mutation_id:'10'};
    const projected = metadata.projectSnapshot([shadow,privateEntity],[privateEntity],[pendingEdit],{actorId:1});
    assert.equal(projected.find(entity=>entity.id===99).name,'Other visible entity','numeric CMI cannot redirect another entity\'s pending content');
    assert.equal(projected.find(entity=>entity.id===10).name,'Private pending edit');
    assert.deepEqual(metadata.collectRevokedIds([shadow],[privateEntity],[pendingEdit],{actorId:1}),[10],'a numeric CMI cannot hide canonical access revocation');
    const forgedCreate={id:2,action:'CREATE_ENTITY',data:{temp_id:10,client_mutation_id:'10'}};
    assert.deepEqual(metadata.reconcileSnapshot([shadow],[privateEntity],[forgedCreate,pendingEdit],{actorId:1}).remaps,[],'a canonical create ID cannot authorize a receipt remap');
  }
  const local={id:'temp-local-entity',name:'Offline',client_mutation_id:'custom-receipt',created_by_user_id:1};
  const create={id:3,action:'CREATE_ENTITY',actor_id:1,data:{temp_id:local.id,client_mutation_id:local.client_mutation_id,name:local.name}};
  const update={id:4,action:'UPDATE_ENTITY',data:{id:local.id,changes:{name:'Keep local edit'}}};
  const own={id:100,name:'Server',client_mutation_id:local.client_mutation_id,created_by_user_id:1};
  const queue=[create,update],before=JSON.stringify(queue);
  assert.deepEqual(metadata.projectSnapshot([own],[local],queue,{actorId:1}).map(entity=>[entity.id,entity.name]),[[100,'Keep local edit']],'a verified receipt remaps the real temporary ID even when CMI differs');
  const reconciled=metadata.reconcileSnapshot([own],[local],queue,{actorId:1});
  assert.deepEqual(reconciled.remaps,[[local.id,100]]);
  assert.deepEqual(reconciled.queueDeleteIds,[create.id]);
  assert.deepEqual(reconciled.revokedIds,[],'a verified temporary acknowledgement is not an access revocation');
  assert.equal(reconciled.entities[0].name,'Keep local edit');
  for (const options of [
    {server:{...own,created_by_user_id:2},queue},
    {server:own,queue,actorId:null},
    {server:own,queue:[{...create,actor_id:2},update]},
    {server:{...own,client_mutation_id:'different-receipt'},queue},
    {server:own,queue,local:{...local,created_by_user_id:2}},
  ]) {
    const result=metadata.reconcileSnapshot([options.server],[options.local||local],options.queue,{actorId:Object.hasOwn(options,'actorId')?options.actorId:1});
    assert.deepEqual(result.remaps,[],'foreign, unknown or mismatching receipts cannot retire a temporary create');
    assert.equal(result.queueDeleteIds.includes(create.id),false);
  }
  assert.deepEqual(metadata.reconcileSnapshot([own],[],queue,{actorId:1}).remaps,[[local.id,100]],'a valid same-actor durable create can recover without a warm local entity');
  assert.equal(JSON.stringify(queue),before,'snapshot projection never mutates durable request bodies');
}

let resolveEviction;
let evictionSignal;
let evictionCalls = 0;
const privacy = createEntityAccessPrivacyController({
  evictEntities: (_ids, { signal }) => {
    evictionCalls += 1;
    evictionSignal = signal;
    return new Promise(resolve => { resolveEviction = resolve; });
  },
});
privacy.beginGeneration();
privacy.schedulePending([7]);
assert.equal(evictionCalls, 1, 'a pending entity starts one privacy eviction');
privacy.commitAccessible([7]);
assert.equal(evictionSignal.aborted, true, 'an authoritative accessible snapshot aborts the older eviction');
privacy.schedulePending([7]);
assert.equal(evictionCalls, 1, 'stale pending render state cannot reschedule an entity accepted in the same snapshot generation');
resolveEviction();
await Promise.resolve();
privacy.beginGeneration();
privacy.schedulePending([7]);
assert.equal(evictionCalls, 2, 'a later authoritative pending snapshot opens a new eviction generation');
resolveEviction();
await Promise.resolve();

function createProjectEvictionDatabase() {
  const calls = [];
  const values = {
    projects: [
      { id: 7, parent_id: null, name: 'Shared root' },
      { id: 8, parent_id: 9, name: 'Locally moved shared child' },
      { id: 81, parent_id: 8, name: 'Dependent moved descendant' },
      { id: 9, parent_id: null, name: 'Unrelated' },
    ],
    sections: [
      { id: 70, project_id: 7 },
      { id: 80, project_id: 8 },
      { id: 81, project_id: 81 },
      { id: 90, project_id: 9 },
    ],
    todos: [
      { id: 700, project_id: 9, section_id: 90 },
      { id: 800, project_id: 8, section_id: 80 },
      { id: 810, project_id: 81, section_id: 81 },
      { id: 900, project_id: 9, section_id: 90 },
    ],
    syncQueue: [
      { id: 1, action: 'UPDATE_PROJECT', data: { id: 7, changes: { name: 'Private' } } },
      { id: 2, action: 'UPDATE_PROJECT', data: { id: 9, changes: { name: 'Keep' } } },
      { id: 3, action: 'UPDATE_SECTION', data: { id: 80, changes: { name: 'Private child' } } },
      { id: 4, action: 'UPDATE_TODO', data: { id: 700, changes: { title: 'Private todo' } } },
      { id: 5, action: 'CREATE_COMMENT', data: { todo_id: 800, body: 'Private comment' } },
      { id: 6, action: 'UPDATE_TODO', data: { id: 900, changes: { title: 'Keep todo' } } },
      { id: 7, action: 'CREATE_COMMENT', data: { todo_id: 701, body: 'Orphaned private comment' } },
      { id: 8, action: 'UPDATE_TODO', data: { id: 702, changes: { title: 'Orphaned private title' } } },
      { id: 9, action: 'DELETE_TODO', data: { id: 703 } },
      { id: 10, action: 'CREATE_COMMENT', data: { todo_id: 704, project_id: 7, body: 'Explicit private boundary' } },
      { id: 11, action: 'UPDATE_SECTION', data: { id: 880, project_id: 88, project_boundary_ids: [88, 7], changes: { name: 'Deleted child private' } } },
      { id: 12, action: 'UPDATE_SECTION', data: { id: 990, project_id: 99, project_boundary_ids: [99, 9], changes: { name: 'Keep outside boundary' } } },
      { id: 13, action: 'UPDATE_PROJECT', data: { id: 8, project_id: 8, project_boundary_ids: [8, 7], changes: { parent_id: 9 } } },
      { id: 14, action: 'UPDATE_TODO', data: { id: 700, project_id: 7, project_boundary_ids: [7], changes: { project_id: 9, section_id: 90 } } },
    ],
  };
  const storeNames = ['projects', 'sections', 'todos', 'syncQueue'];
  const database = {
    transaction(names, mode) {
      calls.push(['transaction', [...names], mode]);
      let reads = 0;
      const tx = {
        objectStore(name) {
          return {
            delete(id) { calls.push([`${name}.delete`, id]); },
            getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = structuredClone(values[name]);
                request.onsuccess?.();
                reads += 1;
                if (reads === storeNames.length) queueMicrotask(() => tx.oncomplete?.());
              });
              return request;
            },
          };
        },
        abort() { calls.push(['abort']); queueMicrotask(() => tx.onabort?.()); },
        error: null,
      };
      return tx;
    },
  };
  return { database, calls };
}

const projectDb = createProjectEvictionDatabase();
const result = await evictPendingProjectEntities([7], { database: projectDb.database });
assert.deepEqual(projectDb.calls[0], ['transaction', ['projects', 'sections', 'todos', 'syncQueue'], 'readwrite']);
for (const id of [7, 8, 81]) {
  assert.equal(projectDb.calls.some(([name, deleted]) => name === 'projects.delete' && String(deleted) === String(id)), true);
}
assert.equal(projectDb.calls.some(([name, id]) => name === 'projects.delete' && String(id) === '9'), false);
for (const id of [70, 80, 81]) {
  assert.equal(projectDb.calls.some(([name, deleted]) => name === 'sections.delete' && String(deleted) === String(id)), true);
}
for (const id of [700, 800, 810]) {
  assert.equal(projectDb.calls.some(([name, deleted]) => name === 'todos.delete' && String(deleted) === String(id)), true);
}
for (const id of [1, 3, 4, 5, 7, 8, 10, 11, 13, 14]) {
  assert.equal(projectDb.calls.some(([name, deleted]) => name === 'syncQueue.delete' && deleted === id), true);
}
for (const id of [2, 6, 9, 12]) {
  assert.equal(projectDb.calls.some(([name, deleted]) => name === 'syncQueue.delete' && deleted === id), false);
}
assert.deepEqual(result.projectIds.map(String).sort(), ['7', '8', '81']);
assert.deepEqual(result.todoIds.map(String).sort(), ['700', '800', '810']);

const lockRef = {};
const finishExistingWriter = await beginSyncQueueWrite(lockRef);
let durableStarted = false;
let releaseDurable;
let memoryPublished = false;
const durableGate = new Promise(resolve => { releaseDurable = resolve; });
const privacyCommit = runEntityPrivacyEviction({
  syncInProgressRef: lockRef,
  acquireCommitLock: acquireSyncCommitLock,
  evict: async () => {
    durableStarted = true;
    await durableGate;
    return { ok: true };
  },
  publish: async () => { memoryPublished = true; },
});
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(durableStarted, false, 'privacy eviction must wait for an existing local queue writer');
finishExistingWriter();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(durableStarted, true);
let lateWriterStarted = false;
const lateWriter = beginSyncQueueWrite(lockRef).then(finish => {
  lateWriterStarted = true;
  finish();
});
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(lateWriterStarted, false, 'new local writers must remain blocked until durable eviction and memory publication finish');
releaseDurable();
await privacyCommit;
assert.equal(memoryPublished, true);
assert.equal(lockRef.privacyGeneration, 1, 'privacy eviction must advance the access commit generation');
await lateWriter;
assert.equal(lateWriterStarted, true);

const realtimeRef = { privacyGeneration: 0 };
let grantRealtimeLock;
let realtimeCommitted = false;
const realtimeLock = new Promise(resolve => { grantRealtimeLock = resolve; });
const staleRealtime = runAccessFencedCommit({
  syncInProgressRef: realtimeRef,
  acquireCommitLock: async () => realtimeLock,
  commit: async () => { realtimeCommitted = true; },
});
realtimeRef.privacyGeneration = 1;
grantRealtimeLock(() => {});
assert.equal(await staleRealtime, false, 'a realtime delta queued before privacy eviction must be discarded');
assert.equal(realtimeCommitted, false);

const boundaryState = {
  projects: [{ id: 7 }, { id: 8, parent_id: 7 }, { id: 9 }],
  sections: [{ id: 70, project_id: 8 }],
  todos: [{ id: 700, project_id: 8, section_id: 70 }],
};
const enrichedComment = enrichTaskQueueBoundary('CREATE_COMMENT', { todo_id: 700, body: 'Private' }, boundaryState);
assert.equal(
  enrichedComment.project_id,
  8,
  'new child mutations must persist the parent project privacy boundary',
);
assert.deepEqual(enrichedComment.project_boundary_ids, [8, 7], 'queue boundaries must preserve ancestor access roots');
assert.equal(
  enrichTaskQueueBoundary('UPDATE_SECTION', { id: 70, changes: { name: 'Private' } }, boundaryState).project_id,
  8,
  'new section mutations must persist the parent project privacy boundary',
);
assert.equal(
  enrichTaskQueueBoundary('UPDATE_TODO', { id: 700, changes: { project_id: 9 } }, boundaryState).project_id,
  8,
  'moving a todo must retain its original project privacy boundary until replay commits',
);
assert.equal(
  enrichTaskQueueBoundary('DELETE_PROJECT', { id: 7 }, { projects: [] }).project_id,
  7,
  'project mutations must retain their own privacy boundary after local deletion',
);

let currentEntities = [{ id: 700, title: 'Private' }];
let releaseCurrentMutation;
let currentMutationWaiting;
const currentMutationGate = new Promise(resolve => { releaseCurrentMutation = resolve; });
const currentMutationStarted = new Promise(resolve => { currentMutationWaiting = resolve; });
let currentMutationCalls = 0;
const currentMutation = runCurrentEntityMutation(700, {
  getEntities: () => currentEntities,
  commit: async operation => {
    currentMutationWaiting();
    await currentMutationGate;
    return operation(() => {});
  },
  mutate: async () => { currentMutationCalls += 1; },
});
await currentMutationStarted;
currentEntities = [];
releaseCurrentMutation();
assert.equal(await currentMutation, null, 'a writer waiting behind privacy eviction must reject a removed entity');
assert.equal(currentMutationCalls, 0, 'a removed entity must not reach durable mutation code');

// A later edit is a durable UPDATE_TODO, not an extra request synthesized
// from the local temporary snapshot after the immutable create acknowledgement.
async function expectReplayRequest(started, replay, label) {
  await Promise.race([started, replay.then(() => assert.fail(`${label} was never dispatched`))]);
}

let createReplayQueue = [{
  id: 41,
  action: 'CREATE_TODO',
  attempted: true,
  data: { title: 'Queued', project_id: 980, section_id: 981, _tempId: 'temp-982' },
}, {
  id: 42,
  action: 'UPDATE_TODO',
  data: { id: 'temp-982', project_id: 980, changes: { section_id: 983 } },
}];
let createReplayTodos = [{ id: 'temp-982', title: 'Queued', project_id: 980, section_id: 983 }];
let createReplayAccess = true;
let releaseSectionCorrection;
let signalSectionCorrection;
const sectionCorrectionGate = new Promise(resolve => { releaseSectionCorrection = resolve; });
const sectionCorrectionStarted = new Promise(resolve => { signalSectionCorrection = resolve; });
const createReplaySyncRef = { value: false, privacyGeneration: 0 };
const createReplayFeature = createSyncFeature({
  getDb: () => ({}),
  dbGetAll: async store => store === 'syncQueue' ? structuredClone(createReplayQueue) : [],
  dbPut: async (store, value) => {
    if (store === 'syncQueue') createReplayQueue = [...createReplayQueue.filter(item => String(item.id) !== String(value.id)), structuredClone(value)];
    if (store === 'todos') createReplayTodos = [...createReplayTodos.filter(todo => String(todo.id) !== String(value.id)), structuredClone(value)];
  },
  dbClear: async () => {},
  getFromDB: async (store, id) => {
    if (store === 'syncQueue') return structuredClone(createReplayQueue.find(item => String(item.id) === String(id)) || null);
    if (store === 'todos') return structuredClone(createReplayTodos.find(todo => String(todo.id) === String(id)) || null);
    return null;
  },
  deleteFromDB: async (store, id) => {
    if (store === 'syncQueue') createReplayQueue = createReplayQueue.filter(item => String(item.id) !== String(id));
    if (store === 'todos') createReplayTodos = createReplayTodos.filter(todo => String(todo.id) !== String(id));
  },
  getTodos: () => createReplayTodos,
  setTodos: next => { createReplayTodos = structuredClone(next); },
  getProjects: () => createReplayAccess ? [{ id: 980 }] : [], setProjects() {},
  getSections: () => createReplayAccess ? [{ id: 981, project_id: 980 }, { id: 983, project_id: 980 }] : [], setSections() {},
  getWorkspaces: () => [], setWorkspaces() {},
  todosApi: {
    create: async data => {
      assert.equal(data.section_id, 981, 'the create must retain its immutable dispatched section');
      assert.equal(createReplaySyncRef.commitLocked, false, 'CREATE_TODO must release its commit lock before HTTP');
      return { id: 982, title: 'Queued', project_id: 980, section_id: 981 };
    },
    update: async (id, changes) => {
      assert.equal(id, 982, 'the durable UPDATE must reference the canonical create identity');
      assert.deepEqual(changes, { section_id: 983 });
      assert.equal(createReplaySyncRef.commitLocked, false, 'queued UPDATE_TODO must release its commit lock before HTTP');
      assert.equal(createReplayQueue.some(item => item.action === 'CREATE_TODO'), false);
      assert.equal(createReplayQueue.find(item => item.action === 'UPDATE_TODO')?.data.id, 982,
        'the correction must be durably remapped before dispatch');
      signalSectionCorrection();
      await sectionCorrectionGate;
      return { id: 982, title: 'Queued', project_id: 980, section_id: 983 };
    },
  },
  projectsApi: {}, sectionsApi: {}, workspacesApi: {},
});
const createReplay = createReplayFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: createReplaySyncRef });
await expectReplayRequest(sectionCorrectionStarted, createReplay, 'queued section update');
let createReplayEvictionStarted = false;
const createReplayEviction = runEntityPrivacyEviction({
  syncInProgressRef: createReplaySyncRef,
  acquireCommitLock: acquireSyncCommitLock,
  evict: async () => {
    createReplayEvictionStarted = true;
    createReplayAccess = false;
    createReplayQueue = [];
    createReplayTodos = [];
  },
});
await new Promise(resolve => setTimeout(resolve, 0));
const evictionProgressedDuringRequest = createReplayEvictionStarted;
releaseSectionCorrection();
await Promise.all([createReplay, createReplayEviction]);
assert.equal(
  evictionProgressedDuringRequest,
  true,
  'the regular UPDATE_TODO after CREATE must not hold the global commit lock during its network request',
);
assert.deepEqual(createReplayQueue, [], 'a held UPDATE response must not restore an evicted queue');
assert.deepEqual(createReplayTodos, [], 'a held UPDATE response must not republish an inaccessible todo');

let revokedCreateQueue = [{
  id: 42,
  action: 'CREATE_TODO',
  attempted: true,
  data: { title: 'Queued', project_id: 980, section_id: 981, _tempId: 'temp-984' },
}, {
  id: 43,
  action: 'UPDATE_TODO',
  data: { id: 'temp-984', project_id: 980, changes: { section_id: 983 } },
}];
let revokedCreateTodos = [{ id: 'temp-984', title: 'Queued', project_id: 980, section_id: 983 }];
let revokedCreateAccess = true;
let releaseInitialCreate;
let signalInitialCreate;
const initialCreateGate = new Promise(resolve => { releaseInitialCreate = resolve; });
const initialCreateStarted = new Promise(resolve => { signalInitialCreate = resolve; });
let revokedSectionCorrectionCalls = 0;
const revokedCreateSyncRef = { value: false, privacyGeneration: 0 };
const revokedCreateFeature = createSyncFeature({
  getDb: () => ({}),
  dbGetAll: async store => store === 'syncQueue' ? structuredClone(revokedCreateQueue) : [],
  dbPut: async (store, value) => {
    if (store === 'syncQueue') revokedCreateQueue = [...revokedCreateQueue.filter(item => String(item.id) !== String(value.id)), structuredClone(value)];
    if (store === 'todos') revokedCreateTodos = [...revokedCreateTodos.filter(todo => String(todo.id) !== String(value.id)), structuredClone(value)];
  },
  dbClear: async () => {},
  getFromDB: async (store, id) => {
    if (store === 'syncQueue') return structuredClone(revokedCreateQueue.find(item => String(item.id) === String(id)) || null);
    if (store === 'todos') return structuredClone(revokedCreateTodos.find(todo => String(todo.id) === String(id)) || null);
    return null;
  },
  deleteFromDB: async (store, id) => {
    if (store === 'syncQueue') revokedCreateQueue = revokedCreateQueue.filter(item => String(item.id) !== String(id));
    if (store === 'todos') revokedCreateTodos = revokedCreateTodos.filter(todo => String(todo.id) !== String(id));
  },
  getTodos: () => revokedCreateTodos, setTodos: next => { revokedCreateTodos = structuredClone(next); },
  getProjects: () => revokedCreateAccess ? [{ id: 980 }] : [], setProjects() {},
  getSections: () => revokedCreateAccess ? [{ id: 981, project_id: 980 }, { id: 983, project_id: 980 }] : [], setSections() {},
  getWorkspaces: () => [], setWorkspaces() {},
  todosApi: {
    create: async data => {
      assert.equal(data.section_id, 981);
      assert.equal(revokedCreateSyncRef.commitLocked, false, 'a held CREATE cannot block privacy eviction');
      signalInitialCreate();
      await initialCreateGate;
      return { id: 984, title: 'Queued', project_id: 980, section_id: 981 };
    },
    update: async () => {
      revokedSectionCorrectionCalls += 1;
      return { id: 984, title: 'Queued', project_id: 980, section_id: 983 };
    },
  },
  projectsApi: {}, sectionsApi: {}, workspacesApi: {},
});
const revokedCreateReplay = revokedCreateFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: revokedCreateSyncRef });
await expectReplayRequest(initialCreateStarted, revokedCreateReplay, 'initial create');
await runEntityPrivacyEviction({
  syncInProgressRef: revokedCreateSyncRef,
  acquireCommitLock: acquireSyncCommitLock,
  evict: async () => {
    revokedCreateAccess = false;
    revokedCreateQueue = [];
    revokedCreateTodos = [];
  },
});
releaseInitialCreate();
await revokedCreateReplay;
assert.equal(revokedSectionCorrectionCalls, 0, 'CREATE_TODO must not dispatch its queued UPDATE after access loss is already known');
assert.deepEqual(revokedCreateQueue, [], 'a revoked CREATE response must not restore its receipt or dependent UPDATE');
assert.deepEqual(revokedCreateTodos, [], 'a revoked CREATE response must not republish its todo');

let staleCreateQueue = [{
  id: 43,
  action: 'CREATE_TODO',
  data: { title: 'Private queued todo', project_id: 980, section_id: 981, _tempId: 'temp-985' },
}];
let staleCreateTodos = [{ id: 'temp-985', title: 'Private queued todo', project_id: 980, section_id: 981 }];
let staleQueueReadCount = 0;
let releaseStaleQueueRead;
let signalStaleQueueRead;
const staleQueueReadGate = new Promise(resolve => { releaseStaleQueueRead = resolve; });
const staleQueueReadStarted = new Promise(resolve => { signalStaleQueueRead = resolve; });
let staleCreateCalls = 0;
const staleCreateSyncRef = { value: false, privacyGeneration: 0 };
const staleCreateFeature = createSyncFeature({
  getDb: () => ({}),
  dbGetAll: async store => {
    if (store !== 'syncQueue') return [];
    staleQueueReadCount += 1;
    const snapshot = structuredClone(staleCreateQueue);
    if (staleQueueReadCount === 2) {
      signalStaleQueueRead();
      await staleQueueReadGate;
    }
    return snapshot;
  },
  dbPut: async () => {}, dbClear: async () => {},
  getFromDB: async (store, id) => {
    if (store === 'syncQueue') return structuredClone(staleCreateQueue.find(item => String(item.id) === String(id)) || null);
    if (store === 'todos') return structuredClone(staleCreateTodos.find(todo => String(todo.id) === String(id)) || null);
    return null;
  },
  deleteFromDB: async (store, id) => {
    if (store === 'syncQueue') staleCreateQueue = staleCreateQueue.filter(item => String(item.id) !== String(id));
    if (store === 'todos') staleCreateTodos = staleCreateTodos.filter(todo => String(todo.id) !== String(id));
  },
  getTodos: () => staleCreateTodos, setTodos: next => { staleCreateTodos = structuredClone(next); },
  getProjects: () => staleCreateQueue.length ? [{ id: 980 }] : [], setProjects() {},
  getSections: () => staleCreateQueue.length ? [{ id: 981, project_id: 980 }] : [], setSections() {},
  getWorkspaces: () => [], setWorkspaces() {},
  todosApi: {
    create: async () => {
      staleCreateCalls += 1;
      return { id: 985, title: 'Private queued todo', project_id: 980, section_id: 981 };
    },
  },
  projectsApi: {}, sectionsApi: {}, workspacesApi: {},
});
const staleCreateReplay = staleCreateFeature.syncWithServer({ wsState: 'connected', syncInProgressRef: staleCreateSyncRef });
await staleQueueReadStarted;
await runEntityPrivacyEviction({
  syncInProgressRef: staleCreateSyncRef,
  acquireCommitLock: acquireSyncCommitLock,
  evict: async () => {
    staleCreateQueue = [];
    staleCreateTodos = [];
  },
});
releaseStaleQueueRead();
await staleCreateReplay;
assert.equal(staleCreateCalls, 0, 'CREATE_TODO must revalidate access under the commit lock immediately before its server request');

globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
const { createTodoAttachmentsFeature } = await import('../web/static/js/features/todo-attachments.js');
let attachmentTodos = [{ id: 982, project_id: 980, attachments: [] }];
let attachmentProjects = [{ id: 980 }];
let attachmentWrites = 0;
let releaseAttachmentResponse;
let signalAttachmentRequest;
const attachmentResponseGate = new Promise(resolve => { releaseAttachmentResponse = resolve; });
const attachmentRequestStarted = new Promise(resolve => { signalAttachmentRequest = resolve; });
const attachmentFileInput = { files: [{ name: 'private.txt', type: 'text/plain', size: 4 }], value: '', focus() {} };
const attachmentTodoIdInput = { value: '982' };
document.getElementById = id => ({
  'todo-id': attachmentTodoIdInput,
  'todo-attachment-file': attachmentFileInput,
}[id] || null);
const attachmentSyncRef = { privacyGeneration: 0 };
const attachmentFeature = createTodoAttachmentsFeature({
  getTodos: () => attachmentTodos,
  setTodos: next => { attachmentTodos = structuredClone(next); },
  getProjects: () => attachmentProjects,
  getCurrentUser: () => ({ id: 1, attachment_remaining_bytes: 100, attachments_enabled: true }),
  setCurrentUser() {}, getAppInitialized: () => true, getDb: () => ({}),
  dbPut: async () => { attachmentWrites += 1; },
  isOnlineForSync: () => true,
  todosApi: {
    getAttachmentUsage: async () => ({ enabled: true, used_bytes: 0, remaining_bytes: 100, quota_bytes: 100, max_upload_bytes: 100, allowed_types: ['text/plain'] }),
    uploadAttachment: async () => {
      signalAttachmentRequest();
      await attachmentResponseGate;
      return { todo: { id: 982, project_id: 980, attachments: [{ id: 1 }] } };
    },
  },
  renderStats() {}, renderTodos() {}, closeModal() {}, confirmDanger: async () => true, showToast() {},
  t: key => key, iconSvg: () => '', escapeHtmlAttr: value => value,
  refreshTodoActionButtonState() {}, refreshTodoSaveButtonState() {},
  syncInProgressRef: attachmentSyncRef,
});
const staleAttachmentResponse = attachmentFeature.uploadTodoAttachmentFromInput();
await attachmentRequestStarted;
attachmentTodos = [];
attachmentProjects = [];
attachmentSyncRef.privacyGeneration += 1;
releaseAttachmentResponse();
await staleAttachmentResponse;
assert.equal(attachmentWrites, 0, 'an attachment response received after privacy eviction must not persist its todo');
assert.deepEqual(attachmentTodos, [], 'an attachment response received after privacy eviction must not republish its todo');

let projectedAttachmentTodos = [{ id: 992, project_id: 990, title: 'Before edit', attachments: [] }];
let projectedAttachmentDurable = structuredClone(projectedAttachmentTodos[0]);
let projectedAttachmentQueue = [];
let releaseProjectedAttachment;
let signalProjectedAttachment;
const projectedAttachmentGate = new Promise(resolve => { releaseProjectedAttachment = resolve; });
const projectedAttachmentStarted = new Promise(resolve => { signalProjectedAttachment = resolve; });
const projectedAttachmentInput = { files: [{ name: 'new.txt', type: 'text/plain', size: 4 }], value: '', focus() {} };
document.getElementById = id => ({
  'todo-id': { value: '992' },
  'todo-attachment-file': projectedAttachmentInput,
}[id] || null);
const projectedAttachmentFeature = createTodoAttachmentsFeature({
  getTodos: () => projectedAttachmentTodos,
  setTodos: next => { projectedAttachmentTodos = structuredClone(next); },
  getProjects: () => [{ id: 990 }],
  getCurrentUser: () => ({ id: 1, attachment_remaining_bytes: 100, attachments_enabled: true }),
  setCurrentUser() {}, getAppInitialized: () => true, getDb: () => ({}),
  dbGetAll: async store => store === 'syncQueue' ? structuredClone(projectedAttachmentQueue) : [],
  dbPut: async (store, value) => { if (store === 'todos') projectedAttachmentDurable = structuredClone(value); },
  isOnlineForSync: () => true,
  todosApi: {
    getAttachmentUsage: async () => ({ enabled: true, used_bytes: 0, remaining_bytes: 100, quota_bytes: 100, max_upload_bytes: 100, allowed_types: ['text/plain'] }),
    uploadAttachment: async () => {
      signalProjectedAttachment();
      await projectedAttachmentGate;
      return {
        todo: {
          id: 992,
          project_id: 990,
          title: 'Stale server title',
          attachments: [{ id: 77, original_filename: 'new.txt' }],
        },
      };
    },
  },
  renderStats() {}, renderTodos() {}, closeModal() {}, confirmDanger: async () => true, showToast() {},
  t: key => key, iconSvg: () => '', escapeHtmlAttr: value => value,
  refreshTodoActionButtonState() {}, refreshTodoSaveButtonState() {},
  syncInProgressRef: { privacyGeneration: 0 },
});
const projectedAttachmentUpload = projectedAttachmentFeature.uploadTodoAttachmentFromInput();
await projectedAttachmentStarted;
projectedAttachmentTodos = [{ ...projectedAttachmentTodos[0], title: 'Newer local title' }];
projectedAttachmentDurable = structuredClone(projectedAttachmentTodos[0]);
projectedAttachmentQueue = [{ id: 71, action: 'UPDATE_TODO', data: { id: 992, changes: { title: 'Newer local title' } } }];
releaseProjectedAttachment();
assert.equal(await projectedAttachmentUpload, true);
assert.equal(projectedAttachmentDurable.title, 'Newer local title', 'attachment response must preserve the newer queued todo edit in IndexedDB');
assert.equal(projectedAttachmentTodos[0].title, 'Newer local title', 'attachment response must preserve the newer queued todo edit in memory');
assert.deepEqual(projectedAttachmentDurable.attachments.map(item => item.id), [77], 'attachment response data must still be persisted');
assert.deepEqual(projectedAttachmentTodos[0].attachments.map(item => item.id), [77], 'attachment response data must still be published');

const projectedCommentTodo = projectPendingTodoChanges({
  id: 992,
  project_id: 990,
  title: 'Stale server title',
  comments: [{ id: 88, todo_id: 992, body: 'Server comment' }],
}, [{ id: 73, action: 'UPDATE_TODO', data: { id: 992, changes: { title: 'Newer local title' } } }]);
let projectedCommentDurable;
let projectedCommentMemory = [{ id: 992, project_id: 990, title: 'Newer local title', comments: [] }];
projectedCommentDurable = structuredClone(projectedCommentTodo);
projectedCommentMemory = projectedCommentMemory.map(todo => String(todo.id) === String(projectedCommentTodo.id) ? structuredClone(projectedCommentTodo) : todo);
assert.equal(projectedCommentDurable.title, 'Newer local title', 'comment response projection must preserve the newer local edit in IndexedDB');
assert.equal(projectedCommentMemory[0].title, 'Newer local title', 'comment response projection must preserve the newer local edit in memory');
assert.deepEqual(projectedCommentDurable.comments.map(comment => comment.id), [88], 'comment response data must still be persisted');
assert.deepEqual(projectedCommentMemory[0].comments.map(comment => comment.id), [88], 'comment response data must still be published');

const projectedTransferProject = projectPendingProjectChanges({
  id: 990,
  name: 'Stale server name',
  ownership_type: 'household',
  owner_household_id: 44,
  household_name: 'Home',
}, [{ id: 74, action: 'UPDATE_PROJECT', data: { id: 990, changes: { name: 'Newer local project name' } } }]);
let projectedTransferDurable = structuredClone(projectedTransferProject);
let projectedTransferMemory = [{ id: 990, name: 'Newer local project name' }]
  .map(project => String(project.id) === String(projectedTransferProject.id) ? structuredClone(projectedTransferProject) : project);
assert.equal(projectedTransferDurable.name, 'Newer local project name', 'project transfer projection must preserve the newer local edit in IndexedDB');
assert.equal(projectedTransferMemory[0].name, 'Newer local project name', 'project transfer projection must preserve the newer local edit in memory');
assert.equal(projectedTransferDurable.owner_household_id, 44, 'project transfer response data must still be persisted');
assert.equal(projectedTransferMemory[0].ownership_type, 'household', 'project transfer response data must still be published');

let refreshedSections = [{ id: 995, project_id: 990, name: 'Newer local section', sort_order: 1 }];
let refreshedDurableSections = structuredClone(refreshedSections);
let refreshedSectionQueue = [{ id: 72, action: 'UPDATE_SECTION', data: { id: 995, changes: { name: 'Newer local section' } } }];
let releaseSectionRefresh;
let signalSectionRefresh;
const sectionRefreshGate = new Promise(resolve => { releaseSectionRefresh = resolve; });
const sectionRefreshStarted = new Promise(resolve => { signalSectionRefresh = resolve; });
const navigation = createNavigationFeature({
  sectionsApi: {
    listByProject: async () => {
      signalSectionRefresh();
      await sectionRefreshGate;
      return { sections: [{ id: 995, project_id: 990, name: 'Stale server section', sort_order: 9 }] };
    },
  },
  getProjects: () => [{ id: 990 }],
  getCurrentProjectId: () => 990,
  getCurrentFilter: () => '990', setCurrentProjectId() {}, setCurrentFilter() {}, setSections: next => { refreshedSections = structuredClone(next); },
  isOnlineForSync: () => true,
  dbGetAll: async store => {
    if (store === 'sections') return structuredClone(refreshedDurableSections);
    if (store === 'syncQueue') return structuredClone(refreshedSectionQueue);
    return [];
  },
  dbPut: async (store, value) => {
    if (store !== 'sections') return;
    const index = refreshedDurableSections.findIndex(section => String(section.id) === String(value.id));
    if (index >= 0) refreshedDurableSections[index] = structuredClone(value);
    else refreshedDurableSections.push(structuredClone(value));
  },
  deleteFromDB: async (store, id) => {
    if (store === 'sections') refreshedDurableSections = refreshedDurableSections.filter(section => String(section.id) !== String(id));
  },
  closeSidebar() {}, renderProjects() {}, renderStats() {}, renderTodos() {},
  syncInProgressRef: { privacyGeneration: 0 },
});
const delayedSectionRefresh = navigation.loadSectionsForCurrentProject();
await sectionRefreshStarted;
releaseSectionRefresh();
await delayedSectionRefresh;
assert.equal(refreshedDurableSections[0].name, 'Newer local section', 'section refresh must preserve the newer queued section edit in IndexedDB');
assert.equal(refreshedSections[0].name, 'Newer local section', 'section refresh must preserve the newer queued section edit in memory');
assert.equal(refreshedDurableSections[0].sort_order, 9, 'section refresh response fields must still be persisted');
assert.equal(refreshedSections[0].sort_order, 9, 'section refresh response fields must still be published');

const { createProjectSharingFeature } = await import('../web/static/js/features/project-sharing.js');
let visibleProjects = [{ id: 7, name: 'Accepted project' }];
let releaseProjectEviction;
let projectEvictionSignal;
const projectSharing = createProjectSharingFeature({
  getProjects: () => visibleProjects,
  setProjects: next => { visibleProjects = structuredClone(next); },
  renderProjects() {}, renderStats() {}, renderTodos() {}, showToast() {},
  confirmDanger: async () => true,
  projectsApi: {
    listInvites: async () => ({ invitations: [] }),
    respondInvite: async () => ({}),
    listMembers: async () => ({ members: [] }),
  },
  removePendingEntities: (_ids, { signal } = {}) => new Promise(resolve => {
    projectEvictionSignal = signal;
    releaseProjectEviction = () => {
      if (!signal?.aborted) visibleProjects = [];
      resolve();
    };
  }),
});
projectSharing.setInvites([{ id: 71, project_id: 7, project_name: 'Accepted project' }]);
projectSharing.commitAuthoritativeSnapshot([{ id: 7, name: 'Accepted project' }]);
assert.equal(projectEvictionSignal.aborted, true, 'the project invitation consumer must cancel its older eviction on accepted access');
releaseProjectEviction();
await Promise.resolve();
assert.deepEqual(visibleProjects.map(project => project.id), [7]);

const projectSharingSource = readFileSync(new URL('../web/static/js/features/project-sharing.js', import.meta.url), 'utf8');
assert.match(projectSharingSource, /createEntityAccessPrivacyController/);
assert.match(projectSharingSource, /privacy\.schedulePending\(state\.invitations\.map\(invite => invite\.entityId\)\)/);
assert.match(projectSharingSource, /commitAuthoritativeSnapshot/);
const appStorageSource = readFileSync(new URL('../web/static/js/storage/app-storage.js', import.meta.url), 'utf8');
assert.match(appStorageSource, /evictPendingProjectEntities\(projectIds, options\)/);
const appSource = readFileSync(new URL('../web/static/js/app.js', import.meta.url), 'utf8');
assert.match(appSource, /removePendingEntities:\s*async\s*\(pendingIds,\s*\{ signal \}\s*=\s*\{\}\)\s*=>/);
assert.match(appSource, /appStorage\.evictPendingProjectEntities/);
assert.match(appSource, /enrichTaskQueueBoundary\(action, data, \{ todos, sections, projects \}\)/);
assert.match(appSource, /onAuthoritativeRefreshCommitted:\s*\(\)\s*=>\s*\{[\s\S]*sharingFeature\?\.commitAuthoritativeSnapshot\?\.\(projects\)[\s\S]*shoppingNavigationFeature\?\.commitAuthoritativeSnapshot\?\.\(shoppingLists\)/);
assert.match(appSource, /createTodosFeature\(\{[\s\S]*getSections:\s*\(\)\s*=>\s*sections[\s\S]*syncInProgressRef/);
assert.match(appSource, /createProjectsFeature\(\{[\s\S]*syncInProgressRef/);
assert.match(appSource, /createNavigationFeature\(\{[\s\S]*getProjects:\s*\(\)\s*=>\s*projects[\s\S]*syncInProgressRef/);
const navigationSource = readFileSync(new URL('../web/static/js/features/navigation.js', import.meta.url), 'utf8');
const todosSource = readFileSync(new URL('../web/static/js/features/todos.js', import.meta.url), 'utf8');
const projectsSource = readFileSync(new URL('../web/static/js/features/projects.js', import.meta.url), 'utf8');
const attachmentsSource = readFileSync(new URL('../web/static/js/features/todo-attachments.js', import.meta.url), 'utf8');
assert.match(navigationSource, /listByProject\(currentProjectId\)[\s\S]*runAccessFencedCommit/);
assert.match(todosSource, /listByProject\(projectId\)[\s\S]*runAccessFencedCommit/);
assert.match(projectsSource, /transferToHousehold[\s\S]*runAccessFencedCommit/);
assert.match(todosSource, /todosApi\.create\(withRoutingFeedback\(todoData\)\)[\s\S]*runAccessFencedCommit/);
assert.match(todosSource, /todosApi\.createComment[\s\S]*applyCommentTodoResponse\(response, commentPrivacyGeneration\)/);
assert.match(attachmentsSource, /uploadAttachment\(id, file\)[\s\S]*applyAttachmentTodoResponse\(latestResponse, privacyGeneration, sameSelection\)/);
assert.match(attachmentsSource, /deleteAttachment\(todoId, attachmentId\)[\s\S]*applyAttachmentTodoResponse\(response, privacyGeneration\)/);
assert.match(attachmentsSource, /projectPendingTodoChanges\(updatedTodo, queue\)/);
assert.match(todosSource, /projectPendingTodoChanges\(updatedTodo, queue\)/);
assert.match(projectsSource, /projectPendingProjectChanges\(project, queue\)/);
assert.match(navigationSource, /projectPendingSectionsSnapshot\(serverSections, localProjectSections, queue, currentProjectId\)/);
assert.match(todosSource, /projectPendingSectionsSnapshot\(serverSections, localProjectSections, queue, projectId\)/);

// Session teardown must cancel queued privacy work before its database closes,
// and stale invitation responses must not start cleanup in the next account.
let releaseSessionLock;
const sessionLock = new Promise(resolve => { releaseSessionLock = resolve; });
let sessionEvictions = 0;
let sessionPublications = 0;
const sessionErrors = [];
const sessionPrivacy = createEntityAccessPrivacyController({
  evictEntities: (_ids, { signal }) => runEntityPrivacyEviction({
    signal, acquireCommitLock: async () => sessionLock,
    evict: async () => { sessionEvictions++; }, publish: () => { sessionPublications++; },
  }),
  onError: error => sessionErrors.push(error),
});
sessionPrivacy.schedulePending([7]);
let sessionDrained = false;
const sessionShutdown = sessionPrivacy.suspend().then(() => { sessionDrained = true; });
sessionPrivacy.schedulePending([8]);
await Promise.resolve();
assert.equal(sessionDrained, false, 'database teardown must wait for the canceled operation to leave the commit-lock queue');
releaseSessionLock(() => {});
await sessionShutdown;
assert.equal(sessionEvictions, 0, 'a canceled old-account eviction must never enter a closed or replacement database');
assert.equal(sessionPublications, 0);
assert.deepEqual(sessionErrors, []);
sessionPrivacy.resume();
sessionPrivacy.schedulePending([8]);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(sessionEvictions, 1, 'a new authenticated runtime can schedule cleanup after reopening its database');
assert.equal(sessionPublications, 1);

let activeAbortObserved = false;
const activePrivacy = createEntityAccessPrivacyController({
  evictEntities: (_ids, { signal }) => runEntityPrivacyEviction({
    signal, acquireCommitLock: async () => () => {},
    evict: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        activeAbortObserved = true;
        reject(new DOMException('transaction canceled', 'AbortError'));
      }, { once: true });
    }),
  }),
  onError: error => sessionErrors.push(error),
});
activePrivacy.schedulePending([9]);
await Promise.resolve();
await activePrivacy.suspend();
assert.equal(activeAbortObserved, true, 'an active durable transaction must receive the teardown abort');
assert.deepEqual(sessionErrors, []);
const genuineFailure = new Error('genuine storage failure');
const failingPrivacy = createEntityAccessPrivacyController({
  evictEntities: async () => { throw genuineFailure; }, onError: error => sessionErrors.push(error),
});
failingPrivacy.schedulePending([10]);
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(sessionErrors, [genuineFailure], 'session cancellation must not hide real storage failures');

let resolveOldInvites;
const oldInvites = new Promise(resolve => { resolveOldInvites = resolve; });
const staleInvitationEvictions = [];
const sessionSharing = createProjectSharingFeature({
  getProjects: () => [], setProjects() {}, renderProjects() {}, renderStats() {}, renderTodos() {}, showToast() {},
  projectsApi: { listInvites: () => oldInvites },
  removePendingEntities: async ids => { staleInvitationEvictions.push(...ids); },
});
const oldInvitationLoad = sessionSharing.loadInvites();
await sessionSharing.suspendAccessPrivacy();
sessionSharing.setInvites([{ id: 77, project_id: 7 }]);
assert.deepEqual(staleInvitationEvictions, [], 'late render/snapshot callbacks cannot restart suspended privacy cleanup');
sessionSharing.resumeAccessPrivacy();
sessionSharing.commitAuthoritativeSnapshot([]);
assert.deepEqual(staleInvitationEvictions, [], 'callbacks received during suspension cannot leave old invitation state for the next account');
resolveOldInvites({ invitations: [{ id: 88, project_id: 8 }] });
assert.equal((await oldInvitationLoad).stale, true, 'old invitation requests must be invalidated across account teardown and resume');
assert.deepEqual(staleInvitationEvictions, []);
sessionSharing.setInvites([{ id: 99, project_id: 9 }]);
assert.deepEqual(staleInvitationEvictions, [9], 'only new-session invitations may schedule new cleanup');
await sessionSharing.suspendAccessPrivacy();

globalThis.window = {};
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
const sessionValues = new Map();
globalThis.localStorage = {
  getItem: key => sessionValues.get(key) || null,
  setItem: (key, value) => sessionValues.set(key, String(value)),
  removeItem: key => sessionValues.delete(key),
};
globalThis.sessionStorage = { getItem: () => null };
const { createAuthSessionFeature } = await import('../web/static/js/features/auth-session.js');
for (const cachedUser of [{ id: 1, username: 'old-user' }, null]) {
 for (const ownerKnown of [true, false]) {
  if (ownerKnown) sessionValues.set('last_user_id', '1');
  else sessionValues.delete('last_user_id');
  sessionValues.set('jwt_token', `header.${btoa(JSON.stringify({ user_id: 2, username: 'new-user' }))}.signature`);
  if (cachedUser) sessionValues.set('cached_user', JSON.stringify(cachedUser));
  else sessionValues.delete('cached_user');
  let cachedHydrations = 0;
  const mismatchedAuth = createAuthSessionFeature({
    authApi: {}, getAppInitialized: () => false, setCurrentUser: () => { cachedHydrations++; },
    clearCache: async () => {}, initApp: async () => {}, refreshFromServer: async () => {}, renderUserInfo() {},
  });
  assert.equal(await mismatchedAuth.checkAuth({ preferCached: true }), false,
    'a changed JWT identity must use authoritative validation instead of hydrating cached or JWT-derived data over another account cache');
  assert.equal(cachedHydrations, 0);
 }
}
for (const entry of ['login', 'authoritative-check']) {
 for (const ownerKnown of [true, false]) {
  const order = [];
  if (ownerKnown) sessionValues.set('last_user_id', '1');
  else sessionValues.delete('last_user_id');
  sessionValues.set('jwt_token', 'old-session');
  let user = { id: 1 };
  const auth = createAuthSessionFeature({
    authApi: {
      login: async () => ({ access_token: 'new-session', user: { id: 2, username: 'new-user' } }),
      me: async () => ({ id: 2, username: 'new-user' }),
    },
    getAppInitialized: () => true,
    setCurrentUser: next => { user = next; order.push(next ? 'hydrate' : 'deactivate-old-user'); },
    onCurrentUserChange: () => { assert.equal(order.includes('close-cache'), true); order.push('render-new-user'); },
    disconnectRealtime: async () => { assert.equal(user, null); order.push('drain-old-runtime'); },
    clearCache: async () => { assert.equal(user, null); order.push('close-cache'); },
    initApp: async () => {}, refreshFromServer: async () => {}, renderUserInfo() {},
  });
  location.reload = () => order.push('reload');
  if (entry === 'login') await auth.login('new-user', 'test');
  else await auth.checkAuth({ authoritative: true });
  assert.deepEqual(order.slice(0, 5), ['deactivate-old-user', 'drain-old-runtime', 'close-cache', 'hydrate', 'render-new-user'],
    `${entry}: teardown and cache clearing must precede new-account hydration and module rendering`);
  assert.equal(user.id, 2);
 }
}

sessionValues.set('last_user_id', '2');
sessionValues.set('jwt_token', 'current-session');
let releaseLogoutCache;
let logoutCacheStarted;
const logoutGate = new Promise(resolve => { releaseLogoutCache = resolve; });
const logoutStarted = new Promise(resolve => { logoutCacheStarted = resolve; });
const logoutAuth = createAuthSessionFeature({
  authApi: { logout: async () => {} }, getAppInitialized: () => true, setCurrentUser() {},
  disconnectRealtime: async () => {},
  clearCache: async () => { logoutCacheStarted(); await logoutGate; },
  initApp: async () => {}, refreshFromServer: async () => {}, renderUserInfo() {},
});
const pendingLogout = logoutAuth.logout();
await logoutStarted;
assert.equal(sessionValues.get('last_user_id'), '2', 'interrupted logout must retain the cache owner marker until the old database is actually cleared');
releaseLogoutCache();
await pendingLogout;
assert.equal(sessionValues.has('last_user_id'), false);

// Execute the production tracker itself: a microtask queued before teardown
// must recheck its captured account before starting any network/cache work.
const trackerStart = appSource.indexOf('function trackBackgroundSyncOperation(');
const trackerEnd = appSource.indexOf('const syncFeature =', trackerStart);
assert.ok(trackerStart >= 0 && trackerEnd > trackerStart);
const createProductionTracker = new Function(`
  let currentUser = null;
  const activeBackgroundSyncOperations = new Set();
  ${appSource.slice(trackerStart, trackerEnd)}
  return {
    setUser(user) { currentUser = user; },
    track: trackBackgroundSyncOperation,
    drain: waitForBackgroundSyncOperations,
  };
`);
const tracker = createProductionTracker();
let trackedCalls = 0;
tracker.setUser({ id: 1 });
const queuedBeforeLogout = tracker.track(() => { trackedCalls++; });
tracker.setUser(null);
await queuedBeforeLogout;
assert.equal(trackedCalls, 0, 'logout must cancel an old job before its queued microtask begins');
tracker.setUser({ id: 1 });
const queuedBeforeAccountChange = tracker.track(() => { trackedCalls++; });
tracker.setUser({ id: 2 });
await queuedBeforeAccountChange;
assert.equal(trackedCalls, 0, 'a job queued for another account must not run in the replacement session');
let releaseTrackedJob;
let trackedJobStarted;
const trackedGate = new Promise(resolve => { releaseTrackedJob = resolve; });
const trackedStarted = new Promise(resolve => { trackedJobStarted = resolve; });
const currentJob = tracker.track(async () => { trackedCalls++; trackedJobStarted(); await trackedGate; });
await trackedStarted;
let trackedDrainFinished = false;
const trackedDrain = tracker.drain().then(() => { trackedDrainFinished = true; });
await Promise.resolve();
assert.equal(trackedDrainFinished, false, 'runtime shutdown must still await work that already started for the current account');
releaseTrackedJob();
await Promise.all([currentJob, trackedDrain]);
assert.equal(trackedCalls, 1);
await assert.rejects(tracker.track(async () => { throw new Error('real tracked failure'); }), /real tracked failure/,
  'the tracker must propagate genuine operation failures to its caller');

console.log('✅ Generic entity access privacy, session teardown and project/todo eviction contracts passed');
