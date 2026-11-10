import { http } from './http.js';

export const routingMemoryApi = Object.freeze({
  read: () => http.get('/api/routing-memory'),
  update: enabled => http.patch('/api/routing-memory', { enabled: Boolean(enabled) }),
  reset: () => http.del('/api/routing-memory'),
});
