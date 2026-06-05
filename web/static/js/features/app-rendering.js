import { apiResourceUrl } from '../core/config.js';
import { getActiveLanguage, t } from '../i18n/index.js';
import { iconSvg, markerHtml, safeColor, safeIconName } from '../icons/lucide-icons.js';
import { hydrateSelect, refreshSelect } from '../ui/dropdowns.js';

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
  getCurrentUser,
  getFocusFilters,
  getFocusFiltersExpanded,
  getFocusProjectMenuOpen,
  getFocusProjectSearch,
  sortTodoList,
  renderTodoItem,
  renderSectionHeader,
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
      button.addEventListener('click', () => window.forceReloadApp?.());
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
    const projectIds = new Set(workspaceProjects.map(project => project.id));
    return getTodos().filter(todo => projectIds.has(todo.project_id));
  }

  function countByProject(pid, includeSubprojects = false) {
    const todos = getWorkspaceTodos();
    const projects = getWorkspaceProjects();
    if (!includeSubprojects) {
      return todos.filter(t => t.project_id === pid && t.status !== 'done').length;
    }

    const projectIds = new Set([pid]);
    function collectChildren(parentId) {
      projects.forEach(p => {
        if (p.parent_id === parentId) {
          projectIds.add(p.id);
          collectChildren(p.id);
        }
      });
    }
    collectChildren(pid);

    return todos.filter(t => projectIds.has(t.project_id) && t.status !== 'done').length;
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
      html += `<button class="nav-btn ${isActiveProject ? 'active' : ''}" data-filter="${escapeHtmlAttr(project.id)}" onclick="setFilter('${project.id}')">`;
      html += markerHtml({ ...project, color: escapeHtmlAttr(project.color || '#6366f1'), icon: project.icon });
      html += `${escapeHtml(project.name)}`;
      html += `<span class="badge">${countByProject(project.id, true)}</span>`;
      html += `</button>`;
      html += `<button class="nav-edit" onclick="event.stopPropagation(); editProject(${escapeHtmlAttr(JSON.stringify(project.id))})" title="${escapeHtmlAttr(t('common.edit'))}">`;
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
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() + 7);
    weekEnd.setHours(23, 59, 59, 999);

    const activeTodos = todos.filter(t => t.status !== 'done');
    const total = todos.length;
    const pending = todos.filter(t => t.status === 'pending').length;
    const inprog = todos.filter(t => t.status === 'in_progress').length;
    const done = todos.filter(t => t.status === 'done').length;
    const validProjectIds = new Set(projects.map(project => Number(project.id)));
    const focusCount = applyFocusFilters(todos, validProjectIds).length;
    const overdue = activeTodos.filter(t => t.due_date && new Date(t.due_date) < now).length;
    const dueToday = activeTodos.filter(t => {
      if (!t.due_date) return false;
      const due = new Date(t.due_date);
      return due >= todayStart && due <= todayEnd;
    }).length;
    const dueWeek = activeTodos.filter(t => t.due_date && new Date(t.due_date) > todayEnd && new Date(t.due_date) <= weekEnd).length;
    const completionRate = total ? Math.round((done / total) * 100) : 0;

    const setCount = (id, value) => {
      const node = document.getElementById(id);
      if (node) node.textContent = value;
    };
    setCount('count-all', total);
    setCount('count-focus', focusCount);
    setCount('count-pending', pending);
    setCount('count-in_progress', inprog);
    setCount('count-done', done);

    const user = getCurrentUser?.();
    const displayName = user?.display_name || user?.username || t('overview.defaultUser');
    const initial = (displayName.trim()[0] || 'U').toUpperCase();
    const avatarVersion = user?.avatar_updated_at ? encodeURIComponent(user.avatar_updated_at) : '';
    const avatarBaseSrc = user?.avatar_url ? apiResourceUrl(user.avatar_url) : '';
    const avatarSrc = avatarBaseSrc ? `${avatarBaseSrc}${avatarVersion ? `?v=${avatarVersion}` : ''}` : '';
    const locale = getActiveLanguage() === 'en' ? 'en-US' : 'de-DE';
    const dateTime = new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }).format(now);

    document.querySelectorAll('.nav-btn[data-filter="all"], .nav-btn[data-filter="focus"], .nav-btn[data-filter="pending"], .nav-btn[data-filter="in_progress"], .nav-btn[data-filter="done"]').forEach((button) => {
      button.classList.toggle('active', !currentProjectId && button.dataset.filter === String(currentFilter));
    });

    const showDashboard = currentFilter === 'all' && !currentProjectId && !search;
    el.hidden = !showDashboard;
    if (!showDashboard) {
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

    const projectsByRecentTodo = projects
      .map(project => {
        const projectTodos = todos.filter(t => t.project_id === project.id);
        const latestDate = projectTodos
          .map(t => parseTodoTimestamp(t.updated_at || t.created_at))
          .filter(Boolean)
          .sort((a, b) => b.getTime() - a.getTime())[0] || null;
        return {
          ...project,
          latestTodoAt: latestDate,
          latestTodoLabel: formatRelativeTime(latestDate),
        };
      })
      .filter(project => project.latestTodoAt)
      .sort((a, b) => b.latestTodoAt.getTime() - a.latestTodoAt.getTime() || a.name.localeCompare(b.name))
      .slice(0, 4);

    const cards = [
      { cls: 'total', num: total, label: t('overview.stats.total'), hint: t('overview.stats.totalHint') },
      { cls: 'pending', num: pending, label: t('todo.status.pending'), hint: t('overview.stats.pendingHint') },
      { cls: 'progress', num: inprog, label: t('todo.status.inProgress'), hint: t('overview.stats.inProgressHint') },
      { cls: 'due', num: overdue, label: t('overview.stats.overdue'), hint: overdue ? t('overview.stats.overdueNeedsCare') : t('overview.stats.overdueRelaxed') },
    ];

    const focusItems = [
      { icon: iconSvg('calendar'), label: t('overview.focus.dueToday'), value: dueToday },
      { icon: iconSvg('calendar-days'), label: t('overview.focus.nextSevenDays'), value: dueWeek },
      { icon: iconSvg('check-circle'), label: t('todo.status.done'), value: done },
      { icon: iconSvg('chart-line'), label: t('overview.focus.completionRate'), value: `${completionRate}%` },
    ];

    el.innerHTML = `
      <section class="overview-dashboard" aria-label="${escapeHtmlAttr(t('overview.aria'))}">
        <div class="overview-dashboard-header">
          <div class="overview-greeting">
            <div class="overview-avatar" aria-hidden="true">
              ${avatarSrc ? `<img src="${escapeHtmlAttr(avatarSrc)}" alt="">` : escapeHtml(initial)}
            </div>
            <div>
              <div class="overview-kicker">${escapeHtml(dateTime)}</div>
              <h2>${escapeHtml(t('overview.greeting', { name: displayName }))}</h2>
              <div class="overview-subtitle">${escapeHtml(t('overview.subtitle'))}</div>
            </div>
          </div>
        </div>
        <div class="overview-stat-grid">
          ${cards.map(card => `
            <div class="overview-stat-card ${card.cls}">
              <div class="overview-stat-num">${card.num}</div>
              <div>
                <div class="overview-stat-label">${escapeHtml(card.label)}</div>
                <div class="overview-stat-hint">${escapeHtml(card.hint)}</div>
              </div>
            </div>
          `).join('')}
        </div>
        <div class="overview-detail-grid">
          <div class="overview-panel">
            <div class="overview-panel-title">${escapeHtml(t('overview.focus.title'))}</div>
            <div class="overview-focus-list">
              ${focusItems.map(item => `
                <div class="overview-focus-item">
                  <span>${item.icon}</span>
                  <span>${escapeHtml(item.label)}</span>
                  <strong>${item.value}</strong>
                </div>
              `).join('')}
            </div>
          </div>
          <div class="overview-panel">
            <div class="overview-panel-title">${escapeHtml(t('overview.activeProjects'))}</div>
            <div class="overview-project-list">
              ${projectsByRecentTodo.length ? projectsByRecentTodo.map(project => `
                <button type="button" class="overview-project-item" onclick="setFilter('${escapeHtmlAttr(project.id)}')">
                  ${markerHtml({ ...project, color: escapeHtmlAttr(project.color || '#6366f1'), icon: project.icon })}
                  <span>${escapeHtml(project.name)}</span>
                  <strong>${escapeHtml(project.latestTodoLabel)}</strong>
                </button>
              `).join('') : `<div class="overview-empty-mini">${escapeHtml(t('overview.noTodoChanges'))}</div>`}
            </div>
          </div>
        </div>
      </section>`;
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
    if (!project || !getShowProjectWidget?.()) return '';
    const activeTodos = projectTodos.filter(t => t.status !== 'done');
    const overdue = activeTodos.filter(t => t.due_date && new Date(t.due_date) < new Date()).length;
    const stats = [
      { cls: 'total', icon: iconSvg('layout-dashboard'), num: projectTodos.length, label: t('overview.stats.total'), hint: t('project.dashboard.totalHint') },
      { cls: 'pending', icon: iconSvg('clock'), num: projectTodos.filter(t => t.status === 'pending').length, label: t('todo.status.pending'), hint: t('project.dashboard.pendingHint') },
      { cls: 'progress', icon: iconSvg('flame'), num: projectTodos.filter(t => t.status === 'in_progress').length, label: t('todo.status.inProgress'), hint: t('project.dashboard.inProgressHint') },
      { cls: 'due', icon: iconSvg('triangle-alert'), num: overdue, label: t('overview.stats.overdue'), hint: t('project.dashboard.overdueHint') },
    ];
    const color = safeColor(project.color);
    const subtitle = project.is_shared ? t('project.dashboard.shared') : t('project.dashboard.subtitle');
    return `<section class="overview-dashboard project-dashboard" aria-label="${escapeHtmlAttr(t('project.dashboard.aria'))}">
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
          <div class="overview-stat-card ${stat.cls}">
            <div class="overview-stat-num">${stat.num}</div>
            <div>
              <div class="overview-stat-label">${stat.label}</div>
              <div class="overview-stat-hint">${stat.hint}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </section>`;
  }

  function parseTodoDate(value) {
    if (!value) return null;
    const date = new Date(String(value).includes('T') ? value : String(value).replace(' ', 'T'));
    return Number.isFinite(date.getTime()) ? date : null;
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
      switch (filters.dueMode || 'next_days') {
        case 'any':
          return true;
        case 'none':
          return !due;
        case 'overdue':
          return Boolean(due && due < now && todo.status !== 'done');
        case 'today':
          return Boolean(due && due >= new Date(now.toDateString()) && due <= todayEnd);
        case 'tomorrow':
          return Boolean(due && due >= tomorrowStart && due <= tomorrowEnd);
        case 'next_days':
        default:
          return Boolean(due && due <= daysEnd);
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
      const due = parseTodoDate(todo.due_date);
      return Boolean(due && due < new Date());
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
      return `<button type="button" class="focus-project-option ${selected ? 'is-selected' : ''}" style="--project-depth:${depth}" data-focus-project-option data-label="${escapeHtmlAttr(label)}" ${matchesSearch ? '' : 'hidden'} onclick="toggleFocusProject(${Number(project.id)})" role="menuitemcheckbox" aria-checked="${selected ? 'true' : 'false'}">${markerHtml(project)}<span>${escapeHtml(label)}</span><span class="focus-project-check" aria-hidden="true">${iconSvg('check')}</span></button>${children.map(child => renderProjectOption(child, depth + 1)).join('')}`;
    };
    const projectOptions = rootProjects.map(project => renderProjectOption(project)).join('') || `<div class="focus-project-empty">${escapeHtml(t('focus.noProjects'))}</div>`;
    const projectMatchCount = rootProjects.length ? (projectOptions.match(/data-focus-project-option/g) || []).length - (projectOptions.match(/data-focus-project-option[^>]*hidden/g) || []).length : 0;
    const headingActions = expanded
      ? `<button type="button" class="btn btn-secondary btn-small focus-reset-btn" onclick="resetFocusFilters()">${iconSvg('refresh-cw')} ${escapeHtml(t('focus.reset'))}</button><button type="button" class="btn btn-secondary btn-small focus-toggle-btn" onclick="toggleFocusFiltersExpanded()" aria-expanded="true">${iconSvg('chevron-up')} ${escapeHtml(t('focus.collapse'))}</button>`
      : `<button type="button" class="btn btn-secondary btn-small focus-toggle-btn" onclick="toggleFocusFiltersExpanded()" aria-expanded="false">${iconSvg('chevron-down')} ${escapeHtml(t('focus.expand'))}</button>`;

    return `<section class="overview-dashboard focus-filter-card ${expanded ? 'is-expanded' : 'is-collapsed'}" aria-label="${escapeHtmlAttr(t('focus.aria'))}">
      <div class="overview-dashboard-header focus-filter-heading">
        <div class="overview-greeting">
          <span class="overview-avatar focus-filter-avatar" aria-hidden="true">${iconSvg('target')}</span>
          <div>
            <div class="overview-kicker">${escapeHtml(t('focus.kicker'))}</div>
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
            <select id="focus-due-mode" data-ui-select onchange="setFocusDueMode(this.value)">
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
            <input id="focus-due-days" type="number" min="1" max="365" value="${escapeHtmlAttr(dueDays)}" ${dueMode === 'next_days' ? '' : 'disabled'} onchange="setFocusDueDays(this.value)">
          </div>
        </div>
        <div class="focus-filter-section">
          <div class="focus-filter-label">${iconSvg('folder')} ${escapeHtml(t('focus.projects'))}</div>
          <div class="focus-project-dropdown ${projectMenuOpen ? 'is-open' : ''}">
            <button type="button" class="ui-select-trigger focus-project-trigger" onclick="toggleFocusProjectMenu()" aria-haspopup="menu" aria-expanded="${projectMenuOpen ? 'true' : 'false'}">
              <span class="ui-select-value">${escapeHtml(projectSummary)}</span>
              <span class="ui-select-chevron" aria-hidden="true">${iconSvg('chevron-down')}</span>
            </button>
            <div class="focus-project-menu ui-select-menu project-ui-select-menu" role="menu" ${projectMenuOpen ? '' : 'hidden'}>
              <div class="ui-select-search">
                <span class="ui-select-search-icon" aria-hidden="true">${iconSvg('search')}</span>
                <input type="search" class="ui-select-search-input" value="${escapeHtmlAttr(projectSearch)}" placeholder="${escapeHtmlAttr(t('focus.projects.search'))}" aria-label="${escapeHtmlAttr(t('focus.projects.search'))}" oninput="filterFocusProjectMenu(this.value)" onkeydown="handleFocusProjectMenuKeydown(event)">
              </div>
              ${projectOptions}
              <div class="ui-select-empty focus-project-empty" ${projectMatchCount > 0 || !rootProjects.length ? 'hidden' : ''}>${escapeHtml(t('focus.projects.noMatches'))}</div>
            </div>
          </div>
        </div>
        <div class="focus-filter-section focus-filter-split">
          <div>
            <div class="focus-filter-label">${iconSvg('flag')} ${escapeHtml(t('focus.priorities'))}</div>
            <div class="focus-chip-row">${priorityOptions.map(([priority, label, color]) => `<button type="button" class="focus-chip priority-chip ${priorities.has(priority) ? 'active' : ''}" onclick="toggleFocusPriority(${priority})"><span class="priority-dot" style="--priority-color:${escapeHtmlAttr(color)}"></span><span>${escapeHtml(label)}</span></button>`).join('')}</div>
          </div>
          <div>
            <div class="focus-filter-label">${iconSvg('list')} ${escapeHtml(t('focus.statuses'))}</div>
            <div class="focus-chip-row">${statusOptions.map(([status, icon, label]) => `<button type="button" class="focus-chip ${statuses.has(status) ? 'active' : ''}" onclick="toggleFocusStatus('${escapeHtmlAttr(status)}')">${icon}<span>${escapeHtml(label)}</span></button>`).join('')}</div>
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
    const search = document.getElementById('search-input')?.value?.trim().toLowerCase() || '';

    let filtered = getWorkspaceTodos();
    if (currentProjectId) filtered = filtered.filter(t => t.project_id === currentProjectId);
    if (search) {
      filtered = filtered.filter(t =>
        (t.title || '').toLowerCase().includes(search) ||
        (t.description || '').toLowerCase().includes(search)
      );
    }
    if (getTodayFocus?.() && currentFilter !== 'done') {
      const now = new Date();
      const todayEnd = new Date(now);
      todayEnd.setHours(23, 59, 59, 999);
      filtered = filtered.filter(todo => {
        if (todo.status === 'done') return false;
        if (todo.is_pinned) return true;
        if (!todo.due_date) return Number(todo.priority) === 1;
        const due = new Date(todo.due_date);
        return Number.isFinite(due.getTime()) && due <= todayEnd;
      });
    }
    if (currentFilter === 'focus' && !currentProjectId) {
      filtered = applyFocusFilters(filtered, new Set(projects.map(project => Number(project.id))));
    }
    filtered = sortTodoList(filtered);

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
      if (hideDone && currentFilter !== 'done') filtered = filtered.filter(t => t.status !== 'done');

      const showPinnedGroup = currentFilter === 'all';
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
        html += `<div class="section-dropzone" data-drop-index="${index}" ondragover="handleSectionDragOver(event)" ondrop="handleSectionDrop(event)"></div>`;
        html += renderSectionHeader(section, sectionTodos);
        html += `<div class="section-todos" data-section-id="${escapeHtmlAttr(section.id)}" ondragover="handleTodoDragOver(event)" ondrop="handleTodoDrop(event)">`;
        html += sectionTodos.map(t => renderTodoItem(t)).join('');
        html += `</div>`;
      });
      if (sections.length) {
        html += `<div class="section-dropzone" data-drop-index="${sections.length}" ondragover="handleSectionDragOver(event)" ondrop="handleSectionDrop(event)"></div>`;
      }

      const unsorted = sortProjectSectionTodos(sectionSource.filter(t => !t.section_id || !validSectionIds.has(t.section_id)));
      if (unsorted.length || sections.length) {
        html += renderSectionHeader(null, unsorted);
        html += `<div class="section-todos" data-section-id="null" ondragover="handleTodoDragOver(event)" ondrop="handleTodoDrop(event)">`;
        html += unsorted.map(t => renderTodoItem(t)).join('');
        html += `</div>`;
      }

      html += `<div class="add-section-row">
        <button class="btn-add-section" onclick="showAddSectionForm()">${iconSvg('plus')} ${escapeHtml(t('section.new'))}</button>
        <button class="btn-add-section" onclick="clearDoneInProject()">${iconSvg('trash-2')} ${escapeHtml(t('todo.clearDone'))}</button>
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
    if (hideDone && currentFilter !== 'done' && currentFilter !== 'focus') filtered = filtered.filter(t => t.status !== 'done');

    let html = currentFilter === 'focus' ? renderFocusControls(projects) : '';
    if (isAggregateFilter) {
      const pinnedItems = filtered.filter(t => t.is_pinned);
      if (pinnedItems.length) {
        html += `<div class="todo-group pinned-todos-group">
          <div class="todo-group-title pinned-title">${iconSvg('star')} ${escapeHtml(t('todo.pinnedGroup'))} (${pinnedItems.length})</div>
          <div class="project-group-todos pinned-todos">${pinnedItems.map(t => renderTodoItem(t)).join('')}</div>
        </div>`;
      }
    }
    const groupedSource = isAggregateFilter ? filtered.filter(t => !t.is_pinned) : filtered;
    for (const [status, title] of Object.entries(groups)) {
      if (!isAggregateFilter && currentFilter !== status) continue;
      const statusItems = groupedSource.filter(t => t.status === status);
      if (!statusItems.length) continue;

      html += `<div class="todo-group"><div class="todo-group-title">${title} (${statusItems.length})</div>`;

      const byProject = new Map();
      for (const t of statusItems) {
        const pid = t.project_id || 0;
        if (!byProject.has(pid)) byProject.set(pid, []);
        byProject.get(pid).push(t);
      }

      const projectOrder = Array.from(byProject.keys()).sort((a, b) => {
        const pa = projects.find(p => p.id === a);
        const pb = projects.find(p => p.id === b);
        if (!!pa?.is_inbox !== !!pb?.is_inbox) return pa?.is_inbox ? -1 : 1;
        const na = pa ? pa.name.toLowerCase() : '';
        const nb = pb ? pb.name.toLowerCase() : '';
        return na.localeCompare(nb);
      });

      for (const pid of projectOrder) {
        const items = byProject.get(pid);
        const project = projects.find(p => p.id === pid);
        if (project) {
          html += `<div class="project-group">
            <div class="project-group-header">
              ${markerHtml(project)}
              <span class="project-group-name">${escapeHtml(project.name)}</span>
              <span class="project-group-count">${items.length}</span>
            </div>
            <div class="project-group-todos">${items.map(t => renderTodoItem(t)).join('')}</div>
          </div>`;
        } else {
          html += `<div class="project-group">
            <div class="project-group-header">
              <span class="project-dot" style="background:var(--text-muted)"></span>
              <span class="project-group-name">${escapeHtml(t('project.unsorted'))}</span>
              <span class="project-group-count">${items.length}</span>
            </div>
            <div class="project-group-todos">${items.map(t => renderTodoItem(t)).join('')}</div>
          </div>`;
        }
      }

      html += `</div>`;
    }

    if (!filtered.length) {
      html = `${currentFilter === 'focus' ? renderFocusControls(projects) : ''}<div class="empty-state">
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
            <button class="invite-action invite-accept" onclick="acceptInvite(${invite.project_id}, ${invite.id})" title="${escapeHtmlAttr(t('invite.accept'))}" aria-label="${escapeHtmlAttr(t('invite.acceptAria'))}">${iconSvg('check')}</button>
            <button class="invite-action invite-decline" onclick="declineInvite(${invite.project_id}, ${invite.id})" title="${escapeHtmlAttr(t('invite.decline'))}" aria-label="${escapeHtmlAttr(t('invite.declineAria'))}">${iconSvg('x')}</button>
          </div>
        </div>
      `;
    }
    el.innerHTML = html;
  }

  return { renderVersionInfo, renderProjects, renderStats, renderTodos, countByProject, renderInvites };
}
