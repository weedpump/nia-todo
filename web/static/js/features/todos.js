import { RUNTIME_CAPABILITIES } from '../core/config.js';
import { getActiveLanguage, t, translatePage } from '../i18n/index.js';
import { iconSvg } from '../icons/lucide-icons.js';
import { hydrateSelect, refreshSelect } from '../ui/dropdowns.js';
import { createNativeBridge } from './native-bridge.js';

export function createTodosFeature({
  getTodos,
  setTodos,
  getProjects,
  getCurrentProjectId,
  getCurrentWorkspaceId,
  getCurrentUser,
  setCurrentUser,
  getAppInitialized,
  getDb,
  dbPut,
  dbGetAll,
  deleteFromDB,
  addToSyncQueue,
  isOnlineForSync,
  syncWithServer,
  todosApi,
  sectionsApi,
  placesApi,
  renderProjects,
  renderStats,
  renderTodos,
  closeModal,
  confirmDanger,
  showToast,
  setupDescPreview,
  renderMarkdown,
}) {
  const nativeBridge = createNativeBridge();
  let todoFormBound = false;
  let savedPlaces = [];
  let todoSaveSnapshot = null;
  let attachmentPreviewObjectUrl = '';
  let attachmentPreviewDownload = null;
  const deletingSubtaskIds = new Set();

  function escapeHtmlAttr(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function normalizeSubtasks(subtasks = []) {
    return (Array.isArray(subtasks) ? subtasks : [])
      .map((subtask, index) => ({
        id: subtask.id ?? null,
        title: String(subtask.title || '').trim(),
        is_done: Boolean(subtask.is_done),
        sort_order: Number.isFinite(Number(subtask.sort_order)) ? Number(subtask.sort_order) : index,
      }))
      .filter(subtask => subtask.title);
  }

  function getOpenSubtaskCount(todoOrSubtasks) {
    const subtasks = Array.isArray(todoOrSubtasks) ? todoOrSubtasks : todoOrSubtasks?.subtasks;
    return normalizeSubtasks(subtasks).filter(subtask => !subtask.is_done).length;
  }

  function setTodoCollapsibleOpen(panelId, shouldOpen) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.open = Boolean(shouldOpen);
  }

  function isMobileTodoModalLayout() {
    return Boolean(window.matchMedia?.('(max-width: 768px)')?.matches);
  }

  function updateTodoMetaPanelsOpenState(todo = null) {
    const existingTodo = Boolean(todo?.id);
    setTodoCollapsibleOpen('todo-subtasks-panel', existingTodo);
    setTodoCollapsibleOpen('todo-comments-panel', existingTodo);
    setTodoCollapsibleOpen('todo-attachments-panel', existingTodo);
    if (existingTodo) {
      setTodoCollapsibleOpen('todo-schedule-panel', true);
      setTodoCollapsibleOpen('todo-organize-panel', true);
      return;
    }
    setTodoCollapsibleOpen('todo-subtasks-panel', false);
    setTodoCollapsibleOpen('todo-comments-panel', false);
    setTodoCollapsibleOpen('todo-attachments-panel', false);
    setTodoCollapsibleOpen('todo-schedule-panel', false);
    setTodoCollapsibleOpen('todo-organize-panel', false);
  }

  function formatTodoMetaDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(getActiveLanguage() === 'de' ? 'de-DE' : 'en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }

  function getSelectedOptionLabel(id) {
    const select = document.getElementById(id);
    const option = select?.selectedOptions?.[0];
    return option?.textContent?.trim() || '';
  }

  function ensureTodoMetaSummary() {
    const titleGroup = document.getElementById('todo-title')?.closest('.form-group');
    if (!titleGroup) return null;
    let summary = document.getElementById('todo-meta-summary');
    if (!summary) {
      summary = document.createElement('div');
      summary.id = 'todo-meta-summary';
      summary.className = 'todo-meta-summary-view';
    }
    if (summary.previousElementSibling !== titleGroup) titleGroup.after(summary);
    return summary;
  }

  function ensureTodoMetaDrawer() {
    const form = document.getElementById('todo-form');
    const organize = document.getElementById('todo-organize-panel');
    const schedule = document.getElementById('todo-schedule-panel');
    if (!form || !organize || !schedule) return null;
    let drawer = document.getElementById('todo-meta-drawer');
    if (!drawer) {
      drawer = document.createElement('aside');
      drawer.id = 'todo-meta-drawer';
      drawer.className = 'todo-meta-edit-drawer';
      drawer.setAttribute('aria-label', getActiveLanguage() === 'de' ? 'Todo Details bearbeiten' : 'Edit todo details');
      form.appendChild(drawer);
    }
    if (organize.parentElement !== drawer) drawer.appendChild(organize);
    if (schedule.parentElement !== drawer) drawer.appendChild(schedule);
    return drawer;
  }

  function renderTodoMetaSummary(todo = null) {
    ensureTodoMetaDrawer();
    const summary = ensureTodoMetaSummary();
    if (!summary) return;
    if (!todo?.id) {
      summary.replaceChildren();
      summary.hidden = true;
      return;
    }
    summary.hidden = false;
    const lang = getActiveLanguage();
    const chips = [];
    const addChip = (icon, label, value, options = {}) => {
      if (!value) return;
      const tone = String(options.tone || icon || 'default').replace(/[^a-z0-9-]/gi, '').toLowerCase();
      const style = options.color ? ` style="--meta-tone: ${escapeHtmlAttr(options.color)}"` : '';
      chips.push(`<span class="todo-meta-summary-chip todo-meta-tone-${tone}${options.muted ? ' is-muted' : ''}"${style}>${iconSvg(icon)}<span class="todo-meta-summary-label">${escapeHtmlAttr(label)}</span><strong>${escapeHtmlAttr(value)}</strong></span>`);
    };
    const selectedProject = getProjects().find(project => String(project.id) === String(document.getElementById('todo-project')?.value || ''));
    const priority = Number(document.getElementById('todo-priority')?.value || todo.priority || 3);
    const status = document.getElementById('todo-status')?.value || todo.status || 'pending';
    const dueDate = todo.due_date ? new Date(todo.due_date) : null;
    const isOverdue = dueDate && status !== 'done' && dueDate < new Date();
    const isSoon = dueDate && !isOverdue && status !== 'done' && dueDate <= new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const priorityTone = { 1: 'priority-very-high', 2: 'priority-high', 3: 'priority-medium', 4: 'priority-low' }[priority] || 'priority-low';
    const statusTone = status === 'done' ? 'status-done' : status === 'in_progress' ? 'status-in-progress' : 'status-pending';
    const statusIcon = status === 'done' ? 'check-circle' : status === 'in_progress' ? 'flame' : 'clock';
    const dueTone = isOverdue ? 'due-overdue' : isSoon ? 'due-soon' : 'due-neutral';
    const projectIcon = /^[a-z0-9-]+$/i.test(String(selectedProject?.icon || '')) ? selectedProject.icon : 'folder';
    addChip(projectIcon, lang === 'de' ? 'Projekt' : 'Project', getSelectedOptionLabel('todo-project'), { tone: 'project', color: selectedProject?.color });
    addChip('layers', lang === 'de' ? 'Section' : 'Section', getSelectedOptionLabel('todo-section'), { tone: 'section' });
    addChip('flag', lang === 'de' ? 'Priorität' : 'Priority', getSelectedOptionLabel('todo-priority'), { tone: priorityTone });
    addChip(statusIcon, 'Status', getSelectedOptionLabel('todo-status'), { tone: statusTone });
    addChip(isOverdue ? 'triangle-alert' : 'calendar-days', lang === 'de' ? 'Deadline' : 'Deadline', formatTodoMetaDate(todo.due_date), { tone: dueTone });
    addChip('bell', lang === 'de' ? 'Erinnerung' : 'Reminder', formatTodoMetaDate(todo.remind_at || todo.reminders?.[0]?.remind_at), { tone: 'reminder' });
    const recurringRule = normalizeRecurringRule(todo.recurring_rule, { defaultTimezone: null });
    if (recurringRule && recurringRule.frequency !== 'none') addChip('repeat', lang === 'de' ? 'Wiederholung' : 'Repeat', getSelectedOptionLabel('todo-recurring-frequency'));
    if (todo.is_pinned) addChip('pin', lang === 'de' ? 'Angepinnt' : 'Pinned', lang === 'de' ? 'Ja' : 'Yes');
    const empty = lang === 'de' ? 'Keine Planung oder Einordnung gesetzt.' : 'No planning or organization set.';
    const edit = lang === 'de' ? 'Details bearbeiten' : 'Edit details';
    summary.innerHTML = `
      <div class="todo-meta-summary-chips">${chips.length ? chips.join('') : `<span class="todo-meta-summary-empty">${empty}</span>`}</div>
      <button type="button" class="todo-meta-edit-toggle" id="todo-meta-edit-toggle">${edit}</button>
    `;
    const toggle = summary.querySelector('#todo-meta-edit-toggle');
    const syncToggleLabel = () => {
      const active = document.getElementById('todo-modal')?.classList.contains('todo-meta-editing');
      toggle.textContent = active ? (lang === 'de' ? 'Details schließen' : 'Close details') : edit;
    };
    toggle?.addEventListener('click', () => {
      document.getElementById('todo-modal')?.classList.toggle('todo-meta-editing');
      syncToggleLabel();
    });
    syncToggleLabel();
    translatePage(summary);
  }

  function updateTodoDetailViewMode(todo = null) {
    const modal = document.getElementById('todo-modal');
    if (!modal) return;
    const isExistingTodo = Boolean(todo?.id);
    modal.classList.toggle('todo-detail-view', isExistingTodo);
    modal.classList.remove('todo-desc-editing');
    modal.classList.remove('todo-meta-editing');
    const preview = document.getElementById('todo-desc-preview');
    if (preview) preview.dataset.emptyLabel = getActiveLanguage() === 'de' ? 'Beschreibung hinzufügen…' : 'Add description…';
    renderTodoMetaSummary(todo);
  }

  function htmlNodeToMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    const children = () => Array.from(node.childNodes).map(htmlNodeToMarkdown).join('');
    if (tag === 'br') return '\n';
    if (tag === 'strong' || tag === 'b') return `**${children()}**`;
    if (tag === 'em' || tag === 'i') return `*${children()}*`;
    if (tag === 'code') return `\`${children()}\``;
    if (tag === 'h1') return `# ${children().trim()}\n\n`;
    if (tag === 'h2') return `## ${children().trim()}\n\n`;
    if (tag === 'h3') return `### ${children().trim()}\n\n`;
    if (tag === 'li') return `- ${children().trim()}\n`;
    if (tag === 'ul' || tag === 'ol') return `${children()}\n`;
    if (tag === 'p' || tag === 'div') return `${children().trim()}\n\n`;
    return children();
  }

  function richDescriptionToMarkdown(editor) {
    return Array.from(editor.childNodes)
      .map(htmlNodeToMarkdown)
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function ensureDescriptionRichEditor(textarea, preview) {
    let wrap = document.getElementById('todo-desc-rich-wrap');
    if (wrap) return wrap;
    wrap = document.createElement('div');
    wrap.id = 'todo-desc-rich-wrap';
    wrap.className = 'todo-desc-rich-wrap';
    wrap.innerHTML = `
      <div class="todo-desc-rich-toolbar" aria-label="Beschreibung formatieren">
        <button type="button" data-rich-command="bold"><strong>B</strong></button>
        <button type="button" data-rich-command="italic"><em>I</em></button>
        <button type="button" data-rich-block="h1">H1</button>
        <button type="button" data-rich-block="h2">H2</button>
        <button type="button" data-rich-command="insertUnorderedList">• Liste</button>
      </div>
      <div id="todo-desc-rich-editor" class="todo-desc-rich-editor" contenteditable="true" role="textbox" aria-multiline="true"></div>
    `;
    preview.after(wrap);
    const editor = wrap.querySelector('#todo-desc-rich-editor');
    const syncFromEditor = () => {
      textarea.value = richDescriptionToMarkdown(editor);
      preview.innerHTML = renderMarkdown(textarea.value);
      refreshTodoSaveButtonState();
    };
    editor.addEventListener('input', syncFromEditor);
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        document.getElementById('todo-modal')?.classList.remove('todo-desc-editing');
        return;
      }
      if (event.key === ' ') {
        window.setTimeout(() => {
          const selection = window.getSelection?.();
          const node = selection?.anchorNode;
          const block = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
          if (!block || !editor.contains(block)) return;
          if ((block.textContent || '').trim() !== '-') return;
          block.textContent = '';
          document.execCommand('insertUnorderedList', false, null);
          syncFromEditor();
        }, 0);
      }
    });
    wrap.querySelectorAll('button[data-rich-command], button[data-rich-block]').forEach(button => {
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => {
        editor.focus();
        if (button.dataset.richBlock) document.execCommand('formatBlock', false, button.dataset.richBlock);
        else document.execCommand(button.dataset.richCommand, false, null);
        syncFromEditor();
      });
    });
    return wrap;
  }

  function bindTodoDescriptionInlineEditor() {
    const modal = document.getElementById('todo-modal');
    const textarea = document.getElementById('todo-desc');
    const preview = document.getElementById('todo-desc-preview');
    if (!modal || !textarea || !preview || textarea.dataset.inlineEditorBound === '1') return;
    textarea.dataset.inlineEditorBound = '1';
    const wrap = ensureDescriptionRichEditor(textarea, preview);
    const editor = wrap.querySelector('#todo-desc-rich-editor');
    editor?.setAttribute('data-placeholder', getActiveLanguage() === 'de' ? 'Beschreibung schreiben…' : 'Write description…');
    const openEditor = () => {
      if (!modal.classList.contains('todo-detail-view')) return;
      editor.innerHTML = renderMarkdown(textarea.value || '');
      modal.classList.add('todo-desc-editing');
      window.requestAnimationFrame?.(() => editor.focus());
    };
    preview.addEventListener('click', openEditor);
    preview.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openEditor();
    });
  }

  function getTodoSaveRelevantState() {
    const id = document.getElementById('todo-id')?.value || '';
    const state = {
      title: document.getElementById('todo-title')?.value || '',
      description: document.getElementById('todo-desc')?.value || '',
      priority: Number(document.getElementById('todo-priority')?.value || 3),
      is_pinned: Boolean(document.getElementById('todo-pinned')?.checked),
      project_id: document.getElementById('todo-project')?.value || '',
      section_id: document.getElementById('todo-section')?.value || '',
      status: document.getElementById('todo-status')?.value || 'pending',
      due_date: document.getElementById('todo-due')?.value || '',
      remind_at: document.getElementById('todo-remind')?.value || '',
      recurring_frequency: document.getElementById('todo-recurring-frequency')?.value || 'none',
      recurring_interval: document.getElementById('todo-recurring-interval')?.value || '1',
      location_enabled: Boolean(document.getElementById('todo-location-enabled')?.checked),
      location_trigger: document.getElementById('todo-location-trigger')?.value || 'arrival',
      location_place: document.getElementById('todo-location-place')?.value || '',
      location_address: document.getElementById('todo-location-address')?.value || '',
    };
    if (!id) state.subtasks = collectTodoSubtasksFromEditor();
    return state;
  }

  function refreshTodoSaveButtonState() {
    const saveButton = document.getElementById('todo-save-btn');
    if (!saveButton) return;
    const current = JSON.stringify(getTodoSaveRelevantState());
    saveButton.disabled = todoSaveSnapshot !== null && current === todoSaveSnapshot;
  }

  function resetTodoSaveSnapshot() {
    todoSaveSnapshot = JSON.stringify(getTodoSaveRelevantState());
    refreshTodoSaveButtonState();
  }

  function updateSubtaskEditorCount() {
    const subtasks = collectTodoSubtasksFromEditor();
    const done = subtasks.filter(subtask => subtask.is_done).length;
    const count = document.getElementById('todo-subtasks-count');
    if (count) count.textContent = t('todo.subtasks.progress', { done, total: subtasks.length });
    refreshTodoSaveButtonState();
  }

  function collectTodoSubtasksFromEditor() {
    return Array.from(document.querySelectorAll('#todo-subtasks-list .todo-subtask-row')).map((row, index) => ({
      id: row.dataset.subtaskId && !row.dataset.subtaskId.startsWith('new-') ? Number(row.dataset.subtaskId) : null,
      title: row.querySelector('.todo-subtask-title-input')?.value?.trim() || '',
      is_done: Boolean(row.querySelector('.todo-subtask-check')?.checked),
      sort_order: index,
    })).filter(subtask => subtask.title);
  }

  async function applySubtaskTodoResponse(response) {
    const updatedTodo = response?.todo;
    if (!updatedTodo) return;
    await dbPut('todos', updatedTodo);
    setTodos(getTodos().map(todo => String(todo.id) === String(updatedTodo.id) ? updatedTodo : todo));
    renderTodoSubtaskEditor(updatedTodo.subtasks || []);
    renderStats();
    renderTodos();
  }

  async function createTodoSubtask(todoId, title, isDone = false) {
    if (!todoId || String(todoId).startsWith('temp-')) {
      showToast(t('todo.subtasks.saveFirst'));
      return false;
    }
    if (!isOnlineForSync()) {
      showToast(t('todo.subtasks.onlineOnly'));
      return false;
    }
    try {
      const response = await todosApi.createSubtask(todoId, { title, is_done: isDone });
      await applySubtaskTodoResponse(response);
      return true;
    } catch (error) {
      console.error('Failed to add todo subtask', error);
      showToast(t('todo.subtasks.saveFailed'));
      return false;
    }
  }

  async function updateTodoSubtask(todoId, subtaskId, changes) {
    if (!todoId || !subtaskId || !isOnlineForSync()) {
      showToast(t('todo.subtasks.onlineOnly'));
      return false;
    }
    try {
      const response = await todosApi.updateSubtask(todoId, subtaskId, changes);
      await applySubtaskTodoResponse(response);
      return true;
    } catch (error) {
      console.error('Failed to update todo subtask', error);
      showToast(t('todo.subtasks.saveFailed'));
      return false;
    }
  }

  async function deleteTodoSubtask(todoId, subtaskId) {
    if (!todoId || !subtaskId || !isOnlineForSync()) {
      showToast(t('todo.subtasks.onlineOnly'));
      return false;
    }
    try {
      const response = await todosApi.deleteSubtask(todoId, subtaskId);
      await applySubtaskTodoResponse(response);
      return true;
    } catch (error) {
      console.error('Failed to delete todo subtask', error);
      showToast(t('todo.subtasks.deleteFailed'));
      return false;
    }
  }

  function addTodoSubtaskRow(subtask = {}) {
    const list = document.getElementById('todo-subtasks-list');
    if (!list) return;
    const todoId = document.getElementById('todo-id')?.value || '';
    const row = document.createElement('div');
    row.className = 'todo-subtask-row';
    row.dataset.subtaskId = subtask.id ? String(subtask.id) : `new-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const checkboxLabel = document.createElement('label');
    checkboxLabel.className = 'ui-checkbox-label todo-subtask-check-label';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'todo-subtask-check';
    checkbox.checked = Boolean(subtask.is_done);
    checkbox.setAttribute('aria-label', t('todo.subtasks.toggleDone'));
    checkbox.addEventListener('change', async () => {
      const persistedId = row.dataset.subtaskId && !row.dataset.subtaskId.startsWith('new-') ? Number(row.dataset.subtaskId) : null;
      if (persistedId && todoId) {
        const previous = !checkbox.checked;
        const ok = await updateTodoSubtask(todoId, persistedId, { is_done: checkbox.checked });
        if (!ok) checkbox.checked = previous;
      } else {
        updateSubtaskEditorCount();
      }
    });

    const checkboxBox = document.createElement('span');
    checkboxBox.className = 'ui-checkbox-box';
    checkboxBox.setAttribute('aria-hidden', 'true');
    checkboxBox.innerHTML = iconSvg('check');
    checkboxLabel.append(checkbox, checkboxBox);

    const inputWrap = document.createElement('div');
    inputWrap.className = 'form-group todo-subtask-title-group';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'todo-subtask-title-input';
    input.maxLength = 500;
    input.value = subtask.title || '';
    input.dataset.originalTitle = input.value;
    input.placeholder = t('todo.subtasks.placeholder');
    input.setAttribute('aria-label', t('todo.subtasks.titleLabel'));
    input.addEventListener('input', updateSubtaskEditorCount);
    input.addEventListener('blur', async () => {
      if (row.dataset.deleting === '1') return;
      const persistedId = row.dataset.subtaskId && !row.dataset.subtaskId.startsWith('new-') ? Number(row.dataset.subtaskId) : null;
      const title = input.value.trim();
      if (!persistedId || !todoId || title === input.dataset.originalTitle) return;
      if (!title) {
        input.value = input.dataset.originalTitle || '';
        return;
      }
      const ok = await updateTodoSubtask(todoId, persistedId, { title });
      if (!ok) input.value = input.dataset.originalTitle || '';
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
    });
    inputWrap.appendChild(input);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-secondary btn-small btn-icon todo-subtask-remove';
    remove.innerHTML = iconSvg('trash-2');
    remove.setAttribute('aria-label', t('todo.subtasks.delete'));
    remove.setAttribute('title', t('todo.subtasks.delete'));
    remove.addEventListener('mousedown', (event) => event.preventDefault());
    remove.addEventListener('click', async () => {
      row.dataset.deleting = '1';
      const persistedId = row.dataset.subtaskId && !row.dataset.subtaskId.startsWith('new-') ? Number(row.dataset.subtaskId) : null;
      const hasTitle = Boolean(input.value.trim());
      if (persistedId || hasTitle) {
        const confirmed = await confirmDanger({
          title: t('todo.subtasks.deleteTitle'),
          message: t('todo.subtasks.deleteMessage'),
          confirmText: t('todo.subtasks.deleteConfirm'),
        });
        if (!confirmed) {
          row.dataset.deleting = '0';
          return;
        }
      }
      if (persistedId && todoId) {
        deletingSubtaskIds.add(String(persistedId));
        row.remove();
        updateSubtaskEditorCount();
        const ok = await deleteTodoSubtask(todoId, persistedId);
        if (!ok) {
          deletingSubtaskIds.delete(String(persistedId));
          row.dataset.deleting = '0';
        }
        return;
      }
      row.remove();
      updateSubtaskEditorCount();
    });

    row.append(checkboxLabel, inputWrap, remove);
    list.appendChild(row);
    updateSubtaskEditorCount();
    return input;
  }


  function renderTodoSubtaskEditor(subtasks = []) {
    const list = document.getElementById('todo-subtasks-list');
    if (!list) return;
    list.innerHTML = '';
    const normalized = normalizeSubtasks(subtasks)
      .filter(subtask => !deletingSubtaskIds.has(String(subtask.id)))
      .sort((a, b) => Number(a.is_done) - Number(b.is_done) || Number(a.sort_order) - Number(b.sort_order));
    normalized.forEach(subtask => addTodoSubtaskRow(subtask));
    updateSubtaskEditorCount();
    setTodoCollapsibleOpen('todo-subtasks-panel', normalized.length > 0);
  }

  async function addTodoSubtaskFromInput() {
    const input = document.getElementById('todo-subtask-new-title');
    const title = input?.value?.trim() || '';
    const todoId = document.getElementById('todo-id')?.value || '';
    if (!title) {
      input?.focus();
      return;
    }
    if (todoId && !String(todoId).startsWith('temp-')) {
      const ok = await createTodoSubtask(todoId, title, false);
      if (!ok) return;
    } else {
      addTodoSubtaskRow({ title, is_done: false });
    }
    if (input) {
      input.value = '';
      input.focus();
    }
  }


  function formatTodoCommentTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    try {
      return date.toLocaleString(getActiveLanguage(), { dateStyle: 'short', timeStyle: 'short' });
    } catch (_error) {
      return date.toLocaleString();
    }
  }

  function renderTodoComments(comments = [], todo = null) {
    const todoId = todo?.id || null;
    const list = document.getElementById('todo-comments-list');
    const empty = document.getElementById('todo-comments-empty');
    const input = document.getElementById('todo-comment-new-body');
    const addButton = document.getElementById('todo-comment-add-btn');
    if (!list) return;
    const normalized = Array.isArray(comments) ? comments : [];
    const count = document.getElementById('todo-comments-count');
    list.innerHTML = '';
    if (count) count.textContent = String(normalized.length);
    setTodoCollapsibleOpen('todo-comments-panel', normalized.length > 0);
    if (empty) {
      empty.textContent = todoId ? t('todo.comments.empty') : t('todo.comments.saveFirst');
      empty.hidden = normalized.length > 0;
    }
    if (input) {
      input.value = '';
      input.disabled = !todoId;
    }
    if (addButton) addButton.disabled = !todoId;
    for (const comment of normalized) {
      const item = document.createElement('article');
      item.className = 'todo-comment-item';
      item.dataset.commentId = comment.id;

      const meta = document.createElement('div');
      meta.className = 'todo-comment-meta';
      const author = document.createElement('span');
      const authorName = comment.author_display_name || comment.author_username || t('todo.comments.unknownAuthor');
      author.textContent = authorName;
      if (comment.author_username && comment.author_username !== authorName) author.title = comment.author_username;
      const time = document.createElement('time');
      time.dateTime = comment.created_at || '';
      time.textContent = formatTodoCommentTime(comment.created_at);
      meta.append(author, time);

      const body = document.createElement('div');
      body.className = 'todo-comment-body';
      body.textContent = comment.body || '';

      const actions = document.createElement('div');
      actions.className = 'todo-comment-actions';
      const currentUserId = getCurrentUser?.()?.id;
      const isAuthor = String(comment.user_id) === String(currentUserId);
      const canDelete = isAuthor || String(todo?.user_id) === String(currentUserId);
      if (isAuthor) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'btn btn-secondary btn-small btn-icon';
        edit.innerHTML = iconSvg('edit-3');
        edit.setAttribute('aria-label', t('todo.comments.edit'));
        edit.setAttribute('title', t('todo.comments.edit'));
        edit.addEventListener('click', () => startTodoCommentEdit(item, body, actions, todoId, comment));
        actions.appendChild(edit);
      }
      if (canDelete) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-secondary btn-small btn-icon';
        remove.innerHTML = iconSvg('trash-2');
        remove.setAttribute('aria-label', t('todo.comments.delete'));
        remove.setAttribute('title', t('todo.comments.delete'));
        remove.addEventListener('click', () => deleteTodoComment(todoId, comment.id));
        actions.appendChild(remove);
      }

      item.append(meta, body, actions);
      list.appendChild(item);
    }
  }

  function startTodoCommentEdit(item, bodyEl, actionsEl, todoId, comment) {
    if (!todoId || !comment?.id || item.dataset.editing === '1') return;
    item.dataset.editing = '1';
    const original = comment.body || '';
    const editor = document.createElement('textarea');
    editor.className = 'todo-comment-edit-input';
    editor.rows = Math.max(3, Math.min(8, original.split('\n').length + 1));
    editor.maxLength = 5000;
    editor.value = original;
    bodyEl.replaceWith(editor);
    actionsEl.innerHTML = '';

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary btn-small btn-icon';
    save.innerHTML = iconSvg('check');
    save.setAttribute('aria-label', t('common.save'));
    save.setAttribute('title', t('common.save'));
    save.addEventListener('click', () => updateTodoComment(todoId, comment.id, editor.value));

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-secondary btn-small btn-icon';
    cancel.innerHTML = iconSvg('x');
    cancel.setAttribute('aria-label', t('common.cancel'));
    cancel.setAttribute('title', t('common.cancel'));
    cancel.addEventListener('click', () => {
      item.dataset.editing = '0';
      renderTodoComments(getTodos().find(todo => String(todo.id) === String(todoId))?.comments || [], getTodos().find(todo => String(todo.id) === String(todoId)) || null);
    });

    actionsEl.append(save, cancel);
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  async function applyCommentTodoResponse(response) {
    const updatedTodo = response?.todo;
    if (!updatedTodo) return;
    await dbPut('todos', updatedTodo);
    setTodos(getTodos().map(todo => String(todo.id) === String(updatedTodo.id) ? updatedTodo : todo));
    renderTodoComments(updatedTodo.comments || [], updatedTodo);
    renderStats();
    renderTodos();
  }

  async function addTodoCommentFromInput() {
    if (!getAppInitialized() || !getDb()) return;
    const id = document.getElementById('todo-id')?.value;
    const input = document.getElementById('todo-comment-new-body');
    const body = input?.value?.trim() || '';
    if (!id || id.startsWith('temp-')) {
      showToast(t('todo.comments.saveFirst'));
      return;
    }
    if (!body) {
      input?.focus();
      return;
    }
    if (!isOnlineForSync()) {
      showToast(t('todo.comments.onlineOnly'));
      return;
    }
    try {
      const response = await todosApi.createComment(id, { body });
      await applyCommentTodoResponse(response);
      if (input) input.value = '';
    } catch (error) {
      console.error('Failed to add todo comment', error);
      showToast(t('todo.comments.saveFailed'));
    }
  }

  async function updateTodoComment(todoId, commentId, body) {
    const normalized = String(body || '').trim();
    if (!normalized) {
      showToast(t('todo.comments.emptyBody'));
      return;
    }
    if (!todoId || !commentId || !isOnlineForSync()) {
      showToast(t('todo.comments.onlineOnly'));
      return;
    }
    try {
      const response = await todosApi.updateComment(todoId, commentId, { body: normalized });
      await applyCommentTodoResponse(response);
    } catch (error) {
      console.error('Failed to update todo comment', error);
      showToast(t('todo.comments.saveFailed'));
    }
  }

  async function deleteTodoComment(todoId, commentId) {
    if (!todoId || !commentId || !isOnlineForSync()) {
      showToast(t('todo.comments.onlineOnly'));
      return;
    }
    const confirmed = await confirmDanger({
      title: t('todo.comments.deleteTitle'),
      message: t('todo.comments.deleteMessage'),
      confirmText: t('todo.comments.deleteConfirm'),
    });
    if (!confirmed) return;
    try {
      const response = await todosApi.deleteComment(todoId, commentId);
      await applyCommentTodoResponse(response);
    } catch (error) {
      console.error('Failed to delete todo comment', error);
      showToast(t('todo.comments.deleteFailed'));
    }
  }

  function formatAttachmentSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
    return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function attachmentIconName(attachment = {}) {
    const type = String(attachment.content_type || '').toLowerCase();
    const name = String(attachment.original_filename || '').toLowerCase();
    if (type.startsWith('image/')) return 'file-image';
    if (type === 'application/pdf' || name.endsWith('.pdf')) return 'file-type';
    return 'file';
  }

  function attachmentIsImagePreview(attachment = {}, blob = null) {
    const type = String(attachment.content_type || blob?.type || '').toLowerCase();
    const name = String(attachment.original_filename || '').toLowerCase();
    return type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(name);
  }

  function attachmentIsPdfPreview(attachment = {}, blob = null) {
    const type = String(attachment.content_type || blob?.type || '').toLowerCase();
    const name = String(attachment.original_filename || '').toLowerCase();
    return type === 'application/pdf' || name.endsWith('.pdf');
  }

  function attachmentCanPreview(attachment = {}) {
    return attachmentIsImagePreview(attachment) || attachmentIsPdfPreview(attachment);
  }

  function attachmentAllowedByClient(file, user = getCurrentUser?.()) {
    const allowed = Array.isArray(user?.attachments_allowed_types) ? user.attachments_allowed_types : [];
    if (!allowed.length) return true;
    const name = String(file?.name || '').toLowerCase();
    const type = String(file?.type || '').split(';', 1)[0].toLowerCase();
    return allowed.some((entry) => {
      const item = String(entry || '').toLowerCase().trim();
      if (!item) return false;
      if (item.startsWith('.')) return name.endsWith(item);
      if (item.endsWith('/*')) return type.startsWith(item.slice(0, -1));
      return type === item;
    });
  }

  function getSelectedAttachmentFiles() {
    return Array.from(document.getElementById('todo-attachment-file')?.files || []);
  }

  function setSelectedAttachmentFileName(files = []) {
    const label = document.getElementById('todo-attachment-file-name');
    const picker = label?.closest?.('.todo-attachment-picker');
    if (!label) return;
    const selected = Array.isArray(files) ? files : (files ? [files] : []);
    const hasFile = selected.length > 0;
    if (selected.length === 1) {
      label.textContent = t('todo.attachments.selectedFile', { filename: selected[0].name });
      label.title = selected[0].name;
    } else if (selected.length > 1) {
      label.textContent = t('todo.attachments.selectedFiles', { count: selected.length });
      label.title = selected.map(file => file.name).join('\n');
    } else {
      label.textContent = t('todo.attachments.chooseFile');
      label.title = '';
    }
    picker?.classList.toggle('has-file', hasFile);
  }

  function setAttachmentInputFiles(files = []) {
    const input = document.getElementById('todo-attachment-file');
    if (!input) return;
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    input.files = transfer.files;
    setSelectedAttachmentFileName(Array.from(input.files));
    refreshTodoSaveButtonState();
  }

  function renderTodoAttachments(attachments = [], todo = null) {
    const todoId = todo?.id || null;
    const list = document.getElementById('todo-attachments-list');
    const empty = document.getElementById('todo-attachments-empty');
    const input = document.getElementById('todo-attachment-file');
    const uploadButton = document.getElementById('todo-attachment-upload-btn');
    const count = document.getElementById('todo-attachments-count');
    if (!list) return;
    const normalized = Array.isArray(attachments) ? attachments : [];
    list.innerHTML = '';
    if (count) count.textContent = String(normalized.length);
    setTodoCollapsibleOpen('todo-attachments-panel', Boolean(todoId));
    if (empty) {
      empty.textContent = todoId ? t('todo.attachments.empty') : t('todo.attachments.saveFirst');
      empty.hidden = normalized.length > 0;
    }
    if (input) {
      input.value = '';
      input.disabled = !todoId;
      setSelectedAttachmentFileName([]);
    }
    if (uploadButton) uploadButton.disabled = !todoId;
    for (const attachment of normalized) {
      const item = document.createElement('article');
      item.className = 'todo-attachment-item';
      item.dataset.attachmentId = attachment.id;

      const icon = document.createElement('button');
      icon.type = 'button';
      icon.className = 'todo-attachment-icon';
      icon.innerHTML = iconSvg(attachmentIconName(attachment));
      icon.setAttribute('aria-label', t('todo.attachments.preview'));
      icon.setAttribute('title', t('todo.attachments.preview'));
      icon.addEventListener('click', () => previewTodoAttachment(todoId, attachment));

      const body = document.createElement('div');
      body.className = 'todo-attachment-body';
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'todo-attachment-name';
      name.textContent = attachment.original_filename || t('todo.attachments.unnamed');
      name.addEventListener('click', () => previewTodoAttachment(todoId, attachment));
      const meta = document.createElement('div');
      meta.className = 'todo-attachment-meta';
      meta.textContent = `${formatAttachmentSize(attachment.size_bytes)} · ${attachment.uploader_display_name || attachment.uploader_username || t('todo.attachments.unknownUploader')}`;
      body.append(name, meta);

      const actions = document.createElement('div');
      actions.className = 'todo-attachment-actions';
      const download = document.createElement('button');
      download.type = 'button';
      download.className = 'btn btn-secondary btn-small btn-icon';
      download.innerHTML = iconSvg('download');
      download.setAttribute('aria-label', t('todo.attachments.download'));
      download.setAttribute('title', t('todo.attachments.download'));
      download.addEventListener('click', () => downloadTodoAttachment(todoId, attachment.id, attachment.original_filename));
      actions.appendChild(download);
      const currentUserId = getCurrentUser?.()?.id;
      const project = (getProjects?.() || []).find((item) => String(item.id) === String(todo?.project_id));
      const canDelete = String(attachment.user_id) === String(currentUserId)
        || String(todo?.user_id) === String(currentUserId)
        || project?.is_owner === true
        || project?.is_shared === true;
      if (canDelete) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-secondary btn-small btn-icon';
        remove.innerHTML = iconSvg('trash-2');
        remove.setAttribute('aria-label', t('todo.attachments.delete'));
        remove.setAttribute('title', t('todo.attachments.delete'));
        remove.addEventListener('click', () => deleteTodoAttachment(todoId, attachment.id));
        actions.appendChild(remove);
      }

      item.append(icon, body, actions);
      list.appendChild(item);
    }
  }

  async function applyAttachmentTodoResponse(response) {
    const updatedTodo = response?.todo;
    if (!updatedTodo) return;
    await dbPut('todos', updatedTodo);
    setTodos(getTodos().map(todo => String(todo.id) === String(updatedTodo.id) ? updatedTodo : todo));
    renderTodoAttachments(updatedTodo.attachments || [], updatedTodo);
    renderStats();
    renderTodos();
  }

  async function uploadTodoAttachmentFromInput() {
    if (!getAppInitialized() || !getDb()) return;
    const id = document.getElementById('todo-id')?.value;
    const input = document.getElementById('todo-attachment-file');
    const files = getSelectedAttachmentFiles();
    if (!id || id.startsWith('temp-')) {
      showToast(t('todo.attachments.saveFirst'));
      return;
    }
    if (files.length === 0) {
      input?.focus();
      return;
    }
    if (!isOnlineForSync()) {
      showToast(t('todo.attachments.onlineOnly'));
      return;
    }
    const currentUser = getCurrentUser?.();
    if (currentUser?.attachments_enabled === false) {
      showToast(t('todo.attachments.disabled'));
      return;
    }
    const maxUploadBytes = Number(currentUser?.attachment_max_upload_bytes || 0);
    const oversized = files.find(file => maxUploadBytes > 0 && file.size > maxUploadBytes);
    if (oversized) {
      showToast(t('todo.attachments.fileTooLarge', { max: formatAttachmentSize(maxUploadBytes) }));
      return;
    }
    const remainingBytes = Number(currentUser?.attachment_remaining_bytes ?? currentUser?.attachment_quota_bytes ?? 0);
    const totalBytes = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    if (totalBytes > Math.max(remainingBytes, 0)) {
      showToast(t('todo.attachments.quotaExceeded'));
      return;
    }
    if (files.some(file => !attachmentAllowedByClient(file, currentUser))) {
      showToast(t('todo.attachments.typeNotAllowed'));
      return;
    }
    const uploadButton = document.getElementById('todo-attachment-upload-btn');
    const previousDisabled = uploadButton?.disabled;
    if (uploadButton) uploadButton.disabled = true;
    try {
      let latestResponse = null;
      let latestUser = currentUser;
      for (const file of files) {
        latestResponse = await todosApi.uploadAttachment(id, file);
        if (latestResponse?.usage && latestUser && typeof setCurrentUser === 'function') {
          latestUser = {
            ...latestUser,
            attachments_enabled: Boolean(latestResponse.usage.enabled),
            attachment_usage_bytes: latestResponse.usage.used_bytes,
            attachment_quota_bytes: latestResponse.usage.quota_bytes,
            attachment_remaining_bytes: latestResponse.usage.remaining_bytes,
            attachments_allowed_types: latestResponse.usage.allowed_types || latestUser.attachments_allowed_types,
            attachment_max_upload_bytes: latestResponse.usage.max_upload_bytes || latestUser.attachment_max_upload_bytes,
          };
          setCurrentUser(latestUser);
        }
      }
      if (latestResponse) await applyAttachmentTodoResponse(latestResponse);
      setSelectedAttachmentFileName([]);
      if (input) input.value = '';
      showToast(files.length === 1 ? t('todo.attachments.uploaded') : t('todo.attachments.uploadedMany', { count: files.length }));
    } catch (error) {
      console.error('Failed to upload todo attachment', error);
      showToast(error?.message || t('todo.attachments.uploadFailed'));
    } finally {
      if (uploadButton) uploadButton.disabled = previousDisabled ?? false;
    }
  }

  function closeAttachmentPreview() {
    closeModal('attachment-preview-modal');
    document.getElementById('attachment-preview-modal')?.classList.remove('show');
    const body = document.getElementById('attachment-preview-body');
    if (body) body.innerHTML = '';
    if (attachmentPreviewObjectUrl) URL.revokeObjectURL(attachmentPreviewObjectUrl);
    attachmentPreviewObjectUrl = '';
    attachmentPreviewDownload = null;
  }

  async function previewTodoAttachment(todoId, attachment) {
    if (!todoId || !attachment?.id || !isOnlineForSync()) {
      showToast(t('todo.attachments.onlineOnly'));
      return;
    }
    if (!attachmentCanPreview(attachment)) {
      showToast(t('todo.attachments.noPreview'));
      return downloadTodoAttachment(todoId, attachment.id, attachment.original_filename);
    }
    try {
      closeAttachmentPreview();
      const blob = await todosApi.getAttachmentBlob(todoId, attachment.id);
      attachmentPreviewObjectUrl = URL.createObjectURL(blob);
      attachmentPreviewDownload = { todoId, attachmentId: attachment.id, filename: attachment.original_filename || 'attachment' };
      const title = document.getElementById('attachment-preview-title');
      const body = document.getElementById('attachment-preview-body');
      const download = document.getElementById('attachment-preview-download-btn');
      if (title) title.textContent = attachment.original_filename || t('todo.attachments.preview');
      if (download) download.disabled = false;
      if (body) {
        if (attachmentIsImagePreview(attachment, blob)) {
          body.innerHTML = `<img src="${attachmentPreviewObjectUrl}" alt="${escapeHtmlAttr(attachment.original_filename || t('todo.attachments.preview'))}">`;
        } else if (attachmentIsPdfPreview(attachment, blob)) {
          body.innerHTML = `<iframe src="${attachmentPreviewObjectUrl}" title="${escapeHtmlAttr(attachment.original_filename || t('todo.attachments.preview'))}"></iframe>`;
        } else {
          body.textContent = t('todo.attachments.noPreview');
        }
      }
      document.getElementById('attachment-preview-modal')?.classList.add('active');
    } catch (error) {
      console.error('Failed to preview todo attachment', error);
      showToast(t('todo.attachments.previewFailed'));
    }
  }

  async function downloadPreviewAttachment() {
    if (!attachmentPreviewDownload) return;
    await downloadTodoAttachment(attachmentPreviewDownload.todoId, attachmentPreviewDownload.attachmentId, attachmentPreviewDownload.filename);
  }

  async function downloadTodoAttachment(todoId, attachmentId, filename) {
    if (!todoId || !attachmentId || !isOnlineForSync()) {
      showToast(t('todo.attachments.onlineOnly'));
      return;
    }
    try {
      await todosApi.downloadAttachment(todoId, attachmentId, filename || 'attachment');
    } catch (error) {
      console.error('Failed to download todo attachment', error);
      showToast(t('todo.attachments.downloadFailed'));
    }
  }

  async function deleteTodoAttachment(todoId, attachmentId) {
    if (!todoId || !attachmentId || !isOnlineForSync()) {
      showToast(t('todo.attachments.onlineOnly'));
      return;
    }
    const confirmed = await confirmDanger({
      title: t('todo.attachments.deleteTitle'),
      message: t('todo.attachments.deleteMessage'),
      confirmText: t('todo.attachments.deleteConfirm'),
    });
    if (!confirmed) return;
    try {
      const response = await todosApi.deleteAttachment(todoId, attachmentId);
      await applyAttachmentTodoResponse(response);
    } catch (error) {
      console.error('Failed to delete todo attachment', error);
      showToast(t('todo.attachments.deleteFailed'));
    }
  }

  function bindTodoForm() {
    if (todoFormBound) return;
    const form = document.getElementById('todo-form');
    if (!form) return;
    todoFormBound = true;
    form.addEventListener('submit', saveTodo);
    form.addEventListener('input', refreshTodoSaveButtonState);
    form.addEventListener('change', refreshTodoSaveButtonState);
    document.getElementById('todo-attachment-file')?.addEventListener('change', (event) => {
      setSelectedAttachmentFileName(Array.from(event.target?.files || []));
    });
    const attachmentDropZone = document.querySelector('.todo-attachments-add-row');
    if (attachmentDropZone) {
      attachmentDropZone.dataset.dropLabel = t('todo.attachments.dropHint');
      const stopDrag = (event) => {
        event.preventDefault();
        event.stopPropagation();
      };
      for (const eventName of ['dragenter', 'dragover']) {
        attachmentDropZone.addEventListener(eventName, (event) => {
          stopDrag(event);
          attachmentDropZone.classList.add('is-drag-over');
        });
      }
      for (const eventName of ['dragleave', 'drop']) {
        attachmentDropZone.addEventListener(eventName, (event) => {
          stopDrag(event);
          attachmentDropZone.classList.remove('is-drag-over');
        });
      }
      attachmentDropZone.addEventListener('drop', (event) => {
        const files = Array.from(event.dataTransfer?.files || []);
        if (files.length) setAttachmentInputFiles(files);
      });
    }
    document.getElementById('todo-subtask-new-title')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addTodoSubtaskFromInput();
      }
    });
  }

  function hydrateTodoSelects() {
    for (const id of ['todo-priority', 'todo-status', 'todo-project', 'todo-section', 'todo-recurring-frequency', 'todo-location-trigger', 'todo-location-place']) {
      const select = document.getElementById(id);
      if (!select) continue;
      hydrateSelect(select, id === 'todo-project' ? { className: 'project-ui-select', menuClassName: 'project-ui-select-menu', searchPlaceholder: t('focus.projects.search'), searchLabel: t('focus.projects.search'), emptyText: t('focus.projects.noMatches') } : {});
      refreshSelect(select);
    }
  }

  function refreshTodoSelect(id) {
    const select = document.getElementById(id);
    if (select) refreshSelect(select);
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

  function browserTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch (_error) {
      return null;
    }
  }

  function normalizeRecurringRule(rule, { defaultTimezone = browserTimeZone() } = {}) {
    if (!rule || typeof rule !== 'object') return null;
    const frequency = String(rule.frequency || 'none').toLowerCase();
    if (!['daily', 'weekly', 'monthly', 'yearly'].includes(frequency)) return null;
    const interval = Math.max(1, Math.min(999, Number.parseInt(rule.interval || 1, 10) || 1));
    const normalized = { frequency, interval, preserve_time: true };
    const timezone = String(rule.timezone || defaultTimezone || '').trim();
    if (timezone) normalized.timezone = timezone;
    return normalized;
  }

  function recurringRuleFromForm() {
    const frequency = document.getElementById('todo-recurring-frequency')?.value || 'none';
    if (frequency === 'none') return null;
    const interval = Number.parseInt(document.getElementById('todo-recurring-interval')?.value || '1', 10);
    return normalizeRecurringRule({ frequency, interval, timezone: browserTimeZone() }, { defaultTimezone: null });
  }

  function updateRecurringControls() {
    const frequency = document.getElementById('todo-recurring-frequency')?.value || 'none';
    const interval = document.getElementById('todo-recurring-interval');
    const intervalGroup = document.getElementById('todo-recurring-interval-group');
    const hint = document.getElementById('todo-recurring-hint');
    const active = frequency !== 'none';
    if (interval) interval.disabled = !active;
    if (intervalGroup) intervalGroup.classList.toggle('is-disabled', !active);
    if (hint) hint.textContent = active ? t('todo.recurring.requiresDeadline') : t('todo.recurring.hint');
    if (!active) {
      const dueInput = document.getElementById('todo-due');
      const dueError = document.getElementById('todo-due-error');
      dueInput?.setCustomValidity('');
      if (dueError?.textContent === t('todo.recurring.deadlineRequired')) dueError.textContent = '';
    }
  }

  function updateLocationReminderControls() {
    const enabled = document.getElementById('todo-location-enabled')?.checked || false;
    const fields = document.getElementById('todo-location-fields');
    if (fields) {
      fields.classList.toggle('is-disabled', !enabled);
      fields.querySelectorAll('input, select, textarea, button').forEach((control) => { control.disabled = !enabled; });
    }
    const placeId = document.getElementById('todo-location-place')?.value || '';
    const addressGroup = document.getElementById('todo-location-address-group');
    if (addressGroup) addressGroup.hidden = Boolean(placeId);
    const error = document.getElementById('todo-location-error');
    if (error && !enabled) error.textContent = '';
  }

  async function loadSavedPlacesForTodoModal() {
    if (!placesApi) return [];
    try {
      const data = await placesApi.list();
      savedPlaces = data.places || [];
    } catch (error) {
      console.warn('Failed to load saved places', error);
      savedPlaces = [];
    }
    renderLocationPlaceSelect();
    return savedPlaces;
  }

  function renderLocationPlaceSelect(selectedId = '') {
    const select = document.getElementById('todo-location-place');
    if (!select) return;
    select.innerHTML = `<option value="" data-i18n-key="todo.location.manualAddress">${t('todo.location.manualAddress')}</option>`;
    for (const place of savedPlaces) {
      const option = document.createElement('option');
      option.value = String(place.id);
      option.textContent = place.name;
      option.dataset.address = place.address || '';
      select.appendChild(option);
    }
    select.value = selectedId ? String(selectedId) : '';
    refreshSelect(select);
    updateLocationReminderControls();
  }

  function bindLocationReminderControls() {
    const enabled = document.getElementById('todo-location-enabled');
    if (enabled && enabled.dataset.locationBound !== '1') {
      enabled.dataset.locationBound = '1';
      enabled.addEventListener('change', updateLocationReminderControls);
    }
    const place = document.getElementById('todo-location-place');
    if (place && place.dataset.locationBound !== '1') {
      place.dataset.locationBound = '1';
      place.addEventListener('change', updateLocationReminderControls);
    }
    updateLocationReminderControls();
  }

  function clearLocationReminderForm() {
    const enabled = document.getElementById('todo-location-enabled');
    if (enabled) enabled.checked = false;
    const trigger = document.getElementById('todo-location-trigger');
    if (trigger) trigger.value = 'arrival';
    for (const id of ['todo-location-address']) {
      const input = document.getElementById(id);
      if (input) input.value = '';
    }
    const place = document.getElementById('todo-location-place');
    if (place) place.value = '';
    updateLocationReminderControls();
  }

  function populateLocationReminderForm(todo) {
    clearLocationReminderForm();
    const locationReminder = todo?.location_reminder || todo?.location_reminders?.[0];
    if (!locationReminder) return;
    const enabled = document.getElementById('todo-location-enabled');
    if (enabled) enabled.checked = true;
    const setValue = (id, value) => {
      const input = document.getElementById(id);
      if (input && value !== undefined && value !== null) input.value = String(value);
    };
    setValue('todo-location-trigger', locationReminder.trigger_type || locationReminder.triggerType || 'arrival');
    renderLocationPlaceSelect(locationReminder.place_id || '');
    if (!locationReminder.place_id) setValue('todo-location-address', locationReminder.address || '');
    updateLocationReminderControls();
  }

  function locationReminderFromForm() {
    const enabled = document.getElementById('todo-location-enabled')?.checked || false;
    if (!enabled) return null;
    const error = document.getElementById('todo-location-error');
    if (error) error.textContent = '';
    const placeId = document.getElementById('todo-location-place')?.value || '';
    const address = document.getElementById('todo-location-address')?.value?.trim() || '';
    if (!placeId && !address) {
      if (error) error.textContent = t('todo.location.addressRequired');
      document.getElementById('todo-location-address')?.focus();
      throw new Error('Invalid location reminder address');
    }
    const payload = {
      trigger_type: document.getElementById('todo-location-trigger')?.value || 'arrival',
      enabled: true,
    };
    if (placeId) {
      payload.place_id = Number(placeId);
      const selectedPlace = savedPlaces.find(place => String(place.id) === String(placeId));
      if (selectedPlace?.address) payload.address = String(selectedPlace.address);
    } else {
      payload.address = address;
    }
    return payload;
  }

  function locationReminderArrayFromPayload(locationReminder) {
    return locationReminder ? [locationReminder] : [];
  }

  function bindRecurringControls() {
    const select = document.getElementById('todo-recurring-frequency');
    const interval = document.getElementById('todo-recurring-interval');
    if (select && select.dataset.recurringBound !== '1') {
      select.dataset.recurringBound = '1';
      select.addEventListener('change', updateRecurringControls);
    }
    if (interval && interval.dataset.recurringBound !== '1') {
      interval.dataset.recurringBound = '1';
      interval.addEventListener('blur', () => {
        const value = Number.parseInt(interval.value, 10);
        if (!Number.isFinite(value) || value < 1) interval.value = '1';
        else if (value > 999) interval.value = '999';
      });
    }
    updateRecurringControls();
  }

  function runHapticFeedback(pattern = 12) {
    try {
      if (RUNTIME_CAPABILITIES.android && nativeBridge.hapticFeedback(pattern)) return;
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

  function normalizedName(value) {
    return String(value || '').toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function compactName(value) {
    return normalizedName(value).replace(/\s+/g, '');
  }

  function quickAddAliases(key) {
    const value = t(key);
    if (!value || value === key) return [];
    return value.split('|').map(item => item.trim().toLowerCase()).filter(Boolean);
  }

  function findProjectByQuickAddName(rawName) {
    const wanted = normalizedName(rawName);
    const compact = compactName(rawName);
    return getProjects().find(p => normalizedName(p.name) === wanted || compactName(p.name) === compact) || null;
  }

  async function loadSectionsForQuickAdd() {
    try { return await dbGetAll('sections'); }
    catch { return []; }
  }

  function findSectionByQuickAddName(rawName, projectId, allSections = []) {
    const wanted = normalizedName(rawName);
    const compact = compactName(rawName);
    return allSections.find(s => {
      if (projectId && String(s.project_id) !== String(projectId)) return false;
      return normalizedName(s.name) === wanted || compactName(s.name) === compact;
    }) || null;
  }

  function parseRelativeQuickAddDate(value, now = new Date()) {
    const n = String(value || '').toLowerCase();
    const todayWords = quickAddAliases('quickAdd.syntax.today');
    const tomorrowWords = quickAddAliases('quickAdd.syntax.tomorrow');
    const dayAfterWords = quickAddAliases('quickAdd.syntax.dayAfterTomorrow');
    const weekendWords = quickAddAliases('quickAdd.syntax.weekend');
    const nextWeekWords = quickAddAliases('quickAdd.syntax.nextWeek');
    const weekdays = quickAddAliases('quickAdd.syntax.weekdays');
    const weekdayIndex = weekdays.indexOf(n);
    let due = null;
    if (todayWords.includes(n)) { due = startOfToday(now); due.setHours(18, 0, 0, 0); }
    else if (tomorrowWords.includes(n)) { due = startOfToday(now); due.setDate(due.getDate() + 1); due.setHours(9, 0, 0, 0); }
    else if (dayAfterWords.includes(n)) { due = startOfToday(now); due.setDate(due.getDate() + 2); due.setHours(9, 0, 0, 0); }
    else if (weekendWords.includes(n)) due = nextWeekday(now, 6);
    else if (nextWeekWords.includes(n)) { due = startOfToday(now); due.setDate(due.getDate() + 7); due.setHours(9, 0, 0, 0); }
    else if (weekdayIndex >= 0) due = nextWeekday(now, weekdayIndex % 7);
    return due;
  }

  function applyQuickAddTime(date, rawTime, now = new Date()) {
    const value = String(rawTime || '').trim().toLowerCase();
    const match = value.match(/^([01]?\d|2[0-3])(?:[:.]([0-5]\d))?$/);
    if (!match) return null;
    const next = date ? new Date(date) : startOfToday(now);
    next.setHours(Number(match[1]), Number(match[2] || 0), 0, 0);
    if (next < now && !date) next.setDate(next.getDate() + 1);
    return next;
  }

  function quickAddDateLabel(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat(getActiveLanguage(), { dateStyle: 'short', timeStyle: 'short' }).format(date);
  }

  function tokenIndexMap(rawText) {
    const indexes = [];
    const pattern = /\S+/g;
    let match;
    while ((match = pattern.exec(rawText)) !== null) indexes.push({ start: match.index, end: match.index + match[0].length });
    return indexes;
  }

  function markTokenRange(used, tokenSpans, start, end) {
    tokenSpans.forEach((span, index) => {
      if (span.start < end && span.end > start) used.add(index);
    });
  }

  function tokenIndexForRange(tokenSpans, start, end) {
    const index = tokenSpans.findIndex(span => span.start < end && span.end > start);
    return index >= 0 ? index : 0;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function aliasPattern(aliases) {
    return aliases
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map(alias => escapeRegExp(alias).replace(/\\\s+/g, '\\s+'))
      .join('|');
  }

  function quickAddNamePatterns(items = []) {
    const variants = new Set();
    items.forEach(item => {
      const name = String(item.name || '').trim();
      if (!name) return;
      variants.add(escapeRegExp(name).replace(/\\\s+/g, '\\s+'));
      const compact = compactName(name);
      if (compact && compact !== normalizedName(name)) variants.add(escapeRegExp(compact));
    });
    return Array.from(variants).sort((a, b) => b.length - a.length).join('|');
  }

  function projectNamePattern() {
    return quickAddNamePatterns(getProjects());
  }

  function sectionNamePattern(allSections = []) {
    return quickAddNamePatterns(allSections);
  }

  function addTokenMatch(matches, matchIndexes, used, tokenSpans, tokens, type, start, end, label, value = '', uniqueKey = null) {
    const tokenIndex = tokenIndexForRange(tokenSpans, start, end);
    if (uniqueKey && matchIndexes.has(uniqueKey)) {
      const existing = matches[matchIndexes.get(uniqueKey)];
      existing.value = value;
      existing.token = tokens[tokenIndex] || '';
    } else {
      if (uniqueKey) matchIndexes.set(uniqueKey, matches.length);
      matches.push({ type, label, value, token: tokens[tokenIndex] || '' });
    }
    markTokenRange(used, tokenSpans, start, end);
  }

  async function parseQuickAddTitle(rawTitle, currentProjectId, formProjectId = null) {
    const original = String(rawTitle || '').trim();
    if (!original) return { title: original, changes: {}, matches: [] };
    const now = new Date();
    const tokens = original.split(/\s+/);
    const tokenSpans = tokenIndexMap(original);
    const used = new Set();
    const changes = {};
    const matches = [];
    const matchIndexes = new Map();
    const allSections = await loadSectionsForQuickAdd();
    const activeProjectId = formProjectId || currentProjectId;
    const prefixAliases = {
      due: quickAddAliases('quickAdd.syntax.duePrefixes'),
      remind: quickAddAliases('quickAdd.syntax.reminderPrefixes'),
      section: quickAddAliases('quickAdd.syntax.sectionPrefixes'),
      project: quickAddAliases('quickAdd.syntax.projectPrefixes'),
      recurring: quickAddAliases('quickAdd.syntax.recurringPrefixes'),
    };
    const timeSuffixes = quickAddAliases('quickAdd.syntax.timeSuffixes');
    const timeSuffixPattern = aliasPattern(timeSuffixes);
    const dateAliases = [
      ...quickAddAliases('quickAdd.syntax.today'),
      ...quickAddAliases('quickAdd.syntax.tomorrow'),
      ...quickAddAliases('quickAdd.syntax.dayAfterTomorrow'),
      ...quickAddAliases('quickAdd.syntax.weekend'),
      ...quickAddAliases('quickAdd.syntax.nextWeek'),
      ...quickAddAliases('quickAdd.syntax.weekdays'),
    ];
    const timePattern = `(?:[01]?\\d|2[0-3])(?:[:.]?[0-5]\\d)?(?:\\s+(?:${timeSuffixPattern}))?`;
    const datePattern = aliasPattern(dateAliases);
    const valuePattern = datePattern ? `(?:${datePattern})(?:\\s+${timePattern})?|${timePattern}` : timePattern;

    const addMatch = (type, tokenIndex, label, value = '') => {
      matches.push({ type, label, value, token: tokens[tokenIndex] });
      used.add(tokenIndex);
    };

    tokens.forEach((token, index) => {
      const normalized = token.toLowerCase();
      const priorityMap = new Map([
        ...quickAddAliases('quickAdd.syntax.priority.veryHigh').map(alias => [alias, 1]),
        ...quickAddAliases('quickAdd.syntax.priority.high').map(alias => [alias, 2]),
        ...quickAddAliases('quickAdd.syntax.priority.medium').map(alias => [alias, 3]),
        ...quickAddAliases('quickAdd.syntax.priority.low').map(alias => [alias, 4]),
      ]);
      if (priorityMap.has(normalized)) {
        changes.priority = priorityMap.get(normalized);
        addMatch('priority', index, t('quickAdd.detected.priority'), t(`todo.priority.${changes.priority === 1 ? 'veryHigh' : changes.priority === 2 ? 'high' : changes.priority === 3 ? 'medium' : 'low'}`));
      }
    });


    const recurringValueAliases = [
      ['daily', quickAddAliases('quickAdd.syntax.recurring.daily')],
      ['weekly', quickAddAliases('quickAdd.syntax.recurring.weekly')],
      ['monthly', quickAddAliases('quickAdd.syntax.recurring.monthly')],
      ['yearly', quickAddAliases('quickAdd.syntax.recurring.yearly')],
    ];
    const recurringPrefixPattern = aliasPattern(prefixAliases.recurring);
    const recurringValuePattern = aliasPattern(recurringValueAliases.flatMap(([, aliases]) => aliases));
    if (recurringPrefixPattern && recurringValuePattern) {
      const recurringRegexes = [
        new RegExp(`(^|\\s)(?:${recurringPrefixPattern})\\s*:?\\s*(?<value>${recurringValuePattern})(?=$|\\s)`, 'giu'),
      ];
      for (const regex of recurringRegexes) {
        for (const match of original.matchAll(regex)) {
          const value = String(match.groups?.value || '').toLowerCase().replace(/\s+/g, ' ').trim();
          const frequency = recurringValueAliases.find(([, aliases]) => aliases.includes(value))?.[0];
          if (!frequency) continue;
          const valueOffset = match[0].lastIndexOf(match.groups.value);
          const start = match.index + match[0].search(/\S/u);
          const end = match.index + valueOffset + match.groups.value.length;
          changes.recurring_rule = { frequency, interval: 1 };
          addTokenMatch(matches, matchIndexes, used, tokenSpans, tokens, 'recurring', start, end, t('quickAdd.detected.recurring'), t(`todo.recurring.${frequency}`), 'recurring_rule');
        }
      }
    }

    const projectNames = projectNamePattern();
    if (projectNames) {
      const projectPrefixPattern = aliasPattern(prefixAliases.project);
      const projectRegexes = [
        new RegExp(`(^|\\s)#(?<name>${projectNames})(?=$|\\s)`, 'giu'),
      ];
      if (projectPrefixPattern) projectRegexes.push(new RegExp(`(^|\\s)(?:${projectPrefixPattern})\\s*:\\s*(?<name>${projectNames})(?=$|\\s)`, 'giu'));
      for (const regex of projectRegexes) {
        for (const match of original.matchAll(regex)) {
          const name = match.groups?.name;
          const start = match.index + match[0].indexOf(name) - (match[0].includes('#') ? 1 : 0);
          const end = match.index + match[0].length;
          const project = findProjectByQuickAddName(name);
          if (!project) continue;
          changes.project_id = project.id;
          addTokenMatch(matches, matchIndexes, used, tokenSpans, tokens, 'project', start, end, t('quickAdd.detected.project'), project.name, 'project_id');
        }
      }
    }

    const sectionNames = sectionNamePattern(allSections);
    if (sectionNames) {
      const sectionPrefixPattern = aliasPattern(prefixAliases.section);
      const sectionRegexes = [
        new RegExp(`(^|\\s)[/§](?<name>${sectionNames})(?=$|\\s)`, 'giu'),
      ];
      if (sectionPrefixPattern) sectionRegexes.push(new RegExp(`(^|\\s)(?:${sectionPrefixPattern})\\s*:\\s*(?<name>${sectionNames})(?=$|\\s)`, 'giu'));
      for (const regex of sectionRegexes) {
        for (const match of original.matchAll(regex)) {
          const name = match.groups?.name;
          const start = match.index + match[0].search(/[\/§]|\S+\s*:/u);
          const end = match.index + match[0].length;
          const projectId = changes.project_id || activeProjectId;
          const section = findSectionByQuickAddName(name, projectId, allSections);
          if (!section) continue;
          changes.section_id = section.id;
          if (!changes.project_id && section.project_id) changes.project_id = section.project_id;
          addTokenMatch(matches, matchIndexes, used, tokenSpans, tokens, 'section', start, end, t('quickAdd.detected.section'), section.name, 'section_id');
        }
      }
    }

    function normalizeTimeValue(rawValue) {
      let value = String(rawValue || '').trim().toLowerCase();
      for (const suffix of timeSuffixes) value = value.replace(new RegExp(`\\s+${escapeRegExp(suffix)}$`, 'iu'), '');
      const compact = value.match(/^([01]?\d|2[0-3])([0-5]\d)$/);
      if (compact) value = `${compact[1]}:${compact[2]}`;
      return value;
    }

    function parseQuickAddDateValue(rawValue, kind) {
      const parts = String(rawValue || '').trim().split(/\s+/).filter(Boolean);
      let date = null;
      let consumed = 0;
      for (let length = Math.min(3, parts.length); length >= 1; length -= 1) {
        const spacedCandidate = parts.slice(0, length).join(' ').toLowerCase();
        const dashedCandidate = parts.slice(0, length).join('-').toLowerCase();
        date = parseRelativeQuickAddDate(spacedCandidate, now) || parseRelativeQuickAddDate(dashedCandidate, now);
        if (date) { consumed = length; break; }
      }
      const timeValue = normalizeTimeValue(parts.slice(consumed).join(' '));
      date = applyQuickAddTime(date || baseDateForKind(kind), timeValue, now) || date;
      return date;
    }

    function setDateField(kind, date, start, end) {
      if (!date || !Number.isFinite(date.getTime())) return;
      const field = kind === 'remind' ? 'remind_at' : 'due_date';
      changes[field] = date.toISOString();
      addTokenMatch(matches, matchIndexes, used, tokenSpans, tokens, kind === 'remind' ? 'reminder' : 'due', start, end, t(kind === 'remind' ? 'quickAdd.detected.reminder' : 'quickAdd.detected.due'), quickAddDateLabel(changes[field]), field);
    }

    function baseDateForKind(kind) {
      if (kind === 'remind') return changes.remind_at ? new Date(changes.remind_at) : (changes.due_date ? new Date(changes.due_date) : null);
      return changes.due_date ? new Date(changes.due_date) : null;
    }

    const dateCandidates = [];
    const prefixedRanges = [];
    const duePrefixPattern = aliasPattern(prefixAliases.due);
    const remindPrefixPattern = aliasPattern(prefixAliases.remind);
    const prefixedPatterns = [];
    if (duePrefixPattern) prefixedPatterns.push({ kind: 'due', regex: new RegExp(`(^|\\s)(?:${duePrefixPattern})\\s*:?\\s*(?<value>${valuePattern})(?=$|\\s)`, 'giu') });
    if (remindPrefixPattern) prefixedPatterns.push({ kind: 'remind', regex: new RegExp(`(^|\\s)(?:${remindPrefixPattern})\\s*:?\\s*(?<value>${valuePattern})(?=$|\\s)`, 'giu') });
    for (const { kind, regex } of prefixedPatterns) {
      for (const match of original.matchAll(regex)) {
        const value = match.groups?.value;
        const valueOffset = match[0].lastIndexOf(value);
        const start = match.index + match[0].search(/\S/u);
        const end = match.index + valueOffset + value.length;
        dateCandidates.push({ kind, value, start, end });
        prefixedRanges.push({ kind, start, end });
      }
    }

    if (datePattern) {
      const dueRegex = new RegExp(`(^|\\s)(?<value>(?:${datePattern})(?:\\s+${timePattern})?)(?=$|\\s)`, 'giu');
      for (const match of original.matchAll(dueRegex)) {
        const value = match.groups?.value;
        const start = match.index + match[0].lastIndexOf(value);
        const end = start + value.length;
        if (prefixedRanges.some(range => range.kind === 'remind' && range.start <= start && range.end >= end)) continue;
        dateCandidates.push({ kind: 'due', value, start, end });
      }
    }

    dateCandidates.sort((a, b) => a.start - b.start || (a.kind === 'remind' ? -1 : 1));
    for (const candidate of dateCandidates) {
      if (tokenSpans.some((span, index) => used.has(index) && span.start < candidate.end && span.end > candidate.start)) continue;
      const date = parseQuickAddDateValue(candidate.value, candidate.kind);
      setDateField(candidate.kind, date, candidate.start, candidate.end);
    }

    const explicitTimeRegex = new RegExp(`(^|\\s)(?<value>${timePattern})(?=$|\\s)`, 'giu');
    for (const match of original.matchAll(explicitTimeRegex)) {
      const value = match.groups?.value;
      const start = match.index + match[0].lastIndexOf(value);
      const end = start + value.length;
      if (tokenSpans.some((span, index) => used.has(index) && span.start < end && span.end > start)) continue;
      if (prefixedRanges.some(range => range.kind === 'remind' && range.start <= start && range.end >= end)) continue;
      if (!/[:.]|\s/.test(value)) continue;
      const date = parseQuickAddDateValue(value, 'due');
      setDateField('due', date, start, end);
    }

    const title = tokens.filter((_, index) => !used.has(index)).join(' ').trim() || original;
    return { title, changes, matches };
  }

  function renderQuickAddPreview(result) {
    const preview = document.getElementById('quick-add-preview');
    if (!preview) return;
    const matches = result?.matches || [];
    preview.innerHTML = '';
    preview.hidden = !matches.length;
    if (!matches.length) return;
    for (const match of matches) {
      const chip = document.createElement('span');
      chip.className = `quick-add-chip ${match.type}`;
      const label = document.createElement('span');
      label.className = 'quick-add-chip-label';
      label.textContent = match.label;
      const value = document.createElement('strong');
      value.textContent = match.value || match.token || '';
      chip.append(label, value);
      preview.appendChild(chip);
    }
  }

  function bindQuickAddPreview() {
    const input = document.getElementById('todo-title');
    if (!input || input.dataset.quickAddPreviewBound === '1') return;
    input.dataset.quickAddPreviewBound = '1';
    let seq = 0;
    const update = async () => {
      const id = document.getElementById('todo-id')?.value;
      if (id) { renderQuickAddPreview(null); return; }
      const mySeq = ++seq;
      const projectId = document.getElementById('todo-project')?.value || null;
      const result = await parseQuickAddTitle(input.value, getCurrentProjectId(), projectId);
      if (mySeq === seq) renderQuickAddPreview(result);
    };
    input.addEventListener('input', update);
    document.getElementById('todo-project')?.addEventListener('change', update);
    window.setTimeout(update, 0);
  }

  function getTodoDueTime(todo) {
    if (!todo?.due_date) return null;
    const date = new Date(todo.due_date);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function getSnoozeDate(mode, todo) {
    const now = new Date();
    const due = getTodoDueTime(todo);
    const next = new Date(mode === 'hour' && due ? due : now);
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

  function getSnoozeChanges(mode, todo) {
    const due = getSnoozeDate(mode, todo);
    const reminder = getTodoReminderTime(todo);
    const changes = { due_date: due.toISOString() };
    if (mode === 'hour' && reminder) {
      const nextReminder = new Date(reminder);
      nextReminder.setHours(nextReminder.getHours() + 1);
      changes.remind_at = nextReminder.toISOString();
      return changes;
    }
    const shiftedReminder = getSnoozedReminderDate(todo, due);
    if (shiftedReminder) changes.remind_at = shiftedReminder.toISOString();
    return changes;
  }


  async function setTodoStatus(id, status) {
    if (!getAppInitialized() || !getDb()) return;
    const todo = getTodos().find(x => String(x.id) === String(id));
    if (!todo || todo.status === status) return;
    const changes = { status };
    const openSubtasks = getOpenSubtaskCount(todo);
    if (status === 'done' && openSubtasks > 0) {
      const confirmed = await confirmDanger({
        title: t('todo.subtasks.completeWithOpenTitle'),
        message: t('todo.subtasks.completeWithOpenMessage', { count: openSubtasks }),
        confirmText: t('todo.subtasks.completeAnyway'),
      });
      if (!confirmed) return;
      changes.confirm_incomplete_subtasks_completion = true;
    }
    const nowIso = new Date().toISOString();
    const completed_at = status === 'done' ? nowIso : null;
    const updatedTodo = { ...todo, status, completed_at, updated_at: nowIso };
    await dbPut('todos', updatedTodo);
    setTodos(getTodos().map(item => String(item.id) === String(id) ? updatedTodo : item));
    renderStats();
    renderTodos();
    runHapticFeedback(status === 'done' ? 18 : 10);
    if (status === 'done') showToast(t('todo.toast.done'), { type: 'status', id: todo.id, previousStatus: todo.status });
    else if (todo.status === 'done' && status === 'pending') showToast(t('todo.toast.reopened'), { type: 'status', id: todo.id, previousStatus: todo.status });
    await addToSyncQueue('UPDATE_TODO', { id: todo.id, changes });
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

  const todoInteractiveTargetSelector = 'button, input, select, textarea, a, label, summary, details, .todo-check, .todo-actions, [role="button"], [contenteditable="true"]';

  function isTodoInteractiveTarget(target) {
    return Boolean(target?.closest?.(todoInteractiveTargetSelector));
  }

  function bindTodoItemClickBehavior() {
    if (document.documentElement.dataset.todoItemClickBound === '1') return;
    document.documentElement.dataset.todoItemClickBound = '1';
    let press = null;

    document.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button > 0) return;
      const item = event.target?.closest?.('.todo-item[data-id]');
      if (!item || isTodoInteractiveTarget(event.target)) return;
      press = { item, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
      item.classList.add('todo-press-active');
    }, { passive: true });

    document.addEventListener('pointermove', (event) => {
      if (!press || event.pointerId !== press.pointerId) return;
      if (Math.abs(event.clientX - press.startX) > 6 || Math.abs(event.clientY - press.startY) > 6) {
        press.moved = true;
        press.item.classList.remove('todo-press-active');
      }
    }, { passive: true });

    const clearPress = (event) => {
      if (!press || event.pointerId !== press.pointerId) return;
      press.item.classList.remove('todo-press-active');
      press = null;
    };
    document.addEventListener('pointerup', clearPress, { passive: true });
    document.addEventListener('pointercancel', clearPress, { passive: true });

    document.addEventListener('click', (event) => {
      if (event.defaultPrevented) return;
      const item = event.target?.closest?.('.todo-item[data-id]');
      if (!item) return;
      if (item.__niaRevealHandledAt && Date.now() - item.__niaRevealHandledAt < 700) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (isTodoInteractiveTarget(event.target)) return;
      event.preventDefault();
      editTodo(item.dataset.id);
    });
  }

  function bindTodoSwipeGestures() {
    if (document.documentElement.dataset.todoSwipeBound === '1') return;
    document.documentElement.dataset.todoSwipeBound = '1';

    const thresholdPx = 80;
    const thresholdRatio = 0.35;
    const lockThreshold = 10;
    const leftEdgeSwipeDeadzonePx = 72;
    const actionZoneLockThreshold = 36;
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
      if (!item) return;
      const startedInActionZone = Boolean(event.target.closest('.todo-actions'));
      if (isTodoInteractiveTarget(event.target) && !startedInActionZone) return;
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
        startedInActionZone,
        originalDraggable: item.getAttribute('draggable'),
      };
    }, { passive: true });

    function elasticSwipeDistance(rawDx, width) {
      const sign = rawDx < 0 ? -1 : 1;
      const distance = Math.abs(rawDx);
      const max = Math.max(0, width);
      const direct = Math.min(120, max * 0.32);
      if (!max || distance <= direct) return rawDx;
      const inputRange = Math.max(1, max * 0.95 - direct);
      const progress = Math.min(1, (distance - direct) / inputRange);
      const eased = direct + (max - direct) * (1 - Math.pow(1 - progress, 0.65));
      return sign * Math.min(max, eased);
    }

    function setSwipeVisual(item, visualDx, rawDx, actionThreshold) {
      const progress = Math.min(1, Math.abs(rawDx) / Math.max(1, actionThreshold));
      item.style.setProperty('--swipe-x', `${visualDx}px`);
      item.style.setProperty('--swipe-progress', progress.toFixed(3));
      item.classList.toggle('swipe-right', visualDx > 0);
      item.classList.toggle('swipe-left', visualDx < 0);
      item.classList.toggle('swipe-ready', progress >= 1);
    }

    function cleanupSwipeVisual(item) {
      item.classList.remove('swiping', 'swipe-right', 'swipe-left', 'swipe-ready', 'swipe-settling', 'swipe-committing');
      item.style.removeProperty('--swipe-x');
      item.style.removeProperty('--swipe-progress');
      item.removeAttribute('data-swipe-right-label');
      item.removeAttribute('data-swipe-left-label');
    }

    function wait(ms) {
      return new Promise(resolve => window.setTimeout(resolve, ms));
    }

    document.addEventListener('pointermove', (event) => {
      if (!active || event.pointerId !== active.pointerId) return;
      const dragDropActive = document.body.classList.contains('native-pointer-dragging') || active.item.classList.contains('dragging');
      if (dragDropActive) {
        cleanupSwipeVisual(active.item);
        active = null;
        suppressClickUntil = Date.now() + 450;
        return;
      }
      active.dx = event.clientX - active.startX;
      active.dy = event.clientY - active.startY;

      if (!active.locked) {
        const absX = Math.abs(active.dx);
        const absY = Math.abs(active.dy);
        const requiredLockThreshold = active.startedInActionZone ? actionZoneLockThreshold : lockThreshold;
        if (absX < requiredLockThreshold && absY < lockThreshold) return;
        const isRightSwipeFromLeftEdge = active.dx > 0 && active.startX < leftEdgeSwipeDeadzonePx;
        active.locked = absX >= requiredLockThreshold && absX > absY * 1.25 && !isRightSwipeFromLeftEdge ? 'horizontal' : 'vertical';
        if (active.locked === 'vertical') return;
        active.item.setAttribute('draggable', 'false');
        active.item.setAttribute('data-swipe-right-label', `↗ ${t('todo.status.inProgress')}`);
        active.item.setAttribute('data-swipe-left-label', `✓ ${t('todo.status.done')}`);
        active.item.classList.remove('touch-feedback');
        if (active.item.__niaTouchFeedbackTimer) window.clearTimeout(active.item.__niaTouchFeedbackTimer);
        active.item.classList.add('swiping');
      }

      if (active.locked !== 'horizontal') return;
      event.preventDefault();
      const actionThreshold = Math.max(thresholdPx, active.item.clientWidth * thresholdRatio);
      const dx = elasticSwipeDistance(active.dx, active.item.clientWidth);
      setSwipeVisual(active.item, dx, active.dx, actionThreshold);
      active.swiped = true;
    }, { passive: false });

    const finish = async (event) => {
      if (!active || event.pointerId !== active.pointerId) return;
      const current = active;
      active = null;
      const item = current.item;
      const actionThreshold = Math.max(thresholdPx, item.clientWidth * thresholdRatio);
      const shouldAct = current.locked === 'horizontal' && Math.abs(current.dx) >= actionThreshold;
      const restoreDraggable = () => {
        if (current.originalDraggable === null) item.removeAttribute('draggable');
        else item.setAttribute('draggable', current.originalDraggable);
      };

      if (current.swiped || shouldAct) suppressClickUntil = Date.now() + 450;
      if (current.locked === 'horizontal') event.preventDefault();

      if (!shouldAct) {
        if (current.swiped) {
          item.classList.add('swipe-settling');
          window.requestAnimationFrame(() => setSwipeVisual(item, 0, 0, actionThreshold));
          await wait(180);
        }
        cleanupSwipeVisual(item);
        restoreDraggable();
        return;
      }

      item.classList.add('swipe-committing');
      setSwipeVisual(item, current.dx < 0 ? -item.clientWidth : item.clientWidth, current.dx, actionThreshold);
      await wait(130);
      cleanupSwipeVisual(item);
      restoreDraggable();
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

  function setTodoActionsExpanded(current, expanded) {
    if (!current) return;
    current.classList.toggle('actions-expanded', Boolean(expanded));
    current.querySelector('.todo-actions-reveal-btn')?.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function closeOtherTodoActions(current) {
    document.querySelectorAll('.todo-item.actions-expanded').forEach((item) => {
      if (item === current) return;
      setTodoActionsExpanded(item, false);
    });
  }

  function toggleTodoActions(idOrItem, event = null) {
    event?.stopPropagation?.();
    const current = idOrItem?.classList?.contains?.('todo-item')
      ? idOrItem
      : Array.from(document.querySelectorAll('.todo-item')).find((item) => item.dataset.id === String(idOrItem));
    if (!current) return;
    const expanded = !current.classList.contains('actions-expanded');
    closeOtherTodoActions(current);
    setTodoActionsExpanded(current, expanded);
  }

  function bindTodoActionsReveal() {
    if (document.documentElement.dataset.todoActionsRevealBound === '1') return;
    document.documentElement.dataset.todoActionsRevealBound = '1';
    let suppressTodoClickUntil = 0;
    let suppressTodoClickItem = null;
    const handleReveal = (event) => {
      const button = event.target?.closest?.('.todo-actions-reveal-btn');
      if (!button) return;
      const item = button.closest('.todo-item[data-id]');
      if (!item) return;
      if (event.type === 'click' && button.__niaRevealPointerHandledAt && Date.now() - button.__niaRevealPointerHandledAt < 600) {
        event.preventDefault?.();
        event.stopPropagation?.();
        event.stopImmediatePropagation?.();
        return;
      }
      event.preventDefault?.();
      if (event.type === 'pointerup') button.__niaRevealPointerHandledAt = Date.now();
      item.__niaRevealHandledAt = Date.now();
      toggleTodoActions(item, event);
      event.stopImmediatePropagation?.();
    };
    const closeExpandedActionsFromEvent = (event, { suppressTodoClick = false } = {}) => {
      const expandedItems = Array.from(document.querySelectorAll('.todo-item.actions-expanded'));
      if (!expandedItems.length) return false;
      if (event.target?.closest?.('.todo-actions')) return false;
      expandedItems.forEach((item) => setTodoActionsExpanded(item, false));
      const tappedTodo = event.target?.closest?.('.todo-item[data-id]');
      if (suppressTodoClick && tappedTodo && !isTodoInteractiveTarget(event.target)) {
        suppressTodoClickUntil = Date.now() + 700;
        suppressTodoClickItem = tappedTodo;
      }
      return true;
    };
    const handleOutsidePointerDown = (event) => {
      if (!event.isPrimary || event.button > 0) return;
      closeExpandedActionsFromEvent(event, { suppressTodoClick: true });
    };
    const handleOutsideClick = (event) => {
      const tappedTodo = event.target?.closest?.('.todo-item[data-id]');
      const shouldSuppressTodoClick = Boolean(
        tappedTodo &&
        suppressTodoClickItem === tappedTodo &&
        Date.now() < suppressTodoClickUntil &&
        !isTodoInteractiveTarget(event.target)
      );
      const closed = closeExpandedActionsFromEvent(event, { suppressTodoClick: true });
      if (closed || shouldSuppressTodoClick) {
        event.preventDefault?.();
        event.stopPropagation?.();
        event.stopImmediatePropagation?.();
      }
      if (shouldSuppressTodoClick) suppressTodoClickItem = null;
    };
    document.addEventListener('pointerup', handleReveal, { capture: true, passive: false });
    document.addEventListener('click', handleReveal, true);
    document.addEventListener('pointerdown', handleOutsidePointerDown, { capture: true, passive: false });
    document.addEventListener('click', handleOutsideClick, true);
  }

  function resetTodoActionMenuPlacement(menu) {
    menu?.classList?.remove('opens-up', 'placement-ready');
  }

  function closeTodoActionMenus(except = null) {
    document.querySelectorAll('.todo-status-menu[open], .todo-snooze-menu[open]').forEach((menu) => {
      if (menu !== except) menu.removeAttribute('open');
    });
    document.querySelectorAll('.todo-status-menu.opens-up, .todo-status-menu.placement-ready, .todo-snooze-menu.opens-up, .todo-snooze-menu.placement-ready').forEach((menu) => {
      if (menu !== except) resetTodoActionMenuPlacement(menu);
    });
  }

  function updateTodoActionMenuPlacement(menu) {
    if (!menu?.open) return;
    const panel = menu.querySelector('.todo-action-menu');
    const summary = menu.querySelector('summary');
    if (!panel || !summary) return;
    menu.classList.remove('opens-up', 'placement-ready');
    const summaryRect = summary.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const safeGap = 8;
    const spaceBelow = viewportHeight - summaryRect.bottom - safeGap;
    const spaceAbove = summaryRect.top - safeGap;
    if (panelRect.height > spaceBelow && spaceAbove > spaceBelow) {
      menu.classList.add('opens-up');
    }
    menu.classList.add('placement-ready');
  }

  function placeOpenTodoActionMenus() {
    document.querySelectorAll('.todo-status-menu[open]:not(.placement-ready), .todo-snooze-menu[open]:not(.placement-ready)').forEach(updateTodoActionMenuPlacement);
  }

  function bindTodoStatusMenuBehavior() {
    if (document.documentElement.dataset.todoStatusMenuBound === '1') return;
    document.documentElement.dataset.todoStatusMenuBound = '1';

    document.addEventListener('click', (event) => {
      const menu = event.target?.closest?.('.todo-status-menu, .todo-snooze-menu');
      closeTodoActionMenus(menu || null);
      if (menu) queueMicrotask(placeOpenTodoActionMenus);
    });

    document.addEventListener('toggle', (event) => {
      const menu = event.target?.closest?.('.todo-status-menu, .todo-snooze-menu');
      if (menu?.open) {
        closeTodoActionMenus(menu);
        updateTodoActionMenuPlacement(menu);
      } else if (menu) {
        resetTodoActionMenuPlacement(menu);
      }
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

    function getShortcutTodoId() {
      const focusedItem = document.activeElement?.closest?.('.todo-item[data-id]');
      const id = focusedItem?.dataset.id || hoveredTodoId;
      if (!id) return null;
      const item = Array.from(document.querySelectorAll('.todo-item[data-id]')).find(el => el.dataset.id === String(id));
      return item ? item.dataset.id : null;
    }

    document.addEventListener('keydown', async (event) => {
      const isSpace = event.key === ' ' || event.key === 'Spacebar';
      const isDelete = event.key === 'Delete';
      if (!isSpace && !isDelete) return;
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isInteractiveTarget(document.activeElement)) return;
      if (document.querySelector('.modal.active')) return;
      const todoId = getShortcutTodoId();
      if (!todoId) return;
      event.preventDefault();
      if (isDelete) await deleteTodo(Number(todoId));
      else await toggleTodo(todoId);
    });
  }

  bindTodoItemClickBehavior();
  bindTodoSwipeGestures();
  bindTodoActionsReveal();
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
    hydrateTodoSelects();
    bindRecurringControls();
    bindLocationReminderControls();
    bindTodoDescriptionInlineEditor();
    updateTodoDetailViewMode(todo);
    await loadSavedPlacesForTodoModal();
    deletingSubtaskIds.clear();
    document.getElementById('todo-form')?.reset();
    clearDateTimeErrors();
    clearLocationReminderForm();
    document.getElementById('todo-id').value = '';
    const newSubtaskInput = document.getElementById('todo-subtask-new-title');
    if (newSubtaskInput) newSubtaskInput.value = '';
    renderTodoSubtaskEditor([]);
    renderTodoComments([], null);
    renderTodoAttachments([], null);
    updateTodoMetaPanelsOpenState(null);
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
        const opt = document.createElement('option');
        opt.value = projectNode.id;
        opt.style.color = projectNode.color;
        opt.dataset.depth = String(depth);
        opt.dataset.projectColor = projectNode.color || '#6366f1';
        opt.dataset.projectIcon = projectNode.icon || '';
        opt.textContent = projectNode.name;
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
      const recurringRule = normalizeRecurringRule(todo.recurring_rule, { defaultTimezone: null });
      document.getElementById('todo-recurring-frequency').value = recurringRule?.frequency || 'none';
      document.getElementById('todo-recurring-interval').value = recurringRule?.interval || 1;
      updateRecurringControls();
      const reminderDate = todo.remind_at || (todo.reminders && todo.reminders[0] && todo.reminders[0].remind_at);
      if (reminderDate) {
        const d = new Date(reminderDate);
        document.getElementById('todo-remind').value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      }
      populateLocationReminderForm(todo);
      renderTodoSubtaskEditor(todo.subtasks || []);
      renderTodoComments(todo.comments || [], todo);
      renderTodoAttachments(todo.attachments || [], todo);
      updateTodoMetaPanelsOpenState(todo);
      renderTodoMetaSummary(todo);
    } else {
      document.getElementById('todo-pinned').checked = false;
      document.getElementById('todo-recurring-frequency').value = 'none';
      document.getElementById('todo-recurring-interval').value = 1;
      updateRecurringControls();
      renderTodoComments([], null);
      renderTodoAttachments([], null);
      const currentWorkspaceId = getCurrentWorkspaceId?.();
      const workspaceProjects = getProjects().filter(p => !p.is_shared && (!currentWorkspaceId || String(p.workspace_id || '') === String(currentWorkspaceId)));
      const inboxProject = workspaceProjects.find(p => p.is_inbox) || workspaceProjects[0];
      document.getElementById('todo-project').value = getCurrentProjectId() || inboxProject?.id || '';
      await onProjectChange(null);
      updateTodoMetaPanelsOpenState(null);
    }

    hydrateTodoSelects();
    updateRecurringControls();
    document.getElementById('todo-delete-btn').style.display = todo ? '' : 'none';
    const duplicateBtn = document.getElementById('todo-duplicate-btn');
    if (duplicateBtn) duplicateBtn.style.display = todo ? '' : 'none';
    setupDescPreview();
    bindQuickAddPreview();
    renderQuickAddPreview(null);
    if (!todo) {
      const quickAddResult = await parseQuickAddTitle(document.getElementById('todo-title')?.value || '', getCurrentProjectId(), document.getElementById('todo-project')?.value || null);
      renderQuickAddPreview(quickAddResult);
    }
    resetTodoSaveSnapshot();
    updateTodoDetailViewMode(todo);
    renderTodoMetaSummary(todo);
    document.getElementById('todo-desc-preview')?.setAttribute('tabindex', todo ? '0' : '-1');
    document.getElementById('todo-modal')?.classList.add('active');
    if (!todo) focusTodoTitle();
  }

  async function onProjectChange(selectedSectionId = null) {
    const projectId = document.getElementById('todo-project').value;
    const sectionSelect = document.getElementById('todo-section');
    if (!sectionSelect) return;
    sectionSelect.innerHTML = `<option value="" data-i18n-key="todo.section.none">${t('todo.section.none')}</option>`;
    sectionSelect.disabled = true;
    refreshTodoSelect('todo-section');
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
    } finally {
      refreshTodoSelect('todo-section');
    }
  }

  async function saveTodo(event) {
    event.preventDefault();
    if (!getAppInitialized() || !getDb()) return;
    if (!validateTodoDateTimes()) return;
    const id = document.getElementById('todo-id').value;
    const parsedQuickAdd = id ? null : await parseQuickAddTitle(document.getElementById('todo-title').value, getCurrentProjectId(), document.getElementById('todo-project')?.value || null);
    const todoData = {
      title: parsedQuickAdd?.title || document.getElementById('todo-title').value,
      description: document.getElementById('todo-desc').value,
      priority: parseInt(document.getElementById('todo-priority').value),
      is_pinned: document.getElementById('todo-pinned')?.checked || false,
      project_id: document.getElementById('todo-project').value ? parseInt(document.getElementById('todo-project').value) : null,
      section_id: document.getElementById('todo-section').value ? parseInt(document.getElementById('todo-section').value) : null,
      status: document.getElementById('todo-status').value,
      subtasks: collectTodoSubtasksFromEditor(),
      due_date: toIsoOrNull('todo-due'),
      remind_at: toIsoOrNull('todo-remind'),
      recurring_rule: recurringRuleFromForm(),
    };
    try {
      todoData.location_reminder = locationReminderFromForm();
    } catch (_error) {
      return;
    }
    if (parsedQuickAdd) {
      if (parsedQuickAdd.changes.priority && Number(document.getElementById('todo-priority').value) === 3) todoData.priority = parsedQuickAdd.changes.priority;
      if (parsedQuickAdd.changes.project_id) todoData.project_id = parsedQuickAdd.changes.project_id;
      if (parsedQuickAdd.changes.section_id && !todoData.section_id) todoData.section_id = parsedQuickAdd.changes.section_id;
      if (parsedQuickAdd.changes.due_date && !todoData.due_date) todoData.due_date = parsedQuickAdd.changes.due_date;
      if (parsedQuickAdd.changes.remind_at && !todoData.remind_at) todoData.remind_at = parsedQuickAdd.changes.remind_at;
      if (parsedQuickAdd.changes.recurring_rule && !todoData.recurring_rule) todoData.recurring_rule = parsedQuickAdd.changes.recurring_rule;
    }
    if (todoData.status === 'done' && getOpenSubtaskCount(todoData.subtasks) > 0) {
      const confirmed = await confirmDanger({
        title: t('todo.subtasks.completeWithOpenTitle'),
        message: t('todo.subtasks.completeWithOpenMessage', { count: getOpenSubtaskCount(todoData.subtasks) }),
        confirmText: t('todo.subtasks.completeAnyway'),
      });
      if (!confirmed) return;
      todoData.confirm_incomplete_subtasks_completion = true;
    }
    if (todoData.recurring_rule && !todoData.due_date) {
      const dueInput = document.getElementById('todo-due');
      const dueError = document.getElementById('todo-due-error');
      const message = t('todo.recurring.deadlineRequired');
      dueInput?.setCustomValidity(message);
      if (dueError) dueError.textContent = message;
      dueInput?.focus();
      return;
    }
    if (todoData.section_id && todoData.project_id) {
      const allSections = await loadSectionsForQuickAdd();
      const selectedSection = allSections.find(section => String(section.id) === String(todoData.section_id));
      if (!selectedSection || String(selectedSection.project_id) !== String(todoData.project_id)) todoData.section_id = null;
    }
    todoData.location_reminders = locationReminderArrayFromPayload(todoData.location_reminder);
    if (id) delete todoData.subtasks;
    if (id) {
      const existing = getTodos().find(t => t.id === parseInt(id));
      if (existing) {
        const nowIso = new Date().toISOString();
        const updated = { ...existing, ...todoData, completed_at: todoData.status === 'done' ? (existing.completed_at || nowIso) : null, updated_at: nowIso };
        await dbPut('todos', updated);
        setTodos(getTodos().map(t => t.id === parseInt(id) ? updated : t));
        await addToSyncQueue('UPDATE_TODO', { id: parseInt(id), changes: todoData });
        if (isOnlineForSync()) await syncWithServer();
      }
    } else {
      const tempId = 'temp-' + Date.now();
      const nowIso = new Date().toISOString();
      const newTodo = { id: tempId, ...todoData, completed_at: todoData.status === 'done' ? nowIso : null, created_at: nowIso, updated_at: nowIso, reminders: [], subtasks: normalizeSubtasks(todoData.subtasks) };
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
    const nowIso = new Date().toISOString();
    const statusChanged = Object.prototype.hasOwnProperty.call(changes, 'status');
    const completed_at = statusChanged ? (changes.status === 'done' ? (todo.completed_at || nowIso) : null) : todo.completed_at;
    const updatedTodo = { ...todo, ...changes, completed_at, updated_at: nowIso };
    await dbPut('todos', updatedTodo);
    setTodos(getTodos().map(item => String(item.id) === String(id) ? updatedTodo : item));
    renderStats();
    renderTodos();
    if (toastMessage) {
      const previousChanges = Object.fromEntries(Object.keys(changes).map((key) => {
        if (key === 'remind_at') return [key, getTodoReminderTime(todo)?.toISOString() || null];
        return [key, todo[key] ?? null];
      }));
      showToast(toastMessage, { type: 'fields', id: todo.id, changes: previousChanges });
    }
    await addToSyncQueue('UPDATE_TODO', { id: todo.id, changes });
    if (isOnlineForSync()) await syncWithServer();
  }

  async function toggleTodoPin(id) {
    const todo = getTodos().find(x => String(x.id) === String(id));
    if (!todo) return;
    await updateTodoFields(id, { is_pinned: !Boolean(todo.is_pinned) }, Boolean(todo.is_pinned) ? t('todo.toast.unpinned') : t('todo.toast.pinned'));
  }


  function getTodoReminderTime(todo) {
    const raw = todo?.remind_at || todo?.reminders?.find?.(reminder => !reminder.sent_at)?.remind_at || todo?.reminders?.[0]?.remind_at;
    if (!raw) return null;
    const date = new Date(raw);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function getSnoozedReminderDate(todo, nextDue) {
    const reminder = getTodoReminderTime(todo);
    if (!reminder || !nextDue || !Number.isFinite(nextDue.getTime())) return null;
    const previousDue = todo?.due_date ? new Date(todo.due_date) : null;
    if (previousDue && Number.isFinite(previousDue.getTime())) {
      return new Date(reminder.getTime() + (nextDue.getTime() - previousDue.getTime()));
    }
    return new Date(nextDue);
  }

  async function snoozeTodo(id, mode) {
    const todo = getTodos().find(x => String(x.id) === String(id));
    if (!todo) return;
    const changes = getSnoozeChanges(mode, todo);
    await updateTodoFields(id, changes, t('todo.toast.snoozed'));
  }


  function cloneLocationReminderPayload(todo) {
    const source = todo?.location_reminder || todo?.location_reminders?.find?.(entry => entry && entry.enabled !== 0 && entry.enabled !== false) || null;
    if (!source) return null;
    return {
      enabled: Boolean(source.enabled ?? true),
      trigger_type: source.trigger_type || source.triggerType || 'arrival',
      place_id: source.place_id || source.placeId || null,
      place_name: source.place_name || source.placeName || null,
      address: source.address || null,
      latitude: source.latitude ?? null,
      longitude: source.longitude ?? null,
      radius_meters: source.radius_meters ?? source.radiusMeters ?? 150,
    };
  }

  async function duplicateTodo(id) {
    if (!getAppInitialized() || !getDb()) return;
    const todo = getTodos().find(x => String(x.id) === String(id));
    if (!todo) return;
    const reminder = getTodoReminderTime(todo);
    const todoData = {
      title: todo.title,
      description: todo.description || '',
      priority: Number(todo.priority) || 3,
      is_pinned: Boolean(todo.is_pinned),
      project_id: todo.project_id ?? null,
      section_id: todo.section_id ?? null,
      status: 'pending',
      due_date: todo.due_date || null,
      remind_at: reminder ? reminder.toISOString() : null,
      recurring_rule: todo.recurring_rule || null,
      subtasks: normalizeSubtasks(todo.subtasks || []).map((subtask, index) => ({ title: subtask.title, is_done: false, sort_order: index })),
      location_reminder: cloneLocationReminderPayload(todo),
    };
    todoData.location_reminders = locationReminderArrayFromPayload(todoData.location_reminder);
    const tempId = 'temp-' + Date.now();
    const nowIso = new Date().toISOString();
    const duplicated = { id: tempId, ...todoData, completed_at: null, created_at: nowIso, updated_at: nowIso, reminders: todoData.remind_at ? [{ remind_at: todoData.remind_at }] : [] };
    await dbPut('todos', duplicated);
    setTodos([...getTodos(), duplicated]);
    renderStats();
    renderTodos();
    showToast(t('todo.toast.duplicated'));
    await addToSyncQueue('CREATE_TODO', { ...todoData, _tempId: tempId });
    if (isOnlineForSync()) await syncWithServer();
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
    await addToSyncQueue('DELETE_TODO', { id, undo_grace_until: Date.now() + 5000 });
    if (isOnlineForSync()) await syncWithServer();
    setTimeout(() => {
      if (isOnlineForSync()) syncWithServer();
    }, 5200);
  }

  return { markTodoDone, markTodoInProgress, setTodoStatus, toggleTodo, toggleTodoPin, toggleTodoActions, addTodoSubtaskFromInput, addTodoCommentFromInput, uploadTodoAttachmentFromInput, deleteTodoComment, deleteTodoAttachment, closeAttachmentPreview, downloadPreviewAttachment, snoozeTodo, duplicateTodo, showTodoModal, onProjectChange, saveTodo, editTodo, deleteTodoFromModal, deleteTodo };
}
