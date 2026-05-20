export function createProjectsFeature({
  getProjects,
  getTodos,
  getCurrentProjectId,
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
  showToast,
  showBatchToast,
  projectsApi,
  sharingFeature,
  getCurrentUser,
}) {
  function isOwner(project) {
    if (!project) return false;
    if (project.is_owner === true || project.is_owner === 1 || project.is_owner === '1') return true;
    const user = getCurrentUser?.();
    return !!(user && project.user_id === user.id);
  }

  function showProjectModal(project = null, parentId = null) {
    document.getElementById('project-form')?.reset();
    document.getElementById('project-id').value = '';
    document.getElementById('project-modal-title').textContent = project ? 'Projekt bearbeiten' : (parentId ? 'Neues Subproject' : 'Neues Projekt');

    const parentSelect = document.getElementById('project-parent-id');
    if (parentSelect) {
      parentSelect.innerHTML = '<option value="">-- Kein Eltern-Projekt --</option>';
      const projects = getProjects().filter(p => !p.is_shared);
      const projectMap = new Map();
      projects.forEach(p => projectMap.set(p.id, { id: p.id, name: p.name, parent_id: p.parent_id, sort_order: p.sort_order, color: p.color }));
      projectMap.forEach(p => { p.children = []; });
      const rootProjects = [];
      projectMap.forEach(p => {
        if (p.parent_id === null || p.parent_id === undefined) rootProjects.push(p);
        else {
          const parent = projectMap.get(p.parent_id);
          if (parent) parent.children.push(p);
        }
      });
      rootProjects.sort((a, b) => (a.id === 1 ? -1 : b.id === 1 ? 1 : a.name.localeCompare(b.name)));
      function addProjectOptions(projectNode, depth = 0) {
        if (project && projectNode.id === project.id) return;
        if (projectNode.id === 1) return;
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
    if (parentFormGroup) parentFormGroup.style.display = (project && project.id === 1) ? 'none' : '';

    const sharingSection = document.getElementById('project-sharing-section');
    const shareRow = document.getElementById('project-share-row');
    const leaveBtn = document.getElementById('project-leave-btn');
    const deleteBtn = document.getElementById('project-delete-btn');

    if (project) {
      document.getElementById('project-id').value = project.id;
      document.getElementById('project-name').value = project.name;
      document.getElementById('project-color').value = project.color;
      if (parentSelect) parentSelect.value = project.parent_id || '';
      const owner = isOwner(project);
      const shared = !!project.is_shared;
      if (deleteBtn) deleteBtn.style.display = (owner && project.id !== 1) ? '' : 'none';
      if (sharingFeature?.applyProjectModalState) {
        sharingFeature.applyProjectModalState(project, owner, shared);
      }
    } else {
      if (sharingSection) sharingSection.style.display = 'none';
      if (deleteBtn) deleteBtn.style.display = 'none';
    }

    document.getElementById('project-modal')?.classList.add('active');
  }

  function editProject(id) {
    const project = getProjects().find(p => p.id === id);
    if (project) showProjectModal(project);
  }

  async function saveProject(event) {
    event.preventDefault();
    const id = document.getElementById('project-id').value;
    const parentIdVal = document.getElementById('project-parent-id')?.value;
    const projectData = {
      name: document.getElementById('project-name').value,
      color: document.getElementById('project-color').value,
      sort_order: getProjects().length,
      parent_id: parentIdVal ? parseInt(parentIdVal) : null,
    };

    if (id) {
      const existing = getProjects().find(p => p.id === parseInt(id));
      if (existing) {
        const updated = { ...existing, ...projectData, updated_at: new Date().toISOString() };
        await dbPut('projects', updated);
        setProjects(getProjects().map(p => p.id === parseInt(id) ? updated : p));
        await addToSyncQueue('UPDATE_PROJECT', { id: parseInt(id), changes: projectData });
        if (isOnlineForSync()) await syncWithServer();
        closeModal('project-modal');
        renderProjects();
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
    if (!confirm('Projekt wirklich löschen?')) return;
    await deleteFromDB('projects', id);
    setProjects(getProjects().filter(p => p.id !== id));
    renderProjects();
    renderStats();
    closeModal('project-modal');

    const todos = getTodos();
    for (const t of todos) {
      if (t.project_id === id) {
        t.project_id = 1;
        t.section_id = null;
        await dbPut('todos', t);
        await addToSyncQueue('UPDATE_TODO', { id: t.id, changes: { project_id: 1, section_id: null } });
      }
    }

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
    if (!confirm(`${doneCount} erledigte Todo(s) in "${project.name}" löschen?`)) return;
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
    if (!confirm(`${doneTodos.length} erledigte Todo(s) in "${project.name}" löschen?`)) return;
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
