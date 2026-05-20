import { API } from '../core/config.js';
import { getAuthHeaders } from './http.js';

async function parseOrThrow(response, fallback = 'Request failed') {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.detail || fallback);
    error.status = response.status;
    throw error;
  }
  return data;
}

export const authApi = {
  async login(username, password) {
    const response = await fetch(API + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      credentials: 'include',
    });
    return parseOrThrow(response, 'Login fehlgeschlagen');
  },

  async me() {
    const response = await fetch(API + '/api/me', {
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    return parseOrThrow(response, 'Not authenticated');
  },

  async logout() {
    const response = await fetch(API + '/api/logout', {
      method: 'POST',
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    return parseOrThrow(response, 'Logout failed');
  },

  async changePassword(oldPassword, newPassword) {
    const response = await fetch(API + '/api/me/change-password', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
      credentials: 'include',
    });
    return parseOrThrow(response, 'Passwortänderung fehlgeschlagen');
  },

  async updateProfile(displayName) {
    const response = await fetch(API + '/api/me/profile', {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ display_name: displayName }),
      credentials: 'include',
    });
    return parseOrThrow(response, 'Profil konnte nicht geändert werden');
  },

  async uploadAvatar(file) {
    const headers = getAuthHeaders();
    delete headers['Content-Type'];
    const name = file.name?.toLowerCase?.() || '';
    const contentType = file.type || (name.endsWith('.heic') ? 'image/heic' : name.endsWith('.heif') ? 'image/heif' : 'application/octet-stream');
    const response = await fetch(API + '/api/me/avatar', {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': contentType },
      body: file,
      credentials: 'include',
    });
    return parseOrThrow(response, 'Avatar konnte nicht hochgeladen werden');
  },

  async updateEmail(email) {
    const response = await fetch(API + '/api/me/email', {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ email }),
      credentials: 'include',
    });
    return parseOrThrow(response, 'E-Mail konnte nicht geändert werden');
  },

  async listApiKeys() {
    const response = await fetch(API + '/api/me/api-keys', {
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    return parseOrThrow(response, 'API-Key-Liste fehlgeschlagen');
  },

  async createApiKey(name) {
    const response = await fetch(API + '/api/me/api-keys', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ name }),
      credentials: 'include',
    });
    return parseOrThrow(response, 'API-Key konnte nicht erstellt werden');
  },

  async revokeApiKey(keyId) {
    const response = await fetch(API + `/api/me/api-keys/${keyId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    return parseOrThrow(response, 'API-Key konnte nicht gelöscht werden');
  },

  async setupStatus() {
    const response = await fetch(API + '/api/setup/status');
    return parseOrThrow(response, 'Setup-Status fehlgeschlagen');
  },
};
