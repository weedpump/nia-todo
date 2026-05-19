import { API } from '../core/config.js';

export function getAuthToken() {
  return localStorage.getItem('jwt_token') || localStorage.getItem('auth_token');
}

export function getCsrfToken() {
  return localStorage.getItem('csrf_token');
}

export function getAuthHeaders() {
  const token = getAuthToken();
  const csrf = getCsrfToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  return headers;
}

async function request(method, path, body) {
  const options = {
    method,
    headers: getAuthHeaders(),
    credentials: 'include',
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const r = await fetch(API + path, options);
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  return r.json();
}

export const http = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};
