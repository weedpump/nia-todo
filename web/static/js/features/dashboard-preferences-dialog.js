import { t } from '../i18n/index.js';
import { iconSvg, markerHtml } from '../icons/lucide-icons.js';
import { hydrateSelect, isDropdownOpen, refreshSelect } from '../ui/dropdowns.js';
import { DEFAULT_DASHBOARD_PREFERENCES, normalizeDashboardPreferences } from './dashboard-preferences.js';

const STAT_OPTIONS = [
  ['total', 'overview.stats.total'],
  ['pending', 'todo.status.pending'],
  ['in_progress', 'dashboard.preferences.stats.inProgress'],
  ['overdue', 'overview.stats.overdue'],
  ['due_today', 'dashboard.preferences.stats.dueToday'],
  ['done', 'dashboard.preferences.stats.done'],
];

function setChecked(id, checked) {
  const input = document.getElementById(id);
  if (input) input.checked = Boolean(checked);
}

function setValue(id, value) {
  const input = document.getElementById(id);
  if (!input) return;
  input.value = String(value);
  refreshSelect(input);
}

export function createDashboardPreferencesFeature({
  getPreferences,
  setPreferences,
  getProjects,
  getWorkspaces,
  getCurrentWorkspaceId,
  getSyncEnabled = () => false,
  setSyncEnabled = () => {},
  renderDashboard,
  showToast,
}) {
  let lastFocusedElement = null;
  let selectedWorkspaceId = null;
  const workspaceDrafts = new Map();

  function getModal() {
    return document.getElementById('dashboard-preferences-modal');
  }

  function workspaceKey(workspaceId) {
    return String(workspaceId ?? '');
  }

  function availableWorkspaces() {
    return (getWorkspaces?.() || []).filter(workspace => workspace?.id !== null && workspace?.id !== undefined);
  }

  function getWorkspaceProjects() {
    if (selectedWorkspaceId === null || selectedWorkspaceId === undefined || selectedWorkspaceId === '') return [];
    return (getProjects?.() || []).filter(project => String(project.workspace_id || '') === String(selectedWorkspaceId));
  }

  function selectedProjectIds() {
    return [...document.querySelectorAll('[data-dashboard-preference-project-id].is-selected')]
      .map(option => Number(option.dataset.dashboardPreferenceProjectId))
      .filter(Number.isInteger);
  }

  function selectedFocusItems() {
    return [...document.querySelectorAll('[data-dashboard-focus-item]:checked')].map(input => input.value);
  }

  function renderStatOptions(values) {
    document.querySelectorAll('[data-dashboard-stat-slot]').forEach((select, index) => {
      select.innerHTML = '';
      for (const [value, labelKey] of STAT_OPTIONS) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = t(labelKey);
        select.append(option);
      }
      select.value = values[index] || STAT_OPTIONS[index]?.[0] || 'total';
      hydrateSelect(select);
      refreshSelect(select);
    });
  }

  function hydratePreferenceSelects() {
    const modal = getModal();
    modal?.querySelectorAll('select[data-ui-select]').forEach(select => hydrateSelect(select));
  }

  function normalizeProjectSearch(value) {
    return String(value || '').toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function updateProjectSummary() {
    const triggerValue = document.querySelector('.dashboard-preferences-project-trigger .ui-select-value');
    if (!triggerValue) return;
    const projects = getWorkspaceProjects();
    const selected = new Set(selectedProjectIds());
    const names = projects.filter(project => selected.has(Number(project.id))).map(project => String(project.name || ''));
    const scope = document.getElementById('dashboard-preferences-project-scope')?.value || 'all';
    triggerValue.textContent = scope === 'all'
      ? t('focus.projects.all')
      : names.length > 0 && names.length <= 2
        ? names.join(', ')
        : t('focus.projects.selectedCount', { count: names.length });
  }

  function navigableProjectOptions(menu = document.querySelector('.dashboard-preferences-project-menu')) {
    if (!menu) return [];
    return [...menu.querySelectorAll('[data-dashboard-preference-project-id]')]
      .filter(option => !option.hidden && !option.disabled && option.getAttribute('aria-disabled') !== 'true');
  }

  function focusProjectOption(option, menu = option?.closest('.dashboard-preferences-project-menu')) {
    if (!option || !menu) return;
    menu.querySelectorAll('[data-dashboard-preference-project-id]').forEach(item => {
      item.tabIndex = item === option ? 0 : -1;
    });
    option.focus();
  }

  function toggleProjectOption(option) {
    if (!option || option.disabled || option.hidden || option.getAttribute('aria-disabled') === 'true') return;
    const selected = !option.classList.contains('is-selected');
    option.classList.toggle('is-selected', selected);
    option.setAttribute('aria-checked', selected ? 'true' : 'false');
    updateProjectSummary();
  }

  function setProjectMenuOpen(open, { restoreFocus = false } = {}) {
    const dropdown = document.querySelector('.dashboard-preferences-project-dropdown');
    const trigger = dropdown?.querySelector('.dashboard-preferences-project-trigger');
    const menu = dropdown?.querySelector('.dashboard-preferences-project-menu');
    if (!dropdown || !trigger || !menu || (open && trigger.disabled)) return;
    dropdown.classList.toggle('is-open', open);
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    menu.hidden = !open;
    if (open) {
      menu.querySelectorAll('[data-dashboard-preference-project-id]').forEach(option => { option.tabIndex = -1; });
      window.setTimeout(() => menu.querySelector('.ui-select-search-input')?.focus(), 0);
    }
    else if (restoreFocus) trigger.focus();
  }

  function filterProjectOptions(value) {
    const menu = document.querySelector('.dashboard-preferences-project-menu');
    if (!menu) return;
    const term = normalizeProjectSearch(value);
    let visibleCount = 0;
    menu.querySelectorAll('[data-dashboard-preference-project-id]').forEach(option => {
      const matches = !term || normalizeProjectSearch(option.dataset.label).includes(term);
      option.hidden = !matches;
      if (!matches) option.tabIndex = -1;
      if (matches) visibleCount += 1;
    });
    const empty = menu.querySelector('.ui-select-empty');
    if (empty) empty.hidden = visibleCount > 0;
    const activeOption = document.activeElement?.closest?.('[data-dashboard-preference-project-id]');
    if (activeOption && (activeOption.hidden || activeOption.disabled)) {
      activeOption.tabIndex = -1;
      menu.querySelector('.ui-select-search-input')?.focus();
    }
  }

  function renderProjectOptions(selectedIds = []) {
    const container = document.getElementById('dashboard-preferences-projects');
    if (!container) return;
    container.innerHTML = '';
    const projects = [...getWorkspaceProjects()];
    if (!projects.length) {
      const empty = document.createElement('p');
      empty.className = 'dashboard-preferences-empty';
      empty.textContent = t('dashboard.preferences.projects.empty');
      container.append(empty);
      return;
    }

    const selected = new Set(selectedIds.map(Number));
    const projectMap = new Map(projects.map(project => [Number(project.id), { ...project, children: [] }]));
    const roots = [];
    projectMap.forEach(project => {
      const parent = projectMap.get(Number(project.parent_id));
      if (parent) parent.children.push(project);
      else roots.push(project);
    });
    roots.sort((a, b) => (!!a.is_inbox !== !!b.is_inbox ? (a.is_inbox ? -1 : 1) : String(a.name || '').localeCompare(String(b.name || ''))));

    const dropdown = document.createElement('div');
    dropdown.className = 'focus-project-dropdown dashboard-preferences-project-dropdown';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'ui-select-trigger focus-project-trigger dashboard-preferences-project-trigger';
    trigger.dataset.dashboardProjectAction = 'toggle';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-labelledby', 'dashboard-preferences-projects-label dashboard-preferences-projects-value');
    const value = document.createElement('span');
    value.className = 'ui-select-value';
    value.id = 'dashboard-preferences-projects-value';
    const chevron = document.createElement('span');
    chevron.className = 'ui-select-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = iconSvg('chevron-down');
    trigger.append(value, chevron);

    const menu = document.createElement('div');
    menu.className = 'focus-project-menu ui-select-menu project-ui-select-menu dashboard-preferences-project-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    const search = document.createElement('div');
    search.className = 'ui-select-search';
    search.innerHTML = `<span class="ui-select-search-icon" aria-hidden="true">${iconSvg('search')}</span>`;
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'ui-select-search-input';
    searchInput.placeholder = t('focus.projects.search');
    searchInput.setAttribute('aria-label', t('focus.projects.search'));
    searchInput.dataset.dashboardProjectSearch = '';
    search.append(searchInput);
    menu.append(search);

    const appendProject = (project, depth = 0) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = `focus-project-option${selected.has(Number(project.id)) ? ' is-selected' : ''}`;
      option.style.setProperty('--project-depth', String(depth));
      option.dataset.dashboardPreferenceProjectId = String(project.id);
      option.dataset.label = String(project.name || '');
      option.setAttribute('role', 'menuitemcheckbox');
      option.setAttribute('aria-checked', selected.has(Number(project.id)) ? 'true' : 'false');
      option.tabIndex = -1;
      option.insertAdjacentHTML('beforeend', markerHtml(project));
      const name = document.createElement('span');
      name.textContent = project.name || '';
      const check = document.createElement('span');
      check.className = 'focus-project-check';
      check.setAttribute('aria-hidden', 'true');
      check.innerHTML = iconSvg('check');
      option.append(name, check);
      menu.append(option);
      [...project.children].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))).forEach(child => appendProject(child, depth + 1));
    };
    roots.forEach(project => appendProject(project));
    const noMatches = document.createElement('div');
    noMatches.className = 'ui-select-empty focus-project-empty';
    noMatches.textContent = t('focus.projects.noMatches');
    noMatches.hidden = true;
    menu.append(noMatches);
    dropdown.append(trigger, menu);
    container.append(dropdown);
    updateProjectSummary();
  }

  function updateProjectSelectionState() {
    const scope = document.getElementById('dashboard-preferences-project-scope')?.value || 'all';
    const container = document.getElementById('dashboard-preferences-projects');
    const disabled = scope === 'all';
    container?.classList.toggle('is-disabled', disabled);
    const trigger = container?.querySelector('.dashboard-preferences-project-trigger');
    if (trigger) trigger.disabled = disabled;
    if (disabled) setProjectMenuOpen(false);
    updateProjectSummary();
  }

  function renderWorkspaceOptions(workspaceId = selectedWorkspaceId) {
    const select = document.getElementById('dashboard-preferences-workspace');
    if (!select) return;
    select.innerHTML = '';
    for (const workspace of availableWorkspaces()) {
      const option = document.createElement('option');
      option.value = String(workspace.id);
      option.textContent = workspace.name || t('dashboard.preferences.workspace.fallback');
      select.append(option);
    }
    select.value = workspaceId === null || workspaceId === undefined ? '' : String(workspaceId);
    hydrateSelect(select);
    refreshSelect(select);
  }

  function hydrateDraft(draft, { clearError = true } = {}) {
    setChecked('dashboard-preferences-compact-display', draft.compactDisplay);
    setChecked('dashboard-preferences-group-by-status', draft.groupByStatus);
    setChecked('dashboard-preferences-show-focus', draft.showFocus);
    setChecked('dashboard-preferences-show-active-projects', draft.showActiveProjects);
    setChecked('dashboard-preferences-show-project-widgets', draft.showProjectWidgets);
    setValue('dashboard-preferences-project-scope', draft.projectScope.mode);
    renderProjectOptions(draft.projectScope.projectIds);
    renderStatOptions(draft.stats);
    document.querySelectorAll('[data-dashboard-focus-item]').forEach(input => {
      input.checked = draft.focusItems.includes(input.value);
    });
    setChecked('dashboard-preferences-hide-empty-focus', draft.hideEmptyFocusItems);
    setValue('dashboard-preferences-project-limit', draft.activeProjects.limit);
    setValue('dashboard-preferences-project-sort', draft.activeProjects.sort);
    const error = document.getElementById('dashboard-preferences-error');
    if (error && clearError) error.textContent = '';
    updateProjectSelectionState();
  }

  function currentWorkspaceDraft() {
    const key = workspaceKey(selectedWorkspaceId);
    return workspaceDrafts.has(key)
      ? workspaceDrafts.get(key)
      : getPreferences?.(selectedWorkspaceId);
  }

  function hydrateForm(preferences = currentWorkspaceDraft()) {
    hydrateDraft(normalizeDashboardPreferences(preferences));
  }

  function stashCurrentDraft() {
    if (selectedWorkspaceId === null || selectedWorkspaceId === undefined || selectedWorkspaceId === '') return;
    workspaceDrafts.set(workspaceKey(selectedWorkspaceId), readDraft());
  }

  function switchDashboardWorkspace(workspaceId) {
    stashCurrentDraft();
    selectedWorkspaceId = workspaceId;
    setProjectMenuOpen(false);
    hydrateForm();
  }

  function readDraft() {
    const stats = [...document.querySelectorAll('[data-dashboard-stat-slot]')].map(select => select.value);
    return {
      compactDisplay: Boolean(document.getElementById('dashboard-preferences-compact-display')?.checked),
      groupByStatus: Boolean(document.getElementById('dashboard-preferences-group-by-status')?.checked),
      showFocus: document.getElementById('dashboard-preferences-show-focus')?.checked,
      showActiveProjects: document.getElementById('dashboard-preferences-show-active-projects')?.checked,
      showProjectWidgets: document.getElementById('dashboard-preferences-show-project-widgets')?.checked,
      projectScope: {
        mode: document.getElementById('dashboard-preferences-project-scope')?.value,
        projectIds: selectedProjectIds(),
      },
      stats,
      focusItems: selectedFocusItems(),
      hideEmptyFocusItems: document.getElementById('dashboard-preferences-hide-empty-focus')?.checked,
      activeProjects: {
        limit: Number(document.getElementById('dashboard-preferences-project-limit')?.value),
        sort: document.getElementById('dashboard-preferences-project-sort')?.value,
      },
    };
  }

  function readForm() {
    const draft = readDraft();
    if (draft.stats.length !== 4 || new Set(draft.stats).size !== 4) {
      const error = document.getElementById('dashboard-preferences-error');
      if (error) error.textContent = t('dashboard.preferences.validation.stats');
      return null;
    }

    return normalizeDashboardPreferences(draft);
  }

  function openDashboardPreferences(returnFocusTo = null) {
    const modal = getModal();
    lastFocusedElement = returnFocusTo
      || (!modal?.contains?.(document.activeElement) ? document.activeElement : lastFocusedElement);
    workspaceDrafts.clear();
    const workspaces = availableWorkspaces();
    const currentWorkspaceId = getCurrentWorkspaceId?.();
    selectedWorkspaceId = workspaces.some(workspace => String(workspace.id) === String(currentWorkspaceId))
      ? currentWorkspaceId
      : workspaces[0]?.id ?? null;
    renderWorkspaceOptions();
    hydrateForm();
    setChecked('dashboard-preferences-sync-enabled', getSyncEnabled?.());
    hydratePreferenceSelects();
    document.getElementById('user-menu')?.classList.remove('active');
    document.getElementById('user-menu-button')?.setAttribute('aria-expanded', 'false');
    modal?.classList.add('active');
    modal?.setAttribute('aria-hidden', 'false');
    window.setTimeout(() => document.getElementById('dashboard-preferences-compact-display')?.focus(), 0);
  }

  function closeDashboardPreferences() {
    setProjectMenuOpen(false);
    const modal = getModal();
    modal?.classList.remove('active');
    modal?.setAttribute('aria-hidden', 'true');
    if (lastFocusedElement?.isConnected) lastFocusedElement.focus();
  }

  function trapDashboardPreferencesFocus(event) {
    if (event.key !== 'Tab') return;
    const modal = getModal();
    if (!modal?.classList.contains('active')) return;
    const focusable = Array.from(modal.querySelectorAll('a[href], button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])'))
      .filter(element => !element.closest('[hidden]'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function saveDashboardPreferencesFromForm(event) {
    event?.preventDefault?.();
    stashCurrentDraft();
    const normalizedDrafts = [];
    for (const [workspaceId, draft] of workspaceDrafts) {
      if (draft.stats.length !== 4 || new Set(draft.stats).size !== 4) {
        selectedWorkspaceId = workspaceId;
        renderWorkspaceOptions(selectedWorkspaceId);
        hydrateDraft(draft);
        const error = document.getElementById('dashboard-preferences-error');
        if (error) error.textContent = t('dashboard.preferences.validation.stats');
        return;
      }
      normalizedDrafts.push([workspaceId, normalizeDashboardPreferences(draft)]);
    }
    normalizedDrafts.forEach(([workspaceId, preferences]) => setPreferences?.(workspaceId, preferences));
    setSyncEnabled?.(Boolean(document.getElementById('dashboard-preferences-sync-enabled')?.checked));
    closeDashboardPreferences();
    renderDashboard?.();
    showToast?.(t('dashboard.preferences.saved'));
  }

  let actionsBound = false;
  function bindDashboardPreferencesActions() {
    if (actionsBound) return;
    actionsBound = true;
    document.addEventListener('click', event => {
      const actionTarget = event.target?.closest?.('[data-dashboard-preferences-action]');
      const action = actionTarget?.dataset.dashboardPreferencesAction;
      if (action === 'open') {
        event.preventDefault();
        openDashboardPreferences(document.getElementById('user-menu-button'));
      } else if (action === 'reset') {
        event.preventDefault();
        const defaults = normalizeDashboardPreferences(DEFAULT_DASHBOARD_PREFERENCES);
        // Reset is an explicit immediate action; closing the modal does not roll it back.
        workspaceDrafts.set(workspaceKey(selectedWorkspaceId), defaults);
        setPreferences?.(selectedWorkspaceId, defaults);
        hydrateForm(defaults);
        renderDashboard?.();
      } else if (action === 'cancel') {
        event.preventDefault();
        closeDashboardPreferences();
      }

      const projectAction = event.target?.closest?.('[data-dashboard-project-action]')?.dataset.dashboardProjectAction;
      if (projectAction === 'toggle') {
        event.preventDefault();
        const dropdown = event.target.closest('.dashboard-preferences-project-dropdown');
        setProjectMenuOpen(!dropdown?.classList.contains('is-open'));
      }

      const projectOption = event.target?.closest?.('[data-dashboard-preference-project-id]');
      if (projectOption) {
        event.preventDefault();
        toggleProjectOption(projectOption);
      }

      if (!event.target?.closest?.('.dashboard-preferences-project-dropdown')) setProjectMenuOpen(false);
    });
    document.addEventListener('input', event => {
      if (event.target?.matches?.('[data-dashboard-project-search]')) filterProjectOptions(event.target.value);
    });
    document.addEventListener('keydown', event => {
      const modal = getModal();
      if (!modal?.classList.contains('active')) return;
      const projectMenu = event.target?.closest?.('.dashboard-preferences-project-menu');
      const projectOption = event.target?.closest?.('[data-dashboard-preference-project-id]');
      if (projectMenu && !projectMenu.hidden) {
        const options = navigableProjectOptions(projectMenu);
        const currentIndex = options.indexOf(projectOption);
        let target = null;
        if (event.key === 'ArrowDown') {
          target = currentIndex >= 0 ? options[(currentIndex + 1) % options.length] : options[0];
        } else if (event.key === 'ArrowUp') {
          target = currentIndex >= 0 ? options[(currentIndex - 1 + options.length) % options.length] : options.at(-1);
        } else if (event.key === 'Home') {
          target = options[0];
        } else if (event.key === 'End') {
          target = options.at(-1);
        } else if (projectOption && (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar')) {
          event.preventDefault();
          toggleProjectOption(projectOption);
          return;
        }
        if (target) {
          event.preventDefault();
          focusProjectOption(target, projectMenu);
          return;
        }
      }
      if (event.key === 'Escape') {
        const sharedDropdownHandledEscape = event.defaultPrevented || isDropdownOpen();
        const dropdown = document.querySelector('.dashboard-preferences-project-dropdown');
        if (dropdown?.classList.contains('is-open')) {
          event.preventDefault();
          setProjectMenuOpen(false, { restoreFocus: true });
          return;
        }
        if (sharedDropdownHandledEscape) return;
        event.preventDefault();
        closeDashboardPreferences();
        return;
      }
      trapDashboardPreferencesFocus(event);
    });
    document.getElementById('dashboard-preferences-form')?.addEventListener('submit', saveDashboardPreferencesFromForm);
    document.getElementById('dashboard-preferences-workspace')?.addEventListener('change', event => {
      switchDashboardWorkspace(event.target.value);
    });
    document.getElementById('dashboard-preferences-project-scope')?.addEventListener('change', updateProjectSelectionState);
    window.addEventListener('nia-language-change', () => {
      if (!getModal()?.classList.contains('active')) return;
      stashCurrentDraft();
      const error = document.getElementById('dashboard-preferences-error');
      const showStatsError = Boolean(error?.textContent);
      renderWorkspaceOptions(selectedWorkspaceId);
      hydrateDraft(currentWorkspaceDraft(), { clearError: false });
      if (error) error.textContent = showStatsError ? t('dashboard.preferences.validation.stats') : '';
    });
  }

  return {
    bindDashboardPreferencesActions,
    closeDashboardPreferences,
    hydrateForm,
    openDashboardPreferences,
    readForm,
  };
}
