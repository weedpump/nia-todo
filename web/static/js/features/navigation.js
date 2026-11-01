import { bindEntitySidebarNavigation } from './entity-sidebar.js';
import { acquireSyncCommitLock, projectPendingSectionsSnapshot } from './todo-pending.js';
import { runAccessFencedCommit } from './entity-access-privacy.js';

export function createNavigationFeature({
  sectionsApi,
  getProjects = () => [],
  getCurrentProjectId,
  getCurrentFilter,
  setCurrentProjectId,
  setCurrentFilter,
  clearDashboardDrilldown = () => {},
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
  editProject = null,
  syncInProgressRef = {},
}) {
  const baseFilters = ['all','focus','calendar','pending','in_progress','done'];
  let applyingHistory = false;

  function cleanRoute() {
    return `${location.pathname}${location.search || ''}`;
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
    const state = { ...(history.state || {}), niaTodoView: true, filter: String(filter || 'all') };
    if (replace || !history.state?.niaTodoView) history.replaceState(state, '', cleanRoute());
    else history.pushState(state, '', cleanRoute());
  }

  function setFilter(filter, options = {}) {
    if (!options.preserveDashboardDrilldown) clearDashboardDrilldown();
    setCurrentFilter(filter);
    const nextProjectId = baseFilters.includes(filter) ? null : parseInt(filter, 10);
    setCurrentProjectId(nextProjectId);

    localStorage.setItem('nia-last-filter', filter);
    const sidebarClosed = options.skipSidebarClose ? false : closeSidebar({ preserveHistory: true });
    updateHistory(filter, Boolean(options.replaceHistory || sidebarClosed));

    document.querySelectorAll('.nav-btn').forEach((button) => {
      const buttonFilter = String(button.dataset.filter || '');
      const isActive = nextProjectId
        ? buttonFilter === String(nextProjectId)
        : buttonFilter === String(filter);
      button.classList.toggle('active', isActive);
    });

    return loadSectionsForCurrentProject().then(() => {
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
        const privacyGeneration = Number(syncInProgressRef?.privacyGeneration || 0);
        const data = await sectionsApi.listByProject(currentProjectId);
        const serverSections = data.sections || [];
        let applied = false;
        const committed = await runAccessFencedCommit({
          syncInProgressRef,
          acquireCommitLock: acquireSyncCommitLock,
          privacyGeneration,
          commit: async () => {
            if (String(getCurrentProjectId()) !== String(currentProjectId)) return;
            if (!getProjects().some(project => String(project.id) === String(currentProjectId))) return;
            const allLocal = await dbGetAll('sections');
            const localProjectSections = allLocal.filter(s => String(s.project_id) === String(currentProjectId));
            const queue = await dbGetAll('syncQueue');
            const projectedSections = projectPendingSectionsSnapshot(serverSections, localProjectSections, queue, currentProjectId);
            if (projectedSections.some(section => String(section.project_id) !== String(currentProjectId))) return;
            for (const section of projectedSections) await dbPut('sections', section);

            const projectedIds = new Set(projectedSections.map(section => String(section.id)));
            for (const local of localProjectSections) {
              if (!projectedIds.has(String(local.id))) await deleteFromDB('sections', local.id);
            }

            setSections(projectedSections);
            applied = true;
          },
        });
        if (committed && applied) return;
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
    bindEntitySidebarNavigation({
      root: document,
      entityType: 'project',
      onSelect: (id, { sidebarClosed } = {}) => setFilter(id, { skipSidebarClose: true, replaceHistory: sidebarClosed }),
      onDetail: id => editProject?.(id),
      onAdd: () => showProjectModal?.(),
      closeSidebar,
    });
    document.addEventListener('click', (event) => {
      const navButton = event.target?.closest?.('.nav-btn[data-filter]:not([data-entity-sidebar-action]), [data-nav-filter]');
      if (navButton) {
        event.preventDefault();
        setFilter(navButton.dataset.filter || navButton.dataset.navFilter);
      }
    });
  }

  function bindNavigationHistory() {
    if (document.documentElement.dataset.navigationHistoryBound === '1') return;
    document.documentElement.dataset.navigationHistoryBound = '1';
    const initialFilter = location.search ? filterFromLocation() : (localStorage.getItem('nia-last-filter') || 'all');
    updateHistory(initialFilter, true);
    window.addEventListener('popstate', (event) => {
      const nextFilter = filterFromHistoryState(event);
      if (String(nextFilter) === String(getCurrentFilter?.() || 'all')) return;
      applyingHistory = true;
      setFilter(nextFilter);
      applyingHistory = false;
    });
  }

  return { setFilter, loadSectionsForCurrentProject, bindNavigationActions, bindNavigationHistory };
}
