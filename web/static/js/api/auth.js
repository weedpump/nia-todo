import { API, RUNTIME_CAPABILITIES } from '../core/config.js';
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

function b64urlToBuffer(value) {
  const base64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - String(value || '').length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, c => c.charCodeAt(0)).buffer;
}

function bufferToB64url(buffer) {
  const bytes = new Uint8Array(buffer || []);
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function credentialToJson(credential) {
  const response = {};
  for (const key of ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle']) {
    if (credential.response?.[key] instanceof ArrayBuffer) response[key] = bufferToB64url(credential.response[key]);
  }
  return {
    id: credential.id,
    rawId: bufferToB64url(credential.rawId),
    type: credential.type,
    response,
    transports: typeof credential.response.getTransports === 'function' ? credential.response.getTransports() : [],
  };
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

  async verify2fa(challengeToken, method, code, rememberDevice = false) {
    const response = await fetch(API + '/api/2fa/challenge/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge_token: challengeToken, method, code, remember_device: rememberDevice }),
      credentials: 'include',
    });
    return parseOrThrow(response, '2FA-Prüfung fehlgeschlagen');
  },

  async verifyPasskeyLogin(challengeToken, rememberDevice = false) {
    if (RUNTIME_CAPABILITIES.native) {
      throw new Error('Passkeys werden in den Native Apps erst mit der nativen Passkey-Bridge unterstützt. Bitte im Browser anmelden oder TOTP/Recovery verwenden.');
    }
    const optionsResponse = await fetch(API + '/api/2fa/passkey/options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ challenge_token: challengeToken }),
    });
    const optionsData = await parseOrThrow(optionsResponse, 'Passkey-Challenge fehlgeschlagen');
    const publicKey = optionsData.publicKey;
    publicKey.challenge = b64urlToBuffer(publicKey.challenge);
    publicKey.allowCredentials = (publicKey.allowCredentials || []).map(item => ({ ...item, id: b64urlToBuffer(item.id) }));
    const credential = await navigator.credentials.get({ publicKey });
    const verifyResponse = await fetch(API + '/api/2fa/passkey/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ challenge_token: challengeToken, credential: credentialToJson(credential), remember_device: rememberDevice }),
    });
    return parseOrThrow(verifyResponse, 'Passkey-Prüfung fehlgeschlagen');
  },

  async twoFactorStatus() {
    const response = await fetch(API + '/api/me/2fa', { headers: getAuthHeaders(), credentials: 'include' });
    return parseOrThrow(response, '2FA-Status fehlgeschlagen');
  },

  async startTotp() {
    const response = await fetch(API + '/api/me/2fa/totp/start', { method: 'POST', headers: getAuthHeaders(), credentials: 'include' });
    return parseOrThrow(response, 'TOTP-Setup fehlgeschlagen');
  },

  async confirmTotp(secret, code, password = '') {
    const response = await fetch(API + '/api/me/2fa/totp/confirm', {
      method: 'POST', headers: getAuthHeaders(), credentials: 'include', body: JSON.stringify({ secret, code, password }),
    });
    return parseOrThrow(response, 'TOTP konnte nicht aktiviert werden');
  },

  async disable2fa(code = '') {
    const response = await fetch(API + '/api/me/2fa/disable', {
      method: 'POST', headers: getAuthHeaders(), credentials: 'include', body: JSON.stringify({ code }),
    });
    return parseOrThrow(response, '2FA konnte nicht deaktiviert werden');
  },

  async deleteTotp() {
    const response = await fetch(API + '/api/me/2fa/totp', { method: 'DELETE', headers: getAuthHeaders(), credentials: 'include' });
    return parseOrThrow(response, 'Authenticator konnte nicht entfernt werden');
  },

  async listPasskeys() {
    const response = await fetch(API + '/api/me/passkeys', { headers: getAuthHeaders(), credentials: 'include' });
    return parseOrThrow(response, 'Passkeys konnten nicht geladen werden');
  },

  async deletePasskey(id) {
    const response = await fetch(API + `/api/me/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE', headers: getAuthHeaders(), credentials: 'include' });
    return parseOrThrow(response, 'Passkey konnte nicht widerrufen werden');
  },

  async createPasskey(name = 'Passkey', password = '') {
    if (RUNTIME_CAPABILITIES.native) {
      throw new Error('Passkeys werden in den Native Apps erst mit der nativen Passkey-Bridge unterstützt. Bitte im Browser verwalten.');
    }
    const optionsResponse = await fetch(API + '/api/me/passkeys/options', {
      method: 'POST', headers: getAuthHeaders(), credentials: 'include', body: JSON.stringify({ name }),
    });
    const optionsData = await parseOrThrow(optionsResponse, 'Passkey-Setup fehlgeschlagen');
    const publicKey = optionsData.publicKey;
    publicKey.challenge = b64urlToBuffer(publicKey.challenge);
    publicKey.user.id = b64urlToBuffer(publicKey.user.id);
    publicKey.excludeCredentials = (publicKey.excludeCredentials || []).map(item => ({ ...item, id: b64urlToBuffer(item.id) }));
    const credential = await navigator.credentials.create({ publicKey });
    const verifyResponse = await fetch(API + '/api/me/passkeys/verify', {
      method: 'POST', headers: getAuthHeaders(), credentials: 'include', body: JSON.stringify({ name, challenge: optionsData.challenge, credential: credentialToJson(credential), password }),
    });
    return parseOrThrow(verifyResponse, 'Passkey konnte nicht gespeichert werden');
  },

  async reauth(method, code) {
    const response = await fetch(API + '/api/me/2fa/reauth', {
      method: 'POST', headers: getAuthHeaders(), credentials: 'include', body: JSON.stringify({ method, code }),
    });
    return parseOrThrow(response, 'Reauth fehlgeschlagen');
  },

  async startEmailReauth() {
    const response = await fetch(API + '/api/me/2fa/reauth/email/start', {
      method: 'POST', headers: getAuthHeaders(), credentials: 'include', body: JSON.stringify({}),
    });
    return parseOrThrow(response, 'E-Mail-Reauth konnte nicht gestartet werden');
  },

  async reauthPasskey() {
    if (RUNTIME_CAPABILITIES.native) {
      throw new Error('Passkey-Reauth wird in den Native Apps erst mit der nativen Passkey-Bridge unterstützt.');
    }
    const optionsResponse = await fetch(API + '/api/me/2fa/reauth/passkey/options', {
      method: 'POST', headers: getAuthHeaders(), credentials: 'include', body: JSON.stringify({}),
    });
    const optionsData = await parseOrThrow(optionsResponse, 'Passkey-Reauth fehlgeschlagen');
    const publicKey = optionsData.publicKey;
    publicKey.challenge = b64urlToBuffer(publicKey.challenge);
    publicKey.allowCredentials = (publicKey.allowCredentials || []).map(item => ({ ...item, id: b64urlToBuffer(item.id) }));
    const credential = await navigator.credentials.get({ publicKey });
    const verifyResponse = await fetch(API + '/api/me/2fa/reauth/passkey/verify', {
      method: 'POST', headers: getAuthHeaders(), credentials: 'include', body: JSON.stringify({ challenge: optionsData.challenge, credential: credentialToJson(credential) }),
    });
    return parseOrThrow(verifyResponse, 'Passkey-Reauth fehlgeschlagen');
  },

  async regenerateRecoveryCodes() {
    const response = await fetch(API + '/api/me/2fa/recovery-codes/regenerate', { method: 'POST', headers: getAuthHeaders(), credentials: 'include' });
    return parseOrThrow(response, 'Recovery Codes konnten nicht erzeugt werden');
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

  async passwordSetupFeatures() {
    const response = await fetch(API + '/api/password-setup/features');
    return parseOrThrow(response, 'Passwort-Reset-Status fehlgeschlagen');
  },

  async requestPasswordReset(identifier) {
    const response = await fetch(API + '/api/password-setup/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier }),
      credentials: 'include',
    });
    return parseOrThrow(response, 'Passwort-Reset konnte nicht angefordert werden');
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

  async verifyEmail(token) {
    const response = await fetch(API + '/api/me/email/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ token }),
      credentials: 'include',
    });
    return parseOrThrow(response, 'E-Mail konnte nicht bestätigt werden');
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
