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

  function renderProjectWorkspaceSelect(project = null) {
    const group = document.getElementById('project-display-workspace-group');
    const select = document.getElementById('project-display-workspace-id');
    if (!group || !select) return;
    const sharedMemberProject = !!project?.is_shared && !isOwner(project);
    group.style.display = sharedMemberProject ? '' : 'none';
    select.disabled = !sharedMemberProject;
    select.innerHTML = '';
    const workspaces = getWorkspaces?.() || [];
    for (const workspace of workspaces) {
      const option = document.createElement('option');
      option.value = workspace.id;
      option.textContent = workspace.name || 'Workspace';
      select.appendChild(option);
    }
    if (sharedMemberProject) {
      select.value = String(project.workspace_id || getCurrentWorkspaceId?.() || workspaces[0]?.id || '');
    }
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

    const parentSelect = document.getElementById('project-parent-id');
    if (parentSelect) {
      parentSelect.innerHTML = `<option value="" data-i18n-key="project.noParent">${t('project.noParent')}</option>`;
      const currentWorkspaceId = getCurrentWorkspaceId?.();
      const projects = getProjects().filter(p => !p.is_shared && (!currentWorkspaceId || String(p.workspace_id || '') === String(currentWorkspaceId)));
      const projectMap = new Map();
      projects.forEach(p => projectMap.set(p.id, { id: p.id, name: p.name, parent_id: p.parent_id, sort_order: p.sort_order, color: p.color, is_inbox: p.is_inbox }));
      projectMap.forEach(p => { p.children = []; });
      const rootProjects = [];
      projectMap.forEach(p => {
        if (p.parent_id === null || p.parent_id === undefined) rootProjects.push(p);
        else {
          const parent = projectMap.get(p.parent_id);
          if (parent) parent.children.push(p);
        }
      });
      rootProjects.sort((a, b) => (!!a.is_inbox !== !!b.is_inbox ? (a.is_inbox ? -1 : 1) : a.name.localeCompare(b.name)));
      function addProjectOptions(projectNode, depth = 0) {
        if (project && projectNode.id === project.id) return;
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
      parentSelect.value = parentId || (project ? project.parent_id : '') || '';
    }

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
      if (parentSelect) parentSelect.value = project.parent_id || '';
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
    const projectData = sharedMemberProject ? {
      workspace_id: displayWorkspaceId ? parseInt(displayWorkspaceId) : null,
    } : {
      name: document.getElementById('project-name').value,
      color: document.getElementById('project-color').value,
      icon: document.getElementById('project-icon')?.value || null,
      sort_order: getProjects().length,
      parent_id: parentIdVal ? parseInt(parentIdVal) : null,
      workspace_id: getCurrentWorkspaceId?.() || null,
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
    if (doneCount === 0) return showToast('Keine erledigten Todos in diesem Projekt');
    const confirmed = await confirmDanger({
      title: 'Erledigte Todos löschen?',
      message: `${doneCount} erledigte Todo(s) in "${project.name}" werden dauerhaft gelöscht.`,
      confirmText: 'Todos löschen',
    });
    if (!confirmed) return;
    try {
      const r = await projectsApi.clearDone(projectId);
      if (r.ok) {
        const result = await r.json();
        setProjects(getProjects());
        renderStats();
        renderTodos();
        showToast(`${result.deleted_count} erledigte Todo(s) gelöscht`);
      } else {
        showToast('Fehler beim Löschen');
      }
    } catch (err) {
      console.error('Clear done error:', err);
      showToast('Fehler beim Löschen');
    }
  }

  async function clearDoneInProject() {
    const currentProjectId = getCurrentProjectId();
    if (!currentProjectId) return;
    const project = getProjects().find(p => p.id === currentProjectId);
    if (!project) return;
    const doneTodos = getTodos().filter(t => t.project_id === currentProjectId && t.status === 'done');
    if (doneTodos.length === 0) return showToast('Keine erledigten Todos in diesem Projekt');
    const confirmed = await confirmDanger({
      title: 'Erledigte Todos löschen?',
      message: `${doneTodos.length} erledigte Todo(s) in "${project.name}" werden dauerhaft gelöscht.`,
      confirmText: 'Todos löschen',
    });
    if (!confirmed) return;
    showBatchToast(`${doneTodos.length} erledigte Todo(s) gelöscht`, { todos: doneTodos });
    try {
      const r = await projectsApi.clearDone(currentProjectId);
      if (!r.ok) showToast('Fehler beim Löschen');
      renderStats();
      renderTodos();
    } catch (err) {
      console.error('Clear done error:', err);
      showToast('Fehler beim Löschen');
    }
  }

  return { showProjectModal, editProject, saveProject, deleteProject, deleteProjectFromModal, clearDoneFromModal, clearDoneInProject };
}
