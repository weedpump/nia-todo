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
}) {
  function hideBootOverlay() {
    document.getElementById('boot-overlay')?.classList.add('hidden');
  }

  function showBootOverlay() {
    document.getElementById('boot-overlay')?.classList.remove('hidden');
  }

  async function loadFromLocalDB() {
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
      await openDB();
      console.log('DB ready');
    } catch (err) {
      console.error('DB init failed:', err);
    }

    try {
      await loadFromLocalDB();
      console.log('Local data loaded');
    } catch (err) {
      console.error('Local load failed:', err);
    }

    const savedFilter = localStorage.getItem('nia-last-filter');
    if (savedFilter) {
      setCurrentFilter(savedFilter);
      if (!['all','pending','in_progress','done'].includes(savedFilter)) {
        setCurrentProjectId(parseInt(savedFilter));
      }
    }

    setAppInitialized(true);
    connectWebSocket();

    if (isOnlineForSync()) {
      console.log('Online at startup - syncing...');
      refreshFromServer().catch(err => console.error('Server refresh failed:', err));
    }

    updateConnectionStatus();
    renderVersionInfo();
    updateToggleDoneButton();
    updateSortButton();
    initTheme();

    console.log('App initialized');
  }

  function bindNetworkEvents() {
    window.addEventListener('online', async () => {
      console.log('Browser reports online');
      if (getWsState() === 'disconnected') connectWebSocket();
      await syncWithServer();
    });

    window.addEventListener('offline', () => {
      console.log('Browser reports offline');
    });
  }

  function bindDomReady() {
    const start = () => {
      initTheme();
      showBootOverlay();

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
          authed = await Promise.race([
            checkAuth(),
            new Promise(resolve => setTimeout(() => resolve(false), 4000)),
          ]);
        } catch (e) {
          // Keep login overlay on auth-check errors/timeouts.
        }

        if (authed) {
          hideLoginOverlay();
          renderUserInfo();
          await initApp();
          hideBootOverlay();
        } else {
          hideBootOverlay();
          showLoginOverlay();
        }
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
