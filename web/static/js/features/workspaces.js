import { t } from '../i18n/index.js';
import { hydrateIcons, iconSvg, markerHtml, renderIconPicker } from '../icons/lucide-icons.js';
import { renderColorPicker } from '../ui/color-picker.js';

export function createWorkspacesFeature({
  workspacesApi,
  getWorkspaces,
  setWorkspaces,
  getCurrentWorkspaceId,
  setCurrentWorkspaceId,
  dbPut,
  dbClear,
  isOnlineForSync,
  refreshFromServer,
  renderProjects,
  renderStats,
  renderTodos,
  closeSidebar,
  confirmDanger,
  showToast,
}) {
  let editingWorkspaceId = null;
  let workspaceFormBound = false;
  let workspaceControlsBound = false;
  let workspaceSaveSnapshot = null;

  function getWorkspaceSaveRelevantState() {
    return {
      id: document.getElementById('workspace-id')?.value || '',
      name: (document.getElementById('workspace-name')?.value || '').trim(),
      color: document.getElementById('workspace-color')?.value || '#6366f1',
      icon: document.getElementById('workspace-icon')?.value || '',
    };
  }

  function canSaveWorkspace() {
    const state = getWorkspaceSaveRelevantState();
    const unchanged = workspaceSaveSnapshot !== null && JSON.stringify(state) === workspaceSaveSnapshot;
    return !!state.name && !unchanged;
  }

  function refreshWorkspaceSaveButtonState() {
    const saveBtn = document.getElementById('workspace-save-btn');
    if (!saveBtn) return;
    const canSave = canSaveWorkspace();
    saveBtn.hidden = !canSave;
    saveBtn.disabled = !canSave;
  }

  function resetWorkspaceSaveSnapshot() {
    workspaceSaveSnapshot = JSON.stringify(getWorkspaceSaveRelevantState());
    refreshWorkspaceSaveButtonState();
  }

  function bindWorkspaceForm() {
    if (workspaceFormBound) return;
    const form = document.getElementById('workspace-form');
    if (!form) return;
    workspaceFormBound = true;
    form.addEventListener('submit', saveWorkspace);
    form.addEventListener('input', refreshWorkspaceSaveButtonState);
    form.addEventListener('change', refreshWorkspaceSaveButtonState);
    document.getElementById('workspace-icon-picker')?.addEventListener('click', (event) => {
      if (!event.target?.closest?.('.icon-picker-option')) return;
      window.setTimeout(refreshWorkspaceSaveButtonState, 0);
    });
  }

  function normalizeWorkspaceId(id) {
    if (id === null || id === undefined || id === '') return null;
    const n = Number(id);
    return Number.isFinite(n) ? n : id;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function getDefaultWorkspaceId() {
    const workspaces = getWorkspaces();
    const saved = normalizeWorkspaceId(localStorage.getItem('nia-current-workspace'));
    if (saved && workspaces.some(w => String(w.id) === String(saved))) return saved;
    const fallback = workspaces.find(w => w.is_default) || workspaces[0] || null;
    return fallback ? fallback.id : null;
  }

  function ensureCurrentWorkspace() {
    const current = getCurrentWorkspaceId();
    const workspaces = getWorkspaces();
    if (current && workspaces.some(w => String(w.id) === String(current))) return current;
    const next = getDefaultWorkspaceId();
    setCurrentWorkspaceId(next);
    if (next) localStorage.setItem('nia-current-workspace', String(next));
    return next;
  }

  function closeWorkspaceMenu() {
    const menu = document.getElementById('workspace-menu');
    const button = document.getElementById('workspace-current-btn');
    menu?.classList.remove('open');
    button?.setAttribute('aria-expanded', 'false');
  }

  function toggleWorkspaceMenu(event) {
    event?.stopPropagation?.();
    const menu = document.getElementById('workspace-menu');
    const button = document.getElementById('workspace-current-btn');
    if (!menu || !button) return;
    const open = !menu.classList.contains('open');
    menu.classList.toggle('open', open);
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function renderWorkspaces() {
    const menu = document.getElementById('workspace-menu');
    const nameEl = document.getElementById('workspace-current-name');
    const dotEl = document.getElementById('workspace-current-dot');
    if (!menu || !nameEl || !dotEl) return;

    const workspaces = getWorkspaces();
    const currentId = ensureCurrentWorkspace();
    const current = workspaces.find(w => String(w.id) === String(currentId)) || workspaces[0] || null;
    nameEl.removeAttribute('data-i18n-key');
    nameEl.textContent = current?.name || 'Workspace';
    dotEl.className = current?.icon ? 'workspace-current-dot has-icon' : 'workspace-current-dot';
    dotEl.style.background = current?.icon ? 'transparent' : (current?.color || '#6366f1');
    dotEl.style.color = current?.color || '#6366f1';
    dotEl.innerHTML = current?.icon ? markerHtml(current, 'workspace-current-dot') : '';

    menu.innerHTML = `
      <div class="workspace-menu-list">
        ${workspaces.map(workspace => {
          const active = String(workspace.id) === String(currentId);
          return `<div class="workspace-menu-row ${active ? 'active' : ''}" role="menuitem">
            <button type="button" class="ui-menu-item workspace-menu-choice" data-workspace-action="switch" data-workspace-id="${escapeAttr(workspace.id)}">
              ${markerHtml(workspace, 'workspace-menu-dot')}
              <span>${escapeHtml(workspace.name)}</span>
              ${active ? `<span class="workspace-menu-check">${iconSvg('check')}</span>` : ''}
            </button>
            <button type="button" class="workspace-menu-edit" data-workspace-action="edit" data-workspace-id="${escapeAttr(workspace.id)}" title="${escapeAttr(t('workspace.rename'))}" aria-label="${escapeAttr(t('workspace.editAria'))}">
              ${iconSvg('edit-3')}
            </button>
          </div>`;
        }).join('')}
      </div>
      <button type="button" class="ui-menu-item workspace-menu-add" data-workspace-action="new"><span class="entity-icon add-project-icon workspace-menu-add-icon" data-icon="plus" aria-hidden="true"></span><span>${escapeHtml(t('workspace.add'))}</span></button>
    `;
    hydrateIcons(menu);
  }

  function isShortcutTypingTarget(element) {
    const tag = element?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element?.isContentEditable;
  }

  function workspaceIndexFromShortcut(event) {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
    if (/^[1-6]$/.test(event.key)) return Number(event.key) - 1;
    const digitMatch = event.code?.match(/^Digit([1-6])$/);
    if (digitMatch) return Number(digitMatch[1]) - 1;
    const numpadMatch = event.code?.match(/^Numpad([1-6])$/);
    if (numpadMatch) return Number(numpadMatch[1]) - 1;
    return null;
  }

  function bindWorkspaceControls() {
    if (workspaceControlsBound) return;
    workspaceControlsBound = true;
    document.addEventListener('click', async (event) => {
      const target = event.target?.closest?.('[data-workspace-action]');
      if (!target) return;
      const action = target.dataset.workspaceAction;
      const workspaceId = target.dataset.workspaceId;
      event.preventDefault();
      if (action === 'toggle-menu') {
        toggleWorkspaceMenu(event);
      } else if (action === 'switch') {
        await switchWorkspace(workspaceId);
      } else if (action === 'edit') {
        event.stopPropagation();
        showWorkspaceModal(workspaceId);
      } else if (action === 'new') {
        showWorkspaceModal();
      } else if (action === 'close-modal') {
        closeWorkspaceModal();
      } else if (action === 'delete') {
        await deleteWorkspaceFromModal();
      }
    });
  }

  function bindWorkspaceShortcuts() {
    if (document.documentElement.dataset.workspaceShortcutsBound === '1') return;
    document.documentElement.dataset.workspaceShortcutsBound = '1';
    document.addEventListener('keydown', async (event) => {
      const index = workspaceIndexFromShortcut(event);
      if (index === null) return;
      if (isShortcutTypingTarget(document.activeElement)) return;
      if (document.querySelector('.modal.active')) return;
      const workspace = getWorkspaces()[index];
      if (!workspace) return;
      if (String(workspace.id) === String(getCurrentWorkspaceId())) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      await switchWorkspace(workspace.id);
    }, true);
  }

  async function switchWorkspace(workspaceId) {
    const next = normalizeWorkspaceId(workspaceId);
    setCurrentWorkspaceId(next);
    if (next) localStorage.setItem('nia-current-workspace', String(next));
    localStorage.setItem('nia-last-filter', 'all');
    closeWorkspaceMenu();
    window.setFilter?.('all');
    renderWorkspaces();
    renderProjects();
    renderStats();
    renderTodos();
    closeSidebar?.();
  }

  function showWorkspaceModal(workspaceId = null) {
    bindWorkspaceForm();
    closeWorkspaceMenu();
    editingWorkspaceId = workspaceId ? normalizeWorkspaceId(workspaceId) : null;
    const workspace = editingWorkspaceId
      ? getWorkspaces().find(w => String(w.id) === String(editingWorkspaceId))
      : null;
    const modalTitle = document.getElementById('workspace-modal-title');
    if (modalTitle) {
      modalTitle.dataset.i18nKey = workspace ? 'workspace.edit' : 'workspace.new';
      modalTitle.textContent = t(modalTitle.dataset.i18nKey);
    }
    document.getElementById('workspace-id').value = workspace?.id || '';
    document.getElementById('workspace-name').value = workspace?.name || '';
    document.getElementById('workspace-color').value = workspace?.color || '#6366f1';
    document.getElementById('workspace-icon').value = workspace?.icon || '';
    renderIconPicker({
      container: document.getElementById('workspace-icon-picker'),
      input: document.getElementById('workspace-icon'),
      selected: workspace?.icon || '',
      color: workspace?.color || '#6366f1',
    });
    document.getElementById('workspace-error').textContent = '';
    const colorInput = document.getElementById('workspace-color');
    if (colorInput) {
      renderColorPicker({
        container: document.getElementById('workspace-color-picker'),
        input: colorInput,
        selected: colorInput.value || '#6366f1',
        onChange: (color) => {
          renderIconPicker({
            container: document.getElementById('workspace-icon-picker'),
            input: document.getElementById('workspace-icon'),
            selected: document.getElementById('workspace-icon')?.value || '',
            color,
          });
          refreshWorkspaceSaveButtonState();
        },
      });
    }
    const canDelete = !!workspace && !workspace.is_default;
    const deleteBtn = document.getElementById('workspace-delete-btn');
    const headerMenu = document.getElementById('workspace-detail-header-menu');
    if (deleteBtn) deleteBtn.style.display = canDelete ? '' : 'none';
    if (headerMenu) {
      headerMenu.hidden = !canDelete;
      headerMenu.removeAttribute('open');
    }
    document.getElementById('workspace-modal')?.classList.add('active');
    resetWorkspaceSaveSnapshot();
    if (!workspace) {
      setTimeout(() => document.getElementById('workspace-name')?.focus(), 50);
    }
  }

  function closeWorkspaceModal() {
    document.getElementById('workspace-modal')?.classList.remove('active');
    editingWorkspaceId = null;
  }

  async function saveWorkspace(event) {
    event?.preventDefault?.();
    refreshWorkspaceSaveButtonState();
    if (!canSaveWorkspace()) return;
    const name = document.getElementById('workspace-name')?.value?.trim();
    const color = document.getElementById('workspace-color')?.value || '#6366f1';
    const icon = document.getElementById('workspace-icon')?.value || null;
    const error = document.getElementById('workspace-error');
    if (error) error.textContent = '';
    if (!name) {
      if (error) error.textContent = t('workspace.nameRequired');
      return;
    }
    if (!isOnlineForSync()) {
      if (error) error.textContent = t('workspace.onlineOnlyUpdate');
      return;
    }

    try {
      if (editingWorkspaceId) {
        const updated = await workspacesApi.update(editingWorkspaceId, { name, color, icon });
        await dbPut('workspaces', updated);
        setWorkspaces(getWorkspaces().map(w => String(w.id) === String(updated.id) ? updated : w));
        showToast?.(t('workspace.saved')); 
      } else {
        const workspace = await workspacesApi.create({ name, color, icon, sort_order: getWorkspaces().length });
        await dbPut('workspaces', workspace);
        setWorkspaces([...getWorkspaces(), workspace]);
        await switchWorkspace(workspace.id);
        showToast?.(t('workspace.created')); 
      }
      closeWorkspaceModal();
      renderWorkspaces();
      renderProjects();
      renderStats();
      renderTodos();
      await refreshFromServer();
    } catch (err) {
      console.error('Workspace save failed', err);
      if (error) error.textContent = t('workspace.saveFailed');
    }
  }

  async function deleteWorkspaceFromModal() {
    if (!editingWorkspaceId) return;
    const workspace = getWorkspaces().find(w => String(w.id) === String(editingWorkspaceId));
    if (!workspace || workspace.is_default) return;
    const confirmed = await confirmDanger({
      title: t('workspace.deleteTitle'),
      message: t('workspace.deleteMessage', { name: workspace.name }),
      confirmText: t('workspace.deleteConfirm'),
    });
    if (!confirmed) return;
    if (!isOnlineForSync()) {
      const error = document.getElementById('workspace-error');
      if (error) error.textContent = t('workspace.onlineOnlyDelete');
      return;
    }
    try {
      const result = await workspacesApi.delete(editingWorkspaceId);
      setWorkspaces(getWorkspaces().filter(w => String(w.id) !== String(editingWorkspaceId)));
      closeWorkspaceModal();
      const next = result?.moved_projects_to || getDefaultWorkspaceId();
      await switchWorkspace(next);
      await refreshFromServer();
      const moved = result?.moved_projects?.length || 0;
      showToast?.(moved ? t('workspace.deletedMoved', { count: moved }) : t('workspace.deleted')); 
    } catch (err) {
      console.error('Workspace delete failed', err);
      const error = document.getElementById('workspace-error');
      if (error) error.textContent = t('workspace.deleteFailed');
    }
  }

  async function createWorkspace() {
    showWorkspaceModal();
  }

  async function loadWorkspacesFromServer() {
    if (!isOnlineForSync()) return;
    const data = await workspacesApi.list();
    const next = data.workspaces || [];
    if (dbClear) await dbClear('workspaces');
    await Promise.all(next.map(workspace => dbPut('workspaces', workspace)));
    setWorkspaces(next);
    ensureCurrentWorkspace();
    renderWorkspaces();
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('click', (event) => {
      if (!event.target.closest?.('#workspace-switcher')) closeWorkspaceMenu();
    });
    bindWorkspaceShortcuts();
  }

  return {
    renderWorkspaces,
    switchWorkspace,
    createWorkspace,
    showWorkspaceModal,
    closeWorkspaceModal,
    saveWorkspace,
    deleteWorkspaceFromModal,
    bindWorkspaceControls,
    toggleWorkspaceMenu,
    closeWorkspaceMenu,
    loadWorkspacesFromServer,
    ensureCurrentWorkspace,
  };
}
