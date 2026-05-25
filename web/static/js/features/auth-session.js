import { getAuthToken, getCsrfToken, getAuthHeaders } from '../api/http.js';
import { RUNTIME_CAPABILITIES } from '../core/config.js';
import { t } from '../i18n/index.js';

export function createAuthSessionFeature({
  authApi,
  getAppInitialized,
  setCurrentUser,
  clearCache,
  initApp,
  refreshFromServer,
  renderUserInfo,
}) {
  let loginInProgress = false;
  let loginFormBound = false;
  let passwordResetAvailable = false;
  let pendingMfaChallenge = null;
  let pendingMfaMethod = null;

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
    return !error?.status || error.name === 'TypeError';
  }

  function storeUserSession(data) {
    const user = { ...data.user, token: data.access_token, mfa_enrollment_required: Boolean(data.mfa_enrollment_required) };
    setCurrentUser(user);
    persistCachedUser(user);
    localStorage.setItem('jwt_token', data.access_token);
    localStorage.setItem('nia-mfa-enrollment-required', data.mfa_enrollment_required ? '1' : '0');
    if (data.csrf_token) localStorage.setItem('csrf_token', data.csrf_token);
    return user;
  }

  async function clearCacheIfUserChanged(newUserId) {
    const lastUserId = localStorage.getItem('last_user_id');
    if (lastUserId && lastUserId !== newUserId) {
      console.log('User changed from', lastUserId, 'to', newUserId, '- clearing cache');
      await clearBrowserAuthCaches();
      await clearCache();
      return true;
    }
    return false;
  }

  async function completeLogin(data) {
    storeUserSession(data);
    await maybeVerifyEmailFromUrl();
    const newUserId = String(data.user.id);
    await clearCacheIfUserChanged(newUserId);
    localStorage.setItem('last_user_id', newUserId);
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

  function canUseLoginPasskey(challengeData = pendingMfaChallenge) {
    const methods = loginMfaMethods(challengeData);
    return methods.includes('passkey') && ((!RUNTIME_CAPABILITIES.native && window.PublicKeyCredential && navigator.credentials) || RUNTIME_CAPABILITIES.nativePasskeys);
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

  async function checkAuth() {
    const token = getAuthToken();
    if (!token) return false;

    try {
      const user = await Promise.race([
        authApi.me(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('auth check timeout')), 2500)),
      ]);
      const refreshedToken = user.access_token || token;
      if (user.access_token) localStorage.setItem('jwt_token', user.access_token);
      if (user.csrf_token) localStorage.setItem('csrf_token', user.csrf_token);
      setCurrentUser({ ...user, token: refreshedToken });
      persistCachedUser({ ...user, token: refreshedToken });
      await maybeVerifyEmailFromUrl();

      const newUserId = String(user.id);
      const userChanged = await clearCacheIfUserChanged(newUserId);
      localStorage.setItem('last_user_id', newUserId);
      if (userChanged) {
        console.log('User changed, cache cleared — reloading once');
        location.reload();
        return false;
      }

      return true;
    } catch (e) {
      if (isTransientAuthCheckFailure(e)) {
        const cachedUser = readCachedUser(token);
        if (cachedUser) {
          console.log('Auth check unavailable; keeping cached offline session');
          setCurrentUser(cachedUser);
          return true;
        }
      }

      localStorage.removeItem('jwt_token');
      localStorage.removeItem('auth_token');
      localStorage.removeItem('csrf_token');
      localStorage.removeItem('cached_user');
      setCurrentUser(null);
      return false;
    }
  }

  async function logout() {
    try {
      if (getAuthToken()) await authApi.logout();
    } catch (e) {
      // Ignore logout errors; local session cleanup still needs to happen.
    }

    setCurrentUser(null);
    localStorage.removeItem('jwt_token');
    localStorage.removeItem('auth_token');
    localStorage.removeItem('last_user_id');
    localStorage.removeItem('csrf_token');
    localStorage.removeItem('cached_user');
    localStorage.removeItem('nia-mfa-enrollment-required');

    await clearBrowserAuthCaches();
    await clearCache();
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
      if (pendingMfaChallenge) {
        await verifyPendingMfaChallenge();
      } else {
        const data = await login(username, password);
        if (data?.mfa_required) {
          showLoginMfaPanel(data);
          return;
        }
      }
      resetLoginMfaPanel();
      hideLoginOverlay();
      renderUserInfo();
      const enrollmentOnly = localStorage.getItem('nia-mfa-enrollment-required') === '1';
      if (!enrollmentOnly) {
        if (!getAppInitialized()) await initApp();
        await refreshFromServer();
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
    if (loginFormBound) return;
    const form = document.getElementById('login-form');
    if (!form) return;
    loginFormBound = true;
    form.addEventListener('submit', handleLogin);
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
    showLoginOverlay,
    hideLoginOverlay,
    handleLogin,
    bindLoginForm,
  };
}
