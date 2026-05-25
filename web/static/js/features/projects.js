import { t } from '../i18n/index.js';
import { renderIconPicker } from '../icons/lucide-icons.js';

export function createProjectsFeature({
  getProjects,
  getTodos,
  setTodos,
  getCurrentProjectId,
  getCurrentWorkspaceId,
  getWorkspaces,
  setProjects,
  dbPut,
  addToSyncQueue,
  deleteFromDB,
  isOnlineForSync,
  syncWithServer,
  renderProjects,
  renderStats,
  renderTodos,
  closeModal,
  confirmDanger,
  showToast,
  showBatchToast,
  projectsApi,
  sharingFeature,
  getCurrentUser,
}) {
  let projectFormBound = false;

  function bindProjectForm() {
    if (projectFormBound) return;
    const form = document.getElementById('project-form');
    if (!form) return;
    projectFormBound = true;
    form.addEventListener('submit', saveProject);
  }

  function isOwner(project) {
    if (!project) return false;
    if (project.is_owner === true || project.is_owner === 1 || project.is_owner === '1') return true;
    const user = getCurrentUser?.();
    return !!(user && project.user_id === user.id);
  }

  function isProjectDescendant(candidate, ancestorId) {
    if (!candidate || ancestorId == null) return false;
    let parentId = candidate.parent_id;
    const seen = new Set();
    while (parentId != null && !seen.has(String(parentId))) {
      if (String(parentId) === String(ancestorId)) return true;
      seen.add(String(parentId));
      const parent = getProjects().find(p => String(p.id) === String(parentId));
      parentId = parent?.parent_id;
    }
    return false;
  }

  function renderParentProjectSelect(project = null, selectedParentId = null, workspaceId = null) {
    const parentSelect = document.getElementById('project-parent-id');
    if (!parentSelect) return;
    parentSelect.innerHTML = `<option value="" data-i18n-key="project.noParent">${t('project.noParent')}</option>`;
    const targetWorkspaceId = workspaceId || getCurrentWorkspaceId?.();
    const projects = getProjects().filter(p => {
      if (p.is_shared) return false;
      if (targetWorkspaceId && String(p.workspace_id || '') !== String(targetWorkspaceId)) return false;
      if (project && (String(p.id) === String(project.id) || isProjectDescendant(p, project.id))) return false;
      return true;
    });
    const projectMap = new Map();
    projects.forEach(p => projectMap.set(p.id, { id: p.id, name: p.name, parent_id: p.parent_id, sort_order: p.sort_order, color: p.color, is_inbox: p.is_inbox }));
    projectMap.forEach(p => { p.children = []; });
    const rootProjects = [];
    projectMap.forEach(p => {
      if (p.parent_id === null || p.parent_id === undefined) rootProjects.push(p);
      else {
        const parent = projectMap.get(p.parent_id);
        if (parent) parent.children.push(p);
        else rootProjects.push(p);
      }
    });
    rootProjects.sort((a, b) => (!!a.is_inbox !== !!b.is_inbox ? (a.is_inbox ? -1 : 1) : a.name.localeCompare(b.name)));
    function addProjectOptions(projectNode, depth = 0) {
      if (projectNode.is_inbox) return;
      const indent = '\u00A0'.repeat(depth * 2) + (depth > 0 ? '└─ ' : '');
      const option = document.createElement('option');
      option.value = projectNode.id;
      option.textContent = indent + projectNode.name;
      parentSelect.appendChild(option);
      if (projectNode.children && projectNode.children.length > 0) {
        projectNode.children.sort((a, b) => a.name.localeCompare(b.name));
        projectNode.children.forEach(child => addProjectOptions(child, depth + 1));
      }
    }
    rootProjects.forEach(p => addProjectOptions(p));
    const selected = selectedParentId || '';
    parentSelect.value = [...parentSelect.options].some(option => String(option.value) === String(selected)) ? String(selected) : '';
  }

  function renderProjectWorkspaceSelect(project = null) {
    const group = document.getElementById('project-display-workspace-group');
    const select = document.getElementById('project-display-workspace-id');
    if (!group || !select) return;
    const sharedMemberProject = !!project?.is_shared && !isOwner(project);
    const ownMovableProject = !!project && isOwner(project) && !project.is_inbox;
    group.style.display = (sharedMemberProject || ownMovableProject) ? '' : 'none';
    select.disabled = !(sharedMemberProject || ownMovableProject);
    select.innerHTML = '';
    const workspaces = getWorkspaces?.() || [];
    for (const workspace of workspaces) {
      const option = document.createElement('option');
      option.value = workspace.id;
      option.textContent = workspace.name || 'Workspace';
      select.appendChild(option);
    }
    if (sharedMemberProject || ownMovableProject) {
      select.value = String(project.workspace_id || getCurrentWorkspaceId?.() || workspaces[0]?.id || '');
    }
    select.onchange = () => {
      if (ownMovableProject) renderParentProjectSelect(project, null, select.value);
    };
  }

  function showProjectModal(project = null, parentId = null) {
    bindProjectForm();
    document.getElementById('project-form')?.reset();
    document.getElementById('project-id').value = '';
    const saveBtn = document.getElementById('project-save-btn');
    if (saveBtn) saveBtn.style.display = '';
    const iconPicker = document.getElementById('project-icon-picker');
    if (iconPicker) {
      iconPicker.style.pointerEvents = '';
      iconPicker.style.opacity = '';
      iconPicker.setAttribute('aria-disabled', 'false');
    }
    const modalTitle = document.getElementById('project-modal-title');
    if (modalTitle) {
      modalTitle.dataset.i18nKey = project ? 'project.edit' : (parentId ? 'project.newSubproject' : 'project.new');
      modalTitle.textContent = t(modalTitle.dataset.i18nKey);
    }

    renderParentProjectSelect(project, parentId || (project ? project.parent_id : '') || '', project?.workspace_id || getCurrentWorkspaceId?.());

    const parentFormGroup = document.getElementById('project-parent-id')?.closest('.form-group');
    if (parentFormGroup) parentFormGroup.style.display = (project && project.is_inbox) ? 'none' : '';
    renderProjectWorkspaceSelect(project);

    const sharingSection = document.getElementById('project-sharing-section');
    const shareRow = document.getElementById('project-share-row');
    const leaveBtn = document.getElementById('project-leave-btn');
    const deleteBtn = document.getElementById('project-delete-btn');

    if (project) {
      document.getElementById('project-id').value = project.id;
      document.getElementById('project-name').value = project.name;
      document.getElementById('project-color').value = project.color;
      document.getElementById('project-icon').value = project.icon || '';
      renderIconPicker({
        container: document.getElementById('project-icon-picker'),
        input: document.getElementById('project-icon'),
        selected: project.icon || '',
        color: project.color || '#6366f1',
      });
      const owner = isOwner(project);
      const shared = !!project.is_shared;
      if (deleteBtn) deleteBtn.style.display = (owner && !project.is_inbox) ? '' : 'none';
      if (sharingFeature?.applyProjectModalState) {
        sharingFeature.applyProjectModalState(project, owner, shared);
      }
    } else {
      if (sharingSection) sharingSection.style.display = 'none';
      if (deleteBtn) deleteBtn.style.display = 'none';
      document.getElementById('project-form')?.classList.remove('readonly-project');
      document.getElementById('project-icon').value = '';
      renderIconPicker({
        container: document.getElementById('project-icon-picker'),
        input: document.getElementById('project-icon'),
        selected: '',
        color: document.getElementById('project-color')?.value || '#6366f1',
      });
      renderProjectWorkspaceSelect(null);
      ['project-name', 'project-color', 'project-parent-id', 'project-icon'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.disabled = false;
          el.setAttribute('aria-readonly', 'false');
        }
      });
    }

    const colorInput = document.getElementById('project-color');
    if (colorInput) {
      colorInput.oninput = () => renderIconPicker({
        container: document.getElementById('project-icon-picker'),
        input: document.getElementById('project-icon'),
        selected: document.getElementById('project-icon')?.value || '',
        color: colorInput.value || '#6366f1',
      });
    }

    document.getElementById('project-modal')?.classList.add('active');
  }

  function editProject(id) {
    const project = getProjects().find(p => String(p.id) === String(id));
    if (project) showProjectModal(project);
  }

  async function saveProject(event) {
    event.preventDefault();
    const id = document.getElementById('project-id').value;
    const parentIdVal = document.getElementById('project-parent-id')?.value;
    const existing = id ? getProjects().find(p => String(p.id) === String(id)) : null;
    const sharedMemberProject = !!existing?.is_shared && !isOwner(existing);
    const displayWorkspaceId = document.getElementById('project-display-workspace-id')?.value || getCurrentWorkspaceId?.() || null;
    const ownerProject = !!existing && isOwner(existing) && !existing.is_inbox;
    const projectData = sharedMemberProject ? {
      workspace_id: displayWorkspaceId ? parseInt(displayWorkspaceId) : null,
    } : {
      name: document.getElementById('project-name').value,
      color: document.getElementById('project-color').value,
      icon: document.getElementById('project-icon')?.value || null,
      sort_order: getProjects().length,
      parent_id: parentIdVal ? parseInt(parentIdVal) : null,
      workspace_id: ownerProject && displayWorkspaceId ? parseInt(displayWorkspaceId) : (getCurrentWorkspaceId?.() || null),
    };

    if (id) {
      if (existing) {
        const updated = { ...existing, ...projectData, updated_at: new Date().toISOString() };
        await dbPut('projects', updated);
        setProjects(getProjects().map(p => String(p.id) === String(id) ? updated : p));
        if (!String(id).startsWith('temp-')) {
          await addToSyncQueue('UPDATE_PROJECT', { id: parseInt(id), changes: projectData });
          if (isOnlineForSync()) await syncWithServer();
        }
        closeModal('project-modal');
        renderProjects();
        renderStats?.();
        renderTodos?.();
      }
    } else {
      const tempId = 'temp-project-' + Date.now();
      const newProject = { id: tempId, ...projectData, created_at: new Date().toISOString(), is_owner: true, is_shared: false };
      await dbPut('projects', newProject);
      setProjects([...getProjects(), newProject]);
      await addToSyncQueue('CREATE_PROJECT', { ...projectData, _tempId: tempId });
      if (isOnlineForSync()) await syncWithServer();
      closeModal('project-modal');
      renderProjects();
    }
  }

  async function deleteProject(id) {
    const confirmed = await confirmDanger({
      title: t('project.deleteTitle'),
      message: t('project.deleteMessage'),
      confirmText: t('project.delete'),
    });
    if (!confirmed) return;
    function collectProjectTreeIds(rootId) {
      const ids = new Set([rootId]);
      let changed = true;
      while (changed) {
        changed = false;
        getProjects().forEach(project => {
          if (project.parent_id != null && ids.has(project.parent_id) && !ids.has(project.id)) {
            ids.add(project.id);
            changed = true;
          }
        });
      }
      return ids;
    }

    const rootProject = getProjects().find(project => project.id === id);
    const deletedIds = collectProjectTreeIds(id);
    const inboxProject = getProjects().find(project => project.is_inbox && String(project.workspace_id || '') === String(rootProject?.workspace_id || ''));
    await Promise.all([...deletedIds].map(projectId => deleteFromDB('projects', projectId)));
    if (inboxProject) {
      const nextTodos = getTodos().map(todo => deletedIds.has(todo.project_id)
        ? { ...todo, project_id: inboxProject.id, section_id: null, updated_at: new Date().toISOString() }
        : todo);
      await Promise.all(nextTodos
        .filter((todo, index) => todo !== getTodos()[index])
        .map(todo => dbPut('todos', todo)));
      setTodos(nextTodos);
    }
    setProjects(getProjects().filter(p => !deletedIds.has(p.id)));
    renderProjects();
    renderStats();
    renderTodos();
    closeModal('project-modal');

    await addToSyncQueue('DELETE_PROJECT', { id });
    if (isOnlineForSync()) await syncWithServer();
  }

  function deleteProjectFromModal() {
    const id = document.getElementById('project-id').value;
    if (id) deleteProject(parseInt(id));
  }

  async function clearDoneFromModal() {
    const id = document.getElementById('project-id').value;
    if (!id) return;
    const projectId = parseInt(id);
    const project = getProjects().find(p => p.id === projectId);
    if (!project) return;
    const doneCount = getTodos().filter(t => t.project_id === projectId && t.status === 'done').length;
    if (doneCount === 0) return showToast(t('project.done.empty'));
    const confirmed = await confirmDanger({
      title: t('project.done.deleteTitle'),
      message: t('project.done.deleteMessage', { count: doneCount, project: project.name }),
      confirmText: t('project.done.deleteConfirm'),
    });
    if (!confirmed) return;
    try {
      const r = await projectsApi.clearDone(projectId);
      if (r.ok) {
        const result = await r.json();
        setProjects(getProjects());
        renderStats();
        renderTodos();
        showToast(t('project.done.deleted', { count: result.deleted_count }));
      } else {
        showToast(t('project.done.deleteFailed'));
      }
    } catch (err) {
      console.error('Clear done error:', err);
      showToast(t('project.done.deleteFailed'));
    }
  }

  async function clearDoneInProject() {
    const currentProjectId = getCurrentProjectId();
    if (!currentProjectId) return;
    const project = getProjects().find(p => p.id === currentProjectId);
    if (!project) return;
    const doneTodos = getTodos().filter(t => t.project_id === currentProjectId && t.status === 'done');
    if (doneTodos.length === 0) return showToast(t('project.done.empty'));
    const confirmed = await confirmDanger({
      title: t('project.done.deleteTitle'),
      message: t('project.done.deleteMessage', { count: doneTodos.length, project: project.name }),
      confirmText: t('project.done.deleteConfirm'),
    });
    if (!confirmed) return;
    showBatchToast(t('project.done.deleted', { count: doneTodos.length }), { todos: doneTodos });
    try {
      const r = await projectsApi.clearDone(currentProjectId);
      if (!r.ok) showToast(t('project.done.deleteFailed'));
      renderStats();
      renderTodos();
    } catch (err) {
      console.error('Clear done error:', err);
      showToast(t('project.done.deleteFailed'));
    }
  }

  return { showProjectModal, editProject, saveProject, deleteProject, deleteProjectFromModal, clearDoneFromModal, clearDoneInProject };
}
