import { http } from './http.js';

export const householdsApi = {
  current: () => http.get('/api/households/current'),
  listInvites: () => http.get('/api/households/invites'),
  create: ({ name }) => http.post('/api/households', { name }),
  update: (householdId, { name }) => http.patch(`/api/households/${householdId}`, { name }),
  invite: (householdId, username) => http.post(`/api/households/${householdId}/invites`, { username }),
  respondInvite: (householdId, inviteId, accept) => http.post(`/api/households/${householdId}/invites/${inviteId}`, { accept }),
  leave: (householdId) => http.post(`/api/households/${householdId}/leave`, {}),
  removeMember: (householdId, userId) => http.del(`/api/households/${householdId}/members/${userId}`),
  transferOwner: (householdId, userId) => http.post(`/api/households/${householdId}/transfer-owner`, { user_id: userId }),
  dissolve: (householdId) => http.del(`/api/households/${householdId}`),
};
