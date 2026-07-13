import { RUNTIME_CAPABILITIES } from '../core/config.js';
import { getActiveLanguage, getActiveLocale, t, translatePage } from '../i18n/index.js';
import { iconSvg } from '../icons/lucide-icons.js';
import { hydrateSelect, refreshSelect } from '../ui/dropdowns.js';
import { createNativeBridge } from './native-bridge.js';
import { createTodoAttachmentsFeature } from './todo-attachments.js';
import { createTodoQuickAddFeature } from './todo-quick-add.js';

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
  const deletingSubtaskIds = new Set();
  const TODO_MODAL_CLASSES = Object.freeze({
    detail: 'todo-detail-view',
    create: 'todo-create-view',
    editingDescription: 'todo-desc-editing',
    editingMeta: 'todo-meta-editing',
  });

  const {
    getSelectedAttachmentFiles,
    renderTodoAttachments,
    uploadTodoAttachmentFromInput,
    closeAttachmentPreview,
    downloadPreviewAttachment,
    deleteTodoAttachment,
    bindTodoAttachmentInputs,
  } = createTodoAttachmentsFeature({
    getTodos,
    setTodos,
    getProjects,
    getCurrentUser,
    setCurrentUser,
    getAppInitialized,
    getDb,
    dbPut,
    isOnlineForSync,
    todosApi,
    renderStats,
    renderTodos,
    closeModal,
    confirmDanger,
    showToast,
    t,
    iconSvg,
    escapeHtmlAttr,
    setTodoCollapsibleOpen,
    refreshTodoActionButtonState,
    refreshTodoSaveButtonState,
    nativeBridge,
  });

  const {
    nextWeekday,
    loadSectionsForQuickAdd,
    parseQuickAddTitle,
    renderQuickAddPreview,
    bindQuickAddPreview,
  } = createTodoQuickAddFeature({
    getActiveLanguage,
    t,
    getProjects,
    getCurrentProjectId,
    getSavedPlaces: () => savedPlaces,
    dbGetAll,
  });

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

  function getTodoModal() {
    return document.getElementById('todo-modal');
  }

  function getTodoBeingEdited() {
    const id = document.getElementById('todo-id')?.value;
    if (!id) return null;
    return getTodos().find(todo => String(todo.id) === String(id)) || null;
  }

  function resizeTodoTitleField() {
    const titleField = document.getElementById('todo-title');
    if (!titleField || titleField.tagName !== 'TEXTAREA') return;
    titleField.style.height = 'auto';
    titleField.style.height = `${titleField.scrollHeight}px`;
  }

  function bindTodoTitleFieldAutosize() {
    const titleField = document.getElementById('todo-title');
    if (!titleField || titleField.dataset.titleAutosizeBound === '1') return;
    titleField.dataset.titleAutosizeBound = '1';
    titleField.addEventListener('input', resizeTodoTitleField);
    titleField.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || (!event.ctrlKey && !event.metaKey) || event.altKey) return;
      event.preventDefault();
      titleField.form?.requestSubmit();
    });
  }


  function updateTodoMetaPanelsOpenState(todo = null) {
    const existingTodo = Boolean(todo?.id);
    setTodoCollapsibleOpen('todo-subtasks-panel', existingTodo);
    setTodoCollapsibleOpen('todo-comments-panel', existingTodo);
    setTodoCollapsibleOpen('todo-attachments-panel', existingTodo);
    if (existingTodo) return;
    setTodoCollapsibleOpen('todo-subtasks-panel', true);
    setTodoCollapsibleOpen('todo-comments-panel', true);
    setTodoCollapsibleOpen('todo-attachments-panel', true);
  }

  function formatTodoMetaDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(getActiveLocale(), {
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
      drawer.setAttribute('aria-label', t('todo.meta.drawerAria'));
      drawer.innerHTML = `
        <div class="todo-meta-drawer-header">
          <div>
            <h4>${escapeHtmlAttr(t('todo.meta.drawerTitle'))}</h4>
            <p>${escapeHtmlAttr(t('todo.meta.drawerSubtitle'))}</p>
          </div>
          <button type="button" class="todo-meta-drawer-close" aria-label="${escapeHtmlAttr(t('todo.meta.close'))}">${iconSvg('x')}</button>
        </div>
        <div class="todo-meta-drawer-body"></div>
      `;
      drawer.querySelector('.todo-meta-drawer-close')?.addEventListener('click', () => {
        getTodoModal()?.classList.remove(TODO_MODAL_CLASSES.editingMeta);
        renderTodoMetaSummary(getTodoBeingEdited());
      });
      form.appendChild(drawer);
    }
    const body = drawer.querySelector('.todo-meta-drawer-body') || drawer;
    if (organize.parentElement !== body) body.appendChild(organize);
    if (schedule.parentElement !== body) body.appendChild(schedule);
    return drawer;
  }

  function todoLocationReminderLabel(todo) {
    const reminder = todo?.location_reminder || todo?.location_reminders?.find?.((entry) => entry && entry.enabled !== 0 && entry.enabled !== false) || null;
    if (!reminder || reminder.enabled === 0 || reminder.enabled === false) return '';
    const trigger = String(reminder.trigger_type || reminder.triggerType || '').toLowerCase();
    const triggerLabel = trigger === 'departure' ? t('todo.location.departureShort') : t('todo.location.arrivalShort');
    const place = String(reminder.place_name || reminder.placeName || reminder.address || '').trim();
    return place ? `${triggerLabel}: ${place}` : triggerLabel;
  }

  function renderTodoMetaSummary(todo = null) {
    const summary = ensureTodoMetaSummary();
    if (!summary) return;
    ensureTodoMetaDrawer();
    summary.hidden = false;
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
    const dueValue = todo?.due_date || document.getElementById('todo-due')?.value || '';
    const remindValue = todo?.remind_at || todo?.reminders?.[0]?.remind_at || document.getElementById('todo-remind')?.value || '';
    const dueDate = dueValue ? new Date(dueValue) : null;
    const isOverdue = dueDate && status !== 'done' && dueDate < new Date();
    const isSoon = dueDate && !isOverdue && status !== 'done' && dueDate <= new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const priorityTone = { 1: 'priority-very-high', 2: 'priority-high', 3: 'priority-medium', 4: 'priority-low' }[priority] || 'priority-low';
    const statusTone = status === 'done' ? 'status-done' : status === 'in_progress' ? 'status-in-progress' : 'status-pending';
    const statusIcon = status === 'done' ? 'check-circle' : status === 'in_progress' ? 'flame' : 'clock';
    const dueTone = isOverdue ? 'due-overdue' : isSoon ? 'due-soon' : 'due-neutral';
    const projectIcon = /^[a-z0-9-]+$/i.test(String(selectedProject?.icon || '')) ? selectedProject.icon : 'folder';
    addChip(projectIcon, t('todo.project'), getSelectedOptionLabel('todo-project'), { tone: 'project', color: selectedProject?.color });
    addChip('layers', t('todo.section'), getSelectedOptionLabel('todo-section'), { tone: 'section' });
    addChip('flag', t('todo.priority'), getSelectedOptionLabel('todo-priority'), { tone: priorityTone });
    addChip(statusIcon, t('todo.status'), getSelectedOptionLabel('todo-status'), { tone: statusTone });
    addChip(isOverdue ? 'triangle-alert' : 'calendar-days', t('todo.deadline'), formatTodoMetaDate(dueValue), { tone: dueTone });
    addChip('bell', t('todo.reminder'), formatTodoMetaDate(remindValue), { tone: 'reminder' });
    addChip('map-pin', t('quickAdd.detected.location'), todoLocationReminderLabel(todo), { tone: 'location' });
    const selectedFrequency = document.getElementById('todo-recurring-frequency')?.value || 'none';
    const recurringRule = todo?.recurring_rule ? normalizeRecurringRule(todo.recurring_rule, { defaultTimezone: null }) : { frequency: selectedFrequency };
    if (recurringRule && recurringRule.frequency !== 'none') addChip('repeat', t('todo.recurring'), getSelectedOptionLabel('todo-recurring-frequency'));
    if (todo?.is_pinned || document.getElementById('todo-pinned')?.checked) addChip('star', t('todo.pinned'), t('todo.meta.pinnedYes'));
    const empty = t('todo.meta.empty');
    const edit = t('todo.meta.edit');
    summary.innerHTML = `
      <div class="todo-meta-summary-chips">${chips.length ? chips.join('') : `<span class="todo-meta-summary-empty">${empty}</span>`}</div>
      <button type="button" class="btn btn-secondary todo-detail-action-btn todo-meta-edit-toggle" id="todo-meta-edit-toggle">${edit}</button>
    `;
    const toggle = summary.querySelector('#todo-meta-edit-toggle');
    const syncToggleLabel = () => {
      const active = getTodoModal()?.classList.contains(TODO_MODAL_CLASSES.editingMeta);
      const label = active ? t('todo.meta.close') : edit;
      toggle.innerHTML = `${iconSvg(active ? 'x' : 'settings')}<span>${escapeHtmlAttr(label)}</span>`;
    };
    toggle?.addEventListener('click', () => {
      getTodoModal()?.classList.toggle(TODO_MODAL_CLASSES.editingMeta);
      syncToggleLabel();
    });
    syncToggleLabel();
    translatePage(summary);
  }

  function ensureTodoDetailHeaderMenu() {
    const actions = document.getElementById('todo-detail-header-actions');
    if (!actions) return null;
    const menu = actions.querySelector('.todo-detail-header-menu-toggle');
    if (actions.dataset.todoHeaderActionsBound !== '1') {
      actions.dataset.todoHeaderActionsBound = '1';
      actions.querySelector('#todo-detail-duplicate-action')?.addEventListener('click', () => {
        menu?.removeAttribute('open');
        const id = document.getElementById('todo-id')?.value;
        if (id) {
          duplicateTodo(id);
          closeModal('todo-modal');
        }
      });
      actions.querySelector('#todo-detail-delete-action')?.addEventListener('click', () => {
        menu?.removeAttribute('open');
        deleteTodoFromModal();
      });
    }
    if (menu && menu.dataset.outsideCloseBound !== '1') {
      menu.dataset.outsideCloseBound = '1';
      document.addEventListener('pointerdown', (event) => {
        if (!menu.open || menu.contains(event.target)) return;
        menu.removeAttribute('open');
      });
    }
    translatePage(actions);
    return actions;
  }

  function updateTodoDetailViewMode(todo = null) {
    const modal = getTodoModal();
    if (!modal) return;
    const isExistingTodo = Boolean(todo?.id);
    modal.classList.add(TODO_MODAL_CLASSES.detail);
    modal.classList.toggle(TODO_MODAL_CLASSES.create, !isExistingTodo);
    modal.classList.remove(TODO_MODAL_CLASSES.editingDescription);
    const shouldOpenMetaDrawer = !isExistingTodo && !window.matchMedia?.('(max-width: 1180px)')?.matches;
    modal.classList.toggle(TODO_MODAL_CLASSES.editingMeta, shouldOpenMetaDrawer);
    const headerActions = ensureTodoDetailHeaderMenu();
    const headerMenu = headerActions?.querySelector('.todo-detail-header-menu-toggle');
    if (headerMenu) headerMenu.hidden = !isExistingTodo;
    const preview = document.getElementById('todo-desc-preview');
    if (preview) preview.dataset.emptyLabel = t('todo.description.add');
    renderTodoMetaSummary(todo);
  }

  function htmlNodeToMarkdown(node, listDepth = 0) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    const children = (depth = listDepth) => Array.from(node.childNodes).map(child => htmlNodeToMarkdown(child, depth)).join('');
    if (tag === 'br') return '\n';
    if (tag === 'strong' || tag === 'b') return `**${children()}**`;
    if (tag === 'em' || tag === 'i') return `*${children()}*`;
    if (tag === 'u') return `<u>${children()}</u>`;
    if (tag === 'code') return `\`${children()}\``;
    if (tag === 'blockquote') return children().split('\n').map(line => line.trim() ? `> ${line.trim()}` : '').join('\n') + '\n\n';
    if (tag === 'h1') return `# ${children().trim()}\n\n`;
    if (tag === 'h2') return `## ${children().trim()}\n\n`;
    if (tag === 'h3') return `### ${children().trim()}\n\n`;
    if (tag === 'li') {
      const marginDepth = Math.max(0, Math.round((parseFloat(node.style?.marginLeft || '') || 0) / 40));
      const effectiveListDepth = listDepth + marginDepth;
      const direct = Array.from(node.childNodes)
        .filter(child => !(child.nodeType === Node.ELEMENT_NODE && ['ul', 'ol'].includes(child.tagName.toLowerCase())))
        .map(child => htmlNodeToMarkdown(child, effectiveListDepth))
        .join('')
        .trim();
      const nested = Array.from(node.childNodes)
        .filter(child => child.nodeType === Node.ELEMENT_NODE && ['ul', 'ol'].includes(child.tagName.toLowerCase()))
        .map(child => htmlNodeToMarkdown(child, effectiveListDepth + 1))
        .join('');
      return `${'  '.repeat(effectiveListDepth)}- ${direct}\n${nested}`;
    }
    if (tag === 'ul' || tag === 'ol') {
      return `${Array.from(node.childNodes).map(child => {
        if (child.nodeType === Node.ELEMENT_NODE && ['ul', 'ol'].includes(child.tagName.toLowerCase())) {
          return htmlNodeToMarkdown(child, listDepth + 1);
        }
        return htmlNodeToMarkdown(child, listDepth);
      }).join('')}\n`;
    }
    if (tag === 'p' || tag === 'div') return `${children().trim()}\n\n`;
    return children();
  }

  function insertInlineCode(editor) {
    const selection = window.getSelection?.();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    const text = selection.toString() || 'code';
    document.execCommand('insertHTML', false, `<code>${escapeHtml(text)}</code>`);
  }

  function richEditorToolbarHtml() {
    return `
      <button type="button" data-rich-command="bold"><strong>B</strong></button>
      <button type="button" data-rich-command="italic"><em>I</em></button>
      <button type="button" data-rich-command="underline"><u>U</u></button>
      <button type="button" data-rich-block="h1">H1</button>
      <button type="button" data-rich-block="h2">H2</button>
      <button type="button" data-rich-block="blockquote">${escapeHtmlAttr(t('todo.description.quote'))}</button>
      <button type="button" data-rich-format="code">${escapeHtmlAttr(t('todo.description.code'))}</button>
      <button type="button" data-rich-command="insertUnorderedList">${escapeHtmlAttr(t('todo.description.bulletList'))}</button>
    `;
  }

  function richDescriptionToMarkdown(editor) {
    return Array.from(editor.childNodes)
      .map(htmlNodeToMarkdown)
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function setToolbarButtonActive(button, active) {
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  function getSelectionElementWithin(root) {
    const selection = window.getSelection?.();
    if (!selection?.rangeCount) return null;
    const node = selection.anchorNode;
    const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!element || !root.contains(element)) return null;
    return element;
  }

  function closestInside(element, selector, root) {
    const match = element?.closest?.(selector);
    return match && root.contains(match) ? match : null;
  }

  function clearToolbarState(toolbar) {
    toolbar?.querySelectorAll?.('button[aria-pressed]')?.forEach(button => setToolbarButtonActive(button, false));
  }

  let activeRichKeyboardToolbar = null;
  let richKeyboardViewportBound = false;
  const richKeyboardToolbarPortals = new WeakMap();

  function isLikelyTouchKeyboardOpen() {
    const viewport = window.visualViewport;
    if (!viewport) return false;
    const coarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches;
    if (!coarsePointer) return false;
    const layoutHeight = Math.max(window.innerHeight || 0, document.documentElement?.clientHeight || 0);
    const screenHeight = window.screen?.height || layoutHeight;
    const hiddenLayoutSpace = layoutHeight - viewport.height - viewport.offsetTop;
    const hiddenScreenSpace = screenHeight - viewport.height;
    return hiddenLayoutSpace > 80 || hiddenScreenSpace > Math.max(180, screenHeight * 0.22);
  }

  function getRichKeyboardToolbarWrap(toolbar) {
    return richKeyboardToolbarPortals.get(toolbar)?.wrap || toolbar?.closest?.('.todo-rich-keyboard-wrap') || toolbar?.parentElement || null;
  }

  function portalRichKeyboardToolbar(toolbar, wrap) {
    if (!toolbar || !wrap || richKeyboardToolbarPortals.has(toolbar)) return;
    richKeyboardToolbarPortals.set(toolbar, {
      parent: toolbar.parentNode,
      nextSibling: toolbar.nextSibling,
      wrap,
    });
    document.body.appendChild(toolbar);
  }

  function restoreRichKeyboardToolbar(toolbar) {
    const portal = richKeyboardToolbarPortals.get(toolbar);
    if (!portal) return;
    const anchor = portal.nextSibling?.parentNode === portal.parent ? portal.nextSibling : null;
    if (portal.parent?.isConnected) portal.parent.insertBefore(toolbar, anchor);
    richKeyboardToolbarPortals.delete(toolbar);
  }

  function releaseRichKeyboardToolbarFixed(toolbar = activeRichKeyboardToolbar) {
    if (!toolbar) return;
    const wrap = getRichKeyboardToolbarWrap(toolbar);
    toolbar.classList.remove('is-keyboard-fixed');
    toolbar.style.removeProperty('--todo-rich-toolbar-left');
    toolbar.style.removeProperty('--todo-rich-toolbar-width');
    toolbar.style.removeProperty('--todo-rich-toolbar-top');
    wrap?.classList.remove('is-keyboard-toolbar-fixed');
    wrap?.style.removeProperty('--todo-rich-toolbar-height');
    restoreRichKeyboardToolbar(toolbar);
  }

  function clearRichKeyboardToolbar() {
    activeRichKeyboardToolbar?.classList.remove('is-stuck');
    releaseRichKeyboardToolbarFixed();
    activeRichKeyboardToolbar = null;
  }

  function getRichToolbarScrollPort(toolbar) {
    return toolbar?.closest?.('.ui-detail-modal-body') || toolbar?.closest?.('.modal-content') || null;
  }

  function updateRichToolbarStickyState(toolbar) {
    if (!toolbar) return;
    if (toolbar.classList.contains('is-keyboard-fixed')) {
      toolbar.classList.add('is-stuck');
      return;
    }
    const scrollPort = getRichToolbarScrollPort(toolbar);
    if (!scrollPort) {
      toolbar.classList.remove('is-stuck');
      return;
    }
    const toolbarTop = toolbar.getBoundingClientRect().top;
    const scrollPortTop = scrollPort.getBoundingClientRect().top;
    const isAtStickyEdge = toolbarTop <= scrollPortTop + 8;
    toolbar.classList.toggle('is-stuck', scrollPort.scrollTop > 0 && isAtStickyEdge);
  }

  function updateRichKeyboardToolbar() {
    const toolbar = activeRichKeyboardToolbar;
    if (!toolbar) return;
    if (!document.activeElement?.closest?.('.todo-desc-rich-editor, .todo-comment-rich-editor')) {
      clearRichKeyboardToolbar();
      return;
    }
    if (!isLikelyTouchKeyboardOpen()) {
      releaseRichKeyboardToolbarFixed(toolbar);
      updateRichToolbarStickyState(toolbar);
      return;
    }
    const viewport = window.visualViewport;
    const wrap = getRichKeyboardToolbarWrap(toolbar);
    if (!wrap) return;
    wrap.classList.add('is-keyboard-toolbar-fixed');
    portalRichKeyboardToolbar(toolbar, wrap);
    toolbar.style.setProperty('--todo-rich-toolbar-left', `${Math.max(0, viewport?.offsetLeft || 0)}px`);
    toolbar.style.setProperty('--todo-rich-toolbar-width', `${Math.max(window.innerWidth || 0, viewport?.width || 0)}px`);
    toolbar.style.setProperty('--todo-rich-toolbar-top', `${Math.max(0, viewport?.offsetTop || 0)}px`);
    toolbar.classList.add('is-keyboard-fixed');
    wrap.style.setProperty('--todo-rich-toolbar-height', `${toolbar.getBoundingClientRect().height}px`);
    updateRichToolbarStickyState(toolbar);
  }

  function bindRichKeyboardViewportHandlers() {
    if (richKeyboardViewportBound) return;
    richKeyboardViewportBound = true;
    const update = () => window.requestAnimationFrame?.(updateRichKeyboardToolbar) || updateRichKeyboardToolbar();
    window.visualViewport?.addEventListener('resize', update, { passive: true });
    window.visualViewport?.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    window.addEventListener('orientationchange', update, { passive: true });
  }

  function activateRichKeyboardToolbar(toolbar) {
    if (!toolbar) return;
    bindRichKeyboardViewportHandlers();
    if (activeRichKeyboardToolbar && activeRichKeyboardToolbar !== toolbar) clearRichKeyboardToolbar();
    activeRichKeyboardToolbar = toolbar;
    window.setTimeout(updateRichKeyboardToolbar, 0);
  }

  function placeCaret(element, atEnd = false) {
    const selection = window.getSelection?.();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(!atEnd);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function placeCaretAtStart(element) {
    placeCaret(element, false);
  }

  function placeCaretAtEnd(element) {
    placeCaret(element, true);
  }

  function indentRichListItem(editor, outdent, syncFromEditor) {
    const element = getSelectionElementWithin(editor);
    const listItem = closestInside(element, 'li', editor);
    if (!listItem) return false;
    document.execCommand(outdent ? 'outdent' : 'indent', false, null);
    window.setTimeout(syncFromEditor, 0);
    return true;
  }

  function resetRichTypingStyleAfterLineBreak(editor, toolbar, syncFromEditor) {
    window.setTimeout(() => {
      const element = getSelectionElementWithin(editor);
      if (!element) return;
      const block = closestInside(element, 'h1,h2,blockquote,p,div', editor);
      const inline = closestInside(element, 'strong,b,em,i,u,code', editor);
      const isEmptyLine = !String(block?.textContent || inline?.textContent || '').trim();
      for (const command of ['bold', 'italic', 'underline']) {
        if (document.queryCommandState?.(command)) document.execCommand(command, false, null);
      }
      if (isEmptyLine && block && block !== editor) {
        const blockTag = block.tagName?.toLowerCase();
        const resetBlock = ['h1', 'h2', 'blockquote'].includes(blockTag) ? document.createElement('div') : block;
        resetBlock.innerHTML = '<br>';
        if (resetBlock !== block) block.replaceWith(resetBlock);
        placeCaretAtStart(resetBlock);
      } else if (isEmptyLine && inline) {
        inline.replaceWith(document.createElement('br'));
      }
      syncFromEditor();
      updateRichToolbarState(editor, toolbar);
    }, 0);
  }

  function cleanupRichEditors(root = document) {
    root.querySelectorAll?.('[data-rich-editor-bound="1"]').forEach(editor => {
      editor._richEditorCleanup?.();
    });
  }

  function updateRichToolbarState(editor, toolbar) {
    if (!editor || !toolbar) return;
    const element = getSelectionElementWithin(editor);
    if (!element) {
      clearToolbarState(toolbar);
      return;
    }
    const selection = window.getSelection?.();
    const inlineElement = closestInside(element, 'strong,b,em,i,u,code', editor);
    const blockElement = closestInside(element, 'h1,h2,blockquote,li,ul,ol', editor);
    const hasInlineContent = Boolean(selection?.toString?.().trim() || inlineElement?.textContent?.trim());
    const inlineTag = hasInlineContent ? (inlineElement?.tagName?.toLowerCase() || '') : '';
    const blockTag = blockElement?.tagName?.toLowerCase() || '';
    toolbar.querySelectorAll('button[data-rich-command], button[data-rich-block], button[data-rich-format]').forEach(button => {
      let active = false;
      if (button.dataset.richCommand === 'bold') active = ['strong', 'b'].includes(inlineTag);
      else if (button.dataset.richCommand === 'italic') active = ['em', 'i'].includes(inlineTag);
      else if (button.dataset.richCommand === 'underline') active = inlineTag === 'u';
      else if (button.dataset.richCommand === 'insertUnorderedList') active = ['li', 'ul'].includes(blockTag) || Boolean(blockElement?.closest?.('ul'));
      else if (button.dataset.richBlock) active = blockTag === button.dataset.richBlock;
      else if (button.dataset.richFormat === 'code') active = inlineTag === 'code';
      setToolbarButtonActive(button, Boolean(active));
    });
  }

  function bindRichEditor(editor, toolbar, syncFromEditor) {
    if (!editor || !toolbar || editor.dataset.richEditorBound === '1') return;
    editor.dataset.richEditorBound = '1';
    const controller = new AbortController();
    const { signal } = controller;
    const listenerOptions = { signal };
    const passiveListenerOptions = { passive: true, signal };
    editor._richEditorCleanup = () => {
      if (signal.aborted) return;
      if (activeRichKeyboardToolbar === toolbar) clearRichKeyboardToolbar();
      else releaseRichKeyboardToolbarFixed(toolbar);
      toolbar.classList.remove('is-stuck');
      controller.abort();
    };
    toolbar.parentElement?.classList.add('todo-rich-keyboard-wrap');
    const updateStickyState = () => window.requestAnimationFrame?.(() => updateRichToolbarStickyState(toolbar)) || updateRichToolbarStickyState(toolbar);
    getRichToolbarScrollPort(toolbar)?.addEventListener('scroll', updateStickyState, passiveListenerOptions);
    window.addEventListener('resize', updateStickyState, passiveListenerOptions);
    editor.addEventListener('input', () => {
      syncFromEditor();
      updateRichKeyboardToolbar();
      updateStickyState();
    }, listenerOptions);
    editor.addEventListener('focus', () => {
      activateRichKeyboardToolbar(toolbar);
      updateStickyState();
    }, listenerOptions);
    editor.addEventListener('keyup', () => window.setTimeout(() => {
      if (signal.aborted) return;
      updateRichToolbarState(editor, toolbar);
      updateRichKeyboardToolbar();
      updateStickyState();
    }, 0), listenerOptions);
    editor.addEventListener('mouseup', () => updateRichToolbarState(editor, toolbar), listenerOptions);
    editor.addEventListener('blur', () => {
      clearToolbarState(toolbar);
      window.setTimeout(() => {
        if (signal.aborted) return;
        if (!document.activeElement?.closest?.('.todo-desc-rich-editor, .todo-comment-rich-editor')) clearRichKeyboardToolbar();
      }, 0);
    }, listenerOptions);
    document.addEventListener('selectionchange', () => updateRichToolbarState(editor, toolbar), listenerOptions);
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        getTodoModal()?.classList.remove(TODO_MODAL_CLASSES.editingDescription);
        return;
      }
      if (event.key === 'Enter') {
        resetRichTypingStyleAfterLineBreak(editor, toolbar, syncFromEditor);
        return;
      }
      if (event.key === 'Tab' && indentRichListItem(editor, event.shiftKey, syncFromEditor)) {
        event.preventDefault();
        return;
      }
      if (event.key === ' ') {
        window.setTimeout(() => {
          if (signal.aborted) return;
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
    }, listenerOptions);
    toolbar.querySelectorAll('button[data-rich-command], button[data-rich-block], button[data-rich-format]').forEach(button => {
      button.addEventListener('mousedown', event => event.preventDefault(), listenerOptions);
      button.addEventListener('click', () => {
        editor.focus();
        if (button.dataset.richBlock) document.execCommand('formatBlock', false, button.dataset.richBlock);
        else if (button.dataset.richFormat === 'code') insertInlineCode(editor);
        else document.execCommand(button.dataset.richCommand, false, null);
        syncFromEditor();
        updateRichToolbarState(editor, toolbar);
      }, listenerOptions);
    });
  }

  function ensureDescriptionRichEditor(textarea, preview) {
    let wrap = document.getElementById('todo-desc-rich-wrap');
    if (wrap) return wrap;
    wrap = document.createElement('div');
    wrap.id = 'todo-desc-rich-wrap';
    wrap.className = 'todo-desc-rich-wrap';
    wrap.innerHTML = `
      <div class="todo-desc-rich-toolbar" aria-label="${escapeHtmlAttr(t('todo.description.formatToolbar'))}">
        ${richEditorToolbarHtml()}
      </div>
      <div id="todo-desc-rich-editor" class="todo-desc-rich-editor" contenteditable="true" role="textbox" aria-multiline="true"></div>
    `;
    preview.after(wrap);
    const editor = wrap.querySelector('#todo-desc-rich-editor');
    const toolbar = wrap.querySelector('.todo-desc-rich-toolbar');
    const syncFromEditor = () => {
      textarea.value = richDescriptionToMarkdown(editor);
      preview.innerHTML = renderMarkdown(textarea.value);
      refreshTodoSaveButtonState();
      updateRichToolbarState(editor, toolbar);
    };
    bindRichEditor(editor, toolbar, syncFromEditor);
    return wrap;
  }

  function getTodoCommentEditor() {
    return document.getElementById('todo-comment-new-editor');
  }

  function getTodoCommentEditorBody(editor = getTodoCommentEditor()) {
    return editor ? richDescriptionToMarkdown(editor).trim() : '';
  }

  function clearTodoCommentEditor(editor = getTodoCommentEditor()) {
    if (!editor) return;
    editor.innerHTML = '';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function bindTodoDescriptionInlineEditor() {
    const modal = getTodoModal();
    const textarea = document.getElementById('todo-desc');
    const preview = document.getElementById('todo-desc-preview');
    if (!modal || !textarea || !preview || textarea.dataset.inlineEditorBound === '1') return;
    textarea.dataset.inlineEditorBound = '1';
    const wrap = ensureDescriptionRichEditor(textarea, preview);
    const editor = wrap.querySelector('#todo-desc-rich-editor');
    editor?.setAttribute('data-placeholder', t('todo.description.write'));
    const openEditor = () => {
      if (!modal.classList.contains(TODO_MODAL_CLASSES.detail)) return;
      editor.innerHTML = renderMarkdown(textarea.value || '');
      modal.classList.add(TODO_MODAL_CLASSES.editingDescription);
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
    if (!id) {
      state.subtasks = collectTodoSubtasksFromEditor();
      state.comments = collectTodoDraftCommentsFromEditor();
      state.attachments = getSelectedAttachmentFiles().map(file => ({
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
      }));
    }
    return state;
  }

  function hasPersistedTodoId() {
    const id = document.getElementById('todo-id')?.value || '';
    return Boolean(id) && !String(id).startsWith('temp-');
  }

  function refreshTodoActionButtonState() {
    const hasTodo = hasPersistedTodoId();
    const subtaskTitle = document.getElementById('todo-subtask-new-title')?.value?.trim() || '';
    const commentBody = getTodoCommentEditorBody();
    const attachmentFiles = getSelectedAttachmentFiles();
    const subtaskButton = document.getElementById('todo-subtask-add-btn');
    const commentButton = document.getElementById('todo-comment-add-btn');
    const attachmentPicker = document.querySelector('.todo-attachment-picker');
    const uploadButton = document.getElementById('todo-attachment-upload-btn');
    if (subtaskButton) subtaskButton.disabled = !subtaskTitle;
    if (commentButton) commentButton.disabled = !commentBody;
    if (attachmentPicker) attachmentPicker.disabled = false;
    if (uploadButton) uploadButton.disabled = !hasTodo || attachmentFiles.length === 0;
  }

  function refreshTodoSaveButtonState() {
    const saveButton = document.getElementById('todo-save-btn');
    if (!saveButton) return;
    const current = JSON.stringify(getTodoSaveRelevantState());
    const unchanged = todoSaveSnapshot !== null && current === todoSaveSnapshot;
    saveButton.hidden = unchanged;
    saveButton.disabled = unchanged;
    refreshTodoActionButtonState();
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
    input.className = 'ui-field todo-subtask-title-input';
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
      .sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
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
    refreshTodoActionButtonState();
  }


  function collectTodoDraftCommentsFromEditor() {
    return Array.from(document.querySelectorAll('#todo-comments-list .todo-comment-item[data-draft-comment="1"] .todo-comment-body'))
      .map(item => item.dataset.rawBody?.trim() || item.textContent?.trim() || '')
      .filter(Boolean);
  }

  function removeTodoDraftComment(commentId) {
    const comments = collectTodoDraftCommentsFromEditor();
    const next = comments.filter((_, index) => `draft-comment-${index}` !== String(commentId));
    renderTodoComments(next.map((body, index) => ({
      id: `draft-comment-${index}`,
      body,
      is_draft: true,
      user_id: getCurrentUser?.()?.id,
      author_display_name: t('todo.comments.draftAuthor'),
    })), null);
    refreshTodoSaveButtonState();
  }

  function formatTodoCommentTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    try {
      return date.toLocaleString(getActiveLocale(), { dateStyle: 'short', timeStyle: 'short' });
    } catch (_error) {
      return date.toLocaleString();
    }
  }

  function renderTodoComments(comments = [], todo = null) {
    const todoId = todo?.id || null;
    const list = document.getElementById('todo-comments-list');
    const empty = document.getElementById('todo-comments-empty');
    const input = getTodoCommentEditor();
    const addButton = document.getElementById('todo-comment-add-btn');
    if (!list) return;
    const normalized = Array.isArray(comments) ? comments : [];
    const count = document.getElementById('todo-comments-count');
    cleanupRichEditors(list);
    list.innerHTML = '';
    if (count) count.textContent = String(normalized.length);
    setTodoCollapsibleOpen('todo-comments-panel', normalized.length > 0);
    if (empty) {
      empty.textContent = todoId ? t('todo.comments.empty') : t('todo.comments.draftEmpty');
      empty.hidden = normalized.length > 0;
    }
    if (input) {
      input.innerHTML = '';
      input.contentEditable = 'true';
      input.closest('.todo-comment-rich-wrap')?.querySelectorAll('button').forEach(button => {
        button.disabled = false;
      });
    }
    if (addButton) addButton.disabled = true;
    refreshTodoActionButtonState();
    for (const comment of normalized) {
      const item = document.createElement('article');
      item.className = 'todo-comment-item';
      item.dataset.commentId = comment.id;
      if (comment.is_draft) item.dataset.draftComment = '1';

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
      body.dataset.rawBody = comment.body || '';
      body.innerHTML = renderMarkdown(comment.body || '');

      const actions = document.createElement('div');
      actions.className = 'todo-comment-actions';
      const currentUserId = getCurrentUser?.()?.id;
      const isDraft = Boolean(comment.is_draft) || String(comment.id || '').startsWith('draft-comment-');
      const isAuthor = String(comment.user_id) === String(currentUserId);
      const canDelete = isDraft || isAuthor || String(todo?.user_id) === String(currentUserId);
      if (isAuthor && !isDraft) {
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
        remove.addEventListener('click', () => {
          if (isDraft) removeTodoDraftComment(comment.id);
          else deleteTodoComment(todoId, comment.id);
        });
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
    const editorWrap = document.createElement('div');
    editorWrap.className = 'todo-comment-edit-wrap todo-comment-rich-wrap';
    const toolbar = document.createElement('div');
    toolbar.className = 'todo-desc-rich-toolbar todo-comment-rich-toolbar';
    toolbar.setAttribute('aria-label', t('todo.comments.formatToolbar'));
    toolbar.innerHTML = richEditorToolbarHtml();
    const editor = document.createElement('div');
    editor.className = 'todo-comment-rich-editor todo-comment-edit-input';
    editor.contentEditable = 'true';
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-multiline', 'true');
    editor.innerHTML = renderMarkdown(original);
    const syncEditEditor = () => updateRichToolbarState(editor, toolbar);
    editorWrap.append(toolbar, editor);
    bodyEl.replaceWith(editorWrap);
    bindRichEditor(editor, toolbar, syncEditEditor);
    actionsEl.innerHTML = '';

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary btn-small btn-icon';
    save.innerHTML = iconSvg('check');
    save.setAttribute('aria-label', t('common.save'));
    save.setAttribute('title', t('common.save'));
    save.addEventListener('click', () => updateTodoComment(todoId, comment.id, richDescriptionToMarkdown(editor)));

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
    placeCaretAtEnd(editor);
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
    const input = getTodoCommentEditor();
    const body = getTodoCommentEditorBody(input);
    if (!body) {
      input?.focus();
      return;
    }
    if (!id || id.startsWith('temp-')) {
      const comments = [...collectTodoDraftCommentsFromEditor(), body];
      renderTodoComments(comments.map((commentBody, index) => ({
        id: `draft-comment-${index}`,
        body: commentBody,
        is_draft: true,
        user_id: getCurrentUser?.()?.id,
        author_display_name: t('todo.comments.draftAuthor'),
      })), null);
      if (input) {
        clearTodoCommentEditor(input);
        input.focus();
      }
      refreshTodoSaveButtonState();
      return;
    }
    if (!isOnlineForSync()) {
      showToast(t('todo.comments.onlineOnly'));
      return;
    }
    try {
      const response = await todosApi.createComment(id, { body });
      await applyCommentTodoResponse(response);
      if (input) {
        clearTodoCommentEditor(input);
      }
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

  function bindTodoForm() {
    if (todoFormBound) return;
    const form = document.getElementById('todo-form');
    if (!form) return;
    todoFormBound = true;
    form.addEventListener('submit', saveTodo);
    form.addEventListener('input', refreshTodoSaveButtonState);
    form.addEventListener('change', refreshTodoSaveButtonState);
    bindTodoTitleFieldAutosize();
    bindTodoAttachmentInputs();
    const commentInput = getTodoCommentEditor();
    const commentToolbar = commentInput?.closest('.todo-comment-rich-wrap')?.querySelector('.todo-comment-rich-toolbar');
    if (commentToolbar && !commentToolbar.innerHTML.trim()) commentToolbar.innerHTML = richEditorToolbarHtml();
    if (commentInput && commentToolbar) {
      commentInput.setAttribute('data-placeholder', t('todo.comments.placeholder'));
      bindRichEditor(commentInput, commentToolbar, () => {
        refreshTodoSaveButtonState();
        updateRichToolbarState(commentInput, commentToolbar);
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
    let swipeVisualFrame = 0;
    let swipeVisualFrameIsTimeout = false;
    let pendingSwipeVisual = null;

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
      const startedInStatusZone = Boolean(event.target.closest('.todo-status-control, .todo-check'));
      if (isTodoInteractiveTarget(event.target) && !startedInActionZone && !startedInStatusZone) return;
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
        startedInStatusZone,
        originalDraggable: item.getAttribute('draggable'),
        capturedPointer: false,
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

    function cancelScheduledSwipeVisual() {
      if (swipeVisualFrame) {
        if (swipeVisualFrameIsTimeout) window.clearTimeout(swipeVisualFrame);
        else window.cancelAnimationFrame?.(swipeVisualFrame);
      }
      swipeVisualFrame = 0;
      swipeVisualFrameIsTimeout = false;
      pendingSwipeVisual = null;
    }

    function flushScheduledSwipeVisual() {
      swipeVisualFrame = 0;
      swipeVisualFrameIsTimeout = false;
      const pending = pendingSwipeVisual;
      pendingSwipeVisual = null;
      if (!pending?.item?.isConnected || !pending.item.classList.contains('swiping')) return;
      setSwipeVisual(pending.item, pending.visualDx, pending.rawDx, pending.actionThreshold);
    }

    function scheduleSwipeVisual(item, visualDx, rawDx, actionThreshold) {
      pendingSwipeVisual = { item, visualDx, rawDx, actionThreshold };
      if (swipeVisualFrame) return;
      if (window.requestAnimationFrame) {
        swipeVisualFrame = window.requestAnimationFrame(flushScheduledSwipeVisual);
        swipeVisualFrameIsTimeout = false;
      } else {
        swipeVisualFrame = window.setTimeout(flushScheduledSwipeVisual, 16);
        swipeVisualFrameIsTimeout = true;
      }
    }

    function cleanupSwipeVisual(item) {
      cancelScheduledSwipeVisual();
      item.classList.remove('swiping', 'swipe-right', 'swipe-left', 'swipe-ready', 'swipe-settling', 'swipe-committing');
      item.style.removeProperty('--swipe-x');
      item.style.removeProperty('--swipe-progress');
      item.removeAttribute('data-swipe-right-label');
      item.removeAttribute('data-swipe-left-label');
    }

    function restoreSwipeDraggable(state) {
      if (!state?.item) return;
      if (state.originalDraggable === null) state.item.removeAttribute('draggable');
      else state.item.setAttribute('draggable', state.originalDraggable);
    }

    function captureSwipePointer(state) {
      if (!state?.item || state.capturedPointer) return;
      try {
        state.item.setPointerCapture?.(state.pointerId);
        state.capturedPointer = true;
      } catch (_) {}
    }

    function releaseSwipePointer(state) {
      if (!state?.capturedPointer) return;
      try { state.item?.releasePointerCapture?.(state.pointerId); } catch (_) {}
      state.capturedPointer = false;
    }

    function cancelActiveSwipe() {
      if (!active) return;
      const current = active;
      active = null;
      cleanupSwipeVisual(current.item);
      restoreSwipeDraggable(current);
      releaseSwipePointer(current);
      suppressClickUntil = Date.now() + 450;
    }

    function wait(ms) {
      return new Promise(resolve => window.setTimeout(resolve, ms));
    }

    document.addEventListener('pointermove', (event) => {
      if (!active || event.pointerId !== active.pointerId) return;
      const dragDropActive = document.body.classList.contains('native-pointer-dragging') || active.item.classList.contains('dragging');
      if (dragDropActive) {
        cancelActiveSwipe();
        return;
      }
      active.dx = event.clientX - active.startX;
      active.dy = event.clientY - active.startY;

      if (!active.locked) {
        const absX = Math.abs(active.dx);
        const absY = Math.abs(active.dy);
        const requiredLockThreshold = (active.startedInActionZone || active.startedInStatusZone) ? actionZoneLockThreshold : lockThreshold;
        if (absX < requiredLockThreshold && absY < lockThreshold) return;
        const isRightSwipeFromLeftEdge = active.dx > 0 && active.startX < leftEdgeSwipeDeadzonePx && !active.startedInStatusZone;
        active.locked = absX >= requiredLockThreshold && absX > absY * 1.25 && !isRightSwipeFromLeftEdge ? 'horizontal' : 'vertical';
        if (active.locked === 'vertical') return;
        captureSwipePointer(active);
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
      scheduleSwipeVisual(active.item, dx, active.dx, actionThreshold);
      active.swiped = true;
    }, { passive: false });

    const finish = async (event) => {
      if (!active || event.pointerId !== active.pointerId) return;
      const current = active;
      active = null;
      const item = current.item;
      const actionThreshold = Math.max(thresholdPx, item.clientWidth * thresholdRatio);
      const shouldAct = current.locked === 'horizontal' && Math.abs(current.dx) >= actionThreshold;
      cancelScheduledSwipeVisual();
      releaseSwipePointer(current);

      if (current.swiped || shouldAct) suppressClickUntil = Date.now() + 450;
      if (current.locked === 'horizontal') event.preventDefault();

      if (!shouldAct) {
        if (current.swiped) {
          item.classList.add('swipe-settling');
          window.requestAnimationFrame(() => setSwipeVisual(item, 0, 0, actionThreshold));
          await wait(180);
        }
        cleanupSwipeVisual(item);
        restoreSwipeDraggable(current);
        return;
      }

      item.classList.add('swipe-committing');
      setSwipeVisual(item, current.dx < 0 ? -item.clientWidth : item.clientWidth, current.dx, actionThreshold);
      await wait(130);
      cleanupSwipeVisual(item);
      restoreSwipeDraggable(current);
      if (current.dx < 0) await toggleTodoStatus(current.id, 'done');
      else await toggleTodoStatus(current.id, 'in_progress');
    };

    const cancel = (event) => {
      if (!active || event.pointerId !== active.pointerId) return;
      cancelActiveSwipe();
    };

    document.addEventListener('pointerup', finish, { passive: false });
    document.addEventListener('pointercancel', cancel, { passive: true });
    document.addEventListener('lostpointercapture', (event) => {
      if (active && event.pointerId === active.pointerId) {
        active.capturedPointer = false;
      }
    }, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) cancelActiveSwipe();
    }, { passive: true });
    window.addEventListener('blur', cancelActiveSwipe, { passive: true });
    window.addEventListener('pagehide', cancelActiveSwipe, { passive: true });
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
    let suppressActionClickUntil = 0;
    let suppressActionClickItem = null;
    const handleReveal = (event) => {
      if (event.type === 'click' && suppressActionClickItem && Date.now() < suppressActionClickUntil) {
        const actionItem = event.target?.closest?.('.todo-item[data-id]');
        if (actionItem === suppressActionClickItem && event.target?.closest?.('.todo-actions')) {
          event.preventDefault?.();
          event.stopPropagation?.();
          event.stopImmediatePropagation?.();
          suppressActionClickItem = null;
          return;
        }
      }

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
      if (event.type === 'pointerup') {
        button.__niaRevealPointerHandledAt = Date.now();
        suppressActionClickUntil = Date.now() + 600;
        suppressActionClickItem = item;
      }
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
    let touchSummaryPress = null;
    let suppressSummaryClick = null;

    const summaryFromTarget = (target) => target?.closest?.('.todo-status-menu > summary, .todo-snooze-menu > summary') || null;
    const isTouchPointer = (event) => event.isPrimary && (event.pointerType === 'touch' || event.pointerType === 'pen');

    function toggleActionSummary(summary) {
      const menu = summary?.parentElement;
      if (!summary || !menu) return false;
      const nextOpen = !menu.open;
      closeTodoActionMenus(nextOpen ? menu : null);
      menu.open = nextOpen;
      if (nextOpen) updateTodoActionMenuPlacement(menu);
      else resetTodoActionMenuPlacement(menu);
      return true;
    }

    document.addEventListener('pointerdown', (event) => {
      if (!isTouchPointer(event)) return;
      const summary = summaryFromTarget(event.target);
      if (!summary) return;
      touchSummaryPress = {
        pointerId: event.pointerId,
        summary,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };
    }, { capture: true, passive: true });

    document.addEventListener('pointermove', (event) => {
      if (!touchSummaryPress || touchSummaryPress.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - touchSummaryPress.startX, event.clientY - touchSummaryPress.startY) > 8) {
        touchSummaryPress.moved = true;
      }
    }, { capture: true, passive: true });

    document.addEventListener('pointerup', (event) => {
      if (!touchSummaryPress || touchSummaryPress.pointerId !== event.pointerId) return;
      const press = touchSummaryPress;
      touchSummaryPress = null;
      if (press.moved || summaryFromTarget(event.target) !== press.summary) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressSummaryClick = { summary: press.summary, until: Date.now() + 500 };
      toggleActionSummary(press.summary);
    }, { capture: true, passive: false });

    document.addEventListener('click', (event) => {
      const summary = summaryFromTarget(event.target);
      if (!summary || suppressSummaryClick?.summary !== summary || Date.now() > suppressSummaryClick.until) return;
      suppressSummaryClick = null;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true, passive: false });

    document.addEventListener('pointercancel', (event) => {
      if (touchSummaryPress?.pointerId === event.pointerId) touchSummaryPress = null;
    }, { capture: true, passive: true });

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
      resizeTodoTitleField();
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
      resizeTodoTitleField();
      document.getElementById('todo-project').value = getCurrentProjectId() || inboxProject?.id || '';
      await onProjectChange(null);
      updateTodoMetaPanelsOpenState(null);
    }

    hydrateTodoSelects();
    updateRecurringControls();
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
    getTodoModal()?.classList.add('active');
    resizeTodoTitleField();
    window.requestAnimationFrame?.(resizeTodoTitleField);
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
      if (parsedQuickAdd.changes.location_reminder && !todoData.location_reminder) todoData.location_reminder = parsedQuickAdd.changes.location_reminder;
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
    const draftComments = id ? [] : collectTodoDraftCommentsFromEditor();
    const draftAttachmentFiles = id ? [] : getSelectedAttachmentFiles();
    const hasPostCreateDrafts = draftComments.length > 0 || draftAttachmentFiles.length > 0;
    if (hasPostCreateDrafts && !isOnlineForSync()) {
      showToast(t('todo.drafts.onlineOnly'));
      return;
    }
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
    } else if (hasPostCreateDrafts) {
      let createdTodo = await todosApi.create(todoData);
      await dbPut('todos', createdTodo);
      setTodos([...getTodos(), createdTodo]);
      document.getElementById('todo-id').value = String(createdTodo.id);
      for (const body of draftComments) {
        const response = await todosApi.createComment(createdTodo.id, { body });
        createdTodo = response?.todo || createdTodo;
        await applyCommentTodoResponse(response);
      }
      if (draftAttachmentFiles.length > 0) {
        const uploaded = await uploadTodoAttachmentFromInput();
        if (!uploaded) return;
      } else {
        await dbPut('todos', createdTodo);
        setTodos(getTodos().map(todo => String(todo.id) === String(createdTodo.id) ? createdTodo : todo));
      }
      renderProjects();
      renderStats();
      renderTodos();
      closeModal('todo-modal');
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
    showToast(t('todo.toast.duplicated'), { type: 'duplicate', id: tempId });
    await addToSyncQueue('CREATE_TODO', { ...todoData, _tempId: tempId, undo_grace_until: Date.now() + 5000 });
    if (isOnlineForSync()) await syncWithServer();
    setTimeout(() => {
      if (isOnlineForSync()) syncWithServer();
    }, 5200);
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

  function resolveTodoActionId(target) {
    const rawId = target?.dataset?.todoId || target?.closest?.('.todo-item[data-id]')?.dataset?.id;
    if (!rawId) return null;
    const todo = getTodos().find(item => String(item.id) === String(rawId));
    return todo ? todo.id : rawId;
  }

  async function handleTodoCardAction(action, target, event) {
    const id = resolveTodoActionId(target);
    if (id === null) return false;
    event.preventDefault();
    event.stopPropagation();
    target.closest('details')?.removeAttribute('open');

    if (action === 'toggle-status') {
      await toggleTodo(id);
      return true;
    }
    if (action === 'set-status') {
      const status = target.dataset.todoStatus;
      if (!['pending', 'in_progress', 'done'].includes(status)) return true;
      await setTodoStatus(id, status);
      return true;
    }
    if (action === 'snooze') {
      const mode = target.dataset.snoozeMode;
      if (!['hour', 'evening', 'tomorrow', 'weekend', 'next-week'].includes(mode)) return true;
      await snoozeTodo(id, mode);
      return true;
    }
    if (action === 'toggle-pin') {
      await toggleTodoPin(id);
      return true;
    }
    if (action === 'duplicate') {
      await duplicateTodo(id);
      return true;
    }
    if (action === 'delete') {
      await deleteTodo(id);
      return true;
    }
    return false;
  }

  let todoActionsBound = false;
  function bindTodoActions() {
    if (todoActionsBound) return;
    todoActionsBound = true;
    document.addEventListener('click', async (event) => {
      const target = event.target?.closest?.('[data-todo-action]');
      if (!target) return;
      const action = target.dataset.todoAction;
      if (await handleTodoCardAction(action, target, event)) return;
      event.preventDefault();
      if (action === 'new') {
        showTodoModal();
      } else if (action === 'add-subtask') {
        await addTodoSubtaskFromInput();
      } else if (action === 'add-comment') {
        await addTodoCommentFromInput();
      } else if (action === 'choose-attachment') {
        document.getElementById('todo-attachment-file')?.click();
      } else if (action === 'upload-attachment') {
        await uploadTodoAttachmentFromInput();
      } else if (action === 'close-attachment-preview') {
        closeAttachmentPreview();
      } else if (action === 'download-preview-attachment') {
        await downloadPreviewAttachment();
      }
    });
    document.getElementById('todo-project')?.addEventListener('change', onProjectChange);
  }

  return { markTodoDone, markTodoInProgress, setTodoStatus, toggleTodo, toggleTodoPin, toggleTodoActions, addTodoSubtaskFromInput, addTodoCommentFromInput, uploadTodoAttachmentFromInput, deleteTodoComment, deleteTodoAttachment, closeAttachmentPreview, downloadPreviewAttachment, snoozeTodo, duplicateTodo, showTodoModal, bindTodoActions, onProjectChange, saveTodo, editTodo, deleteTodoFromModal, deleteTodo };
}
