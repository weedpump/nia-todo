const MAX_MULTI_TODOS = 50;

function stripListPrefix(value) {
  return String(value || '').replace(/^\s*(?:(?:[-*•])\s+|(?:\d+[.)])\s+)/u, '').trim();
}

export function syncMultiAddNativeValidation(multi) {
  const titleInput = document.getElementById('todo-title');
  if (titleInput) titleInput.required = !multi;
}

export function getMultiTodoValidationKey(todoData) {
  return todoData?.recurring_rule && !todoData?.due_date
    ? 'todo.multiAdd.recurringNeedsDue'
    : null;
}

export function splitMultiTodoPaste(text, availableRows) {
  const values = String(text || '').split(/\r?\n/).map(stripListPrefix).filter(Boolean);
  const limit = Math.max(0, Number(availableRows) || 0);
  return {
    values: values.slice(0, limit),
    omittedCount: Math.max(0, values.length - limit),
  };
}

export function getMultiTodoRowA11y(rowId, number, translate) {
  return {
    inputId: `todo-multi-add-input-${rowId}`,
    previewId: `todo-multi-add-preview-${rowId}`,
    messageId: `todo-multi-add-message-${rowId}`,
    inputLabel: translate('todo.multiAdd.rowLabel', { number }),
    removeLabel: translate('todo.multiAdd.removeRow', { number }),
  };
}

export function shouldOpenCreateTodoMetaDrawer(mediaQueryList) {
  return !mediaQueryList?.matches;
}

export function createTodoMultiAddFeature({
  t,
  getTodos,
  setTodos,
  getCurrentProjectId,
  getAppInitialized,
  getDb,
  dbPut,
  addToSyncQueue,
  runSyncQueueMutation,
  isOnlineForSync,
  syncWithServer,
  parseQuickAddTitle,
  loadSectionsForQuickAdd,
  hydrateSelect,
  refreshSelect,
  renderProjects,
  renderStats,
  renderTodos,
  closeModal,
  showToast,
}) {
  const commitQueuedMutation = runSyncQueueMutation || (operation => operation(addToSyncQueue));
  let bound = false;
  let rowSequence = 0;
  let parseSequence = 0;
  let saveInFlight = null;
  let lifecycleGeneration = 0;

  const modal = () => document.getElementById('todo-modal');
  const panel = () => document.getElementById('todo-multi-add-panel');
  const rowsContainer = () => document.getElementById('todo-multi-add-rows');
  const saveButton = () => document.getElementById('todo-save-btn');
  const titleElement = () => document.getElementById('todo-modal-title');
  const subtitleElement = () => document.getElementById('todo-modal-subtitle');

  function isActive() {
    return Boolean(modal()?.classList.contains('todo-multi-add-mode'));
  }

  function rowElements() {
    return Array.from(rowsContainer()?.querySelectorAll('.todo-multi-add-row') || []);
  }

  function inputForRow(row) {
    return row?.querySelector('.todo-multi-add-input') || null;
  }

  function refreshRowAccessibility() {
    rowElements().forEach((row, index) => {
      const input = inputForRow(row);
      const preview = row.querySelector('.todo-multi-add-preview');
      const message = row.querySelector('.todo-multi-add-row-message');
      const remove = row.querySelector('.todo-multi-add-remove');
      const metadata = getMultiTodoRowA11y(row.dataset.rowId, index + 1, t);
      if (input) {
        input.id = metadata.inputId;
        input.setAttribute('aria-label', metadata.inputLabel);
        input.setAttribute('aria-describedby', `${metadata.previewId} ${metadata.messageId}`);
        if (!input.hasAttribute('aria-invalid')) input.setAttribute('aria-invalid', 'false');
      }
      if (preview) preview.id = metadata.previewId;
      if (message) message.id = metadata.messageId;
      if (remove) {
        remove.setAttribute('aria-label', metadata.removeLabel);
        remove.setAttribute('title', metadata.removeLabel);
      }
    });
  }

  function normalizedRows() {
    return rowElements().map((row) => ({
      row,
      input: inputForRow(row),
      raw: stripListPrefix(inputForRow(row)?.value || ''),
    }));
  }

  function syncProjectOptions() {
    const source = document.getElementById('todo-project');
    const target = document.getElementById('todo-multi-project');
    if (!source || !target) return;
    const selected = target.value || source.value || String(getCurrentProjectId?.() || '');
    target.innerHTML = source.innerHTML;
    target.value = selected;
    hydrateSelect(target, {
      className: 'project-ui-select todo-multi-ui-select',
      menuClassName: 'project-ui-select-menu todo-multi-ui-select-menu',
      searchPlaceholder: t('focus.projects.search'),
      searchLabel: t('focus.projects.search'),
      emptyText: t('focus.projects.noMatches'),
    });
    refreshSelect(target);
  }

  async function syncSectionOptions() {
    const projectId = document.getElementById('todo-multi-project')?.value || '';
    const select = document.getElementById('todo-multi-section');
    if (!select) return;
    const previous = select.value;
    select.innerHTML = `<option value="">${t('todo.section.none')}</option>`;
    const sections = await loadSectionsForQuickAdd();
    sections
      .filter(section => String(section.project_id) === String(projectId))
      .forEach((section) => {
        const option = document.createElement('option');
        option.value = String(section.id);
        option.textContent = section.name;
        select.appendChild(option);
      });
    select.disabled = !projectId;
    if (previous && Array.from(select.options).some(option => option.value === previous)) select.value = previous;
    hydrateSelect(select, { className: 'todo-multi-ui-select', menuClassName: 'todo-multi-ui-select-menu' });
    refreshSelect(select);
  }

  function createRow(value = '', { focus = false, after = null } = {}) {
    const container = rowsContainer();
    if (!container || rowElements().length >= MAX_MULTI_TODOS) return null;
    const row = document.createElement('div');
    row.className = 'todo-multi-add-row';
    row.dataset.rowId = String(++rowSequence);
    row.innerHTML = `
      <span class="todo-multi-add-bullet" aria-hidden="true"></span>
      <div class="todo-multi-add-field">
        <input class="ui-field todo-multi-add-input" type="text" maxlength="620" autocomplete="off" aria-invalid="false">
        <div class="todo-multi-add-preview" aria-live="polite"></div>
        <div class="todo-multi-add-row-message" aria-live="polite"></div>
      </div>
      <button type="button" class="todo-multi-add-remove">×</button>
    `;
    const input = inputForRow(row);
    input.value = stripListPrefix(value);
    if (after?.parentElement === container) after.after(row);
    else container.appendChild(row);
    refreshRowAccessibility();
    window.hydrateIcons?.(row);
    scheduleRowParse(row);
    updateState();
    if (focus) window.requestAnimationFrame(() => input.focus());
    return row;
  }

  function removeRow(row) {
    const rows = rowElements();
    if (rows.length === 1) {
      const input = inputForRow(row);
      if (input) input.value = '';
      scheduleRowParse(row);
      input?.focus();
      return;
    }
    const index = rows.indexOf(row);
    const nextFocus = inputForRow(rows[index - 1] || rows[index + 1]);
    row.remove();
    refreshRowAccessibility();
    nextFocus?.focus();
    updateState();
  }

  function reserveRowParse(row) {
    const sequence = ++parseSequence;
    row.dataset.parseSequence = String(sequence);
    return sequence;
  }

  async function parseRow(row, reservedSequence = null) {
    const input = inputForRow(row);
    const preview = row.querySelector('.todo-multi-add-preview');
    const message = row.querySelector('.todo-multi-add-row-message');
    if (!input || !preview || !message) return false;
    if (reservedSequence === null) {
      window.clearTimeout(row._multiParseTimer);
      row._multiParseTimer = null;
    }
    const sequence = reservedSequence ?? reserveRowParse(row);
    if (row.dataset.parseSequence !== String(sequence)) return false;
    const raw = stripListPrefix(input.value);
    if (!raw) {
      message.textContent = '';
      row.classList.remove('is-invalid');
      input.setAttribute('aria-invalid', 'false');
      preview.replaceChildren();
      row._multiParsed = null;
      updateState();
      return true;
    }
    if (raw.length > 500) {
      message.textContent = '';
      row.classList.remove('is-invalid');
      input.setAttribute('aria-invalid', 'false');
      preview.replaceChildren();
      row._multiParsed = null;
      row.classList.add('is-invalid');
      input.setAttribute('aria-invalid', 'true');
      message.textContent = t('todo.multiAdd.tooLong', { count: raw.length - 500 });
      updateState();
      return true;
    }
    const projectId = document.getElementById('todo-multi-project')?.value || null;
    const result = await parseQuickAddTitle(raw, getCurrentProjectId(), projectId);
    if (row.dataset.parseSequence !== String(sequence) || stripListPrefix(input.value) !== raw) return false;
    message.textContent = '';
    row.classList.remove('is-invalid');
    input.setAttribute('aria-invalid', 'false');
    row._multiParsed = result;
    const previewContent = document.createDocumentFragment();
    const validationKey = getMultiTodoValidationKey(result.changes || {});
    if (validationKey) {
      row.classList.add('is-invalid');
      input.setAttribute('aria-invalid', 'true');
      message.textContent = t(validationKey);
    }
    for (const match of result.matches || []) {
      const chip = document.createElement('span');
      chip.className = `quick-add-chip ${match.type}`;
      const label = document.createElement('span');
      label.className = 'quick-add-chip-label';
      label.textContent = match.label;
      const value = document.createElement('strong');
      value.textContent = match.value || match.token || '';
      chip.append(label, value);
      previewContent.appendChild(chip);
    }
    preview.replaceChildren(previewContent);
    updateState();
    return true;
  }

  function scheduleRowParse(row) {
    window.clearTimeout(row._multiParseTimer);
    const sequence = reserveRowParse(row);
    row._multiParseTimer = window.setTimeout(() => {
      row._multiParseTimer = null;
      void parseRow(row, sequence);
    }, 90);
  }

  function updateState() {
    const rows = normalizedRows();
    const nonEmpty = rows.filter(item => item.raw);
    const duplicateCounts = new Map();
    nonEmpty.forEach(item => {
      const key = item.raw.toLocaleLowerCase();
      duplicateCounts.set(key, (duplicateCounts.get(key) || 0) + 1);
    });
    rows.forEach(({ row, raw }) => {
      const duplicate = raw && duplicateCounts.get(raw.toLocaleLowerCase()) > 1;
      row.classList.toggle('is-duplicate', Boolean(duplicate));
      if (duplicate && !row.classList.contains('is-invalid')) {
        row.querySelector('.todo-multi-add-row-message').textContent = t('todo.multiAdd.duplicate');
      } else if (!duplicate && !row.classList.contains('is-invalid')) {
        row.querySelector('.todo-multi-add-row-message').textContent = '';
      }
    });
    const count = nonEmpty.length;
    const overLimit = count > MAX_MULTI_TODOS;
    const hasKnownInvalidRow = nonEmpty.some(({ row }) => (
      row.classList.contains('is-invalid')
      || (row._multiParsed && !row._multiParsed.title?.trim())
    ));
    const countElement = document.getElementById('todo-multi-add-count');
    if (countElement) countElement.textContent = t(`todo.multiAdd.count.${count === 1 ? 'one' : 'many'}`, { count });
    const limitElement = document.getElementById('todo-multi-add-limit');
    const remaining = MAX_MULTI_TODOS - nonEmpty.length;
    if (limitElement) {
      limitElement.textContent = overLimit
        ? t('todo.multiAdd.limit', { max: MAX_MULTI_TODOS })
        : t(`todo.multiAdd.remaining.${remaining === 1 ? 'one' : 'many'}`, { count: remaining });
    }
    const save = saveButton();
    if (save && isActive()) {
      save.hidden = count === 0;
      save.disabled = count === 0 || overLimit || hasKnownInvalidRow;
      save.textContent = t(`todo.multiAdd.create.${count === 1 ? 'one' : 'many'}`, { count });
    }
    const more = document.getElementById('todo-multi-add-more');
    if (more) more.disabled = rowElements().length >= MAX_MULTI_TODOS;
  }

  function setMode(mode) {
    const multi = mode === 'multi';
    const root = modal();
    if (!root) return;
    root.classList.toggle('todo-multi-add-mode', multi);
    syncMultiAddNativeValidation(multi);
    if (multi) root.classList.remove('todo-meta-editing');
    else root.classList.toggle('todo-meta-editing', shouldOpenCreateTodoMetaDrawer(window.matchMedia?.('(max-width: 1180px)')));
    panel()?.toggleAttribute('hidden', !multi);
    document.querySelectorAll('[data-todo-create-mode]').forEach(button => {
      const active = button.dataset.todoCreateMode === (multi ? 'multi' : 'single');
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const title = titleElement();
    const subtitle = subtitleElement();
    if (title) title.textContent = multi ? t('todo.multiAdd.title') : t('todo.new');
    if (subtitle) subtitle.textContent = multi ? t('todo.multiAdd.subtitle') : t('todo.modal.subtitle');
    if (multi) {
      syncProjectOptions();
      void syncSectionOptions();
      const priority = document.getElementById('todo-multi-priority');
      if (priority) {
        hydrateSelect(priority, { className: 'todo-multi-ui-select', menuClassName: 'todo-multi-ui-select-menu' });
        refreshSelect(priority);
      }
      if (!rowElements().length) createRow('', { focus: true });
      else inputForRow(rowElements()[0])?.focus();
    } else {
      const save = saveButton();
      if (save) {
        save.disabled = false;
        save.textContent = t('common.save');
      }
      const titleInput = document.getElementById('todo-title');
      titleInput?.dispatchEvent(new Event('input', { bubbles: true }));
      titleInput?.focus();
    }
    updateState();
  }

  function reset({ editing = false } = {}) {
    invalidateSaveLifecycle();
    const switcher = document.getElementById('todo-create-mode-switch');
    if (switcher) switcher.hidden = editing;
    modal()?.classList.remove('todo-multi-add-mode');
    syncMultiAddNativeValidation(false);
    panel()?.setAttribute('hidden', '');
    const container = rowsContainer();
    if (container) container.innerHTML = '';
    if (!editing) createRow('');
    document.querySelectorAll('[data-todo-create-mode]').forEach(button => {
      const active = button.dataset.todoCreateMode === 'single';
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const save = saveButton();
    if (save) {
      save.disabled = false;
      save.textContent = t('common.save');
    }
  }

  function handlePaste(event, row) {
    const text = event.clipboardData?.getData('text/plain') || '';
    if (!/[\r\n]/.test(text)) return;
    event.preventDefault();
    const availableRows = MAX_MULTI_TODOS - rowElements().length + 1;
    const { values, omittedCount } = splitMultiTodoPaste(text, availableRows);
    if (!values.length) return;
    const input = inputForRow(row);
    input.value = values[0];
    scheduleRowParse(row);
    let current = row;
    for (const value of values.slice(1)) {
      current = createRow(value, { after: current }) || current;
    }
    if (omittedCount) {
      showToast(t(`todo.multiAdd.pasteOmitted.${omittedCount === 1 ? 'one' : 'many'}`, {
        count: omittedCount,
        max: MAX_MULTI_TODOS,
      }));
    }
    inputForRow(current)?.focus();
    updateState();
  }

  function bind() {
    if (bound) return;
    bound = true;
    document.getElementById('todo-create-mode-switch')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-todo-create-mode]');
      if (button) setMode(button.dataset.todoCreateMode);
    });
    document.getElementById('todo-multi-add-more')?.addEventListener('click', () => createRow('', { focus: true }));
    document.getElementById('todo-multi-project')?.addEventListener('change', () => {
      void syncSectionOptions();
      rowElements().forEach(scheduleRowParse);
    });
    document.getElementById('todo-multi-section')?.addEventListener('change', updateState);
    document.getElementById('todo-multi-priority')?.addEventListener('change', updateState);
    rowsContainer()?.addEventListener('input', (event) => {
      const input = event.target.closest('.todo-multi-add-input');
      if (!input) return;
      scheduleRowParse(input.closest('.todo-multi-add-row'));
      updateState();
    });
    rowsContainer()?.addEventListener('paste', (event) => {
      const row = event.target.closest('.todo-multi-add-row');
      if (row) handlePaste(event, row);
    });
    rowsContainer()?.addEventListener('click', (event) => {
      const remove = event.target.closest('.todo-multi-add-remove');
      if (remove) removeRow(remove.closest('.todo-multi-add-row'));
    });
    rowsContainer()?.addEventListener('keydown', (event) => {
      const input = event.target.closest('.todo-multi-add-input');
      if (!input) return;
      const row = input.closest('.todo-multi-add-row');
      if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        createRow('', { focus: true, after: row });
      } else if (event.key === 'Backspace' && !input.value) {
        event.preventDefault();
        removeRow(row);
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        document.getElementById('todo-form')?.requestSubmit();
      }
    });
    window.addEventListener('nia-language-change', () => {
      refreshRowAccessibility();
      if (isActive()) {
        const title = titleElement();
        const subtitle = subtitleElement();
        if (title) title.textContent = t('todo.multiAdd.title');
        if (subtitle) subtitle.textContent = t('todo.multiAdd.subtitle');
      }
      updateState();
    });
  }

  function isSaveLifecycleCurrent(generation) {
    return generation === lifecycleGeneration;
  }

  function captureSaveSnapshot(rows, generation) {
    return {
      generation,
      rows: rows.map(({ row, raw }) => ({
        row,
        raw,
        parseSequence: row.dataset.parseSequence || '',
      })),
      projectId: document.getElementById('todo-multi-project')?.value || '',
      sectionId: document.getElementById('todo-multi-section')?.value || '',
      priority: document.getElementById('todo-multi-priority')?.value || '3',
    };
  }

  function isSaveSnapshotCurrent(snapshot) {
    const currentRows = normalizedRows().filter(item => item.raw);
    return isSaveLifecycleCurrent(snapshot.generation)
      && currentRows.length === snapshot.rows.length
      && currentRows.every(({ row, raw }, index) => {
        const saved = snapshot.rows[index];
        return row === saved.row
          && raw === saved.raw
          && (row.dataset.parseSequence || '') === saved.parseSequence;
      })
      && (document.getElementById('todo-multi-project')?.value || '') === snapshot.projectId
      && (document.getElementById('todo-multi-section')?.value || '') === snapshot.sectionId
      && (document.getElementById('todo-multi-priority')?.value || '3') === snapshot.priority;
  }

  function setSaveInProgress(active) {
    panel()?.toggleAttribute('inert', active);
    modal()?.toggleAttribute('aria-busy', active);
    document.querySelectorAll('[data-todo-create-mode]').forEach(button => {
      button.disabled = active;
    });
    const save = saveButton();
    if (save && active) save.disabled = true;
  }

  function invalidateSaveLifecycle() {
    lifecycleGeneration += 1;
    saveInFlight = null;
    setSaveInProgress(false);
  }

  async function performSave(generation) {
    if (!isActive() || !isSaveLifecycleCurrent(generation) || !getAppInitialized() || !getDb()) return false;
    const rows = normalizedRows().filter(item => item.raw);
    if (!rows.length || rows.length > MAX_MULTI_TODOS) return true;
    const parseResults = await Promise.all(rows.map(({ row }) => parseRow(row)));
    if (parseResults.some(applied => !applied)) {
      updateState();
      return true;
    }
    if (!isSaveLifecycleCurrent(generation)) return true;
    if (rows.some(({ row }) => row.classList.contains('is-invalid') || !row._multiParsed?.title?.trim())) {
      updateState();
      return true;
    }
    const projectId = document.getElementById('todo-multi-project')?.value;
    const sectionId = document.getElementById('todo-multi-section')?.value;
    const priority = Number(document.getElementById('todo-multi-priority')?.value || 3);
    const saveSnapshot = captureSaveSnapshot(rows, generation);
    const sections = await loadSectionsForQuickAdd();
    if (!isSaveSnapshotCurrent(saveSnapshot)) {
      updateState();
      return true;
    }
    const prepared = [];
    let hasValidationError = false;
    for (const { row } of rows) {
      const parsed = row._multiParsed;
      const todoData = {
        title: parsed.title,
        description: '',
        priority,
        is_pinned: false,
        project_id: projectId ? Number(projectId) : null,
        section_id: sectionId ? Number(sectionId) : null,
        status: 'pending',
        subtasks: [],
        due_date: null,
        remind_at: null,
        recurring_rule: null,
        location_reminder: null,
        location_reminders: [],
      };
      if (parsed.changes.priority) todoData.priority = parsed.changes.priority;
      if (parsed.changes.project_id) todoData.project_id = parsed.changes.project_id;
      if (parsed.changes.section_id) todoData.section_id = parsed.changes.section_id;
      if (parsed.changes.due_date) todoData.due_date = parsed.changes.due_date;
      if (parsed.changes.remind_at) todoData.remind_at = parsed.changes.remind_at;
      if (parsed.changes.recurring_rule) todoData.recurring_rule = parsed.changes.recurring_rule;
      if (parsed.changes.location_reminder) todoData.location_reminder = parsed.changes.location_reminder;
      if (todoData.section_id && todoData.project_id) {
        const selectedSection = sections.find(section => String(section.id) === String(todoData.section_id));
        if (!selectedSection || String(selectedSection.project_id) !== String(todoData.project_id)) todoData.section_id = null;
      }
      todoData.location_reminders = todoData.location_reminder ? [todoData.location_reminder] : [];
      const validationKey = getMultiTodoValidationKey(todoData);
      if (validationKey) {
        row.classList.add('is-invalid');
        inputForRow(row)?.setAttribute('aria-invalid', 'true');
        row.querySelector('.todo-multi-add-row-message').textContent = t(validationKey);
        hasValidationError = true;
      }
      prepared.push({ row, todoData });
    }
    if (hasValidationError) {
      updateState();
      return true;
    }
    if (!isSaveSnapshotCurrent(saveSnapshot)) {
      updateState();
      return true;
    }
    const now = Date.now();
    const created = [];
    let commitAborted = false;
    await commitQueuedMutation(async enqueue => {
      if (!isSaveSnapshotCurrent(saveSnapshot)) {
        commitAborted = true;
        return;
      }
      for (const [index, { todoData }] of prepared.entries()) {
        const tempId = `temp-${now}-${index}`;
        const nowIso = new Date(now + index).toISOString();
        const newTodo = { id: tempId, ...todoData, completed_at: null, created_at: nowIso, updated_at: nowIso, reminders: [], subtasks: [] };
        await dbPut('todos', newTodo);
        await enqueue('CREATE_TODO', { ...todoData, _tempId: tempId });
        created.push(newTodo);
      }
      setTodos([...getTodos(), ...created]);
    });
    if (commitAborted) {
      updateState();
      return true;
    }
    renderProjects();
    renderStats();
    renderTodos();
    closeModal('todo-modal');
    showToast(t(`todo.multiAdd.created.${created.length === 1 ? 'one' : 'many'}`, { count: created.length }));
    if (isOnlineForSync()) {
      await syncWithServer();
      renderProjects();
      renderStats();
      renderTodos();
    }
    return true;
  }

  function save() {
    if (saveInFlight) return saveInFlight;
    const generation = lifecycleGeneration;
    setSaveInProgress(true);
    const currentSave = performSave(generation).finally(() => {
      if (saveInFlight !== currentSave) return;
      saveInFlight = null;
      setSaveInProgress(false);
      if (isActive()) updateState();
    });
    saveInFlight = currentSave;
    return currentSave;
  }

  return { bind, reset, isActive, save };
}
