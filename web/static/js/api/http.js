import { API, APP_VERSION, RUNTIME_MODE, RUNTIME_PLATFORM } from '../core/config.js';
import { apiErrorFromResponse } from './errors.js';

let authenticatedRuntimeGeneration = 0;
let authenticatedRequestsSuspended = false;
let serverRuntimeGeneration = 0;
let serverBoundRequestsSuspended = false;

function runtimeBoundaryError() {
  const error = new Error('Authenticated runtime changed while request was in flight');
  error.code = 'authenticated_runtime_changed';
  return error;
}

function serverBoundaryError() {
  const error = new Error('Server runtime changed while request was in flight');
  error.code = 'server_runtime_changed';
  return error;
}

export function suspendAuthenticatedRequests() {
  authenticatedRequestsSuspended = true;
  authenticatedRuntimeGeneration += 1;
}

export function resumeAuthenticatedRequests() {
  authenticatedRequestsSuspended = false;
}

export function suspendServerBoundRequests() {
  serverBoundRequestsSuspended = true;
  serverRuntimeGeneration += 1;
}

export function resumeServerBoundRequests() {
  serverBoundRequestsSuspended = false;
}

function assertAuthenticatedGeneration(generation) {
  if (authenticatedRequestsSuspended || generation !== authenticatedRuntimeGeneration) {
    throw runtimeBoundaryError();
  }
}

function assertServerGeneration(generation) {
  if (serverBoundRequestsSuspended || generation !== serverRuntimeGeneration) {
    throw serverBoundaryError();
  }
}

function guardResponse(response, assertCurrent) {
  const guardedBodyMethods = new Set(['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']);
  return new Proxy(response, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (!guardedBodyMethods.has(property)) return value.bind(target);
      return async (...args) => {
        assertCurrent();
        const result = await value.apply(target, args);
        assertCurrent();
        return result;
      };
    },
  });
}

export async function authenticatedFetch(input, init) {
  if (authenticatedRequestsSuspended) throw runtimeBoundaryError();
  const generation = authenticatedRuntimeGeneration;
  const response = await fetch(input, init);
  try {
    assertAuthenticatedGeneration(generation);
  } catch (error) {
    response.body?.cancel?.().catch?.(() => {});
    throw error;
  }
  return guardResponse(response, () => assertAuthenticatedGeneration(generation));
}

export async function serverBoundFetch(input, init) {
  if (serverBoundRequestsSuspended) throw serverBoundaryError();
  const generation = serverRuntimeGeneration;
  const response = await fetch(input, init);
  try {
    assertServerGeneration(generation);
  } catch (error) {
    response.body?.cancel?.().catch?.(() => {});
    throw error;
  }
  return guardResponse(response, () => assertServerGeneration(generation));
}

export function getAuthToken() {
  return localStorage.getItem('jwt_token') || localStorage.getItem('auth_token');
}

export function getCsrfToken() {
  return localStorage.getItem('csrf_token');
}

export function getClientHeaders() {
  return {
    'X-Nia-Client': `app=nia-todo;mode=${RUNTIME_MODE};platform=${RUNTIME_PLATFORM};version=${APP_VERSION}`,
  };
}

export function getJsonHeaders() {
  return { 'Content-Type': 'application/json', ...getClientHeaders() };
}

export function getAuthHeaders() {
  const token = getAuthToken();
  const csrf = getCsrfToken();
  const headers = getJsonHeaders();
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
    const r = await authenticatedFetch(API + path, options);
    if (!r.ok) await apiErrorFromResponse(r, `${r.status} ${r.statusText}`);
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
