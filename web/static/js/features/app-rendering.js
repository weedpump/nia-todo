export function createAppRenderingFeature({
  appVersion,
  escapeHtml,
  escapeHtmlAttr,
  getTodos,
  getProjects,
  getSections,
  getCurrentFilter,
  getCurrentProjectId,
  getHideDone,
  getCurrentUser,
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

    if (!el.querySelector('.version-separator')) {
      const separator = document.createElement('span');
      separator.className = 'version-separator';
      separator.setAttribute('aria-hidden', 'true');
      separator.textContent = '|';
      versionText.insertAdjacentElement('afterend', separator);
    }

    if (!el.querySelector('#force-refresh-btn')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'force-refresh-btn';
      button.id = 'force-refresh-btn';
      button.title = 'Web-App neu herunterladen und Cache aktualisieren';
      button.textContent = '↻ Neu laden';
      button.addEventListener('click', () => window.forceReloadApp?.());
      el.appendChild(button);
    }
  }

  function countByProject(pid, includeSubprojects = false) {
    const todos = getTodos();
    const projects = getProjects();
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
    const projects = getProjects();
    const currentFilter = getCurrentFilter();

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
      html += `<button class="nav-btn ${currentFilter === String(project.id) ? 'active' : ''}" data-filter="${escapeHtmlAttr(project.id)}" onclick="setFilter('${project.id}')">`;
      html += `<span class="project-dot" style="background:${escapeHtmlAttr(project.color)}"></span>`;
      html += `${escapeHtml(project.name)}`;
      html += `<span class="badge">${countByProject(project.id, true)}</span>`;
      html += `</button>`;
      html += `<button class="nav-edit" onclick="event.stopPropagation(); editProject(${escapeHtmlAttr(JSON.stringify(project.id))})" title="Bearbeiten">`;
      html += `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
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
      html += `<div class="nav-title shared-title">Geteilte Projekte</div>`;
      for (const project of sharedProjects) {
        html += renderProjectTree({ ...project, children: [] });
      }
    }
    el.innerHTML = html;
  }

  function renderStats() {
    const el = document.getElementById('stats-bar');
    if (!el) return;
    const todos = getTodos();
    const projects = getProjects();
    const currentFilter = getCurrentFilter();
    const currentProjectId = getCurrentProjectId();
    const now = new Date();
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
    const overdue = activeTodos.filter(t => t.due_date && new Date(t.due_date) < now).length;
    const dueToday = activeTodos.filter(t => t.due_date && new Date(t.due_date) >= now && new Date(t.due_date) <= todayEnd).length;
    const dueWeek = activeTodos.filter(t => t.due_date && new Date(t.due_date) > todayEnd && new Date(t.due_date) <= weekEnd).length;
    const completionRate = total ? Math.round((done / total) * 100) : 0;

    document.getElementById('count-all').textContent = total;
    document.getElementById('count-pending').textContent = pending;
    document.getElementById('count-in_progress').textContent = inprog;
    document.getElementById('count-done').textContent = done;

    const user = getCurrentUser?.();
    const displayName = user?.display_name || user?.username || 'du';
    const initial = (displayName.trim()[0] || 'U').toUpperCase();
    const avatarVersion = user?.avatar_updated_at ? encodeURIComponent(user.avatar_updated_at) : '';
    const avatarSrc = user?.avatar_url ? `${user.avatar_url}${avatarVersion ? `?v=${avatarVersion}` : ''}` : '';
    const dateTime = new Intl.DateTimeFormat('de-DE', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }).format(now);

    const showDashboard = currentFilter === 'all' && !currentProjectId;
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
      if (diffMinutes < 1) return 'gerade eben';
      if (diffMinutes < 60) return `vor ${diffMinutes} Min.`;
      const diffHours = Math.round(diffMinutes / 60);
      if (diffHours < 24) return `vor ${diffHours} Std.`;
      const diffDays = Math.round(diffHours / 24);
      if (diffDays < 7) return `vor ${diffDays} Tg.`;
      return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' }).format(date);
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
      { cls: 'total', num: total, label: 'Gesamt', hint: 'Todos im System' },
      { cls: 'pending', num: pending, label: 'Offen', hint: 'Warten auf Start' },
      { cls: 'progress', num: inprog, label: 'In Arbeit', hint: 'Aktiv am Laufen' },
      { cls: 'due', num: overdue, label: 'Überfällig', hint: overdue ? 'Braucht Liebe' : 'Alles entspannt' },
    ];

    const focusItems = [
      { icon: '📅', label: 'Heute fällig', value: dueToday },
      { icon: '🗓️', label: 'Nächste 7 Tage', value: dueWeek },
      { icon: '✅', label: 'Erledigt', value: done },
      { icon: '📈', label: 'Erledigt-Quote', value: `${completionRate}%` },
    ];

    el.innerHTML = `
      <section class="overview-dashboard" aria-label="Todo-Dashboard">
        <div class="overview-dashboard-header">
          <div class="overview-greeting">
            <div class="overview-avatar" aria-hidden="true">
              ${avatarSrc ? `<img src="${escapeHtmlAttr(avatarSrc)}" alt="">` : escapeHtml(initial)}
            </div>
            <div>
              <div class="overview-kicker">${escapeHtml(dateTime)}</div>
              <h2>Hallo, ${escapeHtml(displayName)}</h2>
              <div class="overview-subtitle">Alle Todos auf einen Blick</div>
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
            <div class="overview-panel-title">Fokus</div>
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
            <div class="overview-panel-title">Aktive Projekte</div>
            <div class="overview-project-list">
              ${projectsByRecentTodo.length ? projectsByRecentTodo.map(project => `
                <button type="button" class="overview-project-item" onclick="setFilter('${escapeHtmlAttr(project.id)}')">
                  <span class="project-dot" style="background:${escapeHtmlAttr(project.color || '#6366f1')}"></span>
                  <span>${escapeHtml(project.name)}</span>
                  <strong>${escapeHtml(project.latestTodoLabel)}</strong>
                </button>
              `).join('') : '<div class="overview-empty-mini">Noch keine Todo-Änderungen 🎉</div>'}
            </div>
          </div>
        </div>
      </section>`;
  }

  function renderTodos() {
    const el = document.getElementById('todo-list');
    if (!el) return;
    const projects = getProjects();
    const allSections = getSections();
    const currentFilter = getCurrentFilter();
    const currentProjectId = getCurrentProjectId();
    const hideDone = getHideDone();
    const search = document.getElementById('search-input')?.value?.toLowerCase() || '';

    let filtered = getTodos();
    if (currentProjectId) filtered = filtered.filter(t => t.project_id === currentProjectId);
    if (search) {
      filtered = filtered.filter(t =>
        (t.title || '').toLowerCase().includes(search) ||
        (t.description || '').toLowerCase().includes(search)
      );
    }
    filtered = sortTodoList(filtered);

    if (currentProjectId) {
      let html = '';
      const sections = allSections.filter(s => Number(s.project_id) === Number(currentProjectId));
      const validSectionIds = new Set(sections.map(s => s.id));

      if (currentFilter !== 'all' && ['pending','in_progress','done'].includes(currentFilter)) {
        filtered = filtered.filter(t => t.status === currentFilter);
      }
      if (hideDone && currentFilter !== 'done') filtered = filtered.filter(t => t.status !== 'done');

      sections.forEach((section, index) => {
        const sectionTodos = filtered.filter(t => t.section_id === section.id);
        html += `<div class="section-dropzone" data-drop-index="${index}" ondragover="handleSectionDragOver(event)" ondrop="handleSectionDrop(event)"></div>`;
        html += renderSectionHeader(section);
        html += `<div class="section-todos" data-section-id="${escapeHtmlAttr(section.id)}" ondragover="handleTodoDragOver(event)" ondrop="handleTodoDrop(event)">`;
        html += sectionTodos.map(t => renderTodoItem(t)).join('');
        html += `</div>`;
      });
      if (sections.length) {
        html += `<div class="section-dropzone" data-drop-index="${sections.length}" ondragover="handleSectionDragOver(event)" ondrop="handleSectionDrop(event)"></div>`;
      }

      const unsorted = filtered.filter(t => !t.section_id || !validSectionIds.has(t.section_id));
      if (unsorted.length || sections.length) {
        html += renderSectionHeader(null);
        html += `<div class="section-todos" data-section-id="null" ondragover="handleTodoDragOver(event)" ondrop="handleTodoDrop(event)">`;
        html += unsorted.map(t => renderTodoItem(t)).join('');
        html += `</div>`;
      }

      html += `<div class="add-section-row">
        <button class="btn-add-section" onclick="showAddSectionForm()">➕ Neue Section</button>
        <button class="btn-add-section" onclick="clearDoneInProject()">🗑️ Erledigte löschen</button>
      </div>`;

      if (!filtered.length && !sections.length) {
        html += `<div class="empty-state">
          <div class="emoji">🎉</div>
          <h3>Alles erledigt!</h3>
          <p>Keine Todos in dieser Ansicht.</p>
        </div>`;
      }

      el.innerHTML = html;
      return;
    }

    const groups = { in_progress: '🔥 In Arbeit', pending: '⏳ Offen', done: '✅ Erledigt' };

    if (currentFilter !== 'all' && groups[currentFilter]) filtered = filtered.filter(t => t.status === currentFilter);
    if (hideDone && currentFilter !== 'done') filtered = filtered.filter(t => t.status !== 'done');

    let html = '';
    for (const [status, title] of Object.entries(groups)) {
      if (currentFilter !== 'all' && currentFilter !== status) continue;
      const statusItems = filtered.filter(t => t.status === status);
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
          const color = project.color || '#6366f1';
          html += `<div class="project-group">
            <div class="project-group-header">
              <span class="project-dot" style="background:${color}"></span>
              <span class="project-group-name">${escapeHtml(project.name)}</span>
              <span class="project-group-count">${items.length}</span>
            </div>
            <div class="project-group-todos">${items.map(t => renderTodoItem(t)).join('')}</div>
          </div>`;
        } else {
          html += `<div class="project-group">
            <div class="project-group-header">
              <span class="project-dot" style="background:var(--text-muted)"></span>
              <span class="project-group-name">Unsortiert</span>
              <span class="project-group-count">${items.length}</span>
            </div>
            <div class="project-group-todos">${items.map(t => renderTodoItem(t)).join('')}</div>
          </div>`;
        }
      }

      html += `</div>`;
    }

    if (!filtered.length) {
      html = `<div class="empty-state">
        <div class="emoji">🎉</div>
        <h3>Alles erledigt!</h3>
        <p>Keine Todos in dieser Ansicht.</p>
      </div>`;
    }

    el.innerHTML = html;
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
          <span class="invite-title">📩 ${escapeHtml(invite.project_name)}</span>
          <div class="invite-actions">
            <button class="invite-action invite-accept" onclick="acceptInvite(${invite.project_id}, ${invite.id})" title="Annehmen" aria-label="Einladung annehmen">✓</button>
            <button class="invite-action invite-decline" onclick="declineInvite(${invite.project_id}, ${invite.id})" title="Ablehnen" aria-label="Einladung ablehnen">✕</button>
          </div>
        </div>
      `;
    }
    el.innerHTML = html;
  }

  return { renderVersionInfo, renderProjects, renderStats, renderTodos, countByProject, renderInvites };
}
