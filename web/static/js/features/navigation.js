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
  const projectReceipts = new Map();
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
    const seen = new Set();
    let identity = String(filter);
    while (!baseFilters.includes(identity) && projectReceipts.has(identity) && !seen.has(identity)) {
      seen.add(identity);
      identity = String(projectReceipts.get(identity));
    }
    if (seen.size) {
      // A click may still carry the temporary ID from a sidebar node that was
      // rendered before its create receipt committed. Never revive lost access.
      const confirmed = !seen.has(identity) && getProjects().find(project => String(project.id) === identity);
      filter = confirmed ? String(confirmed.id) : 'all';
    }
    if (!options.preserveDashboardDrilldown) clearDashboardDrilldown();
    setCurrentFilter(filter);
    const project = getProjects().find(candidate => String(candidate.id) === String(filter));
    const nextProjectId = baseFilters.includes(filter) ? null
      : project?.id ?? (/^\d+$/.test(String(filter)) ? Number(filter) : null);
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

    const privacyGeneration = Number(syncInProgressRef?.privacyGeneration || 0);
    if (isOnlineForSync() && !String(currentProjectId).startsWith('temp-')) {
      try {
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
      if (String(getCurrentProjectId()) !== String(currentProjectId)
        || Number(syncInProgressRef?.privacyGeneration || 0) !== privacyGeneration
        || !getProjects().some(project => String(project.id) === String(currentProjectId))) return;
      setSections(allSections.filter(s => String(s.project_id) === String(currentProjectId)));
    } catch (e) {
      console.error('Failed to load sections from local DB', e);
    }
  }

  function remapProjectId(from, to) {
    if (from == null || to == null || String(from) === String(to)) return false;
    projectReceipts.set(String(from), to);
    if (String(getCurrentProjectId()) !== String(from) && String(getCurrentFilter()) !== String(from)) return false;
    const confirmed = getProjects().find(project => String(project.id) === String(to));
    if (!confirmed) return false;
    setCurrentProjectId(confirmed.id);
    if (String(getCurrentFilter()) === String(from)) {
      setCurrentFilter(String(to));
      localStorage.setItem('nia-last-filter', String(to));
      updateHistory(String(to), true);
    }
    renderProjects();
    renderStats();
    renderTodos();
    return true;
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

  return { setFilter, remapProjectId, loadSectionsForCurrentProject, bindNavigationActions, bindNavigationHistory };
}
