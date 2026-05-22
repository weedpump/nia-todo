export function createWorkspacesFeature({
  workspacesApi,
  getWorkspaces,
  setWorkspaces,
  getCurrentWorkspaceId,
  setCurrentWorkspaceId,
  dbPut,
  dbClear,
  isOnlineForSync,
  refreshFromServer,
  renderProjects,
  renderStats,
  renderTodos,
  closeSidebar,
  showToast,
}) {
  function normalizeWorkspaceId(id) {
    if (id === null || id === undefined || id === '') return null;
    const n = Number(id);
    return Number.isFinite(n) ? n : id;
  }

  function getDefaultWorkspaceId() {
    const workspaces = getWorkspaces();
    const saved = normalizeWorkspaceId(localStorage.getItem('nia-current-workspace'));
    if (saved && workspaces.some(w => String(w.id) === String(saved))) return saved;
    const fallback = workspaces.find(w => w.is_default) || workspaces[0] || null;
    return fallback ? fallback.id : null;
  }

  function ensureCurrentWorkspace() {
    const current = getCurrentWorkspaceId();
    const workspaces = getWorkspaces();
    if (current && workspaces.some(w => String(w.id) === String(current))) return current;
    const next = getDefaultWorkspaceId();
    setCurrentWorkspaceId(next);
    if (next) localStorage.setItem('nia-current-workspace', String(next));
    return next;
  }

  function renderWorkspaces() {
    const select = document.getElementById('workspace-select');
    if (!select) return;
    const workspaces = getWorkspaces();
    const current = ensureCurrentWorkspace();
    select.innerHTML = workspaces.map(w => `<option value="${String(w.id).replace(/"/g, '&quot;')}">${w.name}</option>`).join('');
    if (current) select.value = String(current);
  }

  async function switchWorkspace(workspaceId) {
    const next = normalizeWorkspaceId(workspaceId);
    setCurrentWorkspaceId(next);
    if (next) localStorage.setItem('nia-current-workspace', String(next));
    localStorage.setItem('nia-last-filter', 'all');
    window.setFilter?.('all');
    renderWorkspaces();
    renderProjects();
    renderStats();
    renderTodos();
    closeSidebar?.();
  }

  async function createWorkspace() {
    const name = prompt('Name des neuen Workspaces?');
    if (!name || !name.trim()) return;
    const payload = { name: name.trim(), color: '#6366f1', sort_order: getWorkspaces().length };
    if (!isOnlineForSync()) {
      showToast?.('Workspace anlegen geht aktuell nur online.');
      return;
    }
    const workspace = await workspacesApi.create(payload);
    await dbPut('workspaces', workspace);
    setWorkspaces([...getWorkspaces(), workspace]);
    await switchWorkspace(workspace.id);
    await refreshFromServer();
  }

  async function loadWorkspacesFromServer() {
    if (!isOnlineForSync()) return;
    const data = await workspacesApi.list();
    const next = data.workspaces || [];
    if (dbClear) await dbClear('workspaces');
    await Promise.all(next.map(workspace => dbPut('workspaces', workspace)));
    setWorkspaces(next);
    ensureCurrentWorkspace();
    renderWorkspaces();
  }

  return { renderWorkspaces, switchWorkspace, createWorkspace, loadWorkspacesFromServer, ensureCurrentWorkspace };
}
