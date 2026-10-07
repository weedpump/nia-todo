import { t } from '../i18n/index.js';

export function createAppLifecycle({
  authApi,
  initTheme,
  checkAuth,
  hideLoginOverlay,
  showLoginOverlay,
  renderUserInfo,
  openSettingsModal,
  isMfaEnrollmentRequired = () => false,
  initServiceWorker,
  openDB,
  dbGetAll,
  setTodos,
  setProjects,
  setSections,
  setWorkspaces,
  setCurrentFilter,
  setCurrentProjectId,
  setCurrentWorkspaceId,
  ensureCurrentWorkspace,
  setAppInitialized,
  connectWebSocket,
  getWsState,
  isAuthenticated = () => false,
  isOnlineForSync,
  syncWithServer,
  refreshFromServer,
  updateConnectionStatus,
  renderVersionInfo,
  renderProjects,
  renderStats,
  renderTodos,
  renderWorkspaces,
  updateToggleDoneButton,
  updateSortButton,
  updateProjectWidgetButton,
  updateTodayFocusButton,
  updateMinimalTodosButton,
  refreshInvites = null,
  onAppReady = null,
}) {
  let lifecycleInitialized = false;

  function hideBootOverlay() {
    const overlay = document.getElementById('boot-overlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.inert = true;
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.display = 'none';
    overlay.style.pointerEvents = 'none';
  }

  function showBootOverlay() {
    const overlay = document.getElementById('boot-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    overlay.inert = false;
    overlay.removeAttribute('aria-hidden');
    overlay.style.display = '';
    overlay.style.pointerEvents = '';
  }

  function showBootError(error) {
    const subtitle = document.getElementById('boot-subtitle');
    const spinner = document.getElementById('boot-spinner');
    const retry = document.getElementById('boot-retry');
    if (subtitle) {
      subtitle.textContent = t('boot.startTimeout');
      subtitle.title = error?.message || String(error || 'Boot timeout');
    }
    if (spinner) spinner.style.display = 'none';
    if (retry) retry.style.display = '';
  }

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
    ]);
  }

  function restoreSavedNavigation() {
    const baseFilters = ['all','focus','calendar','pending','in_progress','done'];
    const params = new URLSearchParams(window.location.search || '');
    const urlProject = params.get('project');
    const urlView = params.get('view');
    const historyFilter = window.history?.state?.niaTodoView ? window.history.state.filter : null;
    const savedFilter = urlProject || (baseFilters.includes(urlView) ? urlView : historyFilter || localStorage.getItem('nia-last-filter'));
    if (!savedFilter) return;
    setCurrentFilter(savedFilter);
    setCurrentProjectId(baseFilters.includes(savedFilter) ? null : parseInt(savedFilter, 10));
  }

  async function loadFromLocalDB() {
    restoreSavedNavigation();
    setTodos(await dbGetAll('todos'));
    setProjects(await dbGetAll('projects'));
    setSections(await dbGetAll('sections'));
    setWorkspaces(await dbGetAll('workspaces'));
    ensureCurrentWorkspace?.();
    renderWorkspaces?.();
    renderProjects();
    renderStats();
    renderTodos();
  }

  async function loadAll() {
    await loadFromLocalDB();
    if (isOnlineForSync()) await refreshFromServer();
  }

  async function initApp() {
    await initServiceWorker();

    try {
      await withTimeout(openDB(), 5000, 'IndexedDB open');
      console.log('DB ready');
    } catch (err) {
      console.error('DB init failed:', err);
    }

    try {
      await withTimeout(loadFromLocalDB(), 5000, 'Local DB load');
      console.log('Local data loaded');
    } catch (err) {
      console.error('Local load failed:', err);
    }

    if (!isAuthenticated()) return;
    restoreSavedNavigation();
    ensureCurrentWorkspace?.();
    renderWorkspaces?.();

    setAppInitialized(true);
    lifecycleInitialized = true;
    connectWebSocket();

    if (isOnlineForSync()) {
      console.log('Online at startup - syncing...');
      refreshFromServer().catch(err => {
        // A cached/offline cold start can race with browser network state: the
        // page may still report online while fetches already fail. Keep the
        // cached session usable and avoid surfacing this as a frontend error.
        console.warn('Server refresh failed:', err);
      });
      refreshInvites?.();
    }

    updateConnectionStatus();
    renderVersionInfo();
    updateToggleDoneButton();
    updateSortButton();
    updateProjectWidgetButton?.();
    updateTodayFocusButton?.();
    updateMinimalTodosButton?.();
    initTheme();
    onAppReady?.();

    console.log('App initialized');
  }

  function bindNetworkEvents() {
    let recoveryActive = false;
    const recoveryDelays = [1000, 3000, 8000];

    const scheduleSyncAttempts = (reason) => {
      if (recoveryActive || !isAuthenticated()) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      if (getWsState() === 'disconnected') connectWebSocket();

      recoveryActive = true;
      const runAttempt = (index) => {
        setTimeout(async () => {
          if (!isAuthenticated() || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
            recoveryActive = false;
            return;
          }
          try {
            const syncResult = await syncWithServer();
            if (syncResult?.skipped) {
              throw new Error('Sync recovery deferred while another sync is active');
            }
            if (Number(syncResult?.failCount || 0) > 0) {
              throw new Error(`Sync completed with ${syncResult.failCount} failed operation(s)`);
            }
            if (!isAuthenticated()) {
              recoveryActive = false;
              return;
            }
            const inviteResult = await refreshInvites?.();
            if (inviteResult?.ok === false) {
              throw inviteResult.error || new Error('Invite refresh failed');
            }
            recoveryActive = false;
          } catch (err) {
            if (index + 1 < recoveryDelays.length && isAuthenticated()) {
              runAttempt(index + 1);
              return;
            }
            recoveryActive = false;
            console.warn(`Sync attempt failed after ${reason}:`, err);
          }
        }, recoveryDelays[index]);
      };

      runAttempt(0);
    };

    window.addEventListener('online', () => {
      console.log('Browser reports online');
      updateConnectionStatus();
      scheduleSyncAttempts('online');
    });

    window.addEventListener('offline', () => {
      console.log('Browser reports offline');
      updateConnectionStatus();
    });

    window.addEventListener('pageshow', (event) => {
      if (event?.persisted) scheduleSyncAttempts('pageshow');
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleSyncAttempts('visibilitychange');
    });

    setInterval(() => {
      if (!isAuthenticated()) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      if (getWsState() === 'connected') {
        if (recoveryActive) return;
        syncWithServer().then((result) => {
          if (Number(result?.failCount || 0) > 0) {
            console.warn(`Periodic sync completed with ${result.failCount} failed operation(s)`);
          }
        }).catch(err => console.warn('Periodic sync failed:', err));
        return;
      }
      scheduleSyncAttempts('periodic');
    }, 60000);
  }

  function bindDomReady() {
    const hideStaleBootOverlay = () => {
      if (lifecycleInitialized && document.visibilityState !== 'hidden') {
        hideBootOverlay();
      }
    };
    window.addEventListener('pageshow', hideStaleBootOverlay);
    document.addEventListener('visibilitychange', hideStaleBootOverlay);

    const start = () => {
      initTheme();
      showBootOverlay();

      const bootWatchdog = setTimeout(() => showBootError(new Error('Boot watchdog timeout')), 18000);
      Promise.resolve().then(async () => {
        try {
          const setupData = await Promise.race([
            authApi.setupStatus(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('setup timeout')), 4000)),
          ]);
          if (!setupData.setup_complete) {
            window.location.href = '/setup';
            return;
          }
        } catch (e) {
          // Continue with login overlay when setup check fails or times out.
        }

        try {
          await initServiceWorker();
        } catch (e) {
          console.warn('Service worker init failed before auth:', e);
        }

        let authed = false;
        try {
          authed = await checkAuth();
        } catch (e) {
          // Keep login overlay on non-recoverable auth-check errors.
        }

        if (authed) {
          hideLoginOverlay();
          renderUserInfo();
          if (isMfaEnrollmentRequired()) {
            hideBootOverlay();
            await openSettingsModal?.();
          } else {
            await withTimeout(initApp(), 12000, 'App init');
            hideBootOverlay();
          }
        } else {
          hideBootOverlay();
          showLoginOverlay();
        }
        clearTimeout(bootWatchdog);
      }).catch((error) => {
        console.error('Boot failed:', error);
        showBootError(error);
        clearTimeout(bootWatchdog);
      });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }

  return { initApp, loadFromLocalDB, loadAll, bindNetworkEvents, bindDomReady };
}
