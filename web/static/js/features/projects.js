import { t } from '../i18n/index.js';
import { hydrateSelect, refreshSelect } from '../ui/dropdowns.js';
import { createEntityAppearanceController } from './entity-appearance.js';
import { createEntityEditorModalController } from './entity-editor-modal.js';
import { createEntityOwnershipField, isHouseholdOwnedEntity } from './entity-ownership-field.js';
import { acquireSyncCommitLock, projectPendingProjectChanges } from './todo-pending.js';
import { runAccessFencedCommit } from './entity-access-privacy.js';

export function createProjectsFeature({
  getProjects,
  getTodos,
  setTodos,
  getCurrentProjectId,
  getCurrentWorkspaceId,
  getWorkspaces,
  setProjects,
  dbPut,
  dbGetAll = async () => [],
  addToSyncQueue,
  runSyncQueueMutation,
  deleteFromDB,
  isOnlineForSync,
  syncWithServer,
  renderProjects,
  renderStats,
  renderTodos,
  confirmDanger,
  showToast,
  showBatchToast,
  projectsApi,
  sharingFeature,
  getCurrentUser,
  getAccessSnapshot = () => window.niaAccessSnapshot || null,
  syncInProgressRef = {},
}) {
  const commitQueuedMutation = runSyncQueueMutation || (operation => operation(addToSyncQueue));
  let projectAppearance = null;
  let projectModalController = null;
  let projectOwnershipField = null;
  let ownershipProject = null;

  function ensureProjectAppearance() {
    if (!projectAppearance) {
      projectAppearance = createEntityAppearanceController({
        prefix: 'project',
        onChange: () => projectModalController?.refreshSaveState?.(),
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
    return projectModalController?.canSave?.() || false;
  }

  function refreshProjectSaveButtonState() {
    projectModalController?.refreshSaveState?.();
  }


  function bindProjectForm() {
    ensureProjectModalController().bind();
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
    return isHouseholdOwnedEntity(project);
  }

  function ensureProjectOwnershipField() {
    if (!projectOwnershipField) {
      projectOwnershipField = createEntityOwnershipField({
        prefix: 'project',
        getHousehold: currentHousehold,
        onChange: () => {
          const project = ownershipProject;
          renderParentProjectSelect(project, null, project?.workspace_id || getCurrentWorkspaceId?.());
          applyHouseholdTransferMode(project);
          refreshProjectSaveButtonState();
        },
      });
    }
    return projectOwnershipField;
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


  function projectDetailButton(id) {
    return Array.from(document.querySelectorAll('[data-entity-sidebar-action="detail"][data-entity-type="project"]'))
      .find(button => String(button.dataset.entityId) === String(id)) || null;
  }

  function projectAddButton() {
    return document.querySelector('[data-entity-sidebar-action="add"][data-entity-type="project"]');
  }

  function applyProjectModalPermissions(project, view) {
    const canEditAppearance = view.appearanceEditable !== false;
    const form = document.getElementById('project-form');
    form?.classList.toggle('entity-editor-appearance-readonly', Boolean(project && !canEditAppearance));
    for (const id of ['project-name', 'project-color', 'project-parent-id', 'project-icon']) {
      const field = document.getElementById(id);
      if (!field) continue;
      field.disabled = !canEditAppearance;
      field.setAttribute('aria-readonly', canEditAppearance ? 'false' : 'true');
      if (field.tagName === 'SELECT') refreshSelect(field);
    }
    const workspace = document.getElementById('project-display-workspace-id');
    if (workspace) {
      workspace.disabled = !(view.canMoveSharedDisplay || view.canMoveOwnProject);
      refreshSelect(workspace);
    }
    const iconPicker = document.getElementById('project-icon-picker');
    if (iconPicker) {
      iconPicker.style.pointerEvents = canEditAppearance ? '' : 'none';
      iconPicker.style.opacity = canEditAppearance ? '' : '0.6';
      iconPicker.setAttribute('aria-disabled', canEditAppearance ? 'false' : 'true');
    }
    const save = document.getElementById('project-save-btn');
    if (save) save.style.display = (canEditAppearance || view.canMoveSharedDisplay || view.canMoveOwnProject) ? '' : 'none';
  }

  function ensureProjectModalController() {
    if (projectModalController) return projectModalController;
    const appearance = ensureProjectAppearance();
    projectModalController = createEntityEditorModalController({
      prefix: 'project',
      appearanceController: appearance,
      ownershipController: {
        render(project, options) {
          ownershipProject = project;
          ensureProjectOwnershipField().render(project, options);
        },
      },
      sharingController: {
        setEntity(project) {
          return sharingFeature?.setEntity?.(project);
        },
      },
      readState: getProjectSaveRelevantState,
      isValid: state => Boolean(state.name) && state.name.length <= 200,
      resolveView({ entity: project, context }) {
        const owner = !project || isOwner(project);
        const householdProject = isHouseholdProject(project);
        const canMoveSharedDisplay = Boolean(project && project.is_shared && !owner && !householdProject);
        const canMoveOwnProject = Boolean(project && owner && !project.is_inbox && !householdProject);
        return {
          mode: project ? 'edit' : (context?.parentId ? 'create-child' : 'create'),
          titleKey: project ? 'project.edit' : (context?.parentId ? 'project.newSubproject' : 'project.new'),
          appearance: project || { name: '', color: '#6366f1', icon: '' },
          appearanceEditable: owner,
          ownershipCanManage: !project || (owner && !project.is_inbox),
          canDelete: Boolean(project && owner && !project.is_inbox),
          readOnly: Boolean(project && !owner && !canMoveSharedDisplay),
          canMoveSharedDisplay,
          canMoveOwnProject,
          restoreFocus: project
            ? () => projectDetailButton(document.getElementById('project-id')?.value || project.id)
              || document.querySelector('[data-entity-sidebar-action="detail"][data-entity-type="project"][aria-current="true"]')
              || projectAddButton()
            : projectAddButton,
        };
      },
      renderDomain({ entity: project, context }) {
        renderParentProjectSelect(project, context?.parentId || project?.parent_id || '', project?.workspace_id || getCurrentWorkspaceId?.());
        const parentFormGroup = document.getElementById('project-parent-id')?.closest('.form-group');
        if (parentFormGroup) parentFormGroup.style.display = project?.is_inbox ? 'none' : '';
        renderProjectWorkspaceSelect(project);
      },
      applyDomainPermissions({ entity: project, view }) {
        applyProjectModalPermissions(project, view);
      },
      onSubmit: saveProject,
      onDelete: deleteProjectFromModal,
    });
    return projectModalController;
  }

  function showProjectModal(project = null, parentId = null) {
    bindProjectForm();
    return ensureProjectModalController().open(project, { parentId });
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
      const privacyGeneration = Number(syncInProgressRef?.privacyGeneration || 0);
      const transferred = await projectsApi.transferToHousehold(
        existing.id,
        selectedHouseholdId,
        parentIdVal ? parseInt(parentIdVal) : null,
      );
      const transferredProjects = Array.isArray(transferred?.transferred_projects)
        ? transferred.transferred_projects
        : [transferred];
      let applied = false;
      const committed = await runAccessFencedCommit({
        syncInProgressRef,
        acquireCommitLock: acquireSyncCommitLock,
        privacyGeneration,
        commit: async () => {
          const current = getProjects().find(project => String(project.id) === String(existing.id));
          if (!current) return;
          if (!isOwner(current) || isHouseholdProject(current)) return;
          if (String(currentHousehold()?.id || '') !== String(selectedHouseholdId || '')) return;
          if (parentIdVal && !getProjects().some(project => String(project.id) === String(parentIdVal))) return;
          const queue = await dbGetAll('syncQueue');
          const currentProjectIds = new Set(getProjects().map(project => String(project.id)));
          const projectedProjects = transferredProjects
            .filter(project => currentProjectIds.has(String(project.id)))
            .map(project => projectPendingProjectChanges(project, queue))
            .filter(Boolean);
          if (!projectedProjects.some(project => String(project.id) === String(existing.id))) return;
          const availableProjectIds = new Set([
            ...getProjects().map(project => String(project.id)),
            ...projectedProjects.map(project => String(project.id)),
          ]);
          if (projectedProjects.some(project => project.parent_id != null && !availableProjectIds.has(String(project.parent_id)))) return;
          const persistenceResults = await Promise.allSettled(
            projectedProjects.map(project => dbPut('projects', project)),
          );
          const persistedProjects = projectedProjects.filter((_project, index) => persistenceResults[index]?.status === 'fulfilled');
          if (!persistedProjects.some(project => String(project.id) === String(existing.id))) return;
          if (persistedProjects.length !== projectedProjects.length) {
            console.warn('Some transferred projects could not be persisted locally');
          }
          const persistedById = new Map(persistedProjects.map(project => [String(project.id), project]));
          setProjects(getProjects().map(project => persistedById.get(String(project.id)) || project));
          applied = true;
        },
      });
      if (!committed || !applied) return;
      ensureProjectModalController().close();
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
      const updated = await commitQueuedMutation(async enqueue => {
        const current = getProjects().find(project => String(project.id) === String(id));
        if (!current) return null;
        if (ownerProject && (!isOwner(current) || current.is_inbox)) return null;
        if (sharedMemberProject && (!current.is_shared || isOwner(current))) return null;
        const nextProject = { ...current, ...projectData, updated_at: new Date().toISOString() };
        await dbPut('projects', nextProject);
        setProjects(getProjects().map(project => String(project.id) === String(id) ? nextProject : project));
        if (!String(id).startsWith('temp-')) {
          await enqueue('UPDATE_PROJECT', { id: parseInt(id), changes: projectData });
        }
        ensureProjectModalController().close();
        renderProjects();
        renderStats?.();
        renderTodos?.();
        return nextProject;
      });
      if (updated && !String(id).startsWith('temp-') && isOnlineForSync()) await syncWithServer();
    } else {
      const newProject = await commitQueuedMutation(async enqueue => {
        const parentProject = parentIdVal
          ? getProjects().find(project => String(project.id) === String(parentIdVal))
          : null;
        if (parentIdVal && !parentProject) return null;
        if (selectedHouseholdId && String(currentHousehold()?.id) !== String(selectedHouseholdId)) return null;
        const tempId = 'temp-project-' + Date.now();
        const household = selectedHouseholdId ? currentHousehold() : null;
        const nextProject = {
          id: tempId,
          ...projectData,
          parent_id: parentProject?.id ?? null,
          created_at: new Date().toISOString(),
          is_owner: true,
          is_shared: false,
          ownership_type: selectedHouseholdId ? 'household' : 'user',
          owner_household_id: selectedHouseholdId,
          household_name: household?.name || null,
        };
        await dbPut('projects', nextProject);
        await enqueue('CREATE_PROJECT', { ...projectData, parent_id: nextProject.parent_id, _tempId: tempId });
        setProjects([...getProjects(), nextProject]);
        ensureProjectModalController().close();
        renderProjects();
        return nextProject;
      });
      if (newProject && isOnlineForSync()) await syncWithServer();
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

    const deleted = await commitQueuedMutation(async enqueue => {
      const rootProject = getProjects().find(project => String(project.id) === String(id));
      if (!rootProject) return false;
      const deletedIds = collectProjectTreeIds(rootProject.id);
      const inboxProject = getProjects().find(project => project.is_inbox && String(project.workspace_id || '') === String(rootProject.workspace_id || ''));
      await Promise.all([...deletedIds].map(projectId => deleteFromDB('projects', projectId)));
      if (inboxProject) {
        const currentTodos = getTodos();
        const nextTodos = currentTodos.map(todo => deletedIds.has(todo.project_id)
          ? { ...todo, project_id: inboxProject.id, section_id: null, updated_at: new Date().toISOString() }
          : todo);
        await Promise.all(nextTodos
          .filter((todo, index) => todo !== currentTodos[index])
          .map(todo => dbPut('todos', todo)));
        setTodos(nextTodos);
      }
      await enqueue('DELETE_PROJECT', { id: rootProject.id });
      setProjects(getProjects().filter(project => !deletedIds.has(project.id)));
      renderProjects();
      renderStats();
      renderTodos();
      ensureProjectModalController().close();
      return true;
    });
    if (deleted && isOnlineForSync()) await syncWithServer();
  }

  function deleteProjectFromModal() {
    const id = document.getElementById('project-id').value;
    if (id) deleteProject(parseInt(id), {
      returnFocus: () => document.querySelector('#project-detail-header-menu > summary'),
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
    if (!currentProjectId) return null;
    const project = getProjects().find(p => p.id === currentProjectId);
    if (!project) return null;
    const doneTodos = getTodos().filter(t => t.project_id === currentProjectId && t.status === 'done');
    if (doneTodos.length === 0) return null;
    const result = await projectsApi.clearDone(currentProjectId);
    await removeDeletedTodosFromLocalState(result.deleted_ids);
    renderStats();
    renderTodos();
    showToast(t('project.done.deleted', { count: result.deleted_count }));
    return result;
  }

  return { showProjectModal, editProject, saveProject, deleteProject, deleteProjectFromModal, clearDoneFromModal, clearDoneInProject };
}
