import { API } from '../core/config.js';
import { getAuthHeaders } from './http.js';

async function request(method, path, body) {
  const options = {
    method,
    headers: getAuthHeaders(),
    credentials: 'include',
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(API + path, options);
  if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
  return response.json();
}

export const pushApi = {
  status: () => request('GET', '/api/push/status'),
  vapidPublicKey: () => request('GET', '/api/push/vapid-public-key'),
  subscribe: (subscription) => request('POST', '/api/push/subscribe', subscription),
  unsubscribe: (subscription) => request('POST', '/api/push/unsubscribe', subscription),
  test: (payload) => request('POST', '/api/push/test', payload),
};
