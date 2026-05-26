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
}) {
  function setFilter(filter) {
    setCurrentFilter(filter);
    const nextProjectId = (!['all','pending','in_progress','done'].includes(filter)) ? parseInt(filter) : null;
    setCurrentProjectId(nextProjectId);

    localStorage.setItem('nia-last-filter', filter);

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

  return { setFilter, loadSectionsForCurrentProject };
}
