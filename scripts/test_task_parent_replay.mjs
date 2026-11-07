#!/usr/bin/env node
/** Actual IndexedDB transactions in a disposable browser; no app/service DB. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('http://task-replay.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Task receipt transactions</title>' });
    if (pathname === '/core/config.js') return route.fulfill({ contentType: 'text/javascript', body: "export const DB_NAME = 'unused-app-db'; export const DB_VERSION = 8;" });
    const paths = {
      '/storage/indexed-db.js': '../web/static/js/storage/indexed-db.js',
      '/features/todo-pending.js': '../web/static/js/features/todo-pending.js',
      '/features/shopping-pending.js': '../web/static/js/features/shopping-pending.js',
    };
    if (!paths[pathname]) return route.abort();
    return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL(paths[pathname], import.meta.url), 'utf8') });
  });
  await page.goto('http://task-replay.test/');
  const results = await page.evaluate(async () => {
    const { commitTaskParentReplay } = await import('/storage/indexed-db.js');
    const names = ['projects', 'sections', 'todos', 'syncQueue'];
    const baseline = {
      projects: [{ id: 'temp-child', parent_id: 'temp-project', name: 'Child' }, { id: 'temp-project', name: 'Parent' }],
      sections: [{ id: 'temp-section', project_id: 'temp-project', name: 'Section' }],
      todos: [{ id: 'temp-todo', project_id: 'temp-project', section_id: 'temp-section', title: 'Child todo' }],
      syncQueue: [
        { id: 1, action: 'CREATE_PROJECT', data: { _tempId: 'temp-project' } },
        { id: 2, action: 'CREATE_SECTION', data: { _tempId: 'temp-section', project_id: 'temp-project' } },
        { id: 3, action: 'CREATE_TODO', data: { _tempId: 'temp-todo', project_id: 'temp-project', section_id: 'temp-section' } },
        { id: 9, action: 'UPDATE_TODO', data: { id: 900, changes: { title: 'Unrelated' } } },
      ],
    };
    const projectReceipt = {
      projects: [{ id: 101, name: 'Parent' }, { id: 'temp-child', parent_id: 101, name: 'Child' }],
      sections: [{ ...baseline.sections[0], project_id: 101 }],
      todos: [{ ...baseline.todos[0], project_id: 101 }],
      removeProjectIds: ['temp-project'],
      queueRecords: [
        { ...baseline.syncQueue[1], data: { ...baseline.syncQueue[1].data, project_id: 101 } },
        { ...baseline.syncQueue[2], data: { ...baseline.syncQueue[2].data, project_id: 101 } },
      ],
      queueDeleteId: 1,
    };
    const open = name => new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => names.forEach(store => request.result.createObjectStore(store, { keyPath: 'id' }));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transactionDone = tx => new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Fixture transaction aborted'));
    });
    const snapshot = database => Promise.all(names.map(store => new Promise((resolve, reject) => {
      const request = database.transaction(store).objectStore(store).getAll();
      request.onsuccess = () => resolve([store, request.result]);
      request.onerror = () => reject(request.error);
    }))).then(Object.fromEntries);
    let sequence = 0;
    const fixture = async perform => {
      const name = `isolated-task-replay-${++sequence}`;
      let database = await open(name);
      try {
        const tx = database.transaction(names, 'readwrite');
        names.forEach(store => baseline[store].forEach(record => tx.objectStore(store).put(record)));
        await transactionDone(tx);
        return await perform(database, async () => {
          database.close();
          database = await open(name);
          return snapshot(database);
        });
      } finally {
        database.close();
        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = resolve;
          request.onerror = () => reject(request.error);
        });
      }
    };
    const successful = await fixture(async (database, reopen) => {
      const applied = await commitTaskParentReplay(projectReceipt, { database });
      const after = await snapshot(database);
      const duplicate = await commitTaskParentReplay(projectReceipt, { database });
      const durable = await reopen();
      return { applied, duplicate, after, durable };
    });
    const section = await fixture(async database => {
      await commitTaskParentReplay(projectReceipt, { database });
      const applied = await commitTaskParentReplay({
        sections: [{ id: 201, project_id: 101, name: 'Section' }],
        todos: [{ ...baseline.todos[0], project_id: 101, section_id: 201 }],
        removeSectionIds: ['temp-section'],
        queueRecords: [{ ...baseline.syncQueue[2], data: { ...baseline.syncQueue[2].data, project_id: 101, section_id: 201 } }],
        queueDeleteId: 2,
      }, { database });
      return { applied, after: await snapshot(database) };
    });
    const absent = await fixture(async database => {
      const tx = database.transaction('syncQueue', 'readwrite');
      tx.objectStore('syncQueue').delete(1);
      await transactionDone(tx);
      const before = await snapshot(database);
      const applied = await commitTaskParentReplay(projectReceipt, { database });
      return { applied, before, after: await snapshot(database) };
    });
    const cloneFailure = await fixture(async (database, reopen) => {
      let error;
      try {
        await commitTaskParentReplay({ ...projectReceipt, queueRecords: [{ id: 3, impossible: () => {} }] }, { database });
      } catch (caught) { error = caught.name; }
      return { error, after: await reopen() };
    });
    const aborted = await fixture(async (database, reopen) => {
      let error;
      const abortingDatabase = {
        transaction(...args) {
          const tx = database.transaction(...args);
          return new Proxy(tx, {
            get(target, key) {
              if (key === 'objectStore') return storeName => {
                const store = target.objectStore(storeName);
                return new Proxy(store, {
                  get(targetStore, method) {
                    if (storeName === 'syncQueue' && method === 'delete') return id => {
                      const request = targetStore.delete(id);
                      request.onsuccess = () => tx.abort();
                      return request;
                    };
                    const value = Reflect.get(targetStore, method, targetStore);
                    return typeof value === 'function' ? value.bind(targetStore) : value;
                  },
                });
              };
              const value = Reflect.get(target, key, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
            set(target, key, value) { return Reflect.set(target, key, value, target); },
          });
        },
      };
      try { await commitTaskParentReplay(projectReceipt, { database: abortingDatabase }); }
      catch (caught) { error = caught.message; }
      return { error, after: await reopen() };
    });
    return { baseline, successful, section, absent, cloneFailure, aborted };
  });
  const { baseline, successful, section, absent, cloneFailure, aborted } = results;
  assert.equal(successful.applied, true);
  assert.equal(successful.duplicate, false, 'Missing acknowledged create must make a repeated receipt a no-op');
  assert.deepEqual(successful.after, successful.durable, 'One committed receipt must survive reopening IndexedDB');
  assert.deepEqual(successful.after.projects.map(project => project.id), [101, 'temp-child']);
  assert.equal(successful.after.projects[1].parent_id, 101);
  assert.equal(successful.after.sections[0].project_id, 101);
  assert.equal(successful.after.todos[0].project_id, 101);
  assert.deepEqual(successful.after.syncQueue.map(entry => entry.id), [2, 3, 9]);
  assert.equal(successful.after.syncQueue[0].data.project_id, 101);
  assert.equal(successful.after.syncQueue[1].data.project_id, 101);
  assert.deepEqual(successful.after.syncQueue[2], baseline.syncQueue[3], 'Unrelated work must remain unchanged');
  assert.equal(section.applied, true);
  assert.deepEqual(section.after.sections.map(row => row.id), [201]);
  assert.equal(section.after.todos[0].section_id, 201);
  assert.equal(section.after.syncQueue[0].data.section_id, 201);
  assert.deepEqual(section.after.syncQueue.map(row => row.id), [3, 9]);
  assert.equal(absent.applied, false);
  assert.deepEqual(absent.after, absent.before, 'A removed queue receipt must prevent every cache and queue write');
  assert.equal(cloneFailure.error, 'DataCloneError');
  assert.deepEqual(cloneFailure.after, baseline, 'A failed late write must roll back canonical IDs and every earlier remap');
  assert.match(aborted.error, /aborted/);
  assert.deepEqual(aborted.after, baseline, 'An aborted transaction must preserve the entire pre-receipt state');
  console.log('✅ Atomic Task parent receipts preserve child/queue references, survive reopen and fully roll back failures');
} finally {
  await browser.close();
}
