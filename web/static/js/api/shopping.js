import { API } from '../core/config.js';
import { getAuthHeaders } from './http.js';
import { apiErrorFromResponse } from './errors.js';

async function request(method, path, body) {
  const response = await fetch(API + path, {
    method,
    headers: getAuthHeaders(),
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) await apiErrorFromResponse(response, `${response.status} ${response.statusText}`);
  return response.json().catch(() => ({}));
}

export const shoppingApi = Object.freeze({
  snapshot: () => request('GET', '/api/shopping/snapshot'),
  listLists: () => request('GET', '/api/shopping/lists'),
  getList: id => request('GET', `/api/shopping/lists/${encodeURIComponent(id)}`),
  createList: data => request('POST', '/api/shopping/lists', data),
  updateList: (listId, data) => request('PATCH', `/api/shopping/lists/${encodeURIComponent(listId)}`, data),
  deleteList: listId => request('DELETE', `/api/shopping/lists/${encodeURIComponent(listId)}`),
  listMembers: listId => request('GET', `/api/shopping/lists/${encodeURIComponent(listId)}/members`),
  shareList: (listId, data) => request('POST', `/api/shopping/lists/${encodeURIComponent(listId)}/members`, data),
  revokeMember: (listId, userId) => request('DELETE', `/api/shopping/lists/${encodeURIComponent(listId)}/members/${encodeURIComponent(userId)}`),
  listStores: () => request('GET', '/api/shopping/stores'),
  createStore: data => request('POST', '/api/shopping/stores', data),
  updateStore: (storeId, data) => request('PATCH', `/api/shopping/stores/${encodeURIComponent(storeId)}`, data),
  deleteStore: storeId => request('DELETE', `/api/shopping/stores/${encodeURIComponent(storeId)}`),
  createSection: (listId, data) => request('POST', `/api/shopping/lists/${encodeURIComponent(listId)}/sections`, data),
  updateSection: (sectionId, data) => request('PATCH', `/api/shopping/sections/${encodeURIComponent(sectionId)}`, data),
  deleteSection: sectionId => request('DELETE', `/api/shopping/sections/${encodeURIComponent(sectionId)}`),
  createItem: (listId, data) => request('POST', `/api/shopping/lists/${encodeURIComponent(listId)}/items`, data),
  updateItem: (itemId, data) => request('PATCH', `/api/shopping/items/${encodeURIComponent(itemId)}`, data),
  deleteItem: itemId => request('DELETE', `/api/shopping/items/${encodeURIComponent(itemId)}`),
  deleteCompletedItems: listId => request('DELETE', `/api/shopping/lists/${encodeURIComponent(listId)}/items/completed`),
  updatePreferences: (listId, data) => request('PUT', `/api/shopping/lists/${encodeURIComponent(listId)}/preferences`, data),
});
