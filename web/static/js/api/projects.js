import { http } from './http.js';

export const projectsApi = {
  list: () => http.get('/api/projects'),
  create: (data) => http.post('/api/projects', data),
  update: (projectId, changes) => http.patch(`/api/projects/${projectId}`, changes),
  delete: (projectId) => http.del(`/api/projects/${projectId}`),
  clearDone: (projectId) => http.post(`/api/projects/${projectId}/clear-done`, {}),
  shareProject: (projectId, username) => http.post(`/api/projects/${projectId}/share`, { username }),
  listMembers: (projectId) => http.get(`/api/projects/${projectId}/members`),
  removeMember: (projectId, memberUserId) => http.del(`/api/projects/${projectId}/members/${memberUserId}`),
  restoreMember: (projectId, memberUserId, status = 'accepted') => http.post(`/api/projects/${projectId}/members/${memberUserId}/restore`, { status }),
  leaveProject: (projectId) => http.post(`/api/projects/${projectId}/leave`, {}),
  undoLeaveProject: (projectId) => http.post(`/api/projects/${projectId}/leave/undo`, {}),
  listInvites: () => http.get('/api/projects/invites'),
  respondInvite: (projectId, inviteId, accept) => http.post(`/api/projects/${projectId}/invites/${inviteId}`, { accept }),
};
