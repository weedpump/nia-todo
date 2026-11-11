#!/usr/bin/env node
// Actual application wiring with held local writes; no browser, service or DB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEntityMutationQueue } from '../web/static/js/features/entity-metadata.js';
import { beginSyncQueueWrite } from '../web/static/js/features/todo-pending.js';

const source = readFileSync(new URL('../web/static/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function commitShoppingMutation(');
const end = source.indexOf('const syncInProgressRef =', start);
assert(start >= 0 && end > start);
const wiring = source.slice(start, end);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let session = '1:first', builds = 0, writes = 0;
let storageWrite = async () => { writes++; };
const ref = { value: false, privacyGeneration: 0 };
const { commit, enqueue } = new Function('getEntitySessionIdentity', 'beginSyncQueueWrite', 'syncInProgressRef', 'appStorage', 'createEntityMutationQueue',
  `${wiring};return {commit:commitShoppingMutation,enqueue:enqueueShoppingListMutation};`)(
  () => session, beginSyncQueueWrite, ref, { commitShoppingMutation: mutation => storageWrite(mutation) }, createEntityMutationQueue);
const build = () => { builds++; return { list: { id: 10 } }; };

const heldTask = deferred(), started = deferred();
const first = enqueue('same-key', async () => { started.resolve(); await heldTask.promise; });
await started.promise;
let staleRan = false;
const stale = enqueue('same-key', () => { staleRan = true; });
session = '2:second';
let newRan = false;
await enqueue('same-key', () => { newRan = true; });
heldTask.resolve(); await first; await stale;
assert.equal(staleRan, false, 'old-account queued work cannot run in a new account');
assert.equal(newRan, true, 'new account is independent of an old account queue');

const lock = deferred(); ref.commitLocked = true; ref.commitGate = lock.promise;
const waiting = commit(build);
session = '2:new-session';
ref.commitLocked = false; lock.resolve();
assert.equal(await waiting, null, 'same account with a new authenticated runtime cancels a waiting write');
assert.equal(builds, 0); assert.equal(writes, 0);

const saved = deferred(), saveStarted = deferred();
storageWrite = async () => { writes++; saveStarted.resolve(); await saved.promise; };
const saving = commit(build); await saveStarted.promise;
session = '3:third'; saved.resolve();
assert.equal(await saving, null, 'late storage completion cannot publish another account\'s mutation');
assert.equal(ref.pendingQueueWrites, 0, 'canceled writes release the privacy reservation');
assert.equal(builds, 1); assert.equal(writes, 1);

session = null;
assert.equal(await commit(build), null, 'unauthenticated cached state cannot create a mutation');
assert.equal(builds, 1); assert.equal(writes, 1);
console.log('✅ Shopping mutation wiring fences queued tasks, held writes and late completion across account/session changes');
