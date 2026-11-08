#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

// This browser has its own origin/IndexedDB; no application service or SQLite.
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('http://cookbook-storage.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><script type="module">
      import * as storage from '/static/js/storage/indexed-db.js';
      import { DB_NAME, DB_VERSION } from '/static/js/core/config.js';
      import { cookbookMetadata, createCookbooksController } from '/static/js/features/cookbooks.js';
      import { createSyncFeature } from '/static/js/features/sync.js';
      // The API transport below is mocked, independently of host connectivity.
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
      window.test = { storage, DB_NAME, DB_VERSION, cookbookMetadata, createCookbooksController, createSyncFeature };
    </script>` });
    try {
      return route.fulfill({ contentType: 'text/javascript', body: readFileSync(new URL(`../web${path}`, import.meta.url), 'utf8') });
    } catch { return route.fulfill({ status: 404 }); }
  });
  await page.goto('http://cookbook-storage.test/');
  await page.waitForFunction(() => Boolean(window.test));

  const upgraded = await page.evaluate(async () => {
    const { storage, DB_NAME, DB_VERSION } = window.test;
    const old = await new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 8);
      open.onupgradeneeded = () => {
        for (const name of ['todos', 'projects', 'sections', 'workspaces', 'shoppingLists', 'shoppingStores', 'avatars']) open.result.createObjectStore(name, { keyPath: 'id' });
        open.result.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
      };
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    await new Promise((resolve, reject) => {
      const tx = old.transaction(['todos', 'shoppingLists', 'shoppingStores', 'syncQueue'], 'readwrite');
      tx.objectStore('todos').put({ id: 1, title: 'Keep Tasks' });
      tx.objectStore('shoppingLists').put({ id: 7, name: 'Keep Shopping' });
      tx.objectStore('shoppingStores').put({ id: 8, shopping_list_id: 7, name: 'Keep store' });
      tx.objectStore('syncQueue').put({ id: 9, action: 'UPDATE_TODO', data: { id: 1, changes: { title: 'Pending Tasks' } } });
      tx.objectStore('syncQueue').put({ id: 10, action: 'UPDATE_SHOPPING_LIST', data: { id: 7, changes: { name: 'Pending Shopping' } } });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    old.close();
    await storage.openDatabase();
    return { version: DB_VERSION, store: storage.getDb().objectStoreNames.contains('cookbooks'),
      todos: await storage.getAll('todos'), lists: await storage.getAll('shoppingLists'), stores: await storage.getAll('shoppingStores'), queue: await storage.getAll('syncQueue') };
  });
  assert.equal(upgraded.version, 10);
  assert.equal(upgraded.store, true);
  assert.equal(upgraded.todos[0].title, 'Keep Tasks');
  assert.equal(upgraded.lists[0].name, 'Keep Shopping');
  assert.equal(upgraded.stores[0].name, 'Keep store');
  assert.deepEqual(upgraded.queue.map(entry => entry.id), [9, 10]);

  await page.evaluate(async () => {
    const { storage } = window.test;
    const entity = { id: 'temp-cookbook-collapse', client_mutation_id: 'temp-cookbook-collapse', name: 'Initial', can_manage: true };
    await storage.commitCookbookMutation({ cookbook: entity, action: 'CREATE_COOKBOOK', data: { temp_id: entity.id, client_mutation_id: entity.id, name: entity.name } });
    await storage.commitCookbookMutation({ cookbook: { ...entity, name: 'Edited' }, action: 'UPDATE_COOKBOOK', data: { id: entity.id, changes: { name: 'Edited', description: 'Preserved draft' } } });
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.test));
  const collapsed = await page.evaluate(async () => {
    const { storage } = window.test;
    await storage.openDatabase();
    const before = await storage.getAll('syncQueue');
    const books = await storage.getAll('cookbooks');
    await storage.commitCookbookMutation({ deleteCookbookId: books[0].id, action: 'DELETE_COOKBOOK', data: { id: books[0].id } });
    return { books, before, after: await storage.getAll('syncQueue'), remaining: await storage.getAll('cookbooks') };
  });
  assert.equal(collapsed.books[0].name, 'Edited');
  assert.equal(collapsed.before.filter(entry => entry.action === 'CREATE_COOKBOOK').length, 1);
  assert.equal(collapsed.before.find(entry => entry.action === 'CREATE_COOKBOOK').data.description, 'Preserved draft');
  assert.deepEqual(collapsed.after.map(entry => entry.id), [9, 10], 'an unsent create/delete collapses without touching other module queues');
  assert.deepEqual(collapsed.remaining, []);

  await page.evaluate(async () => {
    const { storage, createSyncFeature } = window.test;
    await storage.clear('syncQueue');
    window.books = [];
    window.remaps = [];
    window.actor = '1:0';
    window.syncRef = { value: false, privacyGeneration: 0 };
    window.makeBook = (id, name = 'Initial') => ({ id, client_mutation_id: id, created_by_user_id: 1, name, description: '', can_manage: true, can_edit: true });
    window.commitLocal = async mutation => {
      await storage.commitCookbookMutation(mutation);
      if (mutation.deleteCookbookId != null) window.books = window.books.filter(book => book.id !== mutation.deleteCookbookId);
      if (mutation.cookbook) window.books = [...window.books.filter(book => book.id !== mutation.cookbook.id), mutation.cookbook];
      return mutation;
    };
    window.makeSync = (api, hooks = {}) => createSyncFeature({
      getDb: storage.getDb, dbGetAll: storage.getAll, dbPut: storage.put, dbClear: storage.clear, getFromDB: storage.get, deleteFromDB: storage.remove,
      getTodos: () => [], setTodos() {}, getProjects: () => [], setProjects() {}, getSections: () => [], setSections() {}, getWorkspaces: () => [], setWorkspaces() {},
      todosApi: { list: async () => ({ todos: [] }) }, projectsApi: { list: async () => ({ projects: [] }) },
      sectionsApi: { listAll: async () => ({ sections: [] }) }, workspacesApi: { list: async () => ({ workspaces: [] }) },
      recipesApi: { snapshot: async () => ({ cookbooks: [] }), ...api }, getCookbooks: () => window.books,
      setCookbooks: books => { window.books = books; }, renderStats() {}, renderTodos() {}, renderCookbooks() {},
      commitCookbookReplay: storage.commitCookbookReplay, markCookbookMutationAttempt: storage.markCookbookMutationAttempt,
      onCookbookIdRemap: (from, to) => {
        if (window.syncRef.commitLocked) throw new Error('identity callback ran inside the storage lock');
        window.remaps.push([from, to]);
      },
      ...hooks,
    });
  });
  const ambiguous = await page.evaluate(async () => {
    const { storage } = window.test;
    const book = window.makeBook('temp-cookbook-inflight');
    await window.commitLocal({ cookbook: book, action: 'CREATE_COOKBOOK', data: { temp_id: book.id, client_mutation_id: book.id, name: book.name } });
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const requestStarted = new Promise(resolve => { started = resolve; });
    let first = true;
    const requests = [];
    const server = new Map();
    const feature = window.makeSync({
      createCookbook: async data => {
        requests.push(['create', data.client_mutation_id, data.name]);
        if (!server.has(data.client_mutation_id)) server.set(data.client_mutation_id, { ...data, id: data.client_mutation_id === book.id ? 101 : 102, can_manage: true, created_by_user_id: 1 });
        if (first) { first = false; started(); await gate; throw Object.assign(new Error('ambiguous create reply'), { status: 503 }); }
        return server.get(data.client_mutation_id);
      },
      updateCookbook: async (id, changes) => {
        requests.push(['update', id, changes.name]);
        const current = [...server.values()].find(book => book.id === id);
        const next = { ...current, ...changes }; server.set(current.client_mutation_id, next); return next;
      },
    });
    const replay = feature.syncWithServer({ wsState: 'connected', syncInProgressRef: window.syncRef });
    await requestStarted;
    await window.commitLocal({ cookbook: { ...book, name: 'Newer edit' }, action: 'UPDATE_COOKBOOK', data: { id: book.id, changes: { name: 'Newer edit' } } });
    const other = window.makeBook('temp-cookbook-unrelated', 'Unrelated');
    await window.commitLocal({ cookbook: other, action: 'CREATE_COOKBOOK', data: { temp_id: other.id, client_mutation_id: other.id, name: other.name } });
    release(); await replay;
    const pending = await storage.getAll('syncQueue');
    const afterFirst = structuredClone(window.books);
    await feature.syncWithServer({ wsState: 'connected', syncInProgressRef: window.syncRef });
    return { pending, afterFirst, afterRetry: window.books, remaining: await storage.getAll('syncQueue'), requests, remaps: window.remaps };
  });
  assert.deepEqual(ambiguous.pending.map(entry => entry.action), ['CREATE_COOKBOOK', 'UPDATE_COOKBOOK']);
  assert.equal(ambiguous.pending[0].attempted, true);
  assert.equal(ambiguous.pending[0].data.name, 'Initial', 'in-flight create payload must remain immutable for its stable mutation ID');
  assert.equal(ambiguous.pending[1].data.changes.name, 'Newer edit');
  assert.ok(ambiguous.afterFirst.some(book => book.id === 102), 'an unrelated cookbook can finish while one create remains uncertain');
  assert.deepEqual(ambiguous.remaining, []);
  assert.equal(ambiguous.afterRetry.find(book => book.id === 101).name, 'Newer edit');
  assert.ok(ambiguous.requests.some(request => request[0] === 'update' && request[1] === 101));

  const lateDelete = await page.evaluate(async () => {
    const { storage } = window.test;
    const book = window.makeBook('temp-cookbook-delete');
    await window.commitLocal({ cookbook: book, action: 'CREATE_COOKBOOK', data: { temp_id: book.id, client_mutation_id: book.id, name: book.name } });
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { started = resolve; });
    const deleted = [];
    const feature = window.makeSync({ createCookbook: async data => { started(); await gate; return { ...data, id: 201, can_manage: true }; },
      deleteCookbook: async id => { deleted.push(id); return { id, deleted: true }; } });
    const replay = feature.syncWithServer({ wsState: 'connected', syncInProgressRef: window.syncRef });
    await ready;
    await window.commitLocal({ deleteCookbookId: book.id, action: 'DELETE_COOKBOOK', data: { id: book.id } });
    release(); await replay;
    return { deleted, books: window.books, queue: await storage.getAll('syncQueue') };
  });
  assert.deepEqual(lateDelete.deleted, [201]);
  assert.equal(lateDelete.books.some(book => book.id === 201 || book.id === 'temp-cookbook-delete'), false, 'an acknowledged create cannot resurrect a pending deletion');
  assert.deepEqual(lateDelete.queue, []);

  const privacy = await page.evaluate(async () => {
    const { storage } = window.test;
    const book = window.makeBook('temp-cookbook-private');
    await window.commitLocal({ cookbook: book, action: 'CREATE_COOKBOOK', data: { temp_id: book.id, client_mutation_id: book.id, name: 'Old private payload' } });
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { started = resolve; });
    const feature = window.makeSync({ createCookbook: async () => { started(); await gate; return { id: 301, name: 'Old private payload', can_manage: true }; } });
    const replay = feature.syncWithServer({ wsState: 'connected', syncInProgressRef: window.syncRef });
    await ready;
    window.syncRef.privacyGeneration++;
    await storage.evictPendingCookbookEntities([book.id]);
    window.books = [{ id: 301, name: 'New authorized state' }];
    await storage.put('cookbooks', window.books[0]);
    release(); await replay;
    return { books: window.books, stored: await storage.get('cookbooks', 301), queue: await storage.getAll('syncQueue') };
  });
  assert.deepEqual(privacy.books, [{ id: 301, name: 'New authorized state' }]);
  assert.equal(privacy.stored.name, 'New authorized state');
  assert.deepEqual(privacy.queue, []);

  const snapshot = await page.evaluate(async () => {
    const { storage, cookbookMetadata } = window.test;
    const local = window.makeBook('temp-cookbook-confirmed');
    const queue = [
      { id: 801, action: 'CREATE_COOKBOOK', data: { temp_id: local.id, client_mutation_id: local.id, name: 'Offline' } },
      { id: 802, action: 'UPDATE_COOKBOOK', data: { id: local.id, changes: { name: 'Keep pending title', can_manage: true } } },
    ];
    const foreign = cookbookMetadata.reconcileSnapshot([{ id: 401, client_mutation_id: local.id, created_by_user_id: 2, name: 'Other actor' }], [local], queue, { actorId: 1 });
    const own = cookbookMetadata.reconcileSnapshot([{ id: 402, client_mutation_id: local.id, created_by_user_id: 1, name: 'Server', can_manage: true }], [local], queue, { actorId: 1 });
    await storage.put('cookbooks', local);
    for (const entry of queue) await storage.put('syncQueue', entry);
    await storage.commitCookbookReplay(own);
    const confirmed = { entities: own.entities, queue: await storage.getAll('syncQueue'), storedTemp: await storage.get('cookbooks', local.id) };
    const readonly = cookbookMetadata.reconcileSnapshot([{ id: 402, name: 'Authoritative read-only', can_manage: false }], own.entities,
      [{ id: 802, action: 'UPDATE_COOKBOOK', data: { id: 402, changes: { name: 'Forbidden edit', can_manage: true } } },
       { id: 803, action: 'DELETE_COOKBOOK', data: { id: 402 } }], { actorId: 1 });
    await storage.commitCookbookReplay(readonly);
    await storage.put('syncQueue', { id: 804, action: 'UPDATE_SHOPPING_LIST', data: { id: 402 } });
    await storage.put('syncQueue', { id: 805, action: 'UPDATE_TODO', data: { id: 402 } });
    await storage.put('syncQueue', { id: 806, action: 'UPDATE_COOKBOOK', data: { id: 402 } });
    const revoked = cookbookMetadata.reconcileSnapshot([], readonly.entities, await storage.getAll('syncQueue'), { actorId: 1 });
    await storage.commitCookbookReplay(revoked);
    const atomicRevocation = { entity: await storage.get('cookbooks', 402), queue: await storage.getAll('syncQueue'), deleted: revoked.queueDeleteIds };
    await storage.evictPendingCookbookEntities([402]);
    return { foreignRetired: foreign.queueDeleteIds, foreignIds: foreign.entities.map(book => book.id), confirmed,
      readonly: readonly.entities, readonlyDeleted: readonly.queueDeleteIds, atomicRevocation, afterEviction: await storage.getAll('syncQueue') };
  });
  assert.deepEqual(snapshot.foreignRetired, []);
  assert.ok(snapshot.foreignIds.includes('temp-cookbook-confirmed'));
  assert.equal(snapshot.confirmed.entities[0].id, 402);
  assert.equal(snapshot.confirmed.entities[0].name, 'Keep pending title');
  assert.equal(snapshot.confirmed.storedTemp, null);
  assert.deepEqual(snapshot.confirmed.queue.map(entry => [entry.action, entry.data.id]), [['UPDATE_COOKBOOK', 402]]);
  assert.deepEqual(snapshot.readonly, [{ id: 402, name: 'Authoritative read-only', can_manage: false }]);
  assert.deepEqual(snapshot.readonlyDeleted, [802, 803]);
  assert.equal(snapshot.atomicRevocation.entity, null);
  assert.deepEqual(snapshot.atomicRevocation.deleted, [806], 'the full snapshot must retire revoked typed writes atomically with cached metadata');
  assert.deepEqual(snapshot.atomicRevocation.queue.map(entry => entry.action), ['UPDATE_SHOPPING_LIST', 'UPDATE_TODO']);
  assert.deepEqual(snapshot.afterEviction.map(entry => entry.action), ['UPDATE_SHOPPING_LIST', 'UPDATE_TODO']);

  const rollback = await page.evaluate(async () => {
    const { storage } = window.test;
    await storage.put('cookbooks', { id: 501, name: 'Before atomic failure' });
    await storage.put('syncQueue', { id: 901, action: 'UPDATE_COOKBOOK', data: { id: 501, changes: { name: 'After' } } });
    let rejected = false;
    try {
      await storage.commitCookbookReplay({ entity: { id: 501, invalid() {} }, removeIds: [501], queueDeleteId: 901, requireQueueId: 901 });
    } catch { rejected = true; }
    return { rejected, book: await storage.get('cookbooks', 501), queue: await storage.get('syncQueue', 901) };
  });
  assert.equal(rollback.rejected, true);
  assert.equal(rollback.book.name, 'Before atomic failure');
  assert.equal(rollback.queue.id, 901, 'failed cache/queue receipts must roll back together');

  const session = await page.evaluate(async () => {
    const { createCookbooksController } = window.test;
    let key = 'old-account';
    let builds = 0;
    const controller = createCookbooksController({ getCookbooks: () => [], setCookbooks() {}, getSessionIdentity: () => key,
      commitMutation: async build => { builds++; return build(); } });
    const old = controller.create({ name: 'Old account pending create' });
    key = 'new-account';
    const result = await old;
    const reader = createCookbooksController({ getCookbooks: () => [{ id: 1, can_manage: false }], setCookbooks() {},
      commitMutation: async build => build() });
    return { result, builds, blocked: await reader.update(1, { name: 'Unauthorized' }) };
  });
  assert.equal(session.result, null);
  assert.equal(session.builds, 0);
  assert.equal(session.blocked, null);

  const collisions = await page.evaluate(async () => {
    const { createCookbooksController } = window.test;
    const own = { id: 123, name: 'Own canonical', client_mutation_id: 'own-receipt', created_by_user_id: 1, can_manage: true };
    const foreign = { id: 7, name: 'Foreign managed household', client_mutation_id: '123', created_by_user_id: 2, can_manage: true };
    let books = [foreign, own];
    const mutations = [];
    let sequence = 0;
    const controller = createCookbooksController({ getCookbooks: () => books, setCookbooks: rows => { books = rows; },
      getCurrentUser: () => ({ id: 1 }), getSessionIdentity: () => 'actor-1',
      createTempId: () => `temp-cookbook-collision-${++sequence}`,
      commitMutation: async build => { const mutation = build(); if (mutation) mutations.push(mutation); return mutation; },
    });
    const identity = controller.resolveIdentity(123);
    await controller.update(123, { name: 'Correct exact target' });
    const updatedTarget = mutations.at(-1).data.id;
    books[0] = { ...books[0], client_mutation_id: 'own-receipt' };
    const existing = await controller.create({ client_mutation_id: 'own-receipt', name: 'Retry' });
    await controller.remove(123);
    const deletedTarget = mutations.at(-1).data.id;
    const created = await controller.create({ client_mutation_id: 'own-receipt', name: 'New own book' });
    const numericReceipt = await controller.create({ client_mutation_id: '7', name: 'Numeric opaque receipt' });
    const other = books.find(book => book.id === 7);
    const omittedActor = createCookbooksController({ getCookbooks: () => [foreign], commitMutation: async build => build() });
    return { identity, updatedTarget, existingId: existing.id, deletedTarget, created, numericReceipt, other,
      unknownActorAlias: omittedActor.resolveId('own-receipt'), foreignIdentity: controller.resolveIdentity(7) };
  });
  assert.equal(collisions.identity, 'own-receipt');
  assert.equal(collisions.updatedTarget, 123, 'an earlier foreign CMI equal to a real ID cannot hijack its update');
  assert.equal(collisions.existingId, 123, 'create retries must match the current actor receipt rather than an earlier foreign receipt');
  assert.equal(collisions.deletedTarget, 123);
  assert.equal(collisions.created.created_by_user_id, 1);
  assert.equal(collisions.created.name, 'New own book');
  assert.notEqual(collisions.numericReceipt.id, '7', 'an opaque numeric CMI must never become a local ID colliding with a canonical cookbook');
  assert.equal(collisions.other.name, 'Foreign managed household');
  assert.equal(collisions.unknownActorAlias, null, 'actor-less embedders resolve exact IDs only');
  assert.equal(collisions.foreignIdentity, 7, 'another creator receipt must not become the current actor alias');

  const authoritative = await page.evaluate(async () => {
    const { storage } = window.test;
    await storage.clear('syncQueue');
    await storage.put('cookbooks', { id: 999, name: 'Orphan missing from memory' });
    const callbacks = [];
    const feature = window.makeSync({ snapshot: async () => ({ cookbooks: [{ id: 601, name: 'Accessible snapshot', can_manage: true }] }) }, {
      getActorId: () => 1,
      onCookbookSnapshotCommitted: (books, revoked) => {
        if (!window.syncRef.commitLocked) throw new Error('access snapshot must commit before releasing the shared lock');
        callbacks.push({ books, revoked, published: window.books });
      },
    });
    await feature.refreshFromServer({ wsState: 'connected', syncInProgressRef: window.syncRef });
    return { callbacks, stored: await storage.getAll('cookbooks'), books: window.books };
  });
  assert.deepEqual(authoritative.stored, [{ id: 601, name: 'Accessible snapshot', can_manage: true }]);
  assert.deepEqual(authoritative.books, authoritative.stored);
  assert.equal(authoritative.callbacks.length, 1);
  assert.ok(authoritative.callbacks[0].revoked.includes(999), 'full REST snapshots must evict orphan durable IDs, not only in-memory rows');
  assert.deepEqual(authoritative.callbacks[0].published, authoritative.stored);
  console.log('✅ Cookbooks upgrade, atomic offline queue/collapse, ambiguous retry, snapshots, privacy and account boundaries passed');
} finally {
  await browser.close();
}
