import { clear, put } from '../storage/indexed-db.js';

export function enqueue(action, data) {
  return put('syncQueue', {
    action,
    data,
    timestamp: Date.now(),
    localUpdatedAt: new Date().toISOString(),
  });
}

export function clearQueue() {
  return clear('syncQueue');
}
