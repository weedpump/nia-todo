import { apiResourceUrl } from '../core/config.js';
import { loadAuthenticatedImage, releaseAuthenticatedImage } from '../core/authenticated-image.js';
import { getActiveLocale, t } from '../i18n/index.js';
import { iconSvg, markerHtml, safeColor, safeIconName } from '../icons/lucide-icons.js';
import { hydrateSelect, refreshSelect } from '../ui/dropdowns.js';
import { calculateDashboardMetrics, filterTodosForDashboard, filterTodosForDashboardDrilldown, filterTodosForTodayFocus, getEffectiveDashboardPreferences, selectDashboardWorkspaceTodos } from './dashboard-preferences.js';

export function createAppRenderingFeature({
  appVersion,
  escapeHtml,
  escapeHtmlAttr,
  getTodos,
  getProjects,
  getSections,
  getCurrentFilter,
  getCurrentProjectId,
  getCurrentWorkspaceId,
  getHideDone,
  getTodayFocus,
  getShowProjectWidget,
  getDashboardPreferences,
  getDashboardDrilldown = () => null,
  getMinimalTodos,
  getCurrentUser,
  getFocusFilters,
  getFocusFiltersExpanded,
  getFocusProjectMenuOpen,
  getFocusProjectSearch,
  sortTodoList,
  renderTodoItem,
  renderSectionHeader,
  renderCalendarView,
  cleanupCalendarView,
  getInvites,
}) {
  function renderVersionInfo() {
    const el = document.getElementById('version-info');
    if (!el) return;

    let versionText = el.querySelector('.version-text');
    if (!versionText) {
      versionText = document.createElement('span');
      versionText.className = 'version-text';
      el.prepend(versionText);
    }
    versionText.textContent = appVersion;

    const actions = document.getElementById('version-actions');
    if (!actions) return;

    if (!actions.querySelector('#changelog-link')) {
      const changelog = document.createElement('a');
      changelog.className = 'changelog-link version-action-btn';
      changelog.id = 'changelog-link';
      changelog.href = '/changelog';
      changelog.target = '_blank';
      changelog.rel = 'noopener noreferrer';
      changelog.title = t('version.openChangelog');
      changelog.textContent = t('resource.changelog');
      actions.appendChild(changelog);
    }

    if (!actions.querySelector('.version-action-separator')) {
      const separator = document.createElement('span');
      separator.className = 'version-action-separator';
      separator.setAttribute('aria-hidden', 'true');
      separator.textContent = '|';
      actions.appendChild(separator);
    }

    if (!actions.querySelector('#force-refresh-btn')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'force-refresh-btn version-action-btn';
      button.id = 'force-refresh-btn';
      button.title = t('version.refreshCache');
      button.textContent = t('version.reload');
      if (document.getElementById('online-status')?.classList.contains('status-offline')) {
        button.disabled = true;
        button.classList.add('is-offline-disabled');
        button.setAttribute('aria-disabled', 'true');
      }
      actions.appendChild(button);
    }
  }

  function getWorkspaceProjects() {
    const currentWorkspaceId = getCurrentWorkspaceId?.();
    const projects = getProjects();
    if (!currentWorkspaceId) return projects;
    return projects.filter(project => String(project.workspace_id || '') === String(currentWorkspaceId));
  }

  function getWorkspaceTodos() {
    const workspaceProjects = getWorkspaceProjects();
    const projectIds = new Set(workspaceProjects.map(project => Number(project.id)));
    return selectDashboardWorkspaceTodos(getTodos(), projectIds, getCurrentWorkspaceId?.());
  }

  function countByProject(pid) {
    return getWorkspaceTodos().filter(todo => todo.project_id === pid && todo.status !== 'done').length;
  }

  function renderProjects() {
    const el = document.getElementById('project-list');
    if (!el) return;
    const projects = getWorkspaceProjects();
    const currentFilter = getCurrentFilter();
    const currentProjectId = getCurrentProjectId();

    const ownProjects = projects.filter(p => !p.is_shared);
    const sharedProjects = projects.filter(p => p.is_shared);

    const projectMap = new Map();
    ownProjects.forEach(p => projectMap.set(p.id, { ...p, children: [] }));

    const rootProjects = [];
    projectMap.forEach(p => {
      if (p.parent_id === null || p.parent_id === undefined) {
        rootProjects.push(p);
      } else {
        const parent = projectMap.get(p.parent_id);
        if (parent) parent.children.push(p);
      }
    });

    rootProjects.sort((a, b) => {
      if (!!a.is_inbox !== !!b.is_inbox) return a.is_inbox ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    function renderProjectTree(project, depth = 0) {
      const indent = depth * 16;
      const hasChildren = project.children && project.children.length > 0;

      let html = '';
      html += `<div class="project-tree-item" style="padding-left: ${indent}px">`;
      html += `<div class="nav-item-with-action">`;
      const isActiveProject = Number(currentProjectId) === Number(project.id);
      html += `<button class="nav-btn ui-nav-pill project-drop-target ${isActiveProject ? 'active' : ''}" data-filter="${escapeHtmlAttr(project.id)}" data-project-id="${escapeHtmlAttr(project.id)}">`;
      html += markerHtml({ ...project, color: escapeHtmlAttr(project.color || '#6366f1'), icon: project.icon });
      html += `${escapeHtml(project.name)}`;
      html += `<span class="badge">${countByProject(project.id)}</span>`;
      html += `</button>`;
      html += `<button class="nav-edit" data-project-action="edit" data-project-id="${escapeHtmlAttr(project.id)}" title="${escapeHtmlAttr(t('common.edit'))}">`;
      html += iconSvg('edit-3');
      html += `</button>`;
      html += `</div>`;
      html += `</div>`;

      if (hasChildren) {
        project.children.sort((a, b) => a.name.localeCompare(b.name));
        project.children.forEach(child => { html += renderProjectTree(child, depth + 1); });
      }

      return html;
    }

    let html = '';
    if (rootProjects.length) {
      html += rootProjects.map(p => renderProjectTree(p)).join('');
    }
    if (sharedProjects.length) {
      html += `<div class="nav-title shared-title">${escapeHtml(t('project.sharedProjects'))}</div>`;
      for (const project of sharedProjects) {
        html += renderProjectTree({ ...project, children: [] });
      }
    }
    el.innerHTML = html;
  }

  function renderStats() {
    const el = document.getElementById('stats-bar');
    if (!el) return;
    const todos = getWorkspaceTodos();
    const projects = getWorkspaceProjects();
    const currentFilter = getCurrentFilter();
    const currentProjectId = getCurrentProjectId();
    const search = document.getElementById('search-input')?.value?.trim() || '';
    const now = new Date();
    const validProjectIds = new Set(projects.map(project => Number(project.id)));
    const navigationMetrics = calculateDashboardMetrics(todos, now);
    const activeTodos = todos.filter(t => t.status !== 'done');
    const focusCount = applyFocusFilters(todos, validProjectIds).length;
    const calendarCount = activeTodos.filter(t => t.due_date).length;
    const dashboardPreferences = getEffectiveDashboardPreferences(getDashboardPreferences?.(), {
      minimal: Boolean(getMinimalTodos?.()),
    });
    const dashboardTodos = filterTodosForDashboard(todos, dashboardPreferences, validProjectIds);
    const visibleDashboardTodos = getTodayFocus?.()
      ? filterTodosForTodayFocus(dashboardTodos, now)
      : dashboardTodos;
    const dashboardMetrics = calculateDashboardMetrics(visibleDashboardTodos, now);

    const setCount = (id, value) => {
      const node = document.getElementById(id);
      if (node) node.textContent = value;
    };
    setCount('count-all', navigationMetrics.total);
    setCount('count-focus', focusCount);
    setCount('count-calendar', calendarCount);
    setCount('count-pending', navigationMetrics.pending);
    setCount('count-in_progress', navigationMetrics.in_progress);
    setCount('count-done', navigationMetrics.done);

    const user = getCurrentUser?.();
    const displayName = user?.display_name || user?.username || t('overview.defaultUser');
    const initial = (displayName.trim()[0] || 'U').toUpperCase();
    const avatarVersion = user?.avatar_updated_at ? encodeURIComponent(user.avatar_updated_at) : '';
    const avatarBaseSrc = user?.avatar_url ? apiResourceUrl(user.avatar_url) : '';
    const avatarSrc = avatarBaseSrc ? `${avatarBaseSrc}${avatarVersion ? `?v=${avatarVersion}` : ''}` : '';
    const currentAvatar = el.querySelector('[data-auth-avatar]');
    const reusableAvatar = currentAvatar
      && (currentAvatar.dataset.authAvatarSrc === avatarSrc || currentAvatar.dataset.authAvatarPendingSrc === avatarSrc)
      ? currentAvatar
      : null;
    if (currentAvatar && !reusableAvatar) releaseAuthenticatedImage(currentAvatar);
    const locale = getActiveLocale();
    const dateTime = new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }).format(now);

    document.querySelectorAll('.nav-btn[data-filter="all"], .nav-btn[data-filter="focus"], .nav-btn[data-filter="calendar"], .nav-btn[data-filter="pending"], .nav-btn[data-filter="in_progress"], .nav-btn[data-filter="done"]').forEach((button) => {
      button.classList.toggle('active', !currentProjectId && button.dataset.filter === String(currentFilter));
    });

    const showDashboard = currentFilter === 'all' && !currentProjectId && !search;
    el.hidden = !showDashboard;
    if (!showDashboard) {
      if (currentAvatar) releaseAuthenticatedImage(currentAvatar);
      el.innerHTML = '';
      return;
    }

    function parseTodoTimestamp(value) {
      if (!value) return null;
      const normalized = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T');
      const date = new Date(normalized);
      return Number.isFinite(date.getTime()) ? date : null;
    }

    function formatRelativeTime(date) {
      if (!date) return '–';
      const diffMs = now.getTime() - date.getTime();
      const diffMinutes = Math.max(0, Math.round(diffMs / 60000));
      if (diffMinutes < 1) return t('time.justNow');
      if (diffMinutes < 60) return t('time.minutesAgo', { count: diffMinutes });
      const diffHours = Math.round(diffMinutes / 60);
      if (diffHours < 24) return t('time.hoursAgo', { count: diffHours });
      const diffDays = Math.round(diffHours / 24);
      if (diffDays < 7) return t('time.daysAgo', { count: diffDays });
      return new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit' }).format(date);
    }

    const activeProjects = projects
      .map(project => {
        const projectTodos = visibleDashboardTodos.filter(todo => Number(todo.project_id) === Number(project.id));
        const latestDate = projectTodos
          .map(todo => parseTodoTimestamp(todo.updated_at || todo.created_at))
          .filter(Boolean)
          .sort((a, b) => b.getTime() - a.getTime())[0] || null;
        return {
          ...project,
          latestTodoAt: latestDate,
          latestTodoLabel: formatRelativeTime(latestDate),
          openCount: projectTodos.filter(todo => todo.status !== 'done').length,
          dashboardTodoCount: projectTodos.length,
        };
      })
      .filter(project => project.dashboardTodoCount > 0)
      .sort((a, b) => {
        if (dashboardPreferences.activeProjects.sort === 'alphabetical') return a.name.localeCompare(b.name);
        if (dashboardPreferences.activeProjects.sort === 'open_count') {
          return b.openCount - a.openCount || a.name.localeCompare(b.name);
        }
        return (b.latestTodoAt?.getTime() || 0) - (a.latestTodoAt?.getTime() || 0) || a.name.localeCompare(b.name);
      })
      .slice(0, dashboardPreferences.activeProjects.limit);

    const cardDefinitions = {
      total: { cls: 'total', label: t('overview.stats.total'), hint: t('overview.stats.totalHint') },
      pending: { cls: 'pending', label: t('todo.status.pending'), hint: t('overview.stats.pendingHint') },
      in_progress: { cls: 'progress', label: t('todo.status.inProgress'), hint: t('overview.stats.inProgressHint') },
      overdue: { cls: 'due', label: t('overview.stats.overdue'), hint: dashboardMetrics.overdue ? t('overview.stats.overdueNeedsCare') : t('overview.stats.overdueRelaxed') },
      due_today: { cls: 'today', label: t('dashboard.preferences.stats.dueToday'), hint: '' },
      done: { cls: 'done', label: t('dashboard.preferences.stats.done'), hint: '' },
    };
    const cards = dashboardPreferences.stats.map(metric => ({
      metric,
      num: dashboardMetrics[metric] || 0,
      ...cardDefinitions[metric],
    })).filter(card => card.cls);

    const focusDefinitions = {
      overdue: { icon: iconSvg('triangle-alert'), label: t('dashboard.preferences.focus.overdue') },
      due_today: { icon: iconSvg('calendar'), label: t('dashboard.preferences.focus.today') },
      due_week: { icon: iconSvg('calendar-days'), label: t('dashboard.preferences.focus.week') },
      high_priority: { icon: iconSvg('flag'), label: t('dashboard.preferences.focus.priority') },
    };
    const focusItems = dashboardPreferences.focusItems
      .map(metric => ({ metric, value: dashboardMetrics[metric] || 0, ...focusDefinitions[metric] }))
      .filter(item => item.label && (!dashboardPreferences.hideEmptyFocusItems || item.value > 0));
    const showFocusPanel = dashboardPreferences.showFocus && focusItems.length > 0;
    const showProjectsPanel = dashboardPreferences.showActiveProjects;

    el.innerHTML = `
      <section class="overview-dashboard" data-dashboard-compact="${dashboardPreferences.compactDisplay ? 'true' : 'false'}" aria-label="${escapeHtmlAttr(t('overview.aria'))}">
        <div class="overview-dashboard-header">
          <div class="overview-greeting">
            <div class="overview-avatar" aria-hidden="true">
              ${avatarSrc ? `<img data-auth-avatar alt="">` : escapeHtml(initial)}
            </div>
            <div>
              <div class="overview-kicker">${escapeHtml(dateTime)}</div>
              <h2>${escapeHtml(t('overview.greeting', { name: displayName }))}</h2>
              ${dashboardPreferences.compactDisplay ? '' : `<div class="overview-subtitle">${escapeHtml(t('overview.subtitle'))}</div>`}
            </div>
          </div>
        </div>
        <div class="overview-stat-grid">
          ${cards.map(card => `
            <button type="button" class="overview-stat-card ${card.cls}" data-dashboard-metric="${escapeHtmlAttr(card.metric)}">
              <span class="overview-stat-num">${card.num}</span>
              <span>
                <span class="overview-stat-label">${escapeHtml(card.label)}</span>
                ${card.hint ? `<span class="overview-stat-hint">${escapeHtml(card.hint)}</span>` : ''}
              </span>
            </button>
          `).join('')}
        </div>
        ${showFocusPanel || showProjectsPanel ? `<div class="overview-detail-grid ${showFocusPanel && showProjectsPanel ? '' : 'single-panel'}">
          ${showFocusPanel ? `<div class="overview-panel">
            <div class="overview-panel-title">${escapeHtml(t('dashboard.preferences.focus.title'))}</div>
            <div class="overview-focus-list">
              ${focusItems.map(item => `
                <button type="button" class="overview-focus-item" data-dashboard-metric="${escapeHtmlAttr(item.metric)}">
                  <span>${item.icon}</span>
                  <span>${escapeHtml(item.label)}</span>
                  <strong>${item.value}</strong>
                </button>
              `).join('')}
            </div>
          </div>` : ''}
          ${showProjectsPanel ? `<div class="overview-panel">
            <div class="overview-panel-title">${escapeHtml(t('overview.activeProjects'))}</div>
            <div class="overview-project-list">
              ${activeProjects.length ? activeProjects.map(project => `
                <button type="button" class="overview-project-item" data-nav-filter="${escapeHtmlAttr(project.id)}">
                  ${markerHtml({ ...project, color: escapeHtmlAttr(project.color || '#6366f1'), icon: project.icon })}
                  <span>${escapeHtml(project.name)}</span>
                  <strong>${dashboardPreferences.activeProjects.sort === 'open_count' ? project.openCount : escapeHtml(project.latestTodoLabel)}</strong>
                </button>
              `).join('') : `<div class="overview-empty-mini">${escapeHtml(t('overview.noTodoChanges'))}</div>`}
            </div>
          </div>` : ''}
        </div>` : ''}
      </section>`;
    if (avatarSrc) {
      const nextAvatar = el.querySelector('[data-auth-avatar]');
      if (reusableAvatar) {
        nextAvatar?.replaceWith(reusableAvatar);
      } else if (nextAvatar) {
        nextAvatar.dataset.authAvatarPendingSrc = avatarSrc;
        loadAuthenticatedImage(nextAvatar, avatarSrc).then(loaded => {
          const stillCurrent = el.querySelector('[data-auth-avatar]') === nextAvatar
            && nextAvatar.dataset.authAvatarPendingSrc === avatarSrc;
          if (!stillCurrent) {
            if (loaded) releaseAuthenticatedImage(nextAvatar);
            return;
          }
          delete nextAvatar.dataset.authAvatarPendingSrc;
          if (loaded) nextAvatar.dataset.authAvatarSrc = avatarSrc;
        });
      }
    }
  }

  function sortProjectSectionTodos(list) {
    const statusOrder = { in_progress: 0, pending: 1, done: 2 };
    return sortTodoList(list)
      .map((todo, index) => ({ todo, index }))
      .sort((a, b) => {
        const sa = statusOrder[a.todo.status] ?? 3;
        const sb = statusOrder[b.todo.status] ?? 3;
        if (sa !== sb) return sa - sb;
        return a.index - b.index;
      })
      .map(item => item.todo);
  }

  function renderProjectDashboard(project, projectTodos) {
    if (!project) return '';
    const dashboardDrilldown = getDashboardDrilldown?.();
    const drilldownBanner = dashboardDrilldown ? `<div class="dashboard-drilldown-banner project-dashboard-drilldown" role="status">
        <span>${iconSvg('list-filter')} ${escapeHtml(t('dashboard.drilldown.label', { filter: ({
          total: t('overview.stats.total'),
          pending: t('todo.status.pending'),
          in_progress: t('todo.status.inProgress'),
          done: t('dashboard.preferences.stats.done'),
          overdue: t('overview.stats.overdue'),
          due_today: t('dashboard.preferences.stats.dueToday'),
        })[dashboardDrilldown] || dashboardDrilldown }))}</span>
        <button type="button" class="btn btn-secondary btn-small" data-dashboard-drilldown-action="clear" data-dashboard-return-filter="${escapeHtmlAttr(project.id)}">${iconSvg('x')} ${escapeHtml(t('dashboard.drilldown.clear'))}</button>
      </div>` : '';
    if (!getShowProjectWidget?.()) return drilldownBanner;
    const now = new Date();
    const dashboardPreferences = getEffectiveDashboardPreferences(getDashboardPreferences?.(), {
      minimal: Boolean(getMinimalTodos?.()),
    });
    const visibleProjectTodos = getTodayFocus?.() ? filterTodosForTodayFocus(projectTodos, now) : projectTodos;
    const projectMetrics = calculateDashboardMetrics(visibleProjectTodos, now);
    const statDefinitions = {
      total: { cls: 'total', label: t('overview.stats.total'), hint: t('project.dashboard.totalHint') },
      pending: { cls: 'pending', label: t('todo.status.pending'), hint: t('project.dashboard.pendingHint') },
      in_progress: { cls: 'progress', label: t('todo.status.inProgress'), hint: t('project.dashboard.inProgressHint') },
      overdue: { cls: 'due', label: t('overview.stats.overdue'), hint: t('project.dashboard.overdueHint') },
      due_today: { cls: 'today', label: t('dashboard.preferences.stats.dueToday'), hint: '' },
      done: { cls: 'done', label: t('dashboard.preferences.stats.done'), hint: '' },
    };
    const stats = dashboardPreferences.stats
      .map(metric => ({ metric, num: projectMetrics[metric] || 0, ...statDefinitions[metric] }))
      .filter(stat => stat.cls);
    const color = safeColor(project.color);
    const subtitle = project.is_shared ? t('project.dashboard.shared') : t('project.dashboard.subtitle');
    return `<section class="overview-dashboard project-dashboard" data-dashboard-compact="${dashboardPreferences.compactDisplay ? 'true' : 'false'}" aria-label="${escapeHtmlAttr(t('project.dashboard.aria'))}">
      <div class="overview-dashboard-header project-dashboard-header">
        <div class="overview-greeting">
          <span class="project-dashboard-avatar" style="--project-color:${escapeHtmlAttr(color)}">${safeIconName(project.icon) ? iconSvg(project.icon) : '<span class="project-dashboard-dot"></span>'}</span>
          <div>
            <div class="overview-kicker">${escapeHtml(t('todo.project'))}</div>
            <h2>${escapeHtml(project.name)}</h2>
            <div class="overview-subtitle">${subtitle}</div>
          </div>
        </div>
      </div>
      <div class="overview-stat-grid">
        ${stats.map(stat => `
          <button type="button" class="overview-stat-card ${stat.cls}" data-dashboard-metric="${escapeHtmlAttr(stat.metric)}" data-dashboard-project-id="${escapeHtmlAttr(project.id)}">
            <span class="overview-stat-num">${stat.num}</span>
            <span>
              <span class="overview-stat-label">${stat.label}</span>
              ${stat.hint ? `<span class="overview-stat-hint">${stat.hint}</span>` : ''}
            </span>
          </button>
        `).join('')}
      </div>
    </section>${drilldownBanner}`;
  }

  function parseTodoDate(value) {
    if (!value) return null;
    const date = new Date(String(value).includes('T') ? value : String(value).replace(' ', 'T'));
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function parseTodoReminderDate(todo) {
    const raw = todo?.remind_at || todo?.reminders?.find?.(reminder => !reminder.sent_at)?.remind_at || todo?.reminders?.[0]?.remind_at;
    return parseTodoDate(raw);
  }

  function effectiveFocusDate(todo) {
    return parseTodoDate(todo?.due_date) || parseTodoReminderDate(todo);
  }

  function endOfToday() {
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    return today;
  }

  function applyFocusFilters(items, validProjectIds = null) {
    const filters = getFocusFilters?.() || {};
    const rawProjectIds = (filters.projectIds || []).map(Number);
    const projectIds = new Set(validProjectIds ? rawProjectIds.filter(id => validProjectIds.has(id)) : rawProjectIds);
    const priorities = new Set((filters.priorities || [1, 2, 3, 4]).map(Number));
    const statuses = new Set(filters.statuses || ['pending', 'in_progress']);
    const now = new Date();
    const todayEnd = endOfToday();
    const tomorrowStart = new Date(todayEnd);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    tomorrowStart.setHours(0, 0, 0, 0);
    const tomorrowEnd = new Date(tomorrowStart);
    tomorrowEnd.setHours(23, 59, 59, 999);
    const daysEnd = new Date(todayEnd);
    daysEnd.setDate(daysEnd.getDate() + Math.max(1, Number(filters.dueDays || 7) - 1));

    return items.filter(todo => {
      if (statuses.size && !statuses.has(todo.status)) return false;
      if (projectIds.size && !projectIds.has(Number(todo.project_id))) return false;
      if (priorities.size && !priorities.has(Number(todo.priority))) return false;

      const due = parseTodoDate(todo.due_date);
      const focusDate = due || parseTodoReminderDate(todo);
      switch (filters.dueMode || 'next_days') {
        case 'any':
          return true;
        case 'none':
          return !focusDate;
        case 'overdue':
          return Boolean(focusDate && focusDate < now && todo.status !== 'done');
        case 'today':
          return Boolean(focusDate && focusDate >= new Date(now.toDateString()) && focusDate <= todayEnd);
        case 'tomorrow':
          return Boolean(focusDate && focusDate >= tomorrowStart && focusDate <= tomorrowEnd);
        case 'next_days':
        default:
          return Boolean(focusDate && focusDate <= daysEnd);
      }
    });
  }

  function renderFocusControls(projects) {
    const filters = getFocusFilters?.() || {};
    const expanded = Boolean(getFocusFiltersExpanded?.());
    const projectMenuOpen = Boolean(getFocusProjectMenuOpen?.());
    const projectSearch = String(getFocusProjectSearch?.() || '');
    const normalizedProjectSearch = projectSearch.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const dueMode = filters.dueMode || 'next_days';
    const dueDays = Math.max(1, Number(filters.dueDays || 7));
    const validProjectIds = new Set(projects.map(project => Number(project.id)));
    const projectIds = new Set((filters.projectIds || []).map(Number).filter(id => validProjectIds.has(id)));
    const priorities = new Set((filters.priorities || [1, 2, 3, 4]).map(Number));
    const statuses = new Set(filters.statuses || ['pending', 'in_progress']);
    const selectedProjectNames = [...projects]
      .filter(project => projectIds.has(Number(project.id)))
      .map(project => project.name);
    const projectSummary = selectedProjectNames.length
      ? (selectedProjectNames.length <= 2 ? selectedProjectNames.join(', ') : t('focus.projects.selectedCount', { count: selectedProjectNames.length }))
      : t('focus.projects.all');
    const activeParts = [
      dueMode === 'next_days' ? t('focus.summary.nextDays', { count: dueDays }) : t(`focus.due.${dueMode}`),
      projectSummary,
      t('focus.summary.priorities', { count: priorities.size }),
    ];
    const filteredForStats = applyFocusFilters(getWorkspaceTodos(), validProjectIds);
    const activeForStats = filteredForStats.filter(todo => todo.status !== 'done');
    const overdueForStats = activeForStats.filter(todo => {
      const focusDate = effectiveFocusDate(todo);
      return Boolean(focusDate && focusDate < new Date());
    }).length;
    const focusStats = [
      { cls: 'total', num: filteredForStats.length, label: t('overview.stats.total'), hint: t('focus.stats.totalHint') },
      { cls: 'pending', num: filteredForStats.filter(todo => todo.status === 'pending').length, label: t('todo.status.pending'), hint: t('focus.stats.pendingHint') },
      { cls: 'progress', num: filteredForStats.filter(todo => todo.status === 'in_progress').length, label: t('todo.status.inProgress'), hint: t('focus.stats.inProgressHint') },
      { cls: 'due', num: overdueForStats, label: t('overview.stats.overdue'), hint: overdueForStats ? t('overview.stats.overdueNeedsCare') : t('overview.stats.overdueRelaxed') },
    ];
    const statusOptions = [
      ['pending', iconSvg('clock'), t('todo.status.pending')],
      ['in_progress', iconSvg('flame'), t('todo.status.inProgress')],
      ['done', iconSvg('check-circle'), t('todo.status.done')],
    ];
    const priorityOptions = [
      [1, t('todo.priority.veryHigh'), '#ef4444'],
      [2, t('todo.priority.high'), '#f59e0b'],
      [3, t('todo.priority.medium'), '#10b981'],
      [4, t('todo.priority.low'), '#94a3b8'],
    ];
    const projectMap = new Map();
    projects.forEach(project => projectMap.set(project.id, { ...project, children: [] }));
    const rootProjects = [];
    projectMap.forEach(project => {
      if (project.parent_id === null || project.parent_id === undefined) rootProjects.push(project);
      else {
        const parent = projectMap.get(project.parent_id);
        if (parent) parent.children.push(project);
        else rootProjects.push(project);
      }
    });
    rootProjects.sort((a, b) => (!!a.is_inbox !== !!b.is_inbox ? (a.is_inbox ? -1 : 1) : a.name.localeCompare(b.name)));
    const renderProjectOption = (project, depth = 0) => {
      const selected = projectIds.has(Number(project.id));
      const children = (project.children || []).sort((a, b) => a.name.localeCompare(b.name));
      const label = String(project.name || '');
      const matchesSearch = !normalizedProjectSearch || label.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(normalizedProjectSearch);
      return `<button type="button" class="focus-project-option ${selected ? 'is-selected' : ''}" style="--project-depth:${depth}" data-focus-project-option data-focus-project-id="${Number(project.id)}" data-label="${escapeHtmlAttr(label)}" ${matchesSearch ? '' : 'hidden'} role="menuitemcheckbox" aria-checked="${selected ? 'true' : 'false'}">${markerHtml(project)}<span>${escapeHtml(label)}</span><span class="focus-project-check" aria-hidden="true">${iconSvg('check')}</span></button>${children.map(child => renderProjectOption(child, depth + 1)).join('')}`;
    };
    const projectOptions = rootProjects.map(project => renderProjectOption(project)).join('') || `<div class="focus-project-empty">${escapeHtml(t('focus.noProjects'))}</div>`;
    const projectMatchCount = rootProjects.length ? (projectOptions.match(/data-focus-project-option/g) || []).length - (projectOptions.match(/data-focus-project-option[^>]*hidden/g) || []).length : 0;
    const headingActions = expanded
      ? `<button type="button" class="btn btn-secondary btn-small focus-reset-btn" data-focus-action="reset">${iconSvg('refresh-cw')} ${escapeHtml(t('focus.reset'))}</button><button type="button" class="btn btn-secondary btn-small focus-toggle-btn" data-focus-action="toggle-expanded" aria-expanded="true">${iconSvg('chevron-up')} ${escapeHtml(t('focus.collapse'))}</button>`
      : `<button type="button" class="btn btn-secondary btn-small focus-toggle-btn" data-focus-action="toggle-expanded" aria-expanded="false">${iconSvg('chevron-down')} ${escapeHtml(t('focus.expand'))}</button>`;

    return `<section class="overview-dashboard focus-filter-card ${expanded ? 'is-expanded' : 'is-collapsed'}" aria-label="${escapeHtmlAttr(t('focus.aria'))}">
      <div class="overview-dashboard-header focus-filter-heading">
        <div class="overview-greeting">
          <span class="overview-avatar focus-filter-avatar" aria-hidden="true">${iconSvg('funnel')}</span>
          <div>
            <h2>${escapeHtml(t('focus.title'))}</h2>
            <div class="overview-subtitle">${escapeHtml(t('focus.subtitle'))}</div>
          </div>
        </div>
        <div class="focus-heading-actions">${headingActions}</div>
      </div>
      <div class="focus-filter-summary">${activeParts.map(part => `<span>${escapeHtml(part)}</span>`).join('')}</div>
      ${!expanded ? `<div class="overview-stat-grid focus-stat-grid">
        ${focusStats.map(stat => `<div class="overview-stat-card focus-stat-card ${stat.cls}"><div class="overview-stat-num">${stat.num}</div><div><div class="overview-stat-label">${escapeHtml(stat.label)}</div><div class="overview-stat-hint">${escapeHtml(stat.hint)}</div></div></div>`).join('')}
      </div>` : ''}
      <div class="focus-filter-body" ${expanded ? '' : 'hidden'}>
        <div class="focus-filter-grid">
          <div class="form-group focus-due-field">
            <label for="focus-due-mode">${escapeHtml(t('focus.due.label'))}</label>
            <select id="focus-due-mode" data-ui-select data-focus-control="due-mode">
              <option value="any" ${dueMode === 'any' ? 'selected' : ''}>${escapeHtml(t('focus.due.any'))}</option>
              <option value="next_days" ${dueMode === 'next_days' ? 'selected' : ''}>${escapeHtml(t('focus.due.nextDays'))}</option>
              <option value="today" ${dueMode === 'today' ? 'selected' : ''}>${escapeHtml(t('focus.due.today'))}</option>
              <option value="tomorrow" ${dueMode === 'tomorrow' ? 'selected' : ''}>${escapeHtml(t('focus.due.tomorrow'))}</option>
              <option value="overdue" ${dueMode === 'overdue' ? 'selected' : ''}>${escapeHtml(t('focus.due.overdue'))}</option>
              <option value="none" ${dueMode === 'none' ? 'selected' : ''}>${escapeHtml(t('focus.due.none'))}</option>
            </select>
          </div>
          <div class="form-group focus-days-field ${dueMode === 'next_days' ? '' : 'is-muted'}">
            <label for="focus-due-days">${escapeHtml(t('focus.due.days'))}</label>
            <input id="focus-due-days" type="number" min="1" max="365" value="${escapeHtmlAttr(dueDays)}" ${dueMode === 'next_days' ? '' : 'disabled'} data-focus-control="due-days">
          </div>
        </div>
        <div class="focus-filter-section">
          <div class="focus-filter-label">${iconSvg('folder')} ${escapeHtml(t('focus.projects'))}</div>
          <div class="focus-project-dropdown ${projectMenuOpen ? 'is-open' : ''}">
            <button type="button" class="ui-select-trigger focus-project-trigger" data-focus-action="toggle-project-menu" aria-haspopup="menu" aria-expanded="${projectMenuOpen ? 'true' : 'false'}">
              <span class="ui-select-value">${escapeHtml(projectSummary)}</span>
              <span class="ui-select-chevron" aria-hidden="true">${iconSvg('chevron-down')}</span>
            </button>
            <div class="focus-project-menu ui-select-menu project-ui-select-menu" role="menu" ${projectMenuOpen ? '' : 'hidden'}>
              <div class="ui-select-search">
                <span class="ui-select-search-icon" aria-hidden="true">${iconSvg('search')}</span>
                <input type="search" class="ui-select-search-input" value="${escapeHtmlAttr(projectSearch)}" placeholder="${escapeHtmlAttr(t('focus.projects.search'))}" aria-label="${escapeHtmlAttr(t('focus.projects.search'))}" data-focus-control="project-search">
              </div>
              ${projectOptions}
              <div class="ui-select-empty focus-project-empty" ${projectMatchCount > 0 || !rootProjects.length ? 'hidden' : ''}>${escapeHtml(t('focus.projects.noMatches'))}</div>
            </div>
          </div>
        </div>
        <div class="focus-filter-section focus-filter-split">
          <div>
            <div class="focus-filter-label">${iconSvg('flag')} ${escapeHtml(t('focus.priorities'))}</div>
            <div class="focus-chip-row">${priorityOptions.map(([priority, label, color]) => `<button type="button" class="focus-chip priority-chip ${priorities.has(priority) ? 'active' : ''}" data-focus-priority="${priority}"><span class="priority-dot" style="--priority-color:${escapeHtmlAttr(color)}"></span><span>${escapeHtml(label)}</span></button>`).join('')}</div>
          </div>
          <div>
            <div class="focus-filter-label">${iconSvg('list')} ${escapeHtml(t('focus.statuses'))}</div>
            <div class="focus-chip-row">${statusOptions.map(([status, icon, label]) => `<button type="button" class="focus-chip ${statuses.has(status) ? 'active' : ''}" data-focus-status="${escapeHtmlAttr(status)}">${icon}<span>${escapeHtml(label)}</span></button>`).join('')}</div>
          </div>
        </div>
      </div>
    </section>`;
  }

  function hydrateFocusControls() {
    const select = document.getElementById('focus-due-mode');
    if (!select) return;
    hydrateSelect(select);
    refreshSelect(select);
  }

  function renderTodos() {
    const el = document.getElementById('todo-list');
    if (!el) return;
    const projects = getWorkspaceProjects();
    const allSections = getSections();
    const currentFilter = getCurrentFilter();
    const currentProjectId = getCurrentProjectId();
    const hideDone = getHideDone();
    const minimalTodos = Boolean(getMinimalTodos?.());
    const effectiveHideDone = hideDone || minimalTodos;
    const dashboardDrilldown = getDashboardDrilldown?.() || null;
    const search = document.getElementById('search-input')?.value?.trim().toLowerCase() || '';

    let filtered = getWorkspaceTodos();
    if (currentProjectId) filtered = filtered.filter(t => t.project_id === currentProjectId);
    if (search) {
      filtered = filtered.filter(t =>
        (t.title || '').toLowerCase().includes(search) ||
        (t.description || '').toLowerCase().includes(search)
      );
    }
    const dashboardPreferences = getEffectiveDashboardPreferences(getDashboardPreferences?.(), { minimal: minimalTodos });
    const applyDashboardScope = !currentProjectId
      && ((dashboardDrilldown && !search) || (currentFilter === 'all' && !search));
    if (applyDashboardScope) {
      const validProjectIds = new Set(projects.map(project => Number(project.id)));
      filtered = filterTodosForDashboard(filtered, dashboardPreferences, validProjectIds);
    }
    if (dashboardDrilldown) {
      filtered = filterTodosForDashboardDrilldown(filtered, dashboardDrilldown, new Date());
    }
    if (getTodayFocus?.() && currentFilter !== 'done' && currentFilter !== 'calendar') {
      filtered = filterTodosForTodayFocus(filtered);
    }
    if (currentFilter === 'focus' && !currentProjectId) {
      filtered = applyFocusFilters(filtered, new Set(projects.map(project => Number(project.id))));
    }
    filtered = sortTodoList(filtered);

    if (currentFilter === 'calendar' && !currentProjectId) {
      el.innerHTML = renderCalendarView
        ? renderCalendarView({ todos: filtered, projects, hideDone: effectiveHideDone, search })
        : '';
      return;
    }
    cleanupCalendarView?.();

    if (currentProjectId) {
      let html = '';
      const currentProject = projects.find(p => Number(p.id) === Number(currentProjectId));
      const projectTodos = getWorkspaceTodos().filter(t => Number(t.project_id) === Number(currentProjectId));
      if (!search) html += renderProjectDashboard(currentProject, projectTodos);
      const sections = allSections.filter(s => Number(s.project_id) === Number(currentProjectId));
      const validSectionIds = new Set(sections.map(s => s.id));

      if (currentFilter !== 'all' && ['pending','in_progress','done'].includes(currentFilter)) {
        filtered = filtered.filter(t => t.status === currentFilter);
      }
      if (!dashboardDrilldown && (minimalTodos || (hideDone && currentFilter !== 'done'))) filtered = filtered.filter(t => t.status !== 'done');

      const showPinnedGroup = !search;
      const pinnedProjectTodos = showPinnedGroup ? filtered.filter(t => t.is_pinned) : [];
      const sectionSource = showPinnedGroup ? filtered.filter(t => !t.is_pinned) : filtered;
      if (pinnedProjectTodos.length) {
        html += `<div class="pinned-todos-group">
          <div class="todo-group-title pinned-title">${iconSvg('star')} ${escapeHtml(t('todo.pinnedGroup'))} (${pinnedProjectTodos.length})</div>
          <div class="project-group-todos pinned-todos">${pinnedProjectTodos.map(t => renderTodoItem(t)).join('')}</div>
        </div>`;
      }

      sections.forEach((section, index) => {
        const sectionTodos = sortProjectSectionTodos(sectionSource.filter(t => t.section_id === section.id));
        html += `<div class="section-dropzone" data-drop-index="${index}"></div>`;
        html += renderSectionHeader(section, sectionTodos);
        html += `<div class="section-todos" data-section-id="${escapeHtmlAttr(section.id)}">`;
        html += sectionTodos.map(t => renderTodoItem(t)).join('');
        html += `</div>`;
      });
      if (sections.length) {
        html += `<div class="section-dropzone" data-drop-index="${sections.length}"></div>`;
      }

      const unsorted = sortProjectSectionTodos(sectionSource.filter(t => !t.section_id || !validSectionIds.has(t.section_id)));
      if (unsorted.length || sections.length) {
        html += renderSectionHeader(null, unsorted);
        html += `<div class="section-todos" data-section-id="null">`;
        html += unsorted.map(t => renderTodoItem(t)).join('');
        html += `</div>`;
      }

      html += `<div class="add-section-row">
        <button type="button" class="btn btn-secondary btn-small" data-section-action="show-add">${iconSvg('plus')} ${escapeHtml(t('section.new'))}</button>
        <button type="button" class="btn btn-secondary btn-small" data-project-action="clear-done-current">${iconSvg('trash-2')} ${escapeHtml(t('todo.clearDone'))}</button>
      </div>`;

      if (!filtered.length && !sections.length) {
        html += `<div class="empty-state">
          <div class="emoji">${iconSvg('check-circle')}</div>
          <h3>${escapeHtml(t('empty.allDone'))}</h3>
          <p>${escapeHtml(t('empty.noTodosInView'))}</p>
        </div>`;
      }

      el.innerHTML = html;
      return;
    }

    const groups = {
      in_progress: `${iconSvg('flame')} ${escapeHtml(t('todo.status.inProgress'))}`,
      pending: `${iconSvg('clock')} ${escapeHtml(t('todo.status.pending'))}`,
      done: `${iconSvg('check-circle')} ${escapeHtml(t('todo.status.done'))}`,
    };

    const isAggregateFilter = currentFilter === 'all' || currentFilter === 'focus';
    if (!isAggregateFilter && groups[currentFilter]) filtered = filtered.filter(t => t.status === currentFilter);
    if (!dashboardDrilldown && (minimalTodos || (hideDone && currentFilter !== 'done' && currentFilter !== 'focus'))) filtered = filtered.filter(t => t.status !== 'done');

    const dashboardDrilldownLabels = {
      total: t('overview.stats.total'),
      pending: t('todo.status.pending'),
      in_progress: t('todo.status.inProgress'),
      done: t('dashboard.preferences.stats.done'),
      overdue: t('overview.stats.overdue'),
      due_today: t('dashboard.preferences.stats.dueToday'),
      due_week: t('dashboard.preferences.focus.week'),
      high_priority: t('dashboard.preferences.focus.priority'),
    };
    let html = dashboardDrilldown && !currentProjectId ? `
      <div class="dashboard-drilldown-banner" role="status">
        <span>${iconSvg('list-filter')} ${escapeHtml(t('dashboard.drilldown.label', { filter: dashboardDrilldownLabels[dashboardDrilldown] || dashboardDrilldown }))}</span>
        <button type="button" class="btn btn-secondary btn-small" data-dashboard-drilldown-action="clear" data-dashboard-return-filter="all">${iconSvg('x')} ${escapeHtml(t('dashboard.drilldown.clear'))}</button>
      </div>` : (currentFilter === 'focus' ? renderFocusControls(projects) : '');
    if (isAggregateFilter && !search) {
      const pinnedItems = [
        ...filtered.filter(todo => todo.is_pinned && todo.status === 'in_progress'),
        ...filtered.filter(todo => todo.is_pinned && todo.status !== 'in_progress'),
      ];
      if (pinnedItems.length) {
        html += `<div class="todo-group pinned-todos-group">
          <div class="todo-group-title pinned-title">${iconSvg('star')} ${escapeHtml(t('todo.pinnedGroup'))} (${pinnedItems.length})</div>
          <div class="project-group-todos pinned-todos">${pinnedItems.map(t => renderTodoItem(t)).join('')}</div>
        </div>`;
      }
    }
    const groupedSource = isAggregateFilter && !search ? filtered.filter(t => !t.is_pinned) : filtered;

    const renderProjectGroups = (source, { prioritizeInProgress = false } = {}) => {
      const byProject = new Map();
      for (const todo of source) {
        const projectId = todo.project_id || 0;
        if (!byProject.has(projectId)) byProject.set(projectId, []);
        byProject.get(projectId).push(todo);
      }

      const projectOrder = Array.from(byProject.keys()).sort((a, b) => {
        const projectA = projects.find(project => project.id === a);
        const projectB = projects.find(project => project.id === b);
        if (!!projectA?.is_inbox !== !!projectB?.is_inbox) return projectA?.is_inbox ? -1 : 1;
        const nameA = projectA ? projectA.name.toLowerCase() : '';
        const nameB = projectB ? projectB.name.toLowerCase() : '';
        return nameA.localeCompare(nameB);
      });

      const renderSearchSectionGroups = (projectItems, projectId) => {
        const projectSections = allSections
          .filter(section => String(section.project_id) === String(projectId))
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name || '').localeCompare(String(b.name || '')));
        const validSectionIds = new Set(projectSections.map(section => String(section.id)));
        let sectionsHtml = '';
        for (const section of projectSections) {
          const sectionItems = projectItems.filter(item => String(item.section_id || '') === String(section.id));
          if (!sectionItems.length) continue;
          sectionsHtml += `<div class="section-header section-search-header" data-section-id="${escapeHtmlAttr(section.id)}">
            <span class="section-name">${escapeHtml(section.name)}</span>
            <span class="section-count">${sectionItems.length}</span>
          </div>
          <div class="section-todos">${sectionItems.map(item => renderTodoItem(item)).join('')}</div>`;
        }
        const unsortedItems = projectItems.filter(item => !item.section_id || !validSectionIds.has(String(item.section_id)));
        if (unsortedItems.length) {
          sectionsHtml += `<div class="section-header section-unsorted section-search-header" data-section-id="null">
            <span class="section-name">${escapeHtml(t('section.unsorted'))}</span>
            <span class="section-count">${unsortedItems.length}</span>
          </div>
          <div class="section-todos">${unsortedItems.map(item => renderTodoItem(item)).join('')}</div>`;
        }
        return sectionsHtml || projectItems.map(item => renderTodoItem(item)).join('');
      };

      let projectGroupsHtml = '';
      for (const projectId of projectOrder) {
        const sortedItems = byProject.get(projectId);
        const items = prioritizeInProgress
          ? [
              ...sortedItems.filter(item => item.status === 'in_progress'),
              ...sortedItems.filter(item => item.status !== 'in_progress'),
            ]
          : sortedItems;
        const project = projects.find(candidate => candidate.id === projectId);
        const itemsHtml = search ? renderSearchSectionGroups(items, projectId) : items.map(todo => renderTodoItem(todo)).join('');
        if (project) {
          projectGroupsHtml += `<div class="project-group">
            <div class="project-group-header">
              ${markerHtml(project)}
              <span class="project-group-name">${escapeHtml(project.name)}</span>
              <span class="project-group-count">${items.length}</span>
            </div>
            <div class="project-group-todos">${itemsHtml}</div>
          </div>`;
        } else {
          projectGroupsHtml += `<div class="project-group">
            <div class="project-group-header">
              <span class="project-dot" style="background:var(--text-muted)"></span>
              <span class="project-group-name">${escapeHtml(t('project.unsorted'))}</span>
              <span class="project-group-count">${items.length}</span>
            </div>
            <div class="project-group-todos">${itemsHtml}</div>
          </div>`;
        }
      }
      return projectGroupsHtml;
    };

    const groupByStatus = !isAggregateFilter || Boolean(search) || dashboardPreferences.groupByStatus;
    if (groupByStatus) {
      for (const [status, title] of Object.entries(groups)) {
        if (!isAggregateFilter && currentFilter !== status) continue;
        const statusItems = groupedSource.filter(t => t.status === status);
        if (!statusItems.length) continue;
        html += `<div class="todo-group"><div class="todo-group-title">${title} (${statusItems.length})</div>`;
        html += renderProjectGroups(statusItems);
        html += `</div>`;
      }
    } else if (groupedSource.length) {
      html += `<div class="todo-group dashboard-project-groups">${renderProjectGroups(groupedSource, { prioritizeInProgress: true })}</div>`;
    }

    if (!filtered.length) {
      html += `<div class="empty-state">
        <div class="emoji">${iconSvg('check-circle')}</div>
        <h3>${escapeHtml(t('empty.allDone'))}</h3>
        <p>${escapeHtml(t('empty.noTodosInView'))}</p>
      </div>`;
    }

    el.innerHTML = html;
    if (currentFilter === 'focus') hydrateFocusControls();
  }

  function renderInvites(invites) {
    const section = document.getElementById('invites-section');
    const el = document.getElementById('invites-list');
    if (!section || !el) return;
    if (!invites || !invites.length) {
      section.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    section.style.display = '';
    let html = '';
    for (const invite of invites) {
      html += `
        <div class="invite-item" data-invite-id="${escapeHtmlAttr(invite.id)}">
          <span class="invite-title">${iconSvg('mail')} ${escapeHtml(invite.project_name)}</span>
          <div class="invite-actions">
            <button class="btn btn-secondary btn-icon invite-action invite-accept" data-project-sharing-action="accept-invite" data-project-id="${escapeHtmlAttr(invite.project_id)}" data-invite-id="${escapeHtmlAttr(invite.id)}" title="${escapeHtmlAttr(t('invite.accept'))}" aria-label="${escapeHtmlAttr(t('invite.acceptAria'))}">${iconSvg('check')}</button>
            <button class="btn btn-danger btn-icon invite-action invite-decline" data-project-sharing-action="decline-invite" data-project-id="${escapeHtmlAttr(invite.project_id)}" data-invite-id="${escapeHtmlAttr(invite.id)}" title="${escapeHtmlAttr(t('invite.decline'))}" aria-label="${escapeHtmlAttr(t('invite.declineAria'))}">${iconSvg('x')}</button>
          </div>
        </div>
      `;
    }
    el.innerHTML = html;
  }

  return { renderVersionInfo, renderProjects, renderStats, renderTodos, countByProject, renderInvites };
}
