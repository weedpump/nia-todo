import { API, RUNTIME_CAPABILITIES } from '../core/config.js';
import { createNativeBridge } from '../features/native-bridge.js';
import { getAuthHeaders, getJsonHeaders } from './http.js';
import { apiErrorFromResponse } from './errors.js';
import { t } from '../i18n/index.js';

async function parseOrThrow(response, fallback = 'Request failed') {
  if (!response.ok) await apiErrorFromResponse(response, fallback);
  return response.json().catch(() => ({}));
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
  if (credential && typeof credential === 'object' && credential.response && !(credential.rawId instanceof ArrayBuffer)) {
    return {
      id: credential.id,
      rawId: credential.rawId || credential.id,
      type: credential.type || 'public-key',
      response: credential.response,
      transports: credential.response?.transports || credential.transports || [],
    };
  }
  const response = {};
  for (const key of ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle']) {
    const value = credential.response?.[key];
    if (value instanceof ArrayBuffer) response[key] = bufferToB64url(value);
    else if (typeof value === 'string') response[key] = value;
  }
  return {
    id: credential.id,
    rawId: credential.rawId instanceof ArrayBuffer ? bufferToB64url(credential.rawId) : (credential.rawId || credential.id),
    type: credential.type || 'public-key',
    response,
    transports: typeof credential.response?.getTransports === 'function' ? credential.response.getTransports() : (credential.transports || []),
  };
}

const nativeBridge = createNativeBridge();

function canUseNativePasskeyBridge() {
  return nativeBridge.supportsNativePasskeys();
}

function browserPublicKeyFromJson(publicKey, mode) {
  const next = structuredClone(publicKey);
  next.challenge = b64urlToBuffer(next.challenge);
  if (mode === 'create') {
    next.user.id = b64urlToBuffer(next.user.id);
    next.excludeCredentials = (next.excludeCredentials || []).map(item => ({ ...item, id: b64urlToBuffer(item.id) }));
  } else if (Array.isArray(next.allowCredentials)) {
    next.allowCredentials = next.allowCredentials.map(item => ({ ...item, id: b64urlToBuffer(item.id) }));
  }
  return next;
}

function passkeyOrigin(optionsData) {
  return optionsData?.origin || (API ? new URL(API).origin : location.origin);
}

export const authApi = {
  async login(username, password) {
    const response = await fetch(API + '/api/login', {
      method: 'POST',
      headers: getJsonHeaders(),
      body: JSON.stringify({ username, password }),
      credentials: 'include',
    });
    return parseOrThrow(response, t('api.auth.loginFailed'));
  },

  async loginWithPasskey() {
    if (RUNTIME_CAPABILITIES.native && !canUseNativePasskeyBridge()) {
      throw new Error(t('api.auth.nativePasskeysUnsupportedUseCode'));
    }
    const optionsResponse = await fetch(API + '/api/login/passkey/options', {
      method: 'POST', headers: getJsonHeaders(), credentials: 'include', body: JSON.stringify({}),
    });
    const optionsData = await parseOrThrow(optionsResponse, t('api.auth.passkeyChallengeFailed'));
    const publicKey = optionsData.publicKey;
    let credential;
    try {
      credential = canUseNativePasskeyBridge()
        ? await nativeBridge.passkeyAuthenticate(passkeyOrigin(optionsData), publicKey)
        : await navigator.credentials.get({ publicKey: browserPublicKeyFromJson(publicKey, 'get') });
    } catch (error) {
      throw new Error(t('api.auth.passkeyLoginFailed', { error: error?.message || error }));
    }
    const verifyResponse = await fetch(API + '/api/login/passkey/verify', {
      method: 'POST', headers: getJsonHeaders(), credentials: 'include', body: JSON.stringify({ challenge: optionsData.challenge, credential: credentialToJson(credential) }),
    });
    return parseOrThrow(verifyResponse, t('api.auth.passkeyVerifyFailed'));
  },

  async verify2fa(challengeToken, method, code, rememberDevice = false) {
    const response = await fetch(API + '/api/2fa/challenge/verify', {
      method: 'POST',
      headers: getJsonHeaders(),
      body: JSON.stringify({ challenge_token: challengeToken, method, code, remember_device: rememberDevice }),
      credentials: 'include',
    });
    return parseOrThrow(response, t('api.auth.twoFactorVerifyFailed'));
  },

  async verifyPasskeyLogin(challengeToken, rememberDevice = false) {
    if (RUNTIME_CAPABILITIES.native && !canUseNativePasskeyBridge()) {
      throw new Error(t('api.auth.nativePasskeysUnsupportedUseCode'));
    }
    const optionsResponse = await fetch(API + '/api/2fa/passkey/options', {
      method: 'POST', headers: getJsonHeaders(), credentials: 'include', body: JSON.stringify({ challenge_token: challengeToken }),
    });
    const optionsData = await parseOrThrow(optionsResponse, t('api.auth.passkeyChallengeFailed'));
    const publicKey = optionsData.publicKey;
    let credential;
    try {
      credential = canUseNativePasskeyBridge()
        ? await nativeBridge.passkeyAuthenticate(passkeyOrigin(optionsData), publicKey)
        : await navigator.credentials.get({ publicKey: browserPublicKeyFromJson(publicKey, 'get') });
    } catch (error) {
      throw new Error(t('api.auth.passkeyLoginFailed', { error: error?.message || error }));
    }
    const verifyResponse = await fetch(API + '/api/2fa/passkey/verify', {
      method: 'POST', headers: getJsonHeaders(), credentials: 'include', body: JSON.stringify({ challenge_token: challengeToken, credential: credentialToJson(credential), remember_device: rememberDevice }),
    });
    return parseOrThrow(verifyResponse, t('api.auth.passkeyVerifyFailed'));
  },

  async twoFactorStatus() {
    const response = await fetch(API + '/api/me/2fa', { headers: getAuthHeaders(), credentials: 'include' });
    return parseOrThrow(response, t('api.auth.twoFactorStatusFailed'));
  },

  async startTotp() {
    const response = await fetch(API + '/api/me/2fa/totp/start', { method: 'POST', headers: getAuthHeaders(), credentials: 'include' });
    return parseOrThrow(response, t('api.auth.totpSetupFailed'));
  },

  async confirmTotp(secret, code, password = '') {
    const response = await fetch(API + '/api/me/2fa/totp/confirm', {
      method: 'POST', headers: getAuthHeaders(), credentials: 'include', body: JSON.stringify({ secret, code, password }),
    });
    return parseOrThrow(response, t('api.auth.totpEnableFailed'));
  },

  async disable2fa(code = '') {
    const response = await fetch(API + '/api/me/2fa/disable', {
      method: 'POST', headers: getAuthHeaders(), credentials: 'include', body: JSON.stringify({ code }),
    });
    return parseOrThrow(response, t('api.auth.twoFactorDisableFailed'));
  },

  async deleteTotp() {
    const response = await fetch(API + '/api/me/2fa/totp', { method: 'DELETE', headers: getAuthHeaders(), credentials: 'include' });
    return parseOrThrow(response, t('api.auth.authenticatorRemoveFailed'));
  },

  async listPasskeys() {
    const response = await fetch(API + '/api/me/passkeys', { headers: getAuthHeaders(), credentials: 'include' });
    return parseOrThrow(response, t('api.auth.passkeysLoadFailed'));
  },

  async deletePasskey(id) {
    const response = await fetch(API + `/api/me/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE', headers: getAuthHeaders(), credentials: 'include' });
    return parseOrThrow(response, t('api.auth.passkeyRevokeFailed'));
  },

  async listTrustedDevices() {
    const response = await fetch(API + '/api/me/2fa/trusted-devices', { headers: getAuthHeaders(), credentials: 'include' });
    return parseOrThrow(response, t('api.auth.trustedDevicesLoadFailed'));
  },

  async deleteTrustedDevice(id) {
    const response = await fetch(API + `/api/me/2fa/trusted-devices/${encodeURIComponent(id)}`, { method: 'DELETE', headers: getAuthHeaders(), credentials: 'include' });
    return parseOrThrow(response, t('api.auth.trustedDeviceRevokeFailed'));
  },

  async deleteAllTrustedDevices() {
    const response = await fetch(API + '/api/me/2fa/trusted-devices', { method: 'DELETE', headers: getAuthHeaders(), credentials: 'include' });
    return parseOrThrow(response, t('api.auth.trustedDevicesRevokeFailed'));
  },

  async createPasskey(name = 'Passkey', password = '') {
    if (RUNTIME_CAPABILITIES.native && !canUseNativePasskeyBridge()) {
      throw new Error(t('api.auth.nativePasskeysUnsupportedManageBrowser'));
    }
    const optionsResponse = await fetch(API + '/api/me/passkeys/options', {
      method: 'POST', headers: getAuthHeaders(), credentials: 'include', body: JSON.stringify({ name }),
    });
    const optionsData = await parseOrThrow(optionsResponse, t('api.auth.passkeySetupFailed'));
    const publicKey = optionsData.publicKey;
    let credential;
    try {
      credential = canUseNativePasskeyBridge()
        ? await nativeBridge.passkeyRegister(passkeyOrigin(optionsData), publicKey)
        : await navigator.credentials.create({ publicKey: browserPublicKeyFromJson(publicKey, 'create') });
    } catch (error) {
      throw new Error(t('api.auth.passkeyRegistrationFailed', { error: error?.message || error }));
    }
    const verifyResponse = await fetch(API + '/api/me/passkeys/verify', {
      method: 'POST', headers: getAuthHeaders(), credentials: 'include', body: JSON.stringify({ name, challenge: optionsData.challenge, credential: credentialToJson(credential), password }),
    });
    return parseOrThrow(verifyResponse, t('api.auth.passkeySaveFailed'));
  },

  async reauth(method, code) {
    const response = await fetch(API + '/api/me/2fa/reauth', {
      method: 'POST', headers: getAuthHeaders(), credentials: 'include', body: JSON.stringify({ method, code }),
    });
    return parseOrThrow(response, t('api.auth.reauthFailed'));
  },

  async startEmailReauth() {
    const response = await fetch(API + '/api/me/2fa/reauth/email/start', {
      method: 'POST', headers: getAuthHeaders(), credentials: 'include', body: JSON.stringify({}),
    });
    return parseOrThrow(response, t('api.auth.emailReauthStartFailed'));
  },

  async reauthPasskey() {
    if (RUNTIME_CAPABILITIES.native && !canUseNativePasskeyBridge()) {
      throw new Error(t('api.auth.nativePasskeyReauthUnsupported'));
    }
    const optionsResponse = await fetch(API + '/api/me/2fa/reauth/passkey/options', {
      method: 'POST', headers: getAuthHeaders(), credentials: 'include', body: JSON.stringify({}),
    });
    const optionsData = await parseOrThrow(optionsResponse, t('api.auth.passkeyReauthFailed'));
    const publicKey = optionsData.publicKey;
    let credential;
    try {
      credential = canUseNativePasskeyBridge()
        ? await nativeBridge.passkeyAuthenticate(passkeyOrigin(optionsData), publicKey)
        : await navigator.credentials.get({ publicKey: browserPublicKeyFromJson(publicKey, 'get') });
    } catch (error) {
      throw new Error(t('api.auth.passkeyConfirmationFailed', { error: error?.message || error }));
    }
    const verifyResponse = await fetch(API + '/api/me/2fa/reauth/passkey/verify', {
      method: 'POST', headers: getAuthHeaders(), credentials: 'include', body: JSON.stringify({ challenge: optionsData.challenge, credential: credentialToJson(credential) }),
    });
    return parseOrThrow(verifyResponse, t('api.auth.passkeyReauthFailed'));
  },

  async regenerateRecoveryCodes() {
    const response = await fetch(API + '/api/me/2fa/recovery-codes/regenerate', { method: 'POST', headers: getAuthHeaders(), credentials: 'include' });
    return parseOrThrow(response, t('api.auth.recoveryGenerateFailed'));
  },

  async me() {
    const response = await fetch(API + '/api/me', {
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    return parseOrThrow(response, t('api.auth.notAuthenticated'));
  },

  async logout() {
    const response = await fetch(API + '/api/logout', {
      method: 'POST',
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    return parseOrThrow(response, t('api.auth.logoutFailed'));
  },

  async passwordSetupFeatures() {
    const response = await fetch(API + '/api/password-setup/features');
    return parseOrThrow(response, t('api.auth.passwordResetStatusFailed'));
  },

  async requestPasswordReset(identifier) {
    const response = await fetch(API + '/api/password-setup/request', {
      method: 'POST',
      headers: getJsonHeaders(),
      body: JSON.stringify({ identifier }),
      credentials: 'include',
    });
    return parseOrThrow(response, t('api.auth.passwordResetRequestFailed'));
  },

  async changePassword(oldPassword, newPassword) {
    const response = await fetch(API + '/api/me/change-password', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
      credentials: 'include',
    });
    return parseOrThrow(response, t('api.auth.passwordChangeFailed'));
  },

  async updateProfile(displayName) {
    const response = await fetch(API + '/api/me/profile', {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ display_name: displayName }),
      credentials: 'include',
    });
    return parseOrThrow(response, t('api.auth.profileUpdateFailed'));
  },

  async updateLanguage(language) {
    const response = await fetch(API + '/api/me/language', {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ language }),
      credentials: 'include',
    });
    return parseOrThrow(response, t('api.auth.languageSaveFailed'));
  },

  async getBrainDumpLearning() {
    const response = await fetch(API + '/api/braindump/v2/learning', {
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    return parseOrThrow(response, t('api.auth.braindumpLearningLoadFailed'));
  },

  async updateBrainDumpLearning(enabled) {
    const response = await fetch(API + '/api/braindump/v2/learning', {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ enabled: Boolean(enabled) }),
      credentials: 'include',
    });
    return parseOrThrow(response, t('api.auth.braindumpLearningSaveFailed'));
  },

  async resetBrainDumpLearning() {
    const response = await fetch(API + '/api/braindump/v2/learning', {
      method: 'DELETE',
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    return parseOrThrow(response, t('api.auth.braindumpLearningResetFailed'));
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
    return parseOrThrow(response, t('api.auth.avatarUploadFailed'));
  },

  async deleteAvatar() {
    const response = await fetch(API + '/api/me/avatar', {
      method: 'DELETE',
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    return parseOrThrow(response, t('api.auth.avatarDeleteFailed'));
  },

  async verifyEmail(token) {
    const response = await fetch(API + '/api/me/email/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ token }),
      credentials: 'include',
    });
    return parseOrThrow(response, t('api.auth.emailVerifyFailed'));
  },

  async updateEmail(email) {
    const response = await fetch(API + '/api/me/email', {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ email }),
      credentials: 'include',
    });
    return parseOrThrow(response, t('api.auth.emailUpdateFailed'));
  },

  async listApiKeys() {
    const response = await fetch(API + '/api/me/api-keys', {
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    return parseOrThrow(response, t('api.auth.apiKeyListFailed'));
  },

  async createApiKey(name) {
    const response = await fetch(API + '/api/me/api-keys', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ name }),
      credentials: 'include',
    });
    return parseOrThrow(response, t('api.auth.apiKeyCreateFailed'));
  },

  async revokeApiKey(keyId) {
    const response = await fetch(API + `/api/me/api-keys/${keyId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    return parseOrThrow(response, t('api.auth.apiKeyDeleteFailed'));
  },

  async setupStatus() {
    const response = await fetch(API + '/api/setup/status');
    return parseOrThrow(response, t('api.auth.setupStatusFailed'));
  },
};
