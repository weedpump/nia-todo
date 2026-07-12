const DEFAULT_FOCUS_FILTERS = Object.freeze({
  dueMode: 'next_days',
  dueDays: 7,
  projectIds: [],
  priorities: [1, 2, 3, 4],
  statuses: ['pending', 'in_progress'],
});

function normalizeSearchTerm(value) {
  return String(value || '').toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function createFocusFiltersFeature({ renderTodos }) {
  let focusFilters = loadFocusFilters();
  let focusFiltersExpanded = false;
  let focusProjectMenuOpen = false;
  let focusProjectSearch = '';

  function normalizeFocusFilters(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const dueModes = new Set(['any', 'none', 'overdue', 'today', 'tomorrow', 'next_days']);
    const statuses = new Set(['pending', 'in_progress', 'done']);
    const priorities = new Set([1, 2, 3, 4]);
    const next = {
      ...DEFAULT_FOCUS_FILTERS,
      ...source,
      projectIds: Array.isArray(source.projectIds) ? source.projectIds.map(Number).filter(Number.isFinite) : [...DEFAULT_FOCUS_FILTERS.projectIds],
      priorities: Array.isArray(source.priorities) ? source.priorities.map(Number).filter(priority => priorities.has(priority)) : [...DEFAULT_FOCUS_FILTERS.priorities],
      statuses: Array.isArray(source.statuses) ? source.statuses.filter(status => statuses.has(status)) : [...DEFAULT_FOCUS_FILTERS.statuses],
    };
    next.dueMode = dueModes.has(next.dueMode) ? next.dueMode : DEFAULT_FOCUS_FILTERS.dueMode;
    next.dueDays = Math.min(365, Math.max(1, Number.parseInt(next.dueDays, 10) || DEFAULT_FOCUS_FILTERS.dueDays));
    if (!next.priorities.length) next.priorities = [...DEFAULT_FOCUS_FILTERS.priorities];
    if (!next.statuses.length) next.statuses = [...DEFAULT_FOCUS_FILTERS.statuses];
    return next;
  }

  function loadFocusFilters() {
    try {
      return normalizeFocusFilters(JSON.parse(localStorage.getItem('nia-focus-filters') || '{}'));
    } catch {
      return normalizeFocusFilters();
    }
  }

  function saveFocusFilters() {
    localStorage.setItem('nia-focus-filters', JSON.stringify(focusFilters));
  }

  function updateFocusFilters(patch = {}) {
    focusFilters = normalizeFocusFilters({ ...focusFilters, ...patch });
    saveFocusFilters();
    renderTodos();
  }

  function toggleFocusFiltersExpanded() {
    focusFiltersExpanded = !focusFiltersExpanded;
    renderTodos();
  }

  function focusProjectOptionRows() {
    return Array.from(document.querySelectorAll('.focus-project-menu [data-focus-project-option]')).filter(option => !option.hidden);
  }

  function highlightFocusProjectOption(target) {
    const rows = focusProjectOptionRows();
    rows.forEach(option => option.classList.remove('is-highlighted'));
    if (!target) return;
    target.classList.add('is-highlighted');
    target.scrollIntoView({ block: 'nearest' });
  }

  function applyFocusProjectMenuSearch() {
    const term = normalizeSearchTerm(focusProjectSearch);
    const menu = document.querySelector('.focus-project-menu');
    if (!menu) return;
    let visibleCount = 0;
    menu.querySelectorAll('[data-focus-project-option]').forEach(option => {
      const label = normalizeSearchTerm(option.dataset.label);
      const matches = !term || label.includes(term);
      option.hidden = !matches;
      if (matches) visibleCount += 1;
    });
    const empty = menu.querySelector('.ui-select-empty');
    if (empty) empty.hidden = visibleCount > 0 || !menu.querySelector('[data-focus-project-option]');
    const highlighted = menu.querySelector('[data-focus-project-option].is-highlighted');
    if (!highlighted || highlighted.hidden) highlightFocusProjectOption(focusProjectOptionRows()[0]);
  }

  function filterFocusProjectMenu(value) {
    focusProjectSearch = String(value || '');
    applyFocusProjectMenuSearch();
  }

  function moveFocusProjectHighlight(direction = 1) {
    const rows = focusProjectOptionRows();
    if (!rows.length) return;
    const current = rows.findIndex(option => option.classList.contains('is-highlighted'));
    const next = current >= 0 ? (current + direction + rows.length) % rows.length : (direction > 0 ? 0 : rows.length - 1);
    highlightFocusProjectOption(rows[next]);
  }

  function handleFocusProjectMenuKeydown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocusProjectHighlight(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      const target = document.querySelector('.focus-project-menu [data-focus-project-option].is-highlighted:not([hidden])') || focusProjectOptionRows()[0];
      if (target) {
        event.preventDefault();
        target.click();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeFocusProjectMenu();
    }
  }

  function toggleFocusProjectMenu() {
    focusProjectMenuOpen = !focusProjectMenuOpen;
    if (!focusProjectMenuOpen) focusProjectSearch = '';
    renderTodos();
    if (focusProjectMenuOpen) window.setTimeout(() => {
      document.querySelector('.focus-project-menu .ui-select-search-input')?.focus();
      highlightFocusProjectOption(focusProjectOptionRows()[0]);
    }, 0);
  }

  function closeFocusProjectMenu() {
    if (!focusProjectMenuOpen) return;
    focusProjectMenuOpen = false;
    focusProjectSearch = '';
    renderTodos();
  }

  function resetFocusFilters() {
    focusFilters = normalizeFocusFilters();
    focusProjectMenuOpen = false;
    focusProjectSearch = '';
    saveFocusFilters();
    renderTodos();
  }

  function setFocusDueMode(dueMode) {
    updateFocusFilters({ dueMode });
  }

  function setFocusDueDays(dueDays) {
    updateFocusFilters({ dueDays });
  }

  function toggleFocusProject(projectId) {
    const id = Number(projectId);
    if (!Number.isFinite(id)) return;
    const current = new Set(focusFilters.projectIds || []);
    if (current.has(id)) current.delete(id);
    else current.add(id);
    updateFocusFilters({ projectIds: Array.from(current) });
    focusProjectMenuOpen = true;
    window.setTimeout(() => {
      document.querySelector('.focus-project-menu .ui-select-search-input')?.focus();
      highlightFocusProjectOption(focusProjectOptionRows()[0]);
    }, 0);
  }

  function toggleFocusPriority(priority) {
    const value = Number(priority);
    if (![1, 2, 3, 4].includes(value)) return;
    const current = new Set(focusFilters.priorities || []);
    if (current.has(value) && current.size > 1) current.delete(value);
    else current.add(value);
    updateFocusFilters({ priorities: Array.from(current).sort((a, b) => a - b) });
  }

  function toggleFocusStatus(status) {
    if (!['pending', 'in_progress', 'done'].includes(status)) return;
    const current = new Set(focusFilters.statuses || []);
    if (current.has(status) && current.size > 1) current.delete(status);
    else current.add(status);
    updateFocusFilters({ statuses: Array.from(current) });
  }

  let focusProjectMenuDismissalBound = false;
  function bindFocusProjectMenuDismissal() {
    if (focusProjectMenuDismissalBound) return;
    focusProjectMenuDismissalBound = true;
    document.addEventListener('click', (event) => {
      const action = event.target?.closest?.('[data-focus-action]')?.dataset.focusAction;
      if (action === 'reset') resetFocusFilters();
      if (action === 'toggle-expanded') toggleFocusFiltersExpanded();
      if (action === 'toggle-project-menu') toggleFocusProjectMenu();

      const projectOption = event.target?.closest?.('[data-focus-project-id]');
      if (projectOption) toggleFocusProject(projectOption.dataset.focusProjectId);

      const priority = event.target?.closest?.('[data-focus-priority]')?.dataset.focusPriority;
      if (priority) toggleFocusPriority(priority);

      const status = event.target?.closest?.('[data-focus-status]')?.dataset.focusStatus;
      if (status) toggleFocusStatus(status);

      if (focusProjectMenuOpen && !event.target?.closest?.('.focus-project-dropdown')) closeFocusProjectMenu();
    });
    document.addEventListener('change', (event) => {
      if (event.target?.dataset?.focusControl === 'due-mode') setFocusDueMode(event.target.value);
      if (event.target?.dataset?.focusControl === 'due-days') setFocusDueDays(event.target.value);
    });
    document.addEventListener('input', (event) => {
      if (event.target?.dataset?.focusControl === 'project-search') filterFocusProjectMenu(event.target.value);
    });
    document.addEventListener('keydown', (event) => {
      if (event.target?.dataset?.focusControl === 'project-search') {
        handleFocusProjectMenuKeydown(event);
        return;
      }
      if (event.key !== 'Escape' || !focusProjectMenuOpen) return;
      closeFocusProjectMenu();
    });
  }

  return {
    getFocusFilters: () => focusFilters,
    getFocusFiltersExpanded: () => focusFiltersExpanded,
    getFocusProjectMenuOpen: () => focusProjectMenuOpen,
    getFocusProjectSearch: () => focusProjectSearch,
    updateFocusFilters,
    toggleFocusFiltersExpanded,
    toggleFocusProjectMenu,
    closeFocusProjectMenu,
    resetFocusFilters,
    setFocusDueMode,
    setFocusDueDays,
    toggleFocusProject,
    filterFocusProjectMenu,
    handleFocusProjectMenuKeydown,
    toggleFocusPriority,
    toggleFocusStatus,
    bindFocusProjectMenuDismissal,
  };
}
