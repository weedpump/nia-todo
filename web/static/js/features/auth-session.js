import { getAuthToken, getCsrfToken, getAuthHeaders, serverBoundFetch } from '../api/http.js';
import { API, RUNTIME_CAPABILITIES } from '../core/config.js';
import { getJsonHeaders } from '../api/http.js';
import { createNativeBridge } from './native-bridge.js';
import { t } from '../i18n/index.js';

export function createAuthSessionFeature({
  authApi,
  getAppInitialized,
  getCurrentUser = () => null,
  setCurrentUser,
  clearCache,
  initApp,
  refreshFromServer,
  renderUserInfo,
  disconnectRealtime = null,
  resumeRealtime = null,
  clearNativeReminders = async () => {},
  resumeNativeReminders = () => {},
  logoutRevocationTimeoutMs = 5000,
}) {
  let loginInProgress = false;
  let loginFormBound = false;
  let passwordResetAvailable = false;
  let pendingMfaChallenge = null;
  let pendingMfaMethod = null;
  let nativeOidcListenerBound = false;
  let sessionPrivacyCleanupInFlight = null;
  let sessionPrivacyReloadRequested = false;
  const nativeBridge = createNativeBridge();
  const nativeOidcCodesInFlight = new Set();
  const consumedNativeOidcCodesKey = 'nia_consumed_native_oidc_codes';

  function getConsumedNativeOidcCodes() {
    try {
      const value = JSON.parse(sessionStorage.getItem(consumedNativeOidcCodesKey) || '[]');
      return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
    } catch (_error) {
      return [];
    }
  }

  function hasConsumedNativeOidcCode(code) {
    return getConsumedNativeOidcCodes().includes(String(code || ''));
  }

  function rememberConsumedNativeOidcCode(code) {
    const value = String(code || '');
    if (!value) return;
    const codes = getConsumedNativeOidcCodes().filter(existing => existing !== value);
    codes.push(value);
    sessionStorage.setItem(consumedNativeOidcCodesKey, JSON.stringify(codes.slice(-20)));
  }

  async function storeOidcUserSession(payload) {
    return completeLogin(payload);
  }

  async function handleNativeOidcCallback(url) {
    let parsed;
    try {
      parsed = new URL(String(url || ''));
    } catch (_error) {
      return;
    }
    if (parsed.protocol !== 'nia-todo:' || parsed.hostname !== 'oidc' || parsed.pathname !== '/callback') return;
    const code = parsed.searchParams.get('code');
    if (!code || hasConsumedNativeOidcCode(code) || nativeOidcCodesInFlight.has(code)) return;
    nativeOidcCodesInFlight.add(code);
    try {
      const response = await serverBoundFetch(`${API}/api/oidc/native/exchange`, {
        method: 'POST',
        headers: getJsonHeaders(),
        credentials: 'include',
        body: JSON.stringify({ code }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = data.detail || 'Native OIDC exchange failed';
        if (hasConsumedNativeOidcCode(code) && /invalid or expired/i.test(String(detail))) return;
        throw new Error(detail);
      }
      const payload = data.payload || {};
      if (data.kind === 'user') {
        const loginResult = await storeOidcUserSession(payload);
        rememberConsumedNativeOidcCode(code);
        if (loginResult?.identity_reload_required) return;
        hideLoginOverlay();
        if (getAppInitialized()) await refreshFromServer();
        else await initApp();
        renderUserInfo();
        history.replaceState(null, '', data.redirect_after || '/');
        window.dispatchEvent(new CustomEvent('nia-logged-in'));
        return;
      }
      sessionStorage.setItem('nia_oidc_error', JSON.stringify({ error_key: payload.error_key || 'auth.oidc.errorMessage', error: payload.error || '', kind: payload.kind || 'user' }));
      consumeOidcErrorNotice();
    } catch (error) {
      const message = error?.message || t('auth.oidc.errorMessage');
      const errorEl = document.getElementById('login-error');
      if (errorEl) errorEl.textContent = message;
      console.error('Native OIDC callback failed:', error);
    } finally {
      nativeOidcCodesInFlight.delete(code);
    }
  }

  function bindNativeOidcListener() {
    if (nativeOidcListenerBound || !RUNTIME_CAPABILITIES.native) return;
    nativeOidcListenerBound = true;
    nativeBridge.listenOidcCallbacks(handleNativeOidcCallback).catch((error) => {
      console.warn('Native OIDC callback listener unavailable', error);
    });
  }

  async function clearBrowserAuthCaches() {
    if ('serviceWorker' in navigator && typeof navigator.serviceWorker.getRegistrations === 'function') {
      const registrations = await navigator.serviceWorker.getRegistrations();
      registrations.forEach(reg => reg.active?.postMessage({ action: 'clearAuthCaches' }));
    }
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.filter(name => name.startsWith('nia-todo-api-')).map(name => caches.delete(name)));
    }
  }

  function clearLocalAuthState() {
    setCurrentUser(null);
    localStorage.removeItem('jwt_token');
    localStorage.removeItem('auth_token');
    localStorage.removeItem('last_user_id');
    localStorage.removeItem('csrf_token');
    localStorage.removeItem('cached_user');
    localStorage.removeItem('nia-mfa-enrollment-required');
  }

  async function invalidateSessionForPrivacy({ reload = false, triggeringSideEffectTokens = null } = {}) {
    if (reload) sessionPrivacyReloadRequested = true;
    if (!sessionPrivacyCleanupInFlight) {
      sessionPrivacyCleanupInFlight = (async () => {
        await disconnectRealtime?.({ triggeringSideEffectTokens });
        await clearNativeReminders();
        await clearBrowserAuthCaches();
        await clearCache();
        clearLocalAuthState();
        if (sessionPrivacyReloadRequested) location.reload();
        return false;
      })().finally(() => {
        sessionPrivacyCleanupInFlight = null;
        sessionPrivacyReloadRequested = false;
      });
    }
    return sessionPrivacyCleanupInFlight;
  }

  function persistCachedUser(user) {
    const { token, ...cacheableUser } = user || {};
    localStorage.setItem('cached_user', JSON.stringify(cacheableUser));
  }

  function readCachedUser(token) {
    const cached = localStorage.getItem('cached_user');
    if (cached) {
      try {
        const user = JSON.parse(cached);
        if (user?.id && user?.username) return { ...user, token };
      } catch (e) {
        localStorage.removeItem('cached_user');
      }
    }

    if (token?.includes('.')) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (payload.user_id && payload.username) {
          return { id: payload.user_id, username: payload.username, display_name: payload.username, token };
        }
      } catch (e) {
        // Invalid local JWT payload; server validation will decide when online.
      }
    }

    return null;
  }

  function isTransientAuthCheckFailure(error) {
    const status = Number(error?.status || 0);
    return !status || ![401, 403].includes(status) || error.name === 'TypeError';
  }

  function storeBootCredentials(data) {
    localStorage.setItem('jwt_token', data.access_token);
    localStorage.setItem('nia-mfa-enrollment-required', data.mfa_enrollment_required ? '1' : '0');
    if (data.csrf_token) localStorage.setItem('csrf_token', data.csrf_token);
  }

  function storeCrossUserBootCredentials(data) {
    localStorage.removeItem('cached_user');
    localStorage.removeItem('csrf_token');
    storeBootCredentials(data);
  }

  function storeUserSession(data, { activate = true } = {}) {
    const user = { ...data.user, token: data.access_token, mfa_enrollment_required: Boolean(data.mfa_enrollment_required) };
    if (activate) setCurrentUser(user);
    persistCachedUser(user);
    storeBootCredentials(data);
    return user;
  }

  function normalizedUserId(value) {
    if (value === undefined || value === null) return null;
    const id = String(value).trim();
    return /^\d+$/.test(id) ? id : null;
  }

  function priorAuthenticatedUserIds() {
    const ids = [];
    const activeUserId = normalizedUserId(getCurrentUser()?.id);
    if (activeUserId) ids.push(activeUserId);
    try {
      const cached = JSON.parse(localStorage.getItem('cached_user') || 'null');
      const cachedUserId = normalizedUserId(cached?.id);
      if (cachedUserId && cached?.username) ids.push(cachedUserId);
    } catch (_error) {
      // A corrupt cache is not an identity source; the active user still protects an initialized document.
    }
    const lastUserId = normalizedUserId(localStorage.getItem('last_user_id'));
    if (lastUserId) ids.push(lastUserId);
    return [...new Set(ids)];
  }

  async function clearCacheIfUserChanged(newUserId) {
    const previousUserIds = priorAuthenticatedUserIds();
    if (previousUserIds.some(previousUserId => previousUserId !== newUserId)) {
      console.log('User changed from', previousUserIds.join(','), 'to', newUserId, '- clearing cache');
      try {
        await disconnectRealtime?.();
        await clearNativeReminders();
        await clearBrowserAuthCaches();
        await clearCache();
      } catch (error) {
        error.authIdentityCleanupFailed = true;
        throw error;
      }
      return true;
    }
    return false;
  }

  async function completeLogin(data) {
    const newUserId = String(data.user.id);
    const userChanged = await clearCacheIfUserChanged(newUserId);
    if (userChanged) {
      storeCrossUserBootCredentials(data);
      localStorage.setItem('last_user_id', newUserId);
      location.reload();
      return { ...data, identity_reload_required: true };
    }
    storeUserSession(data);
    localStorage.setItem('last_user_id', newUserId);
    resumeNativeReminders();
    await resumeRealtime?.();
    await maybeVerifyEmailFromUrl();
    if (data.mfa_enrollment_required) {
      setTimeout(async () => {
        await window.openSettingsModal?.();
        const warningEl = document.getElementById('settings-2fa-error');
        if (warningEl) {
          warningEl.textContent = t('auth.mfa.enrollmentRequiredWarning');
        }
      }, 100);
    }
    return data;
  }

  async function login(username, password) {
    const data = await authApi.login(username, password);
    if (data.mfa_required) return data;
    return completeLogin(data);
  }

  function loginMfaMethods(challengeData = pendingMfaChallenge) {
    return challengeData?.challenge?.methods || [];
  }

  function browserOrNativePasskeysAvailable() {
    return ((!RUNTIME_CAPABILITIES.native && window.PublicKeyCredential && navigator.credentials) || RUNTIME_CAPABILITIES.nativePasskeys);
  }

  function canUseLoginPasskey(challengeData = pendingMfaChallenge) {
    const methods = loginMfaMethods(challengeData);
    return methods.includes('passkey') && browserOrNativePasskeysAvailable();
  }

  function preferredCodeMfaMethod(challengeData = pendingMfaChallenge) {
    const methods = loginMfaMethods(challengeData);
    return methods.includes('totp') ? 'totp'
      : methods.includes('recovery_code') ? 'recovery_code'
      : methods.includes('email') ? 'email'
      : null;
  }

  function preferredMfaMethod(challengeData) {
    const codeMethod = preferredCodeMfaMethod(challengeData);
    if (RUNTIME_CAPABILITIES.native && codeMethod) return codeMethod;
    if (canUseLoginPasskey(challengeData)) return 'passkey';
    return codeMethod || loginMfaMethods(challengeData)[0];
  }

  function resetLoginMfaPanel() {
    pendingMfaChallenge = null;
    pendingMfaMethod = null;
    document.getElementById('login-mfa-panel')?.classList.add('hidden');
    const codeInput = document.getElementById('login-mfa-code');
    const rememberInput = document.getElementById('login-remember-device');
    const switchBtn = document.getElementById('login-mfa-switch-btn');
    const submitBtn = document.querySelector('button.login-btn');
    if (codeInput) codeInput.value = '';
    if (switchBtn) switchBtn.classList.add('hidden');
    if (rememberInput) rememberInput.checked = false;
    if (submitBtn) submitBtn.textContent = t('auth.signIn');
    document.getElementById('login-username')?.removeAttribute('readonly');
    document.getElementById('login-password')?.removeAttribute('readonly');
    document.getElementById('login-forgot-btn')?.classList.toggle('hidden', !passwordResetAvailable);
  }

  function updateLoginMfaPanel() {
    const methods = loginMfaMethods();
    const panel = document.getElementById('login-mfa-panel');
    const hintEl = document.getElementById('login-mfa-hint');
    const codeWrap = document.getElementById('login-mfa-code-wrap');
    const codeInput = document.getElementById('login-mfa-code');
    const codeLabel = document.getElementById('login-mfa-code-label');
    const switchBtn = document.getElementById('login-mfa-switch-btn');
    const submitBtn = document.querySelector('button.login-btn');
    const codeMethod = preferredCodeMfaMethod();
    const hasCodeOption = Boolean(codeMethod);
    const hasPasskeyOption = canUseLoginPasskey();
    const labels = {
      email: t('security.mfa.code.email'),
      recovery_code: t('security.mfa.code.recovery'),
      passkey: t('security.mfa.passkeyName'),
      totp: methods.includes('recovery_code') ? t('security.mfa.code.authOrRecovery') : t('security.mfa.code.authenticator'),
    };
    const label = labels[pendingMfaMethod] || t('auth.mfa.codeLabel');
    if (hintEl) hintEl.textContent = pendingMfaMethod === 'email'
      ? t('auth.mfa.emailSent')
      : pendingMfaMethod === 'passkey'
        ? t('auth.mfa.passkeyOrCodeHint')
        : hasPasskeyOption
          ? t('auth.mfa.codeOrPasskeyHint')
          : t('auth.mfa.codeHint');
    if (codeLabel) codeLabel.textContent = label;
    if (codeInput) {
      codeInput.value = '';
      codeInput.placeholder = t('auth.mfa.enterCodePlaceholder', { label });
      codeInput.required = pendingMfaMethod !== 'passkey';
    }
    if (codeWrap) codeWrap.style.display = pendingMfaMethod === 'passkey' ? 'none' : '';
    if (switchBtn) {
      const showSwitch = hasPasskeyOption && hasCodeOption;
      switchBtn.classList.toggle('hidden', !showSwitch);
      switchBtn.textContent = pendingMfaMethod === 'passkey' ? t('auth.mfa.signInWithCode') : t('auth.mfa.signInWithPasskey');
    }
    if (submitBtn) submitBtn.textContent = pendingMfaMethod === 'passkey' ? t('auth.mfa.signInWithPasskey') : t('auth.mfa.confirm');
    panel?.classList.remove('hidden');
    if (pendingMfaMethod === 'passkey') submitBtn?.focus();
    else codeInput?.focus();
  }

  function selectLoginMfaMethod(method) {
    const codeMethod = preferredCodeMfaMethod();
    pendingMfaMethod = method === 'passkey' && canUseLoginPasskey() ? 'passkey' : codeMethod || method;
    updateLoginMfaPanel();
  }

  function showLoginMfaPanel(challengeData) {
    pendingMfaChallenge = challengeData;
    pendingMfaMethod = preferredMfaMethod(challengeData);
    document.getElementById('login-username')?.setAttribute('readonly', 'readonly');
    document.getElementById('login-password')?.setAttribute('readonly', 'readonly');
    document.getElementById('login-forgot-btn')?.classList.add('hidden');
    updateLoginMfaPanel();
  }

  async function verifyPendingMfaChallenge() {
    if (!pendingMfaChallenge) throw new Error(t('auth.mfa.noActiveChallenge'));
    const rememberDevice = !!document.getElementById('login-remember-device')?.checked;
    if (pendingMfaMethod === 'passkey') {
      const verified = await authApi.verifyPasskeyLogin(pendingMfaChallenge.challenge.challenge_token, rememberDevice);
      return completeLogin(verified);
    }
    const code = document.getElementById('login-mfa-code')?.value?.trim() || '';
    if (!code) throw new Error(t('auth.mfa.codeRequired'));
    const method = pendingMfaMethod === 'totp' && code.includes('-') ? 'recovery_code' : pendingMfaMethod;
    const verified = await authApi.verify2fa(pendingMfaChallenge.challenge.challenge_token, method, code, rememberDevice);
    return completeLogin(verified);
  }

  async function checkAuth({ preferCached = false, authoritative = false } = {}) {
    const token = getAuthToken();
    if (!token) return false;

    if (preferCached) {
      const cachedUser = readCachedUser(token);
      if (cachedUser) {
        setCurrentUser(cachedUser);
        return true;
      }
    }

    try {
      const authRequest = authApi.me();
      const user = authoritative
        ? await authRequest
        : await Promise.race([
          authRequest,
          new Promise((_, reject) => setTimeout(() => reject(new Error('auth check timeout')), 2500)),
        ]);
      const newUserId = String(user.id);
      const userChanged = await clearCacheIfUserChanged(newUserId);
      const refreshedToken = user.access_token || token;
      if (userChanged) {
        storeCrossUserBootCredentials({
          user,
          access_token: refreshedToken,
          csrf_token: user.csrf_token,
          mfa_enrollment_required: user.mfa_enrollment_required,
        }, { activate: false });
        localStorage.setItem('last_user_id', newUserId);
        console.log('User changed, cache cleared — reloading once');
        location.reload();
        return false;
      }

      if (user.access_token) localStorage.setItem('jwt_token', user.access_token);
      if (user.csrf_token) localStorage.setItem('csrf_token', user.csrf_token);
      setCurrentUser({ ...user, token: refreshedToken });
      persistCachedUser({ ...user, token: refreshedToken });
      localStorage.setItem('last_user_id', newUserId);
      await maybeVerifyEmailFromUrl();

      return true;
    } catch (e) {
      if (e?.authIdentityCleanupFailed) throw e;
      if (e?.code === 'session_invalidated') return false;
      if (isTransientAuthCheckFailure(e)) {
        if (authoritative) throw e;
        const cachedUser = readCachedUser(token);
        if (cachedUser) {
          console.log('Auth check unavailable; keeping cached offline session');
          setCurrentUser(cachedUser);
          return true;
        }
      }

      return invalidateSessionForPrivacy();
    }
  }

  async function logout() {
    const realtimeShutdown = Promise.resolve(disconnectRealtime?.());
    await realtimeShutdown;
    await clearNativeReminders();
    if (getAuthToken()) {
      const controller = new AbortController();
      let timeoutId;
      try {
        await Promise.race([
          authApi.logout({ signal: controller.signal }),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              controller.abort();
              reject(new Error('Logout revocation timed out'));
            }, logoutRevocationTimeoutMs);
          }),
        ]);
      } catch (e) {
        // Local privacy cleanup must still complete when server revocation is unavailable.
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }
    await clearBrowserAuthCaches();
    await clearCache();

    clearLocalAuthState();
    location.reload();
  }

  function showLoginOverlay() {
    const overlay = document.getElementById('login-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    overlay.inert = false;
    overlay.removeAttribute('aria-hidden');
    overlay.style.display = '';
    overlay.style.pointerEvents = '';
  }

  function hideLoginOverlay() {
    const overlay = document.getElementById('login-overlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.inert = true;
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.display = 'none';
    overlay.style.pointerEvents = 'none';
  }

  async function loadPasswordResetFeatures() {
    try {
      const features = await authApi.passwordSetupFeatures();
      passwordResetAvailable = !!features.password_reset_available;
      const forgotBtn = document.getElementById('login-forgot-btn');
      if (forgotBtn) forgotBtn.classList.toggle('hidden', !passwordResetAvailable);
    } catch (e) {
      passwordResetAvailable = false;
    }
  }

  function toggleResetPanel() {
    if (!passwordResetAvailable) return;
    const panel = document.getElementById('login-reset-panel');
    if (!panel) return;
    panel.classList.toggle('hidden');
    document.getElementById('login-reset-message').textContent = '';
    if (!panel.classList.contains('hidden')) {
      const username = document.getElementById('login-username')?.value?.trim() || '';
      const input = document.getElementById('login-reset-identifier');
      if (input && !input.value) input.value = username;
      input?.focus();
    }
  }

  async function requestPasswordReset() {
    const input = document.getElementById('login-reset-identifier');
    const messageEl = document.getElementById('login-reset-message');
    const button = document.getElementById('login-reset-submit');
    const identifier = input?.value?.trim() || '';
    if (!identifier) {
      messageEl.textContent = 'Please enter username or email.';
      return;
    }
    if (button) button.disabled = true;
    try {
      const data = await authApi.requestPasswordReset(identifier);
      messageEl.textContent = data.message || 'If an account matches, an email has been sent.';
    } catch (e) {
      messageEl.textContent = e.message || 'Reset could not be requested.';
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function maybeVerifyEmailFromUrl() {
    const params = new URLSearchParams(location.search);
    const urlToken = params.get('verifyEmail');
    if (urlToken) {
      sessionStorage.setItem('pending_email_verify_token', urlToken);
      params.delete('verifyEmail');
      const next = `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash}`;
      history.replaceState(null, '', next);
    }
    const token = sessionStorage.getItem('pending_email_verify_token');
    if (!token || !getAuthToken()) return;
    try {
      await authApi.verifyEmail(token);
      sessionStorage.removeItem('pending_email_verify_token');
    } catch (e) {
      console.warn('Email verification failed:', e);
    }
  }

  async function handlePasswordlessPasskeyLogin() {
    if (loginInProgress) return;
    loginInProgress = true;
    const errorEl = document.getElementById('login-error');
    const button = document.getElementById('login-passkey-btn');
    if (errorEl) errorEl.textContent = '';
    if (button) button.disabled = true;
    try {
      const data = await authApi.loginWithPasskey();
      const loginResult = await completeLogin(data);
      if (loginResult?.identity_reload_required) return;
      resetLoginMfaPanel();
      hideLoginOverlay();
      renderUserInfo();
      if (!getAppInitialized()) await initApp();
      await refreshFromServer().catch(err => console.warn('Post-login refresh failed:', err));
      window.dispatchEvent(new CustomEvent('nia-logged-in'));
    } catch (err) {
      console.error('Passkey login failed:', err);
      if (errorEl) errorEl.textContent = err.message || t('api.auth.passkeyLoginFailed', { error: '' });
    } finally {
      loginInProgress = false;
      if (button) button.disabled = false;
    }
  }

  async function handleLogin(e) {
    e?.preventDefault?.();
    if (loginInProgress) return;
    loginInProgress = true;
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('login-error');
    const submitBtn = e?.submitter || document.querySelector('button.login-btn');
    errorEl.textContent = '';
    if (submitBtn) submitBtn.disabled = true;

    try {
      let loginResult;
      if (pendingMfaChallenge) {
        loginResult = await verifyPendingMfaChallenge();
      } else {
        const data = await login(username, password);
        if (data?.mfa_required) {
          showLoginMfaPanel(data);
          return;
        }
        loginResult = data;
      }
      if (loginResult?.identity_reload_required) return;
      resetLoginMfaPanel();
      hideLoginOverlay();
      renderUserInfo();
      const enrollmentOnly = localStorage.getItem('nia-mfa-enrollment-required') === '1';
      if (!enrollmentOnly) {
        if (!getAppInitialized()) await initApp();
        await refreshFromServer().catch(err => console.warn('Post-login refresh failed:', err));
      }
      window.dispatchEvent(new CustomEvent('nia-logged-in'));
    } catch (err) {
      console.error('Login failed:', err);
      errorEl.textContent = err.message || 'Login failed';
    } finally {
      loginInProgress = false;
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  function bindLoginForm() {
    bindNativeOidcListener();
    if (loginFormBound) return;
    const form = document.getElementById('login-form');
    if (!form) return;
    loginFormBound = true;
    form.addEventListener('submit', handleLogin);
    const oidcBtn = document.getElementById('login-oidc-btn');
    if (oidcBtn) {
      serverBoundFetch(`${API}/api/oidc/status`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (!data?.enabled) return;
          oidcBtn.textContent = t('auth.oidc.signInWithProvider', { provider: data.provider_name || 'OIDC' });
          oidcBtn.classList.remove('hidden');
        })
        .catch(() => {});
      oidcBtn.addEventListener('click', async () => {
        const next = encodeURIComponent(location.pathname + location.search + location.hash || '/');
        if (RUNTIME_CAPABILITIES.native && nativeBridge?.openExternal) {
          try {
            const opened = await nativeBridge.openExternal(`${API}/api/oidc/login?redirect_after=${next}&native=1`);
            if (opened) return;
          } catch (error) {
            console.warn('Native OIDC external browser launch failed, falling back to WebView redirect', error);
          }
        }
        location.href = `${API}/api/oidc/login?redirect_after=${next}`;
      });
    }
    const passkeyBtn = document.getElementById('login-passkey-btn');
    if (passkeyBtn) {
      passkeyBtn.classList.toggle('hidden', !browserOrNativePasskeysAvailable());
      passkeyBtn.addEventListener('click', handlePasswordlessPasskeyLogin);
    }
    document.getElementById('login-forgot-btn')?.addEventListener('click', toggleResetPanel);
    document.getElementById('login-mfa-switch-btn')?.addEventListener('click', () => {
      selectLoginMfaMethod(pendingMfaMethod === 'passkey' ? preferredCodeMfaMethod() : 'passkey');
      document.getElementById('login-error').textContent = '';
    });
    document.getElementById('login-mfa-back-btn')?.addEventListener('click', () => {
      resetLoginMfaPanel();
      document.getElementById('login-error').textContent = '';
      document.getElementById('login-password')?.focus();
    });
    document.getElementById('login-reset-submit')?.addEventListener('click', requestPasswordReset);
    document.getElementById('login-reset-identifier')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') requestPasswordReset();
      if (event.key === 'Escape') document.getElementById('login-reset-panel')?.classList.add('hidden');
    });
    loadPasswordResetFeatures();
    window.__niaLoginReady = true;

    if (window.__niaPendingLoginSubmit) {
      window.__niaPendingLoginSubmit = false;
      requestAnimationFrame(() => form.requestSubmit());
    }
  }

  return {
    getAuthToken,
    getCsrfToken,
    getAuthHeaders,
    login,
    checkAuth,
    logout,
    invalidateSessionForPrivacy,
    handleNativeOidcCallback,
    showLoginOverlay,
    hideLoginOverlay,
    handleLogin,
    bindLoginForm,
    clearLocalAuthState,
    clearBrowserAuthCaches,
  };
}
