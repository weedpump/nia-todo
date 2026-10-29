import { t } from '../i18n/index.js';
import { hydrateSelect, refreshSelect } from '../ui/dropdowns.js';
import { openUiLayer } from './ui-history.js';
import { createEntityAppearanceController } from './entity-appearance.js';
import { createFormSaveState } from './form-save-state.js';

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
  getAccessSnapshot = () => window.niaAccessSnapshot || null,
}) {
  let projectFormBound = false;
  let projectActionsBound = false;
  let projectAppearance = null;
  let projectSaveState = null;

  function ensureProjectAppearance() {
    if (!projectAppearance) {
      projectAppearance = createEntityAppearanceController({
        prefix: 'project',
        onChange: () => projectSaveState?.refresh?.(),
      });
    }
    return projectAppearance;
  }

  function getProjectSaveRelevantState() {
    const appearance = ensureProjectAppearance().readState();
    return {
      id: document.getElementById('project-id')?.value || '',
      ...appearance,
      parent_id: document.getElementById('project-parent-id')?.value || '',
      display_workspace_id: document.getElementById('project-display-workspace-id')?.value || '',
      household_id: document.getElementById('project-household-id')?.value || '',
    };
  }

  function canSaveProject() {
    return projectSaveState?.canSave?.() || false;
  }

  function refreshProjectSaveButtonState() {
    projectSaveState?.refresh?.();
  }

  function resetProjectSaveSnapshot() {
    projectSaveState?.reset?.();
  }

  function bindProjectForm() {
    if (projectFormBound) return;
    const form = document.getElementById('project-form');
    if (!form) return;
    projectFormBound = true;
    ensureProjectAppearance();
    projectSaveState = createFormSaveState({
      form,
      button: document.getElementById('project-save-btn'),
      readState: getProjectSaveRelevantState,
      isValid: state => Boolean(state.name) && state.name.length <= 200,
    });
    form.addEventListener('submit', saveProject);
  }

  function isOwner(project) {
    if (!project) return false;
    if (Object.prototype.hasOwnProperty.call(project, 'is_owner')) {
      return project.is_owner === true || project.is_owner === 1 || project.is_owner === '1';
    }
    const user = getCurrentUser?.();
    return !!(user && project.user_id === user.id);
  }

  function currentHousehold() {
    return getAccessSnapshot?.()?.household || null;
  }

  function isHouseholdProject(project) {
    return Boolean(project?.owner_household_id || project?.ownership_type === 'household');
  }

  function applyHouseholdTransferMode(project) {
    const selectedHouseholdId = document.getElementById('project-household-id')?.value || '';
    const transferMode = Boolean(project && isOwner(project) && !isHouseholdProject(project) && selectedHouseholdId);
    if (!project || isHouseholdProject(project)) return;

    const nameInput = document.getElementById('project-name');
    const colorInput = document.getElementById('project-color');
    const iconInput = document.getElementById('project-icon');
    const parentInput = document.getElementById('project-parent-id');
    const workspaceInput = document.getElementById('project-display-workspace-id');
    if (nameInput) nameInput.value = project.name || '';
    if (colorInput) colorInput.value = project.color || '#6366f1';
    if (iconInput) iconInput.value = project.icon || '';
    if (parentInput) parentInput.value = transferMode ? '' : String(project.parent_id || '');
    if (workspaceInput) {
      if (transferMode) {
        const defaultWorkspaceId = getWorkspaces?.().find(workspace => workspace.is_default)?.id;
        if (defaultWorkspaceId != null) workspaceInput.value = String(defaultWorkspaceId);
      } else {
        workspaceInput.value = String(project.workspace_id || '');
      }
    }
    [nameInput, colorInput, iconInput, workspaceInput].forEach(input => {
      if (input) input.disabled = transferMode;
    });
    if (parentInput) parentInput.disabled = false;
    ensureProjectAppearance().setValues({
      name: nameInput?.value || '',
      color: colorInput?.value || '#6366f1',
      icon: iconInput?.value || '',
    }, { editable: !transferMode });
    if (parentInput) refreshSelect(parentInput);
    if (workspaceInput) refreshSelect(workspaceInput);
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
    const selectedHouseholdId = document.getElementById('project-household-id')?.value || (isHouseholdProject(project) ? String(project.owner_household_id || '') : '');
    const defaultWorkspaceId = getWorkspaces?.().find(workspace => workspace.is_default)?.id;
    const targetWorkspaceId = selectedHouseholdId
      ? (defaultWorkspaceId || workspaceId || getCurrentWorkspaceId?.())
      : (workspaceId || getCurrentWorkspaceId?.());
    const projects = getProjects().filter(p => {
      if (p.is_shared && !selectedHouseholdId) return false;
      if (selectedHouseholdId && String(p.owner_household_id || '') !== String(selectedHouseholdId)) return false;
      if (!selectedHouseholdId && isHouseholdProject(p)) return false;
      if (targetWorkspaceId && String(p.workspace_id || '') !== String(targetWorkspaceId)) return false;
      if (project && (String(p.id) === String(project.id) || isProjectDescendant(p, project.id))) return false;
      return true;
    });
    const projectMap = new Map();
    projects.forEach(p => projectMap.set(p.id, { id: p.id, name: p.name, parent_id: p.parent_id, sort_order: p.sort_order, color: p.color, icon: p.icon, is_inbox: p.is_inbox }));
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
      const option = document.createElement('option');
      option.value = projectNode.id;
      option.dataset.depth = String(depth);
      option.dataset.projectColor = projectNode.color || '#6366f1';
      option.dataset.projectIcon = projectNode.icon || '';
      option.textContent = projectNode.name;
      parentSelect.appendChild(option);
      if (projectNode.children && projectNode.children.length > 0) {
        projectNode.children.sort((a, b) => a.name.localeCompare(b.name));
        projectNode.children.forEach(child => addProjectOptions(child, depth + 1));
      }
    }
    rootProjects.forEach(p => addProjectOptions(p));
    const selected = selectedParentId || '';
    parentSelect.value = [...parentSelect.options].some(option => String(option.value) === String(selected)) ? String(selected) : '';
    hydrateSelect(parentSelect, { className: 'project-ui-select', menuClassName: 'project-ui-select-menu', searchPlaceholder: t('focus.projects.search'), searchLabel: t('focus.projects.search'), emptyText: t('focus.projects.noMatches') });
    refreshSelect(parentSelect);
  }

  function renderProjectWorkspaceSelect(project = null) {
    const group = document.getElementById('project-display-workspace-group');
    const select = document.getElementById('project-display-workspace-id');
    if (!group || !select) return;
    const householdProject = isHouseholdProject(project);
    const sharedMemberProject = !!project?.is_shared && !isOwner(project) && !householdProject;
    const ownMovableProject = !!project && isOwner(project) && !project.is_inbox && !householdProject;
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
      refreshSelect(select);
      refreshProjectSaveButtonState();
    };
    hydrateSelect(select);
    refreshSelect(select);
  }

  function renderProjectHouseholdSelect(project = null) {
    const group = document.getElementById('project-household-group');
    const select = document.getElementById('project-household-id');
    const readonly = document.getElementById('project-household-readonly');
    if (!group || !select) return;
    const household = currentHousehold();
    group.style.display = household ? '' : 'none';
    if (!household) {
      select.innerHTML = '';
      select.value = '';
      return;
    }
    const householdProject = isHouseholdProject(project);
    const normalMemberHouseholdProject = householdProject && !isOwner(project);
    select.innerHTML = `<option value="">${t('project.forPersonal')}</option><option value="${household.id}">${t('project.forHousehold', { name: household.name })}</option>`;
    select.value = householdProject ? String(project.owner_household_id || household.id) : '';
    select.disabled = householdProject || Boolean(project?.is_inbox);
    if (readonly) {
      readonly.hidden = !normalMemberHouseholdProject;
      readonly.textContent = normalMemberHouseholdProject ? t('project.forHousehold', { name: project.household_name || household.name }) : '';
    }
    select.onchange = () => {
      renderParentProjectSelect(project, null, project?.workspace_id || getCurrentWorkspaceId?.());
      applyHouseholdTransferMode(project);
      refreshSelect(select);
      refreshProjectSaveButtonState();
    };
    hydrateSelect(select);
    refreshSelect(select);
  }

  function showProjectModal(project = null, parentId = null) {
    bindProjectForm();
    document.getElementById('project-form')?.reset();
    document.getElementById('project-id').value = '';
    const saveBtn = document.getElementById('project-save-btn');
    if (saveBtn) {
      saveBtn.hidden = false;
      saveBtn.disabled = false;
      saveBtn.style.display = '';
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
    renderProjectHouseholdSelect(project);

    const sharingSection = document.getElementById('project-sharing-section');
    const deleteBtn = document.getElementById('project-delete-btn');
    const headerMenu = document.getElementById('project-detail-header-menu');

    if (project) {
      document.getElementById('project-id').value = project.id;
      const owner = isOwner(project);
      ensureProjectAppearance().setValues(project, { editable: owner });
      const shared = !!project.is_shared;
      const canDelete = owner && !project.is_inbox;
      if (deleteBtn) deleteBtn.style.display = canDelete ? '' : 'none';
      if (headerMenu) {
        headerMenu.hidden = !canDelete;
        headerMenu.removeAttribute('open');
      }
      if (sharingFeature?.applyProjectModalState) {
        sharingFeature.applyProjectModalState(project, owner, shared);
      }
    } else {
      if (sharingSection) sharingSection.style.display = 'none';
      if (deleteBtn) deleteBtn.style.display = 'none';
      if (headerMenu) {
        headerMenu.hidden = true;
        headerMenu.removeAttribute('open');
      }
      document.getElementById('project-form')?.classList.remove('readonly-project');
      ensureProjectAppearance().setValues({ name: '', color: '#6366f1', icon: '' }, { editable: true });
      renderProjectWorkspaceSelect(null);
      renderProjectHouseholdSelect(null);
      ['project-parent-id'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.disabled = false;
          el.setAttribute('aria-readonly', 'false');
        }
      });
    }

    document.getElementById('project-modal')?.classList.add('active');
    document.getElementById('project-modal')?.setAttribute('aria-hidden', 'false');
    openUiLayer('project-modal');
    resetProjectSaveSnapshot();
    if (!project) {
      window.setTimeout(() => document.getElementById('project-name')?.focus(), 0);
    }
  }

  function editProject(id) {
    const project = getProjects().find(p => String(p.id) === String(id));
    if (project) showProjectModal(project);
  }

  async function saveProject(event) {
    event.preventDefault();
    refreshProjectSaveButtonState();
    if (!canSaveProject()) return;
    const id = document.getElementById('project-id').value;
    const parentIdVal = document.getElementById('project-parent-id')?.value;
    const existing = id ? getProjects().find(p => String(p.id) === String(id)) : null;
    const sharedMemberProject = !!existing?.is_shared && !isOwner(existing);
    const displayWorkspaceId = document.getElementById('project-display-workspace-id')?.value || getCurrentWorkspaceId?.() || null;
    const ownerProject = !!existing && isOwner(existing) && !existing.is_inbox;
    const appearance = ensureProjectAppearance().readState();
    const householdValue = document.getElementById('project-household-id')?.value || '';
    const selectedHouseholdId = householdValue ? parseInt(householdValue) : null;
    const defaultWorkspaceId = getWorkspaces?.().find(workspace => workspace.is_default)?.id || getCurrentWorkspaceId?.() || null;
    if (existing && ownerProject && !isHouseholdProject(existing) && selectedHouseholdId) {
      const household = currentHousehold();
      const confirmed = await confirmDanger({
        title: t('project.transferHousehold.title'),
        message: t('project.transferHousehold.message', { project: existing.name, household: household?.name || '' }),
        confirmText: t('project.transferHousehold.confirm'),
        cancelText: t('project.transferHousehold.cancel'),
      });
      if (!confirmed) {
        const householdSelect = document.getElementById('project-household-id');
        if (householdSelect) {
          householdSelect.value = '';
          refreshSelect(householdSelect);
        }
        renderParentProjectSelect(existing, existing.parent_id || null, existing.workspace_id);
        applyHouseholdTransferMode(existing);
        refreshProjectSaveButtonState();
        return;
      }
      const transferred = await projectsApi.transferToHousehold(
        existing.id,
        selectedHouseholdId,
        parentIdVal ? parseInt(parentIdVal) : null,
      );
      const transferredProjects = Array.isArray(transferred?.transferred_projects)
        ? transferred.transferred_projects
        : [transferred];
      const transferredById = new Map(transferredProjects.map(project => [String(project.id), project]));
      const persistenceResults = await Promise.allSettled(
        transferredProjects.map(project => dbPut('projects', project)),
      );
      if (persistenceResults.some(result => result.status === 'rejected')) {
        console.warn('Some transferred projects could not be persisted locally');
      }
      setProjects(getProjects().map(project => transferredById.get(String(project.id)) || project));
      closeModal('project-modal');
      renderProjects();
      renderStats?.();
      renderTodos?.();
      return;
    }
    const projectData = sharedMemberProject ? {
      workspace_id: displayWorkspaceId ? parseInt(displayWorkspaceId) : null,
    } : {
      name: appearance.name,
      color: appearance.color,
      icon: appearance.icon,
      sort_order: getProjects().length,
      parent_id: parentIdVal ? parseInt(parentIdVal) : null,
      workspace_id: selectedHouseholdId
        ? defaultWorkspaceId
        : (ownerProject && displayWorkspaceId ? parseInt(displayWorkspaceId) : (getCurrentWorkspaceId?.() || null)),
      ...(!existing ? { household_id: selectedHouseholdId } : {}),
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
      const household = selectedHouseholdId ? currentHousehold() : null;
      const newProject = {
        id: tempId,
        ...projectData,
        created_at: new Date().toISOString(),
        is_owner: true,
        is_shared: false,
        ownership_type: selectedHouseholdId ? 'household' : 'user',
        owner_household_id: selectedHouseholdId,
        household_name: household?.name || null,
      };
      await dbPut('projects', newProject);
      setProjects([...getProjects(), newProject]);
      await addToSyncQueue('CREATE_PROJECT', { ...projectData, _tempId: tempId });
      if (isOnlineForSync()) await syncWithServer();
      closeModal('project-modal');
      renderProjects();
    }
  }

  async function deleteProject(id, { returnFocus = null } = {}) {
    const confirmed = await confirmDanger({
      title: t('project.deleteTitle'),
      message: t('project.deleteMessage'),
      confirmText: t('project.delete'),
      returnFocus,
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
    if (id) deleteProject(parseInt(id), {
      returnFocus: () => document.querySelector('#project-detail-header-menu > summary'),
    });
  }

  function bindProjectActions() {
    if (projectActionsBound) return;
    projectActionsBound = true;
    document.addEventListener('click', (event) => {
      const target = event.target?.closest?.('[data-project-action]');
      if (!target) return;
      const action = target.dataset.projectAction;
      event.preventDefault();
      if (action === 'delete-from-modal') {
        document.getElementById('project-detail-header-menu')?.removeAttribute('open');
        deleteProjectFromModal();
      } else if (action === 'clear-done-current') {
        clearDoneInProject();
      }
    });
  }

  async function removeDeletedTodosFromLocalState(deletedIds) {
    const ids = new Set((deletedIds || []).map(id => Number(id)));
    if (!ids.size) return;
    await Promise.all([...ids].map(id => deleteFromDB('todos', id)));
    setTodos(getTodos().filter(todo => !ids.has(Number(todo.id))));
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
      const result = await projectsApi.clearDone(projectId);
      await removeDeletedTodosFromLocalState(result.deleted_ids);
      renderStats();
      renderTodos();
      showToast(t('project.done.deleted', { count: result.deleted_count }));
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
    try {
      const result = await projectsApi.clearDone(currentProjectId);
      await removeDeletedTodosFromLocalState(result.deleted_ids);
      renderStats();
      renderTodos();
      showToast(t('project.done.deleted', { count: result.deleted_count }));
    } catch (err) {
      console.error('Clear done error:', err);
      showToast(t('project.done.deleteFailed'));
    }
  }

  return { showProjectModal, editProject, saveProject, deleteProject, deleteProjectFromModal, bindProjectActions, clearDoneFromModal, clearDoneInProject };
}
