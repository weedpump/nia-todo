import { http } from './http.js';

const path = id => `/api/recipes/cookbooks/${encodeURIComponent(id)}`;
const sharing = id => `/api/entity-sharing/cookbook/${encodeURIComponent(id)}`;
export const recipesApi = Object.freeze({
  snapshot: () => http.get('/api/recipes/cookbooks'),
  listCookbooks: () => http.get('/api/recipes/cookbooks'),
  getCookbook: id => http.get(path(id)),
  createCookbook: data => http.post('/api/recipes/cookbooks', data),
  updateCookbook: (id, data) => http.patch(path(id), data),
  deleteCookbook: id => http.del(path(id)),
  transferToHousehold: (id, householdId) => http.post(`${path(id)}/household`, { household_id: householdId }),
  listMembers: id => http.get(`${sharing(id)}/members`),
  shareCookbook: (id, data) => http.post(`${sharing(id)}/invites`, data),
  revokeMember: (id, userId) => http.del(`${sharing(id)}/members/${encodeURIComponent(userId)}`),
  leaveCookbook: id => http.post(`${sharing(id)}/leave`),
  listInvites: () => http.get('/api/entity-sharing/invites'),
  respondInvite: (id, inviteId, accept) => http.post(`${sharing(id)}/invites/${encodeURIComponent(inviteId)}`, { accept }),
});
