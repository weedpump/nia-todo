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
    document.addEventListener('DOMContentLoaded', async () => {
      console.log('App starting...');
      initTheme();

      try {
        const setupData = await authApi.setupStatus();
        if (!setupData.setup_complete) {
          window.location.href = '/setup';
          return;
        }
      } catch (e) {
        console.log('Setup check failed, continuing');
      }

      const authed = await checkAuth();
      if (authed) {
        hideLoginOverlay();
        renderUserInfo();
        await initApp();
      } else {
        showLoginOverlay();
      }
    });
  }

  return { initApp, loadFromLocalDB, loadAll, bindNetworkEvents, bindDomReady };
}
