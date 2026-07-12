export function createNavigationFeature({
  sectionsApi,
  getCurrentProjectId,
  setCurrentProjectId,
  setCurrentFilter,
  setSections,
  isOnlineForSync,
  dbGetAll,
  dbPut,
  deleteFromDB,
  closeSidebar,
  renderProjects,
  renderStats,
  renderTodos,
  showProjectModal = null,
}) {
  const baseFilters = ['all','focus','calendar','pending','in_progress','done'];
  let applyingHistory = false;

  function cleanRoute() {
    return `${location.pathname}${location.hash || ''}`;
  }

  function filterFromLocation() {
    const params = new URLSearchParams(location.search);
    const project = params.get('project');
    if (project) return project;
    const view = params.get('view');
    return baseFilters.includes(view) ? view : 'all';
  }

  function filterFromHistoryState(event = null) {
    const stateFilter = event?.state?.niaTodoView ? event.state.filter : history.state?.filter;
    return stateFilter || filterFromLocation();
  }

  function updateHistory(filter, replace = false) {
    if (applyingHistory || typeof history === 'undefined') return;
    const state = { niaTodoView: true, filter: String(filter || 'all') };
    if (replace || !history.state?.niaTodoView) history.replaceState(state, '', cleanRoute());
    else history.pushState(state, '', cleanRoute());
  }

  function setFilter(filter, options = {}) {
    setCurrentFilter(filter);
    const nextProjectId = baseFilters.includes(filter) ? null : parseInt(filter, 10);
    setCurrentProjectId(nextProjectId);

    localStorage.setItem('nia-last-filter', filter);
    updateHistory(filter, Boolean(options.replaceHistory));

    document.querySelectorAll('.nav-btn').forEach((button) => {
      const buttonFilter = String(button.dataset.filter || '');
      const isActive = nextProjectId
        ? buttonFilter === String(nextProjectId)
        : buttonFilter === String(filter);
      button.classList.toggle('active', isActive);
    });
    closeSidebar();

    loadSectionsForCurrentProject().then(() => {
      renderProjects();
      renderStats();
      renderTodos();
    });
  }

  async function loadSectionsForCurrentProject() {
    setSections([]);
    const currentProjectId = getCurrentProjectId();
    if (!currentProjectId) return;

    if (isOnlineForSync()) {
      try {
        const data = await sectionsApi.listByProject(currentProjectId);
        const serverSections = data.sections || [];

        for (const section of serverSections) await dbPut('sections', section);

        const serverIds = new Set(serverSections.map(s => s.id));
        const allLocal = await dbGetAll('sections');
        const localProjectSections = allLocal.filter(s => s.project_id === currentProjectId);
        for (const local of localProjectSections) {
          if (!serverIds.has(local.id)) await deleteFromDB('sections', local.id);
        }

        setSections(serverSections);
        return;
      } catch (e) {
        console.error('Failed to load sections from server', e);
      }
    }

    try {
      const allSections = await dbGetAll('sections');
      setSections(allSections.filter(s => s.project_id === currentProjectId));
    } catch (e) {
      console.error('Failed to load sections from local DB', e);
    }
  }

  function bindNavigationActions() {
    if (document.documentElement.dataset.navigationActionsBound === '1') return;
    document.documentElement.dataset.navigationActionsBound = '1';
    document.addEventListener('click', (event) => {
      const navButton = event.target?.closest?.('.nav-btn[data-filter], [data-nav-filter]');
      if (navButton) {
        event.preventDefault();
        setFilter(navButton.dataset.filter || navButton.dataset.navFilter);
        return;
      }
      const action = event.target?.closest?.('[data-nav-action]')?.dataset.navAction;
      if (action === 'new-project') {
        event.preventDefault();
        showProjectModal?.();
      }
    });
  }

  function bindNavigationHistory() {
    if (document.documentElement.dataset.navigationHistoryBound === '1') return;
    document.documentElement.dataset.navigationHistoryBound = '1';
    const initialFilter = location.search ? filterFromLocation() : (localStorage.getItem('nia-last-filter') || 'all');
    updateHistory(initialFilter, true);
    window.addEventListener('popstate', (event) => {
      applyingHistory = true;
      setFilter(filterFromHistoryState(event));
      applyingHistory = false;
    });
  }

  return { setFilter, loadSectionsForCurrentProject, bindNavigationActions, bindNavigationHistory };
}
