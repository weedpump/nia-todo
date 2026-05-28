import { t, translatePage } from '../i18n/index.js';

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
      message = t('todo.invalidDate', { field: label });
    } else {
      const date = new Date(input.value);
      const year = Number(input.value.slice(0, 4));
      if (!Number.isFinite(date.getTime()) || year < 1900 || year > 9999) {
        message = t('todo.invalidDate', { field: label });
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
        validateDateTimeInput(id, id === 'todo-due' ? t('todo.deadline') : t('todo.reminder'));
      });
    }
  }

  function validateTodoDateTimes() {
    const dueOk = validateDateTimeInput('todo-due', t('todo.deadline'));
    const remindOk = validateDateTimeInput('todo-remind', t('todo.reminder'));
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
  function runHapticFeedback(pattern = 12) {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
    } catch (error) {
      // Haptics are best-effort only.
    }
  }

  function setDateTimeInputValue(id, date) {
    const input = document.getElementById(id);
    if (!input || !date || !Number.isFinite(date.getTime())) return;
    input.value = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}T${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
  }

  function startOfToday(base = new Date()) {
    const d = new Date(base);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function nextWeekday(base, targetDay) {
    const d = startOfToday(base);
    const delta = (targetDay + 7 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + delta);
    d.setHours(9, 0, 0, 0);
    return d;
  }

  function parseQuickAddTitle(rawTitle, currentProjectId) {
    const original = String(rawTitle || '').trim();
    if (!original) return { title: original, changes: {} };
    const now = new Date();
    const tokens = original.split(/\s+/);
    const used = new Set();
    const changes = {};

    tokens.forEach((token, index) => {
      const normalized = token.toLowerCase();
      const priorityMap = {
        '!p1': 1, '!urgent': 1, '!sehrhoch': 1, '!sehr-hoch': 1,
        '!hoch': 2, '!high': 2, '!p2': 2,
        '!mittel': 3, '!medium': 3, '!p3': 3,
        '!niedrig': 4, '!low': 4, '!p4': 4,
      };
      if (priorityMap[normalized]) {
        changes.priority = priorityMap[normalized];
        used.add(index);
      }
    });

    tokens.forEach((token, index) => {
      if (!token.startsWith('#') || token.length < 2) return;
      const wanted = token.slice(1).replace(/[-_]/g, ' ').toLowerCase();
      const project = getProjects().find(p => String(p.name || '').toLowerCase() === wanted || String(p.name || '').toLowerCase().replace(/\s+/g, '') === wanted.replace(/\s+/g, ''));
      if (project) {
        changes.project_id = project.id;
        used.add(index);
      }
    });

    let due = null;
    for (let i = 0; i < tokens.length; i += 1) {
      const n = tokens[i].toLowerCase();
      if (['heute', 'today'].includes(n)) { due = startOfToday(now); due.setHours(18, 0, 0, 0); used.add(i); }
      else if (['morgen', 'tomorrow'].includes(n)) { due = startOfToday(now); due.setDate(due.getDate() + 1); due.setHours(9, 0, 0, 0); used.add(i); }
      else if (['übermorgen', 'uebermorgen'].includes(n)) { due = startOfToday(now); due.setDate(due.getDate() + 2); due.setHours(9, 0, 0, 0); used.add(i); }
      else if (['wochenende', 'weekend'].includes(n)) { due = nextWeekday(now, 6); used.add(i); }
      else if (n === 'montag') { due = nextWeekday(now, 1); used.add(i); }
      else if (n === 'dienstag') { due = nextWeekday(now, 2); used.add(i); }
      else if (n === 'mittwoch') { due = nextWeekday(now, 3); used.add(i); }
      else if (n === 'donnerstag') { due = nextWeekday(now, 4); used.add(i); }
      else if (n === 'freitag') { due = nextWeekday(now, 5); used.add(i); }
      else if (n === 'samstag') { due = nextWeekday(now, 6); used.add(i); }
      else if (n === 'sonntag') { due = nextWeekday(now, 0); used.add(i); }
      else if (n === 'nächste' && ['woche', 'week'].includes(tokens[i + 1]?.toLowerCase())) { due = startOfToday(now); due.setDate(due.getDate() + 7); due.setHours(9, 0, 0, 0); used.add(i); used.add(i + 1); }
    }

    const timeIndex = tokens.findIndex((token, index) => !used.has(index) && /^([01]?\d|2[0-3])[:.]([0-5]\d)$/.test(token));
    if (timeIndex >= 0) {
      const [, hh, mm] = tokens[timeIndex].match(/^([01]?\d|2[0-3])[:.]([0-5]\d)$/);
      if (!due) due = startOfToday(now);
      due.setHours(Number(hh), Number(mm), 0, 0);
      if (due < now && !tokens.some(token => ['heute', 'today'].includes(token.toLowerCase()))) due.setDate(due.getDate() + 1);
      used.add(timeIndex);
    }

    if (due) changes.due_date = due.toISOString();
    if (currentProjectId && !changes.project_id) changes.project_id = currentProjectId;
    const title = tokens.filter((_, index) => !used.has(index)).join(' ').trim() || original;
    return { title, changes };
  }

  function getSnoozeDate(mode, todo) {
    const base = todo?.due_date ? new Date(todo.due_date) : new Date();
    const now = new Date();
    const start = Number.isFinite(base.getTime()) && base > now ? base : now;
    const next = new Date(start);
    if (mode === 'hour') next.setHours(next.getHours() + 1);
    else if (mode === 'evening') {
      next.setHours(18, 0, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
    } else if (mode === 'tomorrow') {
      next.setDate(now.getDate() + 1);
      next.setHours(9, 0, 0, 0);
    } else if (mode === 'weekend') return nextWeekday(now, 6);
    else if (mode === 'next-week') {
      next.setDate(now.getDate() + 7);
      next.setHours(9, 0, 0, 0);
    }
    return next;
  }


  async function setTodoStatus(id, status) {
    if (!getAppInitialized() || !getDb()) return;
    const todo = getTodos().find(x => String(x.id) === String(id));
    if (!todo || todo.status === status) return;
    const updatedTodo = { ...todo, status, updated_at: new Date().toISOString() };
    await dbPut('todos', updatedTodo);
    setTodos(getTodos().map(item => String(item.id) === String(id) ? updatedTodo : item));
    renderStats();
    renderTodos();
    runHapticFeedback(status === 'done' ? 18 : 10);
    if (status === 'done') showToast(t('todo.toast.done'), { type: 'status', id: todo.id, previousStatus: todo.status });
    else if (todo.status === 'done' && status === 'pending') showToast(t('todo.toast.reopened'), { type: 'status', id: todo.id, previousStatus: todo.status });
    await addToSyncQueue('UPDATE_TODO', { id: todo.id, changes: { status } });
    if (isOnlineForSync()) await syncWithServer();
  }

  async function markTodoDone(id) {
    await setTodoStatus(id, 'done');
  }

  async function markTodoInProgress(id) {
    await setTodoStatus(id, 'in_progress');
  }

  async function toggleTodoStatus(id, status) {
    const todo = getTodos().find(x => String(x.id) === String(id));
    if (!todo) return;
    await setTodoStatus(todo.id, todo.status === status ? 'pending' : status);
  }

  function bindTodoSwipeGestures() {
    if (document.documentElement.dataset.todoSwipeBound === '1') return;
    document.documentElement.dataset.todoSwipeBound = '1';

    const thresholdPx = 80;
    const thresholdRatio = 0.35;
    const lockThreshold = 10;
    const leftEdgeSwipeDeadzonePx = 72;
    let active = null;
    let suppressClickUntil = 0;

    document.addEventListener('click', (event) => {
      if (Date.now() > suppressClickUntil) return;
      if (!event.target?.closest?.('.todo-item')) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    }, true);

    document.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || (event.pointerType && event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
      const item = event.target?.closest?.('.todo-item');
      if (!item || event.target.closest('button, input, select, textarea, a, .todo-check, .todo-actions')) return;
      active = {
        item,
        id: item.dataset.id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        dx: 0,
        dy: 0,
        locked: null,
        swiped: false,
        originalDraggable: item.getAttribute('draggable'),
      };
    }, { passive: true });

    document.addEventListener('pointermove', (event) => {
      if (!active || event.pointerId !== active.pointerId) return;
      active.dx = event.clientX - active.startX;
      active.dy = event.clientY - active.startY;

      if (!active.locked) {
        const absX = Math.abs(active.dx);
        const absY = Math.abs(active.dy);
        if (absX < lockThreshold && absY < lockThreshold) return;
        const isRightSwipeFromLeftEdge = active.dx > 0 && active.startX < leftEdgeSwipeDeadzonePx;
        active.locked = absX > absY * 1.25 && !isRightSwipeFromLeftEdge ? 'horizontal' : 'vertical';
        if (active.locked === 'vertical') return;
        active.item.setAttribute('draggable', 'false');
        active.item.classList.add('swiping');
      }

      if (active.locked !== 'horizontal') return;
      event.preventDefault();
      const max = Math.min(130, active.item.clientWidth * 0.45);
      const dx = Math.max(-max, Math.min(max, active.dx));
      active.item.style.setProperty('--swipe-x', `${dx}px`);
      active.item.classList.toggle('swipe-right', dx > 0);
      active.item.classList.toggle('swipe-left', dx < 0);
      active.swiped = Math.abs(dx) > lockThreshold;
    }, { passive: false });

    const finish = async (event) => {
      if (!active || event.pointerId !== active.pointerId) return;
      const current = active;
      active = null;
      const item = current.item;
      const actionThreshold = Math.max(thresholdPx, item.clientWidth * thresholdRatio);
      const shouldAct = current.locked === 'horizontal' && Math.abs(current.dx) >= actionThreshold;
      item.classList.remove('swiping', 'swipe-right', 'swipe-left');
      item.style.removeProperty('--swipe-x');
      if (current.originalDraggable === null) item.removeAttribute('draggable');
      else item.setAttribute('draggable', current.originalDraggable);

      if (current.swiped || shouldAct) suppressClickUntil = Date.now() + 450;
      if (!shouldAct) return;
      event.preventDefault();
      if (current.dx < 0) await toggleTodoStatus(current.id, 'done');
      else await toggleTodoStatus(current.id, 'in_progress');
    };

    document.addEventListener('pointerup', finish, { passive: false });
    document.addEventListener('pointercancel', finish, { passive: false });
  }

  function isInteractiveTarget(element) {
    const tag = element?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A' || element?.isContentEditable;
  }

  function closeTodoActionMenus(except = null) {
    document.querySelectorAll('.todo-status-menu[open], .todo-snooze-menu[open]').forEach((menu) => {
      if (menu !== except) menu.removeAttribute('open');
    });
  }

  function bindTodoStatusMenuBehavior() {
    if (document.documentElement.dataset.todoStatusMenuBound === '1') return;
    document.documentElement.dataset.todoStatusMenuBound = '1';

    document.addEventListener('click', (event) => {
      const menu = event.target?.closest?.('.todo-status-menu, .todo-snooze-menu');
      closeTodoActionMenus(menu || null);
    });

    document.addEventListener('toggle', (event) => {
      const menu = event.target?.closest?.('.todo-status-menu, .todo-snooze-menu');
      if (menu?.open) closeTodoActionMenus(menu);
    }, true);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeTodoActionMenus();
    });
  }

  function bindTodoHoverKeyboardShortcuts() {
    if (document.documentElement.dataset.todoHoverKeyboardBound === '1') return;
    document.documentElement.dataset.todoHoverKeyboardBound = '1';
    let hoveredTodoId = null;

    document.addEventListener('pointerover', (event) => {
      const item = event.target?.closest?.('.todo-item[data-id]');
      if (item) hoveredTodoId = item.dataset.id;
    }, { passive: true });

    document.addEventListener('pointerout', (event) => {
      const item = event.target?.closest?.('.todo-item[data-id]');
      if (!item || item.contains(event.relatedTarget)) return;
      if (hoveredTodoId === item.dataset.id) hoveredTodoId = null;
    }, { passive: true });

    document.addEventListener('keydown', async (event) => {
      if (event.key !== ' ' && event.key !== 'Spacebar') return;
      if (!hoveredTodoId || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isInteractiveTarget(document.activeElement)) return;
      if (document.querySelector('.modal.active')) return;
      const item = Array.from(document.querySelectorAll('.todo-item[data-id]')).find(el => el.dataset.id === String(hoveredTodoId));
      if (!item) return;
      event.preventDefault();
      await toggleTodo(hoveredTodoId);
    });
  }

  bindTodoSwipeGestures();
  bindTodoStatusMenuBehavior();
  bindTodoHoverKeyboardShortcuts();

  async function toggleTodo(id) {
    if (!getAppInitialized() || !getDb()) return;
    const todo = getTodos().find(x => String(x.id) === String(id));
    if (!todo) return;
    const cycle = { pending: 'in_progress', in_progress: 'done', done: 'pending' };
    await setTodoStatus(todo.id, cycle[todo.status] || 'pending');
  }

  function focusTodoTitle() {
    const focus = () => document.getElementById('todo-title')?.focus();
    window.requestAnimationFrame?.(focus);
    window.setTimeout(focus, 80);
  }

  async function showTodoModal(todo = null) {
    bindTodoForm();
    bindDateTimeValidation();
    document.getElementById('todo-form')?.reset();
    clearDateTimeErrors();
    document.getElementById('todo-id').value = '';
    const modalTitle = document.getElementById('todo-modal-title');
    if (modalTitle) {
      modalTitle.dataset.i18nKey = todo ? 'todo.edit' : 'todo.new';
      modalTitle.textContent = t(modalTitle.dataset.i18nKey);
    }
    const projSelect = document.getElementById('todo-project');
    if (projSelect) {
      projSelect.innerHTML = '';
      const currentWorkspaceId = getCurrentWorkspaceId?.();
      const projects = getProjects().filter(p => !currentWorkspaceId || String(p.workspace_id || '') === String(currentWorkspaceId));
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
      document.getElementById('todo-pinned').checked = Boolean(todo.is_pinned);
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
      document.getElementById('todo-pinned').checked = false;
      const currentWorkspaceId = getCurrentWorkspaceId?.();
      const workspaceProjects = getProjects().filter(p => !p.is_shared && (!currentWorkspaceId || String(p.workspace_id || '') === String(currentWorkspaceId)));
      const inboxProject = workspaceProjects.find(p => p.is_inbox) || workspaceProjects[0];
      document.getElementById('todo-project').value = getCurrentProjectId() || inboxProject?.id || '';
      await onProjectChange(null);
    }

    document.getElementById('todo-delete-btn').style.display = todo ? '' : 'none';
    setupDescPreview();
    document.getElementById('todo-modal')?.classList.add('active');
    if (!todo) focusTodoTitle();
  }

  async function onProjectChange(selectedSectionId = null) {
    const projectId = document.getElementById('todo-project').value;
    const sectionSelect = document.getElementById('todo-section');
    if (!sectionSelect) return;
    sectionSelect.innerHTML = `<option value="" data-i18n-key="todo.section.none">${t('todo.section.none')}</option>`;
    sectionSelect.disabled = true;
    if (!projectId) return;

    const loadLocalSections = async () => {
      const allSections = await dbGetAll('sections');
      return allSections.filter(s => String(s.project_id) === String(projectId));
    };

    try {
      let projectSections;
      if (isOnlineForSync()) {
        try {
          const data = await sectionsApi.listByProject(projectId);
          projectSections = data.sections || [];
          const serverIds = new Set(projectSections.map(s => String(s.id)));
          const allLocal = await dbGetAll('sections');
          const localProjectSections = allLocal.filter(s => String(s.project_id) === String(projectId));
          for (const local of localProjectSections) {
            if (!serverIds.has(String(local.id))) await deleteFromDB('sections', local.id);
          }
          for (const s of projectSections) await dbPut('sections', s);
        } catch (serverError) {
          console.warn('Failed to load sections from server, using local cache', serverError);
          projectSections = await loadLocalSections();
        }
      } else {
        projectSections = await loadLocalSections();
      }
      translatePage(sectionSelect);
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
    const parsedQuickAdd = id ? null : parseQuickAddTitle(document.getElementById('todo-title').value, getCurrentProjectId());
    const todoData = {
      title: parsedQuickAdd?.title || document.getElementById('todo-title').value,
      description: document.getElementById('todo-desc').value,
      priority: parseInt(document.getElementById('todo-priority').value),
      is_pinned: document.getElementById('todo-pinned')?.checked || false,
      project_id: document.getElementById('todo-project').value ? parseInt(document.getElementById('todo-project').value) : null,
      section_id: document.getElementById('todo-section').value ? parseInt(document.getElementById('todo-section').value) : null,
      status: document.getElementById('todo-status').value,
      due_date: toIsoOrNull('todo-due'),
      remind_at: toIsoOrNull('todo-remind'),
    };
    if (parsedQuickAdd) {
      if (parsedQuickAdd.changes.priority && Number(document.getElementById('todo-priority').value) === 3) todoData.priority = parsedQuickAdd.changes.priority;
      if (parsedQuickAdd.changes.project_id && !getCurrentProjectId()) todoData.project_id = parsedQuickAdd.changes.project_id;
      if (parsedQuickAdd.changes.due_date && !todoData.due_date) todoData.due_date = parsedQuickAdd.changes.due_date;
    }
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

  async function updateTodoFields(id, changes, toastMessage = null) {
    if (!getAppInitialized() || !getDb()) return;
    const todo = getTodos().find(x => String(x.id) === String(id));
    if (!todo) return;
    const updatedTodo = { ...todo, ...changes, updated_at: new Date().toISOString() };
    await dbPut('todos', updatedTodo);
    setTodos(getTodos().map(item => String(item.id) === String(id) ? updatedTodo : item));
    renderStats();
    renderTodos();
    if (toastMessage) showToast(toastMessage);
    await addToSyncQueue('UPDATE_TODO', { id: todo.id, changes });
    if (isOnlineForSync()) await syncWithServer();
  }

  async function toggleTodoPin(id) {
    const todo = getTodos().find(x => String(x.id) === String(id));
    if (!todo) return;
    await updateTodoFields(id, { is_pinned: !Boolean(todo.is_pinned) }, Boolean(todo.is_pinned) ? t('todo.toast.unpinned') : t('todo.toast.pinned'));
  }

  async function snoozeTodo(id, mode) {
    const todo = getTodos().find(x => String(x.id) === String(id));
    if (!todo) return;
    const due = getSnoozeDate(mode, todo);
    await updateTodoFields(id, { due_date: due.toISOString() }, t('todo.toast.snoozed'));
  }

  function editTodo(id) {
    const todo = getTodos().find(t => String(t.id) === String(id));
    if (todo) showTodoModal(todo);
  }

  function deleteTodoFromModal() {
    const id = document.getElementById('todo-id').value;
    if (id) deleteTodo(parseInt(id));
  }

  async function deleteTodo(id) {
    const confirmed = await confirmDanger({
      title: t('todo.deleteTitle'),
      message: t('todo.deleteMessage'),
      confirmText: t('todo.deleteConfirm'),
    });
    if (!confirmed) return;
    const todo = getTodos().find(t => t.id === id);
    if (!todo) return;
    await deleteFromDB('todos', id);
    setTodos(getTodos().filter(t => t.id !== id));
    renderStats();
    renderTodos();
    closeModal('todo-modal');
    showToast(t('todo.toast.deleted'), { type: 'delete', id, data: { ...todo } });
    await addToSyncQueue('DELETE_TODO', { id });
    if (isOnlineForSync()) await syncWithServer();
  }

  return { markTodoDone, markTodoInProgress, setTodoStatus, toggleTodo, toggleTodoPin, snoozeTodo, showTodoModal, onProjectChange, saveTodo, editTodo, deleteTodoFromModal, deleteTodo };
}
