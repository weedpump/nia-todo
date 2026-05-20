import { http } from './http.js';

export const projectsApi = {
  list: () => http.get('/api/projects'),
  create: (data) => http.post('/api/projects', data),
  update: (projectId, changes) => http.patch(`/api/projects/${projectId}`, changes),
  delete: (projectId) => http.del(`/api/projects/${projectId}`),
  clearDone: (projectId) => http.post(`/api/projects/${projectId}/clear-done`, {}),
};
