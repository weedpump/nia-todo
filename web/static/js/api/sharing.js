import { http } from './http.js';

export const sharingApi = {
  listShared: () => http.get('/api/projects/shared'),
  listInvites: () => http.get('/api/projects/invites'),
  shareProject: (projectId, username) => http.post(`/api/projects/${projectId}/share`, { username }),
  acceptInvite: (projectId, inviteId) => http.post(`/api/projects/${projectId}/invites/${inviteId}`, { accept: true }),
  declineInvite: (projectId, inviteId) => http.post(`/api/projects/${projectId}/invites/${inviteId}`, { accept: false }),
  removeMember: (projectId, memberUserId) => http.del(`/api/projects/${projectId}/members/${memberUserId}`),
  leaveProject: (projectId) => http.post(`/api/projects/${projectId}/leave`, {}),
  updateMemberColor: (projectId, memberUserId, color) => http.patch(`/api/projects/${projectId}/members/${memberUserId}/color`, { color }),
};
