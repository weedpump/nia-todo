import { sameEntityId } from '../features/entity-metadata.js';

function deleteKey(store, id) {
  store.delete(id);
  if (typeof id === 'number' && Number.isInteger(id)) store.delete(String(id));
  if (typeof id === 'string' && /^\d+$/.test(id)) store.delete(Number(id));
}

/** Atomic entity/cache/queue receipt, shared by metadata collections. */
export function commitEntityReplay({ writes = {}, remove = {}, queueRecords = [], queueDeleteIds = [], queueDeleteId,
  requireQueueId, scanRemove = {}, database } = {}) {
  if (!database) return Promise.reject(new Error('IndexedDB is not open'));
  const stores = [...new Set([...Object.keys(writes), ...Object.keys(remove), ...Object.keys(scanRemove), 'syncQueue'])];
  return new Promise((resolve, reject) => {
    let tx;
    let failure;
    let applied = false;
    try {
      tx = database.transaction(stores, 'readwrite');
      const abort = error => { failure = error; tx.abort(); };
      const apply = () => {
        try {
          for (const [name, ids] of Object.entries(remove)) for (const id of ids) deleteKey(tx.objectStore(name), id);
          for (const [name, rows] of Object.entries(writes)) for (const row of rows) tx.objectStore(name).put(row);
          const queue = tx.objectStore('syncQueue');
          queueRecords.forEach(row => queue.put(row));
          queueDeleteIds.forEach(id => queue.delete(id));
          if (queueDeleteId != null) queue.delete(queueDeleteId);
          for (const [name, matches] of Object.entries(scanRemove)) {
            const store = tx.objectStore(name);
            const request = store.openCursor();
            request.onsuccess = () => { const cursor = request.result; if (!cursor) return; if (matches(cursor.value)) cursor.delete(); cursor.continue(); };
          }
          applied = true;
        } catch (error) { abort(error); }
      };
      if (requireQueueId != null) {
        const receipt = tx.objectStore('syncQueue').get(requireQueueId);
        receipt.onsuccess = () => { if (receipt.result) apply(); };
      } else apply();
      tx.oncomplete = () => resolve(applied);
      tx.onerror = () => reject(failure || tx.error || new Error('Entity replay failed'));
      tx.onabort = () => reject(failure || tx.error || new Error('Entity replay was aborted'));
    } catch (error) {
      failure = error;
      tx?.abort?.();
      reject(error);
    }
  });
}

/** Persist metadata and safely collapse only requests never sent to the API. */
export function commitMetadataMutation({ contract, entity, deleteId, action, data, database,
  timestamp = Date.now(), localUpdatedAt = new Date().toISOString(), extraStores = [], onMutation = null } = {}) {
  if (!database) return Promise.reject(new Error('IndexedDB is not open'));
  const sanitized = contract.sanitize({ action, data });
  if (!sanitized) return Promise.reject(new Error('Unknown metadata mutation'));
  return new Promise((resolve, reject) => {
    let tx;
    let failure;
    try {
      tx = database.transaction([...new Set([contract.storeName, 'syncQueue', ...extraStores])], 'readwrite');
      const entities = tx.objectStore(contract.storeName);
      const queueStore = tx.objectStore('syncQueue');
      const request = queueStore.getAll();
      request.onsuccess = () => {
        try {
          const queue = request.result || [];
          onMutation?.(tx, queue);
          const id = contract.idFor(sanitized);
          const related = queue.filter(entry => contract.references(entry, id));
          const create = related.find(entry => entry.action === contract.createAction);
          const last = related.at(-1);
          if (action === contract.updateAction && related.some(entry => entry.action === contract.deleteAction)) throw new Error('Entity is pending deletion');
          if (deleteId != null) deleteKey(entities, deleteId);
          if (entity) entities.put(entity);
          const record = { ...sanitized, timestamp, localUpdatedAt };
          if (action === contract.deleteAction && create && related.every(entry => entry.attempted !== true)) {
            related.forEach(entry => queueStore.delete(entry.id));
          } else if (action === contract.updateAction && create && create.attempted !== true) {
            queueStore.put({ ...create, data: { ...create.data, ...sanitized.data.changes }, localUpdatedAt });
          } else if (action === contract.updateAction && last?.action === contract.updateAction && last.attempted !== true) {
            queueStore.put({ ...last, data: { ...last.data, changes: { ...last.data.changes, ...sanitized.data.changes } }, localUpdatedAt });
          } else if (action === contract.createAction && create) {
            // A stable client mutation identity is already durably queued.
          } else if (action === contract.deleteAction && last?.action === contract.deleteAction) {
            // Repeated delete intent is idempotent, including ambiguous replies.
          } else {
            if (action === contract.deleteAction) related.filter(entry => entry.action === contract.updateAction && entry.attempted !== true)
              .forEach(entry => queueStore.delete(entry.id));
            queueStore.put(record);
          }
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(failure || tx.error || new Error('Metadata mutation failed'));
      tx.onabort = () => reject(failure || tx.error || new Error('Metadata mutation was aborted'));
    } catch (error) { tx?.abort?.(); reject(error); }
  });
}

export function markMetadataMutationAttempt({ contract, queueId, database } = {}) {
  if (!database) return Promise.reject(new Error('IndexedDB is not open'));
  return new Promise((resolve, reject) => {
    let tx;
    let marked = null;
    let failure;
    try {
      tx = database.transaction(['syncQueue'], 'readwrite');
      const store = tx.objectStore('syncQueue');
      const request = store.get(queueId);
      request.onsuccess = () => {
        try {
          if (!contract.actions.has(request.result?.action)) return;
          marked = { ...request.result, attempted: true };
          store.put(marked);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(marked);
      tx.onerror = () => reject(failure || tx.error || new Error('Failed to reserve metadata request'));
      tx.onabort = () => reject(failure || tx.error || new Error('Metadata request reservation was aborted'));
    } catch (error) { tx?.abort?.(); reject(error); }
  });
}

/** Known entity IDs plus optional children, never unrelated queue namespaces. */
export function evictEntityMetadata({ remove = {}, scan = {}, references, signal, database } = {}) {
  if (!database) return Promise.reject(new Error('IndexedDB is not open'));
  if (signal?.aborted) return Promise.reject(new DOMException('Entity eviction was aborted', 'AbortError'));
  const names = [...new Set([...Object.keys(remove), ...Object.keys(scan), 'syncQueue'])];
  return new Promise((resolve, reject) => {
    let tx;
    const records = {};
    const abort = () => { try { tx?.abort(); } catch {} };
    try {
      tx = database.transaction(names, 'readwrite');
      signal?.addEventListener('abort', abort, { once: true });
      for (const [name, ids] of Object.entries(remove)) ids.forEach(id => deleteKey(tx.objectStore(name), id));
      let pending = Object.keys(scan).length + 1;
      const finish = () => {
        if (--pending) return;
        for (const [name, matches] of Object.entries(scan)) for (const row of records[name]) if (matches(row)) deleteKey(tx.objectStore(name), row.id);
        for (const entry of records.syncQueue) if (references(entry, records)) tx.objectStore('syncQueue').delete(entry.id);
      };
      for (const name of [...Object.keys(scan), 'syncQueue']) {
        const request = tx.objectStore(name).getAll();
        request.onsuccess = () => { records[name] = request.result || []; finish(); };
        request.onerror = abort;
      }
      const cleanup = () => signal?.removeEventListener('abort', abort);
      tx.oncomplete = () => { cleanup(); resolve(); };
      tx.onerror = () => { cleanup(); reject(tx.error || new Error('Entity eviction failed')); };
      tx.onabort = () => { cleanup(); reject(signal?.aborted ? new DOMException('Entity eviction was aborted', 'AbortError') : tx.error || new Error('Entity eviction was aborted')); };
    } catch (error) { abort(); reject(error); }
  });
}
