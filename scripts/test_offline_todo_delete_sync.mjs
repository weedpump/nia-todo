#!/usr/bin/env node
// Disposable queue/cache doubles plus real, held loopback HTTP responses.
// No application service, SQLite database or installed browser cache is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSyncFeature } from '../web/static/js/features/sync.js';
import { createToastUndoFeature } from '../web/static/js/features/toast-undo.js';
import { acquireSyncCommitLock, beginSyncQueueWrite } from '../web/static/js/features/todo-pending.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const clone = value => structuredClone(value);
const cases = new Map();
let sequence = 100;
const server = createServer(async (request, response) => {
  const scenario = cases.get(request.url.split('/')[1]);
  if (request.method === 'POST') {
    let body = ''; for await (const chunk of request) body += chunk;
    const data = JSON.parse(body);
    scenario.posts.push(data);
    const todo = { ...data, id: ++sequence, comments: [],
      subtasks: (data.subtasks || []).map((step, index) => ({ ...step, id: sequence * 10 + index })) };
    delete todo._tempId;
    scenario.remote.set(todo.id, todo);
    scenario.started.resolve();
    await scenario.responseGate.promise;
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(todo));
  } else if (request.method === 'DELETE') {
    const id = Number(request.url.split('/')[2]);
    scenario.deletes.push(id); scenario.remote.delete(id);
    scenario.deleteStarted.resolve(); await scenario.deleteResponseGate.promise;
    response.writeHead(scenario.deleteStatuses.shift() || 200, { 'Content-Type': 'application/json' }); response.end('{}');
  } else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const elements = new Map(['toast-container', 'toast-message', 'toast-undo'].map(id => [id, { style: {}, textContent: '' }]));
const previousDocument = globalThis.document;
globalThis.document = { getElementById: id => elements.get(id) };

function scenario(name, { hold = false, holdDelete = false, deleteStatuses = [] } = {}) {
  const state = { posts: [], deletes: [], remote: new Map(), started: deferred(), responseGate: deferred(),
    deleteStarted: deferred(), deleteResponseGate: deferred(), deleteStatuses: [...deleteStatuses] };
  if (!hold) state.responseGate.resolve();
  if (!holdDelete) state.deleteResponseGate.resolve();
  cases.set(name, state);
  return { name, ...state };
}

function harness(test, { stores, deleted = false, grace = 0, failReceiptCommit = false,
  onQueueRead = async () => {}, onPut = async () => {}, onRemove = async () => {} } = {}) {
  const temporary = { id: `temp-${test.name}`, title: test.name, description: 'Preserved description', priority: 2,
    project_id: 1, section_id: 2, comments: [],
    subtasks: [{ id: `temp-child-${test.name}`, title: 'Preserved child', is_done: false }] };
  stores ||= { todos: deleted ? [] : [temporary], projects: [{ id: 1 }], sections: [{ id: 2, project_id: 1 }], workspaces: [],
    syncQueue: [{ id: 1, action: 'CREATE_TODO', data: { ...temporary,
      subtasks: [{ title: 'Preserved child', is_done: false }], _tempId: temporary.id } },
      ...(deleted ? [{ id: 2, action: 'DELETE_TODO', data: { id: temporary.id, project_id: 1, local_todo: temporary, undo_grace_until: grace } }] : [])] };
  let visible = clone(stores.todos), session = '1:first', nextQueueId = 10;
  const ref = { value: false, privacyGeneration: 0 }, remaps = [], published = [];
  const getAll = async name => {
    const rows = clone(name === 'syncQueue' ? [...stores.syncQueue].sort((left, right) => left.id - right.id) : stores[name] || []);
    if (name === 'syncQueue') await onQueueRead();
    return rows;
  };
  const put = async (store, item) => {
    stores[store] = [...(stores[store] || []).filter(row => String(row.id) !== String(item.id)), clone(item)];
    await onPut(store);
  };
  const remove = async (store, id) => {
    if (failReceiptCommit && store === 'todos' && String(id) === temporary.id
      && stores.syncQueue.some(item => item.data?.create_receipt)) { failReceiptCommit = false; throw new Error('simulated reload before receipt remap'); }
    stores[store] = (stores[store] || []).filter(row => String(row.id) !== String(id));
    await onRemove(store);
  };
  const setTodos = rows => { visible = clone(rows); published.push(visible.map(row => row.id)); };
  const enqueue = async (action, data) => put('syncQueue', { id: ++nextQueueId, action, data });
  const mutate = async operation => { const finish = await beginSyncQueueWrite(ref); try { return await operation(enqueue); } finally { finish(); } };
  const undo = createToastUndoFeature({ getDb: () => ({}), getTodos: () => visible, getProjects: () => stores.projects,
    getSessionIdentity: () => session, setTodos, dbPut: put, dbGetAll: getAll,
    deleteFromDB: remove, addToSyncQueue: enqueue, runSyncQueueMutation: mutate,
    isOnlineForSync: () => false, syncWithServer: async () => {}, renderStats() {}, renderTodos() {}, toggleTodo() {} });
  const feature = createSyncFeature({ getDb: () => ({}), dbGetAll: getAll, dbPut: put,
    dbClear: async name => { stores[name] = []; }, getFromDB: async (name, id) => clone((stores[name] || []).find(row => String(row.id) === String(id)) || null), deleteFromDB: remove,
    getTodos: () => visible, setTodos, getProjects: () => stores.projects, setProjects: rows => { stores.projects = clone(rows); },
    getSections: () => stores.sections, setSections: rows => { stores.sections = clone(rows); }, getWorkspaces: () => [], setWorkspaces() {},
    todosApi: { create: async data => {
      assert.equal(data.create_attempted, undefined); assert.equal(data.create_receipt, undefined);
      assert.equal(data.restore_after_delete_id, undefined);
      const response = await fetch(`${base}/${test.name}`, { method: 'POST', body: JSON.stringify(data) }); return response.json();
    }, delete: async id => {
      assert.equal(typeof id, 'number');
      const response = await fetch(`${base}/${test.name}/${id}`, { method: 'DELETE' });
      if (!response.ok) throw Object.assign(new Error('simulated DELETE response'), { status: response.status });
    } },
    projectsApi: {}, sectionsApi: {}, workspacesApi: {}, renderStats() {}, renderTodos() {},
    onTodoIdRemap: (from, to) => { assert.equal(ref.commitLocked, false); remaps.push([from, to]); undo.remapTodoId(from, to); } });
  const localDelete = async (until = 0) => mutate(async add => {
    const current = visible.find(todo => todo.id === temporary.id) || visible[0];
    assert(current);
    await remove('todos', current.id); setTodos(visible.filter(row => row.id !== current.id));
    await add('DELETE_TODO', { id: current.id, local_todo: current, project_id: current.project_id, undo_grace_until: until });
    return current;
  });
  return { feature, undo, stores, temporary, ref, remaps, published, localDelete,
    sync: () => feature.syncWithServer({ wsState: 'connected', syncInProgressRef: ref }),
    visible: () => visible, setSession: value => { session = value; }, mutate,
    switchAccount: (todos, queue) => { session = '2:second'; stores.todos = clone(todos); stores.syncQueue = clone(queue); setTodos(todos); } };
}

async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { assert(Date.now() < deadline, 'bounded asynchronous Undo did not settle'); await new Promise(resolve => setTimeout(resolve, 1)); }
}

try {
  const unsent = scenario('unsent');
  const first = harness(unsent, { deleted: true, grace: Date.now() + 60000 });
  await first.sync(); assert.equal(first.stores.syncQueue.length, 2); assert.equal(unsent.posts.length, 0);
  first.stores.syncQueue[1].data.undo_grace_until = 0;
  await first.sync(); assert.deepEqual(first.stores.syncQueue, []); assert.equal(unsent.posts.length, 0); assert.deepEqual(first.visible(), []);
  console.log('✅ Never-sent create/delete waits for Undo grace then cancels locally');

  const before = scenario('undo-unsent');
  const second = harness(before, { deleted: true, grace: Date.now() + 60000 });
  await second.undo.restoreTodo(second.temporary.id, clone(second.temporary));
  await second.sync(); assert.equal(before.posts.length, 1); assert.deepEqual(before.deletes, []); assert.equal(second.visible().length, 1); assert.deepEqual(second.stores.syncQueue, []);
  console.log('✅ Undo before dispatch restores the temporary task without duplicating its create');

  const inflight = scenario('inflight', { hold: true });
  const third = harness(inflight);
  const running = third.sync(); await inflight.started.promise;
  assert.equal(third.stores.syncQueue[0].data.create_attempted, true);
  const deleted = await third.localDelete(Date.now() + 60000);
  third.undo.showToast('Deleted', { type: 'delete', id: deleted.id, data: clone(deleted) });
  third.published.length = 0;
  inflight.responseGate.resolve(); await running;
  const canonical = [...inflight.remote.keys()][0];
  assert.deepEqual(third.visible(), []); assert.deepEqual(third.stores.todos, []);
  assert(third.published.every(ids => ids.length === 0), 'receipt must not resurrect a deleted task');
  assert.equal(third.stores.syncQueue[0].data.id, canonical);
  assert.equal(third.stores.syncQueue[0].data.local_todo.id, canonical);
  assert.equal(third.stores.syncQueue[0].data.local_todo.subtasks[0].id, canonical * 10);
  assert.deepEqual(third.remaps, [[third.temporary.id, canonical]]);
  third.undo.undoLastAction(); await until(() => third.visible().some(todo => todo.id === canonical));
  assert.equal(third.visible()[0].subtasks[0].id, canonical * 10, 'Undo must restore canonical child identities');
  await third.sync(); assert.equal(inflight.posts.length, 1); assert.deepEqual(inflight.deletes, []); assert.deepEqual(third.stores.syncQueue, []);
  console.log('✅ Held HTTP create receipts remap deletion and Undo without UI resurrection');

  const earlyUndo = scenario('undo-inflight', { hold: true });
  const fourth = harness(earlyUndo);
  const earlyRunning = fourth.sync(); await earlyUndo.started.promise;
  const earlyDeleted = await fourth.localDelete(Date.now() + 60000);
  await fourth.undo.restoreTodo(earlyDeleted.id, earlyDeleted);
  earlyUndo.responseGate.resolve(); await earlyRunning;
  assert.equal(fourth.visible()[0].id, [...earlyUndo.remote.keys()][0]); assert.equal(earlyUndo.posts.length, 1); assert.deepEqual(earlyUndo.deletes, []);
  console.log('✅ Undo while HTTP is held preserves one eventual canonical task');

  const expiry = scenario('delete-inflight', { hold: true });
  const fifth = harness(expiry); const expiring = fifth.sync(); await expiry.started.promise;
  await fifth.localDelete(); expiry.responseGate.resolve(); await expiring;
  assert.equal(expiry.posts.length, 1); assert.equal(expiry.deletes.length, 1); assert.equal(expiry.remote.size, 0); assert.deepEqual(fifth.stores.syncQueue, []); assert.deepEqual(fifth.visible(), []);
  console.log('✅ Expired deletion after an in-flight create leaves neither a server orphan nor queue entries');

  const reload = scenario('reload-receipt', { hold: true });
  const crashing = harness(reload, { failReceiptCommit: true });
  const crashSync = crashing.sync(); await reload.started.promise;
  await crashing.localDelete(); reload.responseGate.resolve();
  const crashResult = await crashSync;
  assert.equal(crashResult.failCount, 1);
  assert(crashing.stores.syncQueue.find(item => item.action === 'CREATE_TODO').data.create_receipt);
  assert.deepEqual(crashing.stores.todos, []);
  const restarted = harness(reload, { stores: crashing.stores }); await restarted.sync();
  assert.equal(reload.posts.length, 1); assert.equal(reload.remote.size, 0); assert.deepEqual(restarted.stores.syncQueue, []); assert.deepEqual(restarted.visible(), []);
  console.log('✅ Reload finishes a durable create receipt and deleted snapshot without a second POST');


  const legacyMemory = scenario('legacy-memory-receipt', { hold: true });
  const legacy = harness(legacyMemory, { deleted: true, grace: Date.now() + 60000, failReceiptCommit: true });
  const legacyCreate = legacy.stores.syncQueue.find(item => item.action === 'CREATE_TODO');
  const feedback = { event_id: 'legacy-routing-event', source: 'manual', project_id: 1, section_id: 2 };
  const privateMetadata = { routing_feedback: feedback, braindump_route: { title: 'Private original wording' } };
  Object.assign(legacyCreate.data, { create_attempted: true, client_mutation_id: 'legacy-create-mutation',
    title: 'Immutable dispatched title', routing_feedback: clone(feedback) });
  Object.assign(legacy.stores.syncQueue.find(item => item.action === 'DELETE_TODO').data.local_todo,
    privateMetadata, { title: 'Later local title' });
  assert.equal(legacyCreate.attempted, undefined, 'old V4 queues only recorded data.create_attempted');
  const legacyRunning = legacy.sync(); await legacyMemory.started.promise;
  assert.equal(legacyMemory.posts.length, 1, 'legacy attempted creates cannot be canceled as never sent');
  assert.equal(legacyMemory.posts[0].title, 'Immutable dispatched title', 'deleted snapshots cannot rewrite the dispatched request');
  assert.equal(legacyMemory.posts[0].client_mutation_id, 'legacy-create-mutation');
  assert.deepEqual(legacyMemory.posts[0].routing_feedback, feedback, 'request feedback must still reach the API');
  legacyMemory.responseGate.resolve();
  assert.equal((await legacyRunning).failCount, 1, 'simulate a reload after storing the receipt, before remapping');
  const durableLegacy = legacy.stores.syncQueue.find(item => item.action === 'CREATE_TODO');
  assert(durableLegacy.data.create_receipt?.id);
  assert.equal(durableLegacy.data.title, 'Immutable dispatched title');
  assert.equal(durableLegacy.data.client_mutation_id, 'legacy-create-mutation');
  assert.deepEqual(durableLegacy.data.routing_feedback, feedback, 'receipt persistence cannot erase pending request feedback');
  for (const field of Object.keys(privateMetadata)) {
    assert.equal(Object.hasOwn(durableLegacy.data.create_receipt, field), false, `receipt must exclude ${field}`);
  }
  // Reopen another old-format queue: receipt + data marker, no top-level marker.
  delete durableLegacy.attempted;
  const legacyReloaded = harness(legacyMemory, { stores: legacy.stores });
  await legacyReloaded.sync();
  assert.equal(legacyMemory.posts.length, 1, 'a durable legacy receipt must never POST again');
  assert.deepEqual(legacyMemory.deletes, [], 'the remapped deletion must keep its Undo grace');
  const canonicalDeletion = legacyReloaded.stores.syncQueue.find(item => item.action === 'DELETE_TODO');
  assert.equal(canonicalDeletion.data.id, durableLegacy.data.create_receipt.id);
  assert.equal(canonicalDeletion.data.local_todo.id, canonicalDeletion.data.id);
  for (const field of Object.keys(privateMetadata)) {
    assert.equal(Object.hasOwn(canonicalDeletion.data.local_todo, field), false, `canonical delete snapshot must exclude ${field}`);
  }
  assert.deepEqual(legacyReloaded.visible(), []);
  await legacyReloaded.undo.restoreTodo(legacyReloaded.temporary.id, { ...legacyReloaded.temporary, ...privateMetadata });
  assert.equal(legacyReloaded.visible()[0].id, canonicalDeletion.data.id);
  for (const field of Object.keys(privateMetadata)) {
    assert.equal(Object.hasOwn(legacyReloaded.visible()[0], field), false, `Undo must exclude ${field}`);
    assert.equal(Object.hasOwn(legacyReloaded.stores.todos[0], field), false, `cached Undo must exclude ${field}`);
  }
  await legacyReloaded.sync();
  assert.equal(legacyMemory.posts.length, 1); assert.deepEqual(legacyReloaded.stores.syncQueue, []);
  console.log('✅ Legacy attempted creates retain routing feedback and immutable identity across receipt reload and private Undo snapshots');

  const duplicate = scenario('undo-duplicate', { hold: true });
  const duplicated = harness(duplicate); const duplicateSync = duplicated.sync(); await duplicate.started.promise;
  duplicated.undo.showToast('Duplicated', { type: 'duplicate', id: duplicated.temporary.id });
  duplicated.undo.undoLastAction();
  await until(() => duplicated.stores.syncQueue.some(item => item.action === 'DELETE_TODO'));
  assert(duplicated.stores.syncQueue.some(item => item.action === 'CREATE_TODO'), 'Undo cannot discard an already sent create');
  duplicate.responseGate.resolve(); await duplicateSync;
  assert.equal(duplicate.posts.length, 1); assert.equal(duplicate.remote.size, 0); assert.deepEqual(duplicated.stores.syncQueue, []);
  console.log('✅ Undo Duplicate keeps an attempted create until its canonical delete can finish');


  const legacyDuplicate = scenario('legacy-undo-duplicate', { hold: true });
  const legacyDuplicated = harness(legacyDuplicate);
  const legacyDuplicateSync = legacyDuplicated.sync(); await legacyDuplicate.started.promise;
  const legacyAttempt = legacyDuplicated.stores.syncQueue.find(item => item.action === 'CREATE_TODO');
  assert.equal(legacyAttempt.attempted, true);
  // Shared-memory queues originally persisted only this top-level marker.
  delete legacyAttempt.data.create_attempted;
  legacyDuplicated.undo.showToast('Duplicated', { type: 'duplicate', id: legacyDuplicated.temporary.id });
  legacyDuplicated.undo.undoLastAction();
  await until(() => legacyDuplicated.stores.syncQueue.some(item => item.action === 'DELETE_TODO'));
  assert(legacyDuplicated.stores.syncQueue.some(item => item.action === 'CREATE_TODO'),
    'Undo must retain a legacy top-level attempted create until its held response supplies the canonical ID');
  legacyDuplicate.responseGate.resolve(); await legacyDuplicateSync;
  assert.equal(legacyDuplicate.posts.length, 1); assert.equal(legacyDuplicate.deletes.length, 1);
  assert.equal(legacyDuplicate.remote.size, 0); assert.deepEqual(legacyDuplicated.stores.syncQueue, []);
  assert.deepEqual(legacyDuplicated.visible(), []);
  console.log('✅ Undo Duplicate also retains old top-level attempted creates and deletes their canonical result');

  const callbackGap = harness(scenario('undo-callback-gap'), { deleted: true });
  callbackGap.stores.syncQueue = [{ id: 2, action: 'DELETE_TODO', data: {
    id: 999, original_todo_id: callbackGap.temporary.id, project_id: 1, local_todo: { ...callbackGap.temporary, id: 999 },
  } }];
  await callbackGap.undo.restoreTodo(callbackGap.temporary.id, clone(callbackGap.temporary));
  assert.equal(callbackGap.visible()[0].id, 999); assert.deepEqual(callbackGap.stores.syncQueue, []);
  console.log('✅ Undo queued before the remap callback uses the durable canonical delete snapshot');

  const heldDelete = scenario('held-delete-undo', { holdDelete: true, deleteStatuses: [503, 404] });
  const undoDelete = harness(heldDelete); await undoDelete.sync();
  const deletingData = await undoDelete.localDelete();
  const deleting = undoDelete.sync(); await heldDelete.deleteStarted.promise;
  assert.equal(undoDelete.stores.syncQueue.find(item => item.action === 'DELETE_TODO').data.delete_attempted, true);
  await undoDelete.undo.restoreTodo(deletingData.id, deletingData);
  const replacement = undoDelete.visible()[0];
  assert.match(replacement.id, /^temp-undo-/); assert.notEqual(replacement.id, deletingData.id);
  assert.equal(undoDelete.stores.syncQueue.find(item => item.action === 'CREATE_TODO').data.restore_after_delete_id, deletingData.id);
  assert.equal(heldDelete.posts.length, 1, 'restoration cannot POST ahead of its in-flight DELETE');
  heldDelete.deleteResponseGate.resolve(); const failedDelete = await deleting;
  assert.equal(failedDelete.failCount, 1); assert.equal(heldDelete.posts.length, 1);
  assert.equal(undoDelete.stores.syncQueue.length, 2, 'transient DELETE failure must retain its dependent restoration');
  const deleteReload = harness(heldDelete, { stores: undoDelete.stores }); await deleteReload.sync();
  assert.equal(heldDelete.posts.length, 2); assert.equal(heldDelete.remote.size, 1);
  assert.deepEqual(deleteReload.stores.syncQueue, []); assert.equal(deleteReload.visible()[0].description, deletingData.description);
  assert.equal(deleteReload.visible()[0].priority, deletingData.priority);
  assert.equal(deleteReload.visible()[0].subtasks[0].title, deletingData.subtasks[0].title);
  assert.notEqual(deleteReload.visible()[0].id, deletingData.id);
  console.log('✅ Held DELETE Undo restores under a new ID only after retry/404, including reload');

  const completedDelete = scenario('completed-delete-undo');
  const completed = harness(completedDelete); await completed.sync();
  const completedData = await completed.localDelete(); await completed.sync();
  assert.equal(completedDelete.remote.size, 0);
  await completed.undo.restoreTodo(completedData.id, completedData);
  assert.equal(completed.stores.syncQueue.length, 1, 'offline Undo of a completed DELETE must queue its restoration');
  await completed.sync(); assert.equal(completedDelete.remote.size, 1); assert.equal(completedDelete.posts.length, 2);
  assert.notEqual(completed.visible()[0].id, completedData.id); assert.equal(completed.visible()[0].subtasks[0].title, completedData.subtasks[0].title);
  console.log('✅ Undo after a completed DELETE durably recreates editable fields and subtasks');

  const readStarted = deferred(), readGate = deferred(); let holdUndoRead = false;
  const readCase = scenario('undo-read-before-delete');
  const reading = harness(readCase, { onQueueRead: async () => {
    if (holdUndoRead) { holdUndoRead = false; readStarted.resolve(); await readGate.promise; }
  } });
  await reading.sync(); const readData = await reading.localDelete(); holdUndoRead = true;
  const undoReading = reading.undo.restoreTodo(readData.id, readData); await readStarted.promise;
  const syncReading = reading.sync(); readGate.resolve(); await undoReading; await syncReading;
  assert.deepEqual(readCase.deletes, []); assert.equal(readCase.remote.size, 1); assert.deepEqual(reading.stores.syncQueue, []);
  assert.equal(reading.visible()[0].id, readData.id);
  console.log('✅ DELETE dispatch waits for an Undo already holding a queue-read reservation');

  const revoked = scenario('revoked', { hold: true });
  const sixth = harness(revoked); const revokedSync = sixth.sync(); await revoked.started.promise;
  await sixth.localDelete(); sixth.stores.syncQueue = []; sixth.stores.todos = []; sixth.stores.projects = []; sixth.ref.privacyGeneration++;
  revoked.responseGate.resolve(); await revokedSync;
  assert.deepEqual(sixth.stores.syncQueue, []); assert.deepEqual(sixth.stores.todos, []); assert.deepEqual(sixth.remaps, []); assert.deepEqual(sixth.visible(), []);
  console.log('✅ Privacy eviction fences held receipts and deleted snapshots');

  const switched = harness(scenario('account-switch'), { deleted: true });
  switched.undo.showToast('Old account', { type: 'delete', id: switched.temporary.id, data: { ...switched.temporary, project_id: null } });
  switched.stores.syncQueue = []; switched.setSession('2:second'); switched.undo.undoLastAction();
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.deepEqual(switched.visible(), []); assert.deepEqual(switched.stores.todos, []);
  const waiting = harness(scenario('account-switch-wait'), { deleted: true });
  const release = await acquireSyncCommitLock(waiting.ref);
  const restoring = waiting.undo.restoreTodo(waiting.temporary.id, { ...waiting.temporary, project_id: null });
  waiting.stores.syncQueue = []; waiting.setSession('2:second'); release(); await restoring;
  assert.deepEqual(waiting.visible(), []); assert.deepEqual(waiting.stores.todos, []);
  console.log('✅ Old account Undo cannot restore projectless data in a new session');

  for (const heldRead of [1, 2]) {
    const started = deferred(), gate = deferred(); let reads = 0;
    const guarded = harness(scenario(`account-queue-read-${heldRead}`), { deleted: true,
      onQueueRead: async () => { if (++reads === heldRead) { started.resolve(); await gate.promise; } } });
    const restoring = guarded.undo.restoreTodo(guarded.temporary.id, { ...guarded.temporary, project_id: null });
    await started.promise;
    const foreign = { id: guarded.temporary.id, title: 'Other account private task', project_id: null };
    const foreignQueue = [{ id: 2, action: 'DELETE_TODO', data: { id: foreign.id, local_todo: foreign } }];
    guarded.switchAccount([foreign], foreignQueue); gate.resolve(); await restoring;
    assert.deepEqual(guarded.visible(), [foreign]); assert.deepEqual(guarded.stores.todos, [foreign]);
    assert.deepEqual(guarded.stores.syncQueue, foreignQueue, 'an old account queue read must not cancel a colliding new account mutation');
  }
  console.log('✅ Account changes during initial and cancellation queue reads prevent stale Undo writes');

  for (const mode of ['restore', 'fields', 'duplicate-delete', 'duplicate-read']) {
    const started = deferred(), gate = deferred(); let held = false;
    const pause = async () => { if (!held) { held = true; started.resolve(); await gate.promise; } };
    const guarded = harness(scenario(`account-${mode}`), { deleted: mode === 'restore',
      onPut: async store => { if (store === 'todos' && ['restore', 'fields'].includes(mode)) await pause(); },
      onRemove: async store => { if (store === 'todos' && mode === 'duplicate-delete') await pause(); },
      onQueueRead: async () => { if (mode === 'duplicate-read') await pause(); } });
    let restoring;
    if (mode === 'restore') restoring = guarded.undo.restoreTodo(guarded.temporary.id, guarded.temporary);
    else if (mode === 'fields') restoring = guarded.undo.restoreTodoFields(guarded.temporary.id, { title: 'Old account edit' });
    else {
      guarded.undo.showToast('Old duplicate', { type: 'duplicate', id: guarded.temporary.id });
      guarded.undo.undoLastAction();
    }
    await started.promise;
    const foreign = { id: guarded.temporary.id, title: 'New account current task', project_id: null };
    const foreignQueue = [{ id: 1, action: 'CREATE_TODO', data: { _tempId: foreign.id, title: foreign.title } }];
    guarded.switchAccount([foreign], foreignQueue); gate.resolve();
    if (restoring) await restoring;
    await until(() => Number(guarded.ref.pendingQueueWrites || 0) === 0);
    assert.deepEqual(guarded.visible(), [foreign]); assert.deepEqual(guarded.stores.todos, [foreign]);
    assert.deepEqual(guarded.stores.syncQueue, foreignQueue, mode + ': stale Undo must not publish, enqueue or cancel in the new account');
  }
  console.log('✅ Held writes and duplicate cancellation reads preserve new-account tasks and queue identities');
} finally {
  for (const value of cases.values()) { value.responseGate.resolve(); value.deleteResponseGate.resolve(); }
  globalThis.document = previousDocument;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
