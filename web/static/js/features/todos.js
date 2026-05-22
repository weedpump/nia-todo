export function createTodosFeature({
  getTodos,
  setTodos,
  getProjects,
  getCurrentProjectId,
  getCurrentWorkspaceId,
  getAppInitialized,
  getDb,
  dbPut,
  dbGetAll,
  deleteFromDB,
  addToSyncQueue,
  isOnlineForSync,
  syncWithServer,
  sectionsApi,
  renderProjects,
  renderStats,
  renderTodos,
  closeModal,
  confirmDanger,
  showToast,
  setupDescPreview,
  renderMarkdown,
}) {
  let todoFormBound = false;

  function bindTodoForm() {
    if (todoFormBound) return;
    const form = document.getElementById('todo-form');
    if (!form) return;
    todoFormBound = true;
    form.addEventListener('submit', saveTodo);
  }

  function clearDateTimeErrors() {
    for (const id of ['todo-due', 'todo-remind']) {
      const input = document.getElementById(id);
      const error = document.getElementById(`${id}-error`);
      if (input) input.setCustomValidity('');
      if (error) error.textContent = '';
    }
  }

  function validateDateTimeInput(id, label) {
    const input = document.getElementById(id);
    const error = document.getElementById(`${id}-error`);
    if (!input) return true;
    if (error) error.textContent = '';
    if (!input.value && !input.validity.badInput && !input.validity.customError) {
      input.setCustomValidity('');
      return true;
    }

    let message = '';
    if (input.validity.badInput || input.validity.typeMismatch || !input.validity.valid) {
      message = `${label} ist ungültig`;
    } else {
      const date = new Date(input.value);
      const year = Number(input.value.slice(0, 4));
      if (!Number.isFinite(date.getTime()) || year < 1900 || year > 9999) {
        message = `${label} ist ungültig`;
      }
    }

    if (message) {
      input.setCustomValidity(message);
      if (error) error.textContent = message;
      return false;
    }
    input.setCustomValidity('');
    return true;
  }

  function bindDateTimeValidation() {
    for (const id of ['todo-due', 'todo-remind']) {
      const input = document.getElementById(id);
      if (!input || input.dataset.validationBound === '1') continue;
      input.dataset.validationBound = '1';
      input.addEventListener('input', () => {
        input.setCustomValidity('');
        const error = document.getElementById(`${id}-error`);
        if (error) error.textContent = '';
      });
      input.addEventListener('invalid', (event) => {
        event.preventDefault();
        validateDateTimeInput(id, id === 'todo-due' ? 'Deadline' : 'Erinnerung');
      });
    }
  }

  function validateTodoDateTimes() {
    const dueOk = validateDateTimeInput('todo-due', 'Deadline');
    const remindOk = validateDateTimeInput('todo-remind', 'Erinnerung');
    if (!dueOk) document.getElementById('todo-due')?.focus();
    else if (!remindOk) document.getElementById('todo-remind')?.focus();
    return dueOk && remindOk;
  }

  function toIsoOrNull(id) {
    const value = document.getElementById(id)?.value;
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  async function markTodoDone(id) {
    if (!getAppInitialized() || !getDb()) return;
    const t = getTodos().find(x => x.id === id);
    if (!t || t.status === 'done') return;
    const updatedTodo = { ...t, status: 'done', updated_at: new Date().toISOString() };
    await dbPut('todos', updatedTodo);
    setTodos(getTodos().map(todo => todo.id === id ? updatedTodo : todo));
    renderStats();
    renderTodos();
    showToast('Todo erledigt', { type: 'status', id, previousStatus: t.status });
    await addToSyncQueue('UPDATE_TODO', { id, changes: { status: 'done' } });
    if (isOnlineForSync()) await syncWithServer();
  }

  async function toggleTodo(id) {
    if (!getAppInitialized() || !getDb()) return;
    const t = getTodos().find(x => x.id === id);
    if (!t) return;
    const cycle = { pending: 'in_progress', in_progress: 'done', done: 'pending' };
    const newStatus = cycle[t.status] || 'pending';
    const updatedTodo = { ...t, status: newStatus, updated_at: new Date().toISOString() };
    await dbPut('todos', updatedTodo);
    setTodos(getTodos().map(todo => todo.id === id ? updatedTodo : todo));
    renderStats();
    renderTodos();
    if (newStatus === 'done') showToast('Todo erledigt', { type: 'status', id, previousStatus: t.status });
    else if (t.status === 'done' && newStatus === 'pending') showToast('Todo wiedereröffnet', { type: 'status', id, previousStatus: t.status });
    await addToSyncQueue('UPDATE_TODO', { id, changes: { status: newStatus } });
    if (isOnlineForSync()) await syncWithServer();
  }

  async function showTodoModal(todo = null) {
    bindTodoForm();
    bindDateTimeValidation();
    document.getElementById('todo-form')?.reset();
    clearDateTimeErrors();
    document.getElementById('todo-id').value = '';
    document.getElementById('todo-modal-title').textContent = todo ? 'Todo bearbeiten' : 'Neues Todo';
    const projSelect = document.getElementById('todo-project');
    if (projSelect) {
      projSelect.innerHTML = '';
      const currentWorkspaceId = getCurrentWorkspaceId?.();
      const projects = getProjects().filter(p => p.is_shared || !currentWorkspaceId || String(p.workspace_id || '') === String(currentWorkspaceId));
      const projectMap = new Map();
      projects.forEach(p => projectMap.set(p.id, { ...p, children: [] }));
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
        const indent = '\u00A0'.repeat(depth * 2) + (depth > 0 ? '└─ ' : '');
        const opt = document.createElement('option');
        opt.value = projectNode.id;
        opt.style.color = projectNode.color;
        opt.textContent = indent + projectNode.name;
        projSelect.appendChild(opt);
        if (projectNode.children && projectNode.children.length > 0) {
          projectNode.children.sort((a, b) => a.name.localeCompare(b.name));
          projectNode.children.forEach(child => addProjectOptions(child, depth + 1));
        }
      }
      rootProjects.forEach(p => addProjectOptions(p));
    }

    if (todo) {
      document.getElementById('todo-id').value = todo.id;
      document.getElementById('todo-title').value = todo.title;
      document.getElementById('todo-desc').value = todo.description || '';
      document.getElementById('todo-priority').value = todo.priority;
      document.getElementById('todo-status').value = todo.status;
      document.getElementById('todo-project').value = todo.project_id || '';
      await onProjectChange(todo.section_id);
      if (todo.due_date) {
        const d = new Date(todo.due_date);
        document.getElementById('todo-due').value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      }
      const reminderDate = todo.remind_at || (todo.reminders && todo.reminders[0] && todo.reminders[0].remind_at);
      if (reminderDate) {
        const d = new Date(reminderDate);
        document.getElementById('todo-remind').value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      }
    } else {
      const currentWorkspaceId = getCurrentWorkspaceId?.();
      const workspaceProjects = getProjects().filter(p => !p.is_shared && (!currentWorkspaceId || String(p.workspace_id || '') === String(currentWorkspaceId)));
      const inboxProject = workspaceProjects.find(p => p.is_inbox) || workspaceProjects[0];
      document.getElementById('todo-project').value = getCurrentProjectId() || inboxProject?.id || '';
      await onProjectChange(null);
    }

    document.getElementById('todo-delete-btn').style.display = todo ? '' : 'none';
    setupDescPreview();
    document.getElementById('todo-modal')?.classList.add('active');
  }

  async function onProjectChange(selectedSectionId = null) {
    const projectId = document.getElementById('todo-project').value;
    const sectionSelect = document.getElementById('todo-section');
    if (!sectionSelect) return;
    sectionSelect.innerHTML = '<option value="">Keine Section (Unsortiert)</option>';
    sectionSelect.disabled = true;
    if (!projectId) return;
    try {
      let projectSections;
      if (isOnlineForSync()) {
        const data = await sectionsApi.listByProject(projectId);
        projectSections = data.sections || [];
        const serverIds = new Set(projectSections.map(s => s.id));
        const allLocal = await dbGetAll('sections');
        const localProjectSections = allLocal.filter(s => s.project_id === parseInt(projectId));
        for (const local of localProjectSections) {
          if (!serverIds.has(local.id)) await deleteFromDB('sections', local.id);
        }
        for (const s of projectSections) await dbPut('sections', s);
      } else {
        const allSections = await dbGetAll('sections');
        projectSections = allSections.filter(s => s.project_id === parseInt(projectId));
      }
      for (const s of projectSections) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        sectionSelect.appendChild(opt);
      }
      sectionSelect.disabled = false;
      if (selectedSectionId !== null) sectionSelect.value = selectedSectionId;
    } catch (e) {
      console.error('Failed to load sections for project', e);
    }
  }

  async function saveTodo(event) {
    event.preventDefault();
    if (!getAppInitialized() || !getDb()) return;
    if (!validateTodoDateTimes()) return;
    const id = document.getElementById('todo-id').value;
    const todoData = {
      title: document.getElementById('todo-title').value,
      description: document.getElementById('todo-desc').value,
      priority: parseInt(document.getElementById('todo-priority').value),
      project_id: document.getElementById('todo-project').value ? parseInt(document.getElementById('todo-project').value) : null,
      section_id: document.getElementById('todo-section').value ? parseInt(document.getElementById('todo-section').value) : null,
      status: document.getElementById('todo-status').value,
      due_date: toIsoOrNull('todo-due'),
      remind_at: toIsoOrNull('todo-remind'),
    };
    if (id) {
      const existing = getTodos().find(t => t.id === parseInt(id));
      if (existing) {
        const updated = { ...existing, ...todoData, updated_at: new Date().toISOString() };
        await dbPut('todos', updated);
        setTodos(getTodos().map(t => t.id === parseInt(id) ? updated : t));
        await addToSyncQueue('UPDATE_TODO', { id: parseInt(id), changes: todoData });
        if (isOnlineForSync()) await syncWithServer();
      }
    } else {
      const tempId = 'temp-' + Date.now();
      const newTodo = { id: tempId, ...todoData, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), reminders: [] };
      await dbPut('todos', newTodo);
      setTodos([...getTodos(), newTodo]);
      renderProjects();
      renderStats();
      renderTodos();
      closeModal('todo-modal');
      await addToSyncQueue('CREATE_TODO', { ...todoData, _tempId: tempId });
      if (isOnlineForSync()) {
        await syncWithServer();
        renderProjects();
        renderStats();
        renderTodos();
      }
    }
    if (id) {
      renderProjects();
      renderStats();
      renderTodos();
      closeModal('todo-modal');
    }
  }

  function editTodo(id) {
    const todo = getTodos().find(t => t.id === id);
    if (todo) showTodoModal(todo);
  }

  function deleteTodoFromModal() {
    const id = document.getElementById('todo-id').value;
    if (id) deleteTodo(parseInt(id));
  }

  async function deleteTodo(id) {
    const confirmed = await confirmDanger({
      title: 'Todo löschen?',
      message: 'Dieses Todo wird dauerhaft gelöscht.',
      confirmText: 'Todo löschen',
    });
    if (!confirmed) return;
    const todo = getTodos().find(t => t.id === id);
    if (!todo) return;
    await deleteFromDB('todos', id);
    setTodos(getTodos().filter(t => t.id !== id));
    renderStats();
    renderTodos();
    closeModal('todo-modal');
    showToast('Todo gelöscht', { type: 'delete', id, data: { ...todo } });
    await addToSyncQueue('DELETE_TODO', { id });
    if (isOnlineForSync()) await syncWithServer();
  }

  return { markTodoDone, toggleTodo, showTodoModal, onProjectChange, saveTodo, editTodo, deleteTodoFromModal, deleteTodo };
}
