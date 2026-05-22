export function createAppLifecycle({
  authApi,
  initTheme,
  checkAuth,
  hideLoginOverlay,
  showLoginOverlay,
  renderUserInfo,
  initServiceWorker,
  openDB,
  dbGetAll,
  setTodos,
  setProjects,
  setSections,
  setCurrentFilter,
  setCurrentProjectId,
  setAppInitialized,
  connectWebSocket,
  getWsState,
  isOnlineForSync,
  syncWithServer,
  refreshFromServer,
  updateConnectionStatus,
  renderVersionInfo,
  renderProjects,
  renderStats,
  renderTodos,
  updateToggleDoneButton,
  updateSortButton,
  updateProjectWidgetButton,
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
      subtitle.textContent = 'App-Start hängt. Bitte neu laden.';
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
    const savedFilter = localStorage.getItem('nia-last-filter');
    if (!savedFilter) return;
    setCurrentFilter(savedFilter);
    if (!['all','pending','in_progress','done'].includes(savedFilter)) {
      setCurrentProjectId(parseInt(savedFilter, 10));
    } else {
      setCurrentProjectId(null);
    }
  }

  async function loadFromLocalDB() {
    restoreSavedNavigation();
    setTodos(await dbGetAll('todos'));
    setProjects(await dbGetAll('projects'));
    setSections(await dbGetAll('sections'));
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

    restoreSavedNavigation();

    setAppInitialized(true);
    lifecycleInitialized = true;
    connectWebSocket();

    if (isOnlineForSync()) {
      console.log('Online at startup - syncing...');
      refreshFromServer().catch(err => console.error('Server refresh failed:', err));
    }

    updateConnectionStatus();
    renderVersionInfo();
    updateToggleDoneButton();
    updateSortButton();
    updateProjectWidgetButton?.();
    initTheme();

    console.log('App initialized');
  }

  function bindNetworkEvents() {
    const scheduleSyncAttempts = (reason) => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      if (getWsState() === 'disconnected') connectWebSocket();

      // Native/WebView can fire `online` before DNS/fetch is usable. Try a
      // short burst and also rely on WebSocket onopen/periodic retries.
      for (const delay of [1000, 3000, 8000]) {
        setTimeout(() => {
          if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
          syncWithServer().catch(err => console.warn(`Sync attempt failed after ${reason}:`, err));
        }, delay);
      }
    };

    window.addEventListener('online', () => {
      console.log('Browser reports online');
      scheduleSyncAttempts('online');
    });

    window.addEventListener('offline', () => {
      console.log('Browser reports offline');
    });

    window.addEventListener('pageshow', () => scheduleSyncAttempts('pageshow'));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleSyncAttempts('visibilitychange');
    });

    setInterval(() => scheduleSyncAttempts('periodic'), 15000);
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

        let authed = false;
        try {
          authed = await checkAuth();
        } catch (e) {
          // Keep login overlay on non-recoverable auth-check errors.
        }

        if (authed) {
          hideLoginOverlay();
          renderUserInfo();
          await withTimeout(initApp(), 12000, 'App init');
          hideBootOverlay();
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
