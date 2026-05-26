import { http } from './http.js';

export const sectionsApi = {
  listAll: () => http.get('/api/sections'),
  listByProject: (projectId) => http.get(`/api/sections/by-project/${projectId}`),
  create: (projectId, data) => http.post(`/api/sections/by-project/${projectId}`, data),
  update: (sectionId, changes) => http.patch(`/api/sections/${sectionId}`, changes),
  delete: (sectionId) => http.del(`/api/sections/${sectionId}`),
};
