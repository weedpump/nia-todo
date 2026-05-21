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
  if (token) {
    if (token.includes('.')) headers['Authorization'] = `Bearer ${token}`;
    else headers['X-Session-Token'] = token;
  }
  if (csrf) headers['X-CSRF-Token'] = csrf;
  return headers;
}

async function request(method, path, body) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), 8000) : null;
  const options = {
    method,
    headers: getAuthHeaders(),
    credentials: 'include',
  };
  if (controller) options.signal = controller.signal;
  if (body !== undefined) options.body = JSON.stringify(body);
  try {
    const r = await fetch(API + path, options);
    if (!r.ok) {
      const err = new Error(r.status + ' ' + r.statusText);
      err.status = r.status;
      throw err;
    }
    return r.json();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export const http = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};
