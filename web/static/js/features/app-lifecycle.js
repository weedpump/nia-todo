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
    document.addEventListener('DOMContentLoaded', () => {
      console.log('[boot] app starting', Math.round(performance.now()) + 'ms');
      initTheme();
      showLoginOverlay();

      Promise.resolve().then(async () => {
        try {
          const t0 = performance.now();
          console.log('[boot] setup check start', Math.round(t0 - window.__niaBootT0) + 'ms');
          const setupData = await Promise.race([
            authApi.setupStatus(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('setup timeout')), 4000)),
          ]);
          console.log('[boot] setup check done', Math.round(performance.now() - window.__niaBootT0) + 'ms');
          if (!setupData.setup_complete) {
            window.location.href = '/setup';
            return;
          }
        } catch (e) {
          console.log('[boot] setup check failed or timed out', Math.round(performance.now() - window.__niaBootT0) + 'ms');
        }

        let authed = false;
        try {
          console.log('[boot] auth check start', Math.round(performance.now() - window.__niaBootT0) + 'ms');
          authed = await Promise.race([
            checkAuth(),
            new Promise(resolve => setTimeout(() => resolve(false), 4000)),
          ]);
          console.log('[boot] auth check done', Math.round(performance.now() - window.__niaBootT0) + 'ms', 'authed=', authed);
        } catch (e) {
          console.log('[boot] auth check failed or timed out', Math.round(performance.now() - window.__niaBootT0) + 'ms');
        }

        if (authed) {
          console.log('[boot] init authenticated app', Math.round(performance.now() - window.__niaBootT0) + 'ms');
          hideLoginOverlay();
          renderUserInfo();
          await initApp();
          console.log('[boot] init authenticated app done', Math.round(performance.now() - window.__niaBootT0) + 'ms');
        } else {
          console.log('[boot] stay on login overlay', Math.round(performance.now() - window.__niaBootT0) + 'ms');
          showLoginOverlay();
        }
      });
    });
  }

  return { initApp, loadFromLocalDB, loadAll, bindNetworkEvents, bindDomReady };
}
