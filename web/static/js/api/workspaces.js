import { http } from './http.js';

export const workspacesApi = {
  list: () => http.get('/api/workspaces'),
  create: (data) => http.post('/api/workspaces', data),
  update: (workspaceId, changes) => http.patch(`/api/workspaces/${workspaceId}`, changes),
  delete: (workspaceId) => http.del(`/api/workspaces/${workspaceId}`),
};
