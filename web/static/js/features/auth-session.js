import { getAuthToken, getCsrfToken, getAuthHeaders } from '../api/http.js';

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

  function storeUserSession(data) {
    const user = { ...data.user, token: data.access_token };
    setCurrentUser(user);
    localStorage.setItem('jwt_token', data.access_token);
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

  async function login(username, password) {
    const data = await authApi.login(username, password);
    storeUserSession(data);

    const newUserId = String(data.user.id);
    await clearCacheIfUserChanged(newUserId);
    localStorage.setItem('last_user_id', newUserId);

    return data;
  }

  async function checkAuth() {
    const token = getAuthToken();
    if (!token) return false;

    try {
      const user = await authApi.me();
      setCurrentUser({ ...user, token });

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
      localStorage.removeItem('jwt_token');
      localStorage.removeItem('auth_token');
      localStorage.removeItem('csrf_token');
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

    await clearBrowserAuthCaches();
    await clearCache();
    location.reload();
  }

  function showLoginOverlay() {
    document.getElementById('login-overlay').classList.remove('hidden');
  }

  function hideLoginOverlay() {
    document.getElementById('login-overlay').classList.add('hidden');
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
      await login(username, password);
      hideLoginOverlay();
      renderUserInfo();
      if (!getAppInitialized()) await initApp();
      await refreshFromServer();
      window.dispatchEvent(new CustomEvent('nia-logged-in'));
    } catch (err) {
      console.error('Login failed:', err);
      errorEl.textContent = err.message || 'Login fehlgeschlagen';
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
