export const DASHBOARD_PREFERENCES_KEY = 'nia-dashboard-preferences-v3';
const LEGACY_DASHBOARD_PREFERENCES_KEYS = ['nia-dashboard-preferences-v2', 'nia-dashboard-preferences-v1'];

function workspacePreferencesKey(workspaceId) {
  if (workspaceId === null || workspaceId === undefined || workspaceId === '') return DASHBOARD_PREFERENCES_KEY;
  return `${DASHBOARD_PREFERENCES_KEY}:workspace:${String(workspaceId)}`;
}

export const DEFAULT_DASHBOARD_PREFERENCES = Object.freeze({
  version: 3,
  compactDisplay: false,
  groupByStatus: true,
  showFocus: true,
  showActiveProjects: true,
  showProjectWidgets: true,
  projectScope: Object.freeze({
    mode: 'all',
    projectIds: Object.freeze([]),
  }),
  stats: Object.freeze(['total', 'pending', 'in_progress', 'overdue']),
  focusItems: Object.freeze(['overdue', 'due_today', 'due_week', 'high_priority']),
  hideEmptyFocusItems: false,
  activeProjects: Object.freeze({
    limit: 4,
    sort: 'recent',
  }),
});

const PROJECT_SCOPE_MODES = new Set(['all', 'include', 'exclude']);
const DASHBOARD_STATS = new Set(['total', 'pending', 'in_progress', 'overdue', 'due_today', 'done']);
const DASHBOARD_FOCUS_ITEMS = new Set(['overdue', 'due_today', 'due_week', 'high_priority']);
const ACTIVE_PROJECT_LIMITS = new Set([2, 4, 6]);
const ACTIVE_PROJECT_SORTS = new Set(['recent', 'alphabetical', 'open_count']);

function cloneDefaults() {
  return {
    ...DEFAULT_DASHBOARD_PREFERENCES,
    projectScope: {
      ...DEFAULT_DASHBOARD_PREFERENCES.projectScope,
      projectIds: [...DEFAULT_DASHBOARD_PREFERENCES.projectScope.projectIds],
    },
    stats: [...DEFAULT_DASHBOARD_PREFERENCES.stats],
    focusItems: [...DEFAULT_DASHBOARD_PREFERENCES.focusItems],
    activeProjects: { ...DEFAULT_DASHBOARD_PREFERENCES.activeProjects },
  };
}

function normalizeUniqueList(values, allowedValues, limit = Number.POSITIVE_INFINITY) {
  if (!Array.isArray(values)) return [];
  const normalized = [];
  for (const value of values) {
    if (!allowedValues.has(value) || normalized.includes(value)) continue;
    normalized.push(value);
    if (normalized.length >= limit) break;
  }
  return normalized;
}

function normalizeProjectIds(values) {
  if (!Array.isArray(values)) return [];
  const normalized = [];
  for (const value of values) {
    const projectId = Number(value);
    if (!Number.isInteger(projectId) || projectId <= 0 || normalized.includes(projectId)) continue;
    normalized.push(projectId);
  }
  return normalized;
}

function normalizeBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function parseStoredDashboardPreferences(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const legacyDefaultFocusItems = Number(parsed?.version || 1) < 3
      && Array.isArray(parsed?.focusItems)
      && parsed.focusItems.length === 3
      && ['overdue', 'due_today', 'due_week'].every(item => parsed.focusItems.includes(item));
    if (legacyDefaultFocusItems) parsed.focusItems = [...parsed.focusItems, 'high_priority'];
    return normalizeDashboardPreferences(parsed);
  } catch {
    return null;
  }
}

export function normalizeDashboardPreferences(value) {
  const defaults = cloneDefaults();
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const projectScope = source.projectScope && typeof source.projectScope === 'object' ? source.projectScope : {};
  const activeProjects = source.activeProjects && typeof source.activeProjects === 'object' ? source.activeProjects : {};
  const requestedStats = normalizeUniqueList(source.stats, DASHBOARD_STATS, 4);
  const stats = [...requestedStats];
  for (const fallback of defaults.stats) {
    if (stats.length >= 4) break;
    if (!stats.includes(fallback)) stats.push(fallback);
  }
  const requestedFocusItems = normalizeUniqueList(source.focusItems, DASHBOARD_FOCUS_ITEMS);
  const hasExplicitEmptyFocusItems = Array.isArray(source.focusItems) && source.focusItems.length === 0;
  const legacyMode = source.mode === 'full' || source.mode === 'focused' || source.mode === 'compact'
    ? source.mode
    : null;
  const compactDisplay = normalizeBoolean(
    source.compactDisplay,
    legacyMode === 'compact' ? true : defaults.compactDisplay,
  );
  const showFocus = normalizeBoolean(source.showFocus, defaults.showFocus);
  const showActiveProjects = normalizeBoolean(source.showActiveProjects, defaults.showActiveProjects);
  const showProjectWidgets = normalizeBoolean(source.showProjectWidgets, defaults.showProjectWidgets);

  return {
    version: 3,
    compactDisplay,
    groupByStatus: normalizeBoolean(source.groupByStatus, defaults.groupByStatus),
    showFocus: legacyMode === 'compact' ? false : showFocus,
    showActiveProjects: legacyMode && legacyMode !== 'full' ? false : showActiveProjects,
    showProjectWidgets: legacyMode === 'compact' ? false : showProjectWidgets,
    projectScope: {
      mode: PROJECT_SCOPE_MODES.has(projectScope.mode) ? projectScope.mode : defaults.projectScope.mode,
      projectIds: normalizeProjectIds(projectScope.projectIds),
    },
    stats,
    focusItems: hasExplicitEmptyFocusItems || requestedFocusItems.length ? requestedFocusItems : [...defaults.focusItems],
    hideEmptyFocusItems: normalizeBoolean(source.hideEmptyFocusItems, defaults.hideEmptyFocusItems),
    activeProjects: {
      limit: ACTIVE_PROJECT_LIMITS.has(Number(activeProjects.limit)) ? Number(activeProjects.limit) : defaults.activeProjects.limit,
      sort: ACTIVE_PROJECT_SORTS.has(activeProjects.sort) ? activeProjects.sort : defaults.activeProjects.sort,
    },
  };
}

export function loadDashboardPreferences(storage = globalThis.localStorage, workspaceId = null) {
  const key = workspacePreferencesKey(workspaceId);
  const workspaceScoped = key !== DASHBOARD_PREFERENCES_KEY;
  const workspaceRaw = storage?.getItem?.(key);
  const globalEntries = [
    [DASHBOARD_PREFERENCES_KEY, storage?.getItem?.(DASHBOARD_PREFERENCES_KEY)],
    ...LEGACY_DASHBOARD_PREFERENCES_KEYS.map(legacyKey => [legacyKey, storage?.getItem?.(legacyKey)]),
  ];
  const legacyProjectWidgetRaw = storage?.getItem?.('nia-project-widget');
  const hasLegacyProjectWidget = legacyProjectWidgetRaw !== null && legacyProjectWidgetRaw !== undefined;
  const concrete = parseStoredDashboardPreferences(workspaceRaw);
  const global = globalEntries.map(([, raw]) => parseStoredDashboardPreferences(raw)).find(Boolean) || null;
  const normalized = concrete || global || cloneDefaults();

  if (!workspaceScoped) {
    if (hasLegacyProjectWidget) normalized.showProjectWidgets = legacyProjectWidgetRaw !== 'false';
    return normalized;
  }

  const hasPendingGlobal = globalEntries.some(([, raw]) => raw !== null && raw !== undefined);
  if (hasLegacyProjectWidget) normalized.showProjectWidgets = legacyProjectWidgetRaw !== 'false';
  if ((!concrete && (global || hasLegacyProjectWidget)) || (concrete && (hasPendingGlobal || hasLegacyProjectWidget))) {
    storage?.setItem?.(key, JSON.stringify(normalized));
    globalEntries.forEach(([globalKey]) => storage?.removeItem?.(globalKey));
    if (hasLegacyProjectWidget) storage?.removeItem?.('nia-project-widget');
  }
  return normalized;
}

export function saveDashboardPreferences(storage = globalThis.localStorage, preferences, workspaceId = null) {
  const normalized = normalizeDashboardPreferences(preferences);
  const key = workspacePreferencesKey(workspaceId);
  storage?.setItem?.(key, JSON.stringify(normalized));
  if (key !== DASHBOARD_PREFERENCES_KEY) storage?.removeItem?.(DASHBOARD_PREFERENCES_KEY);
  LEGACY_DASHBOARD_PREFERENCES_KEYS.forEach(key => storage?.removeItem?.(key));
  return normalized;
}

export function getEffectiveDashboardPreferences(preferences, { minimal = false } = {}) {
  const normalized = normalizeDashboardPreferences(preferences);
  if (!minimal) return normalized;
  return {
    ...normalized,
    compactDisplay: true,
    showFocus: false,
    showActiveProjects: false,
    showProjectWidgets: false,
  };
}

export function filterTodosForTodayFocus(todos, now = new Date()) {
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);
  return (Array.isArray(todos) ? todos : []).filter(todo => {
    if (todo?.status === 'done') return false;
    if (todo?.is_pinned) return true;
    const reminder = todo?.remind_at
      || todo?.reminders?.find?.(entry => !entry?.sent_at)?.remind_at
      || todo?.reminders?.[0]?.remind_at;
    const dueDate = parseDashboardDate(todo?.due_date);
    const reminderDate = parseDashboardDate(reminder);
    if (dueDate && dueDate <= todayEnd) return true;
    if (reminderDate && reminderDate <= todayEnd) return true;
    if (!dueDate && !reminderDate) return Number(todo?.priority) === 1;
    return false;
  });
}

export function selectDashboardWorkspaceTodos(todos, validProjectIds = new Set(), workspaceId = null) {
  return (Array.isArray(todos) ? todos : []).filter(todo => {
    const rawProjectId = todo?.project_id;
    if (rawProjectId !== null && rawProjectId !== undefined && rawProjectId !== '') {
      return validProjectIds.has(Number(rawProjectId));
    }
    if (workspaceId === null || workspaceId === undefined || workspaceId === '') return true;
    const todoWorkspaceId = todo?.workspace_id;
    return todoWorkspaceId === null || todoWorkspaceId === undefined || todoWorkspaceId === ''
      || String(todoWorkspaceId) === String(workspaceId);
  });
}

export function filterTodosForDashboard(todos, preferences, validProjectIds = new Set()) {
  const normalized = normalizeDashboardPreferences(preferences);
  const selectedIds = new Set(normalized.projectScope.projectIds);
  return (Array.isArray(todos) ? todos : []).filter(todo => {
    const rawProjectId = todo?.project_id;
    if (rawProjectId === null || rawProjectId === undefined || rawProjectId === '') {
      return normalized.projectScope.mode !== 'include';
    }

    const projectId = Number(rawProjectId);
    if (!Number.isInteger(projectId) || !validProjectIds.has(projectId)) return false;
    if (normalized.projectScope.mode === 'include') return selectedIds.has(projectId);
    if (normalized.projectScope.mode === 'exclude') return !selectedIds.has(projectId);
    return true;
  });
}

function parseDashboardDate(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (dateOnly) {
      const [, yearText, monthText, dayText] = dateOnly;
      const year = Number(yearText);
      const month = Number(monthText) - 1;
      const day = Number(dayText);
      const parsed = new Date(year, month, day, 23, 59, 59, 999);
      return parsed.getFullYear() === year && parsed.getMonth() === month && parsed.getDate() === day
        ? parsed
        : null;
    }
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function calculateDashboardMetrics(todos, now = new Date()) {
  const source = Array.isArray(todos) ? todos : [];
  return {
    total: filterTodosForDashboardDrilldown(source, 'total', now).length,
    pending: filterTodosForDashboardDrilldown(source, 'pending', now).length,
    in_progress: filterTodosForDashboardDrilldown(source, 'in_progress', now).length,
    done: filterTodosForDashboardDrilldown(source, 'done', now).length,
    overdue: filterTodosForDashboardDrilldown(source, 'overdue', now).length,
    due_today: filterTodosForDashboardDrilldown(source, 'due_today', now).length,
    due_week: filterTodosForDashboardDrilldown(source, 'due_week', now).length,
    high_priority: filterTodosForDashboardDrilldown(source, 'high_priority', now).length,
  };
}

export function filterTodosForDashboardDrilldown(todos, metric, now = new Date()) {
  const visibleTodos = (Array.isArray(todos) ? todos : []).filter(todo => todo?.status !== 'archived');
  if (metric === 'total') return visibleTodos;
  if (metric === 'pending' || metric === 'in_progress' || metric === 'done') {
    return visibleTodos.filter(todo => todo?.status === metric);
  }

  const activeTodos = visibleTodos.filter(todo => todo?.status !== 'done');
  if (metric === 'high_priority') {
    return activeTodos.filter(todo => Number(todo?.priority) === 1 || Number(todo?.priority) === 2);
  }

  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(now);
  dayEnd.setHours(23, 59, 59, 999);
  const weekEnd = new Date(dayEnd);
  weekEnd.setDate(weekEnd.getDate() + 7);

  if (metric === 'overdue') {
    return activeTodos.filter(todo => {
      const due = parseDashboardDate(todo?.due_date);
      return Boolean(due && due < now);
    });
  }
  if (metric === 'due_today') {
    return activeTodos.filter(todo => {
      const due = parseDashboardDate(todo?.due_date);
      return Boolean(due && due >= dayStart && due <= dayEnd);
    });
  }
  if (metric === 'due_week') {
    return activeTodos.filter(todo => {
      const due = parseDashboardDate(todo?.due_date);
      return Boolean(due && due > dayEnd && due <= weekEnd);
    });
  }
  return [];
}
