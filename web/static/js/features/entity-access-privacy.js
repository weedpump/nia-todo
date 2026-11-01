export async function runEntityPrivacyEviction({
  syncInProgressRef,
  acquireCommitLock,
  signal,
  evict,
  publish = async () => {},
} = {}) {
  if (typeof acquireCommitLock !== 'function') throw new Error('Entity privacy eviction requires a commit lock');
  if (typeof evict !== 'function') throw new Error('Entity privacy eviction requires a durable eviction');
  if (signal?.aborted) throw new DOMException('Entity privacy eviction was aborted', 'AbortError');
  const releaseCommitLock = await acquireCommitLock(syncInProgressRef);
  try {
    if (signal?.aborted) throw new DOMException('Entity privacy eviction was aborted', 'AbortError');
    const result = await evict();
    if (signal?.aborted) throw new DOMException('Entity privacy eviction was aborted', 'AbortError');
    if (syncInProgressRef) {
      syncInProgressRef.privacyGeneration = Number(syncInProgressRef.privacyGeneration || 0) + 1;
    }
    await publish(result);
    return result;
  } finally {
    releaseCommitLock();
  }
}

export async function runAccessFencedCommit({
  syncInProgressRef,
  acquireCommitLock,
  commit,
  privacyGeneration = Number(syncInProgressRef?.privacyGeneration || 0),
} = {}) {
  if (typeof acquireCommitLock !== 'function') throw new Error('Access-fenced commit requires a commit lock');
  if (typeof commit !== 'function') throw new Error('Access-fenced commit requires a commit callback');
  const releaseCommitLock = await acquireCommitLock(syncInProgressRef);
  try {
    if (Number(syncInProgressRef?.privacyGeneration || 0) !== privacyGeneration) return false;
    await commit();
    return true;
  } finally {
    releaseCommitLock();
  }
}

export function createEntityAccessPrivacyController({
  evictEntities = async () => {},
  onError = error => console.error('Failed to evict pending entity data', error),
} = {}) {
  let generation = 0;
  const scheduled = new Set();
  const active = new Map();

  function beginGeneration() {
    generation += 1;
    scheduled.clear();
  }

  function track(id, operation) {
    const key = String(id);
    const operations = active.get(key) || new Set();
    operations.add(operation);
    active.set(key, operations);
  }

  function untrack(id, operation) {
    const key = String(id);
    const operations = active.get(key);
    operations?.delete(operation);
    if (!operations?.size) active.delete(key);
  }

  function abort(id) {
    for (const operation of active.get(String(id)) || []) operation.controller.abort();
  }

  function schedulePending(entityIds) {
    const ids = [...new Map((entityIds || [])
      .filter(id => id !== undefined && id !== null)
      .map(id => [String(id), id])).values()];
    const operationGeneration = generation;
    for (const id of ids) {
      const key = String(id);
      if (scheduled.has(key)) continue;
      scheduled.add(key);
      const operation = { generation: operationGeneration, controller: new AbortController() };
      track(id, operation);
      let eviction;
      try {
        eviction = evictEntities([id], { signal: operation.controller.signal });
      } catch (error) {
        eviction = Promise.reject(error);
      }
      void Promise.resolve(eviction)
        .catch(error => {
          if (operationGeneration === generation && error?.name !== 'AbortError') scheduled.delete(key);
          if (error?.name !== 'AbortError') onError(error);
        })
        .finally(() => untrack(id, operation));
    }
  }

  function commitAccessible(entityIds) {
    beginGeneration();
    for (const id of entityIds || []) {
      if (id === undefined || id === null) continue;
      scheduled.add(String(id));
      abort(id);
    }
  }

  return {
    beginGeneration,
    schedulePending,
    commitAccessible,
  };
}
