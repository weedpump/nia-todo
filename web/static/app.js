// nia-todo: Frontend app
const API = '';

let todos = [];
let projects = [];
let sections = [];
let currentFilter = 'all';
let currentProjectId = null;
let dragSrcTodoId = null;
let dragOverSectionId = null;

// ─── Sidebar ─────────────────────────────────────────────────────────────────
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('sidebar-overlay');
  sb.classList.toggle('open');
  ov.classList.toggle('active');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('active');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadAll();
});

async function loadAll() {
  await loadProjects();
  await loadTodos();
  await loadSectionsForCurrentProject();
  renderProjects();
  renderStats();
  renderTodos();
}

// ─── API ──────────────────────────────────────────────────────────────────────

async function get(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  return r.json();
}

async function post(path, body) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  return r.json();
}

async function patch(path, body) {
  const r = await fetch(API + path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  return r.json();
}

async function del(path) {
  const r = await fetch(API + path, { method: 'DELETE' });
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  return r.json();
}

async function loadTodos() {
  const params = new URLSearchParams();
  if (currentFilter !== 'all' && !['pending','in_progress','done'].includes(currentFilter)) {
    params.set('project_id', currentFilter);
  } else if (['pending','in_progress','done'].includes(currentFilter)) {
    params.set('status', currentFilter);
  }
  const data = await get('/api/todos?' + params.toString());
  todos = data.todos || [];
}

async function loadProjects() {
  const data = await get('/api/projects');
  projects = data.projects || [];
}

async function loadSectionsForCurrentProject() {
  sections = [];
  if (currentProjectId) {
    try {
      const data = await get(`/api/projects/${currentProjectId}/sections`);
      sections = data.sections || [];
    } catch (e) {
      console.error('Failed to load sections', e);
    }
  }
}

// ─── Render ──────────────────────────────────────────────────────────────────

function renderProjects() {
  const el = document.getElementById('project-list');
  el.innerHTML = projects.map(p => `
    <div class="nav-item-with-action">
      <button class="nav-btn ${currentFilter === String(p.id) ? 'active' : ''}" onclick="setFilter('${p.id}')">
        <span class="project-dot" style="background:${p.color}"></span>
        ${escapeHtml(p.name)}
        <span class="badge">${countByProject(p.id)}</span>
      </button>
      <button class="nav-edit" onclick="event.stopPropagation(); editProject(${p.id})" title="Bearbeiten">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
    </div>
  `).join('');
}

function renderStats() {
  const total = todos.length;
  const pending = todos.filter(t => t.status === 'pending').length;
  const inprog = todos.filter(t => t.status === 'in_progress').length;
  const done = todos.filter(t => t.status === 'done').length;
  const overdue = todos.filter(t => t.status !== 'done' && t.due_date && new Date(t.due_date) < new Date()).length;

  document.getElementById('count-all').textContent = total;
  document.getElementById('count-pending').textContent = pending;
  document.getElementById('count-in_progress').textContent = inprog;
  document.getElementById('count-done').textContent = done;

  document.getElementById('stats-bar').innerHTML = `
    <div class="stat-card total"><span class="stat-num">${total}</span> Gesamt</div>
    <div class="stat-card pending"><span class="stat-num">${pending}</span> Offen</div>
    <div class="stat-card pending"><span class="stat-num">${inprog}</span> In Arbeit</div>
    <div class="stat-card due"><span class="stat-num">${overdue}</span> Überfällig</div>
    <div class="stat-card done"><span class="stat-num">${done}</span> Erledigt</div>
  `;
}

function renderTodos() {
  const el = document.getElementById('todo-list');
  const search = document.getElementById('search-input').value.toLowerCase();

  let filtered = todos;
  if (search) {
    filtered = filtered.filter(t =>
      (t.title || '').toLowerCase().includes(search) ||
      (t.description || '').toLowerCase().includes(search)
    );
  }

  // When a project is selected, group by section
  if (currentProjectId) {
    let html = '';

    // Sections with todos
    for (const section of sections) {
      const sectionTodos = filtered.filter(t => t.section_id === section.id);
      if (!sectionTodos.length) continue;
      html += renderSectionHeader(section);
      html += `<div class="section-todos" data-section-id="${section.id}" ondragover="onDragOver(event)" ondrop="onDropOnSection(event, ${section.id})">`;
      html += sectionTodos.map(t => renderTodoItem(t)).join('');
      html += `</div>`;
    }

    // Unsorted section
    const unsorted = filtered.filter(t => !t.section_id);
    if (unsorted.length || sections.length) {
      html += renderSectionHeader(null);
      html += `<div class="section-todos" data-section-id="null" ondragover="onDragOver(event)" ondrop="onDropOnSection(event, null)">`;
      html += unsorted.map(t => renderTodoItem(t)).join('');
      html += `</div>`;
    }

    // Add section button
    html += `<div class="add-section-row">
      <button class="btn btn-add-section" onclick="showAddSectionInline(this)">
        <span>➕</span> Section
      </button>
      <form class="inline-section-form" style="display:none;" onsubmit="createSectionInline(event, this)">
        <input type="text" placeholder="Section-Name..." required>
        <button type="submit">✓</button>
        <button type="button" onclick="cancelAddSection(this)">✕</button>
      </form>
    </div>`;

    if (!filtered.length && !sections.length) {
      html = `<div class="empty-state">
        <div class="emoji">🎉</div>
        <h3>Alles erledigt!</h3>
        <p>Keine Todos in dieser Ansicht.</p>
      </div>`;
    }

    el.innerHTML = html;
    return;
  }

  // Default grouping by status
  const groups = {
    pending: '⏳ Offen',
    in_progress: '🔥 In Arbeit',
    done: '✅ Erledigt'
  };

  let html = '';
  for (const [status, title] of Object.entries(groups)) {
    const items = filtered.filter(t => t.status === status);
    if (!items.length) continue;
    html += `<div class="todo-group">
      <div class="todo-group-title">${title} (${items.length})</div>
      ${items.map(t => renderTodoItem(t)).join('')}
    </div>`;
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

function renderSectionHeader(section) {
  if (section) {
    return `
      <div class="section-header" draggable="false" data-section-id="${section.id}">
        <span class="section-name" onclick="editSectionInline(this, ${section.id})">${escapeHtml(section.name)}</span>
        <span class="section-count">${todos.filter(t => t.section_id === section.id).length}</span>
        <button class="section-delete" onclick="deleteSection(${section.id})" title="Löschen">🗑️</button>
        <form class="inline-edit-form" style="display:none;" onsubmit="saveSectionInline(event, ${section.id}, this)">
          <input type="text" value="${escapeHtml(section.name)}" required>
          <button type="submit">✓</button>
          <button type="button" onclick="cancelEditSection(this)">✕</button>
        </form>
      </div>
    `;
  } else {
    const unsortedCount = todos.filter(t => !t.section_id && t.project_id === currentProjectId).length;
    return `
      <div class="section-header section-unsorted" data-section-id="null">
        <span class="section-name">📁 Unsortiert</span>
        <span class="section-count">${unsortedCount}</span>
      </div>
    `;
  }
}

function renderTodoItem(t) {
  const isOverdue = t.due_date && t.status !== 'done' && new Date(t.due_date) < new Date();
  const dueStr = t.due_date ? formatDate(t.due_date) : '';
  const prioEmoji = {1: '🔴', 2: '🟡', 3: '🟢', 4: '⚪'}[t.priority] || '⚪';
  const project = projects.find(p => p.id === t.project_id);

  return `
    <div class="todo-item ${t.status === 'done' ? 'done' : ''}" data-id="${t.id}" draggable="true" ondragstart="onDragStart(event, ${t.id})" ondragend="onDragEnd(event)" onclick="editTodo(${t.id})">
      <div class="todo-check" onclick="event.stopPropagation(); toggleTodo(${t.id})">
        ${t.status === 'done' ? '✓' : ''}
      </div>
      <div class="todo-body">
        <div class="todo-title">${escapeHtml(t.title)}</div>
        <div class="todo-meta">
          ${t.project_id && project && !currentProjectId ? `<span style="color:${project.color}">● ${escapeHtml(project.name)}</span>` : ''}
          <span class="todo-prio">${prioEmoji}</span>
          ${dueStr ? `<span class="todo-due ${isOverdue ? 'overdue' : ''}">📅 ${dueStr}${isOverdue ? ' (überfällig)' : ''}</span>` : ''}
        </div>
        ${t.description ? `<div style="margin-top:4px;font-size:13px;color:var(--text-muted)">${escapeHtml(t.description)}</div>` : ''}
      </div>
      <div class="todo-actions" onclick="event.stopPropagation()">
        <button onclick="deleteTodo(${t.id})" title="Löschen">🗑️</button>
      </div>
    </div>
  `;
}

// ─── Drag & Drop ─────────────────────────────────────────────────────────────

function onDragStart(e, todoId) {
  dragSrcTodoId = todoId;
  e.dataTransfer.setData('text/plain', String(todoId));
  e.dataTransfer.effectAllowed = 'move';
  document.querySelectorAll('.todo-item').forEach(el => {
    if (el.dataset.id !== String(todoId)) {
      el.style.opacity = '0.5';
    }
  });
}

function onDragEnd(e) {
  dragSrcTodoId = null;
  document.querySelectorAll('.todo-item').forEach(el => el.style.opacity = '');
  document.querySelectorAll('.section-header').forEach(el => el.classList.remove('drag-over'));
  document.querySelectorAll('.section-todos').forEach(el => el.classList.remove('drag-over'));
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

async function onDropOnSection(e, sectionId) {
  e.preventDefault();
  if (!dragSrcTodoId) return;

  const todoId = dragSrcTodoId;
  const todo = todos.find(t => t.id === todoId);
  if (!todo) return;

  // Update the todo's section
  try {
    await patch(`/api/todos/${todoId}`, { section_id: sectionId });
    await loadAll();
  } catch (err) {
    console.error('Failed to move todo to section', err);
    alert('Fehler beim Verschieben: ' + err.message);
  }
}

// ─── Section Inline Actions ──────────────────────────────────────────────────

function showAddSectionInline(btn) {
  const row = btn.closest('.add-section-row');
  btn.style.display = 'none';
  row.querySelector('.inline-section-form').style.display = 'flex';
  row.querySelector('input').focus();
}

function cancelAddSection(btn) {
  const row = btn.closest('.add-section-row');
  row.querySelector('.btn-add-section').style.display = 'inline-flex';
  row.querySelector('.inline-section-form').style.display = 'none';
  row.querySelector('input').value = '';
}

async function createSectionInline(e, form) {
  e.preventDefault();
  const name = form.querySelector('input').value.trim();
  if (!name || !currentProjectId) return;

  try {
    await post(`/api/projects/${currentProjectId}/sections`, { name, sort_order: sections.length });
    await loadAll();
  } catch (err) {
    console.error('Failed to create section', err);
    alert('Fehler beim Erstellen: ' + err.message);
  }
}

function editSectionInline(span, sectionId) {
  const header = span.closest('.section-header');
  span.style.display = 'none';
  const actions = header.querySelector('.section-actions');
  if (actions) actions.style.display = 'none';
  const count = header.querySelector('.section-count');
  if (count) count.style.display = 'none';
  const form = header.querySelector('.inline-edit-form');
  if (form) {
    form.style.display = 'flex';
    form.querySelector('input').focus();
  }
}

function cancelEditSection(btn) {
  const header = btn.closest('.section-header');
  const name = header.querySelector('.section-name');
  if (name) name.style.display = '';
  const actions = header.querySelector('.section-actions');
  if (actions) actions.style.display = '';
  const count = header.querySelector('.section-count');
  if (count) count.style.display = '';
  const form = header.querySelector('.inline-edit-form');
  if (form) form.style.display = 'none';
}

async function saveSectionInline(e, sectionId, form) {
  e.preventDefault();
  const name = form.querySelector('input').value.trim();
  if (!name) return;

  try {
    await patch(`/api/sections/${sectionId}`, { name });
    await loadAll();
  } catch (err) {
    console.error('Failed to update section', err);
    alert('Fehler beim Speichern: ' + err.message);
  }
}

async function deleteSection(sectionId) {
  if (!confirm('Section löschen? Todos werden zu "Unsortiert" verschoben.')) return;
  try {
    await del(`/api/sections/${sectionId}`);
    await loadAll();
  } catch (err) {
    console.error('Failed to delete section', err);
    alert('Fehler beim Löschen: ' + err.message);
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function setFilter(filter) {
  currentFilter = filter;
  currentProjectId = (!['all','pending','in_progress','done'].includes(filter)) ? parseInt(filter) : null;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  event.target.closest('.nav-btn')?.classList.add('active');
  closeSidebar();
  loadAll();
}

function countByProject(pid) {
  return todos.filter(t => t.project_id === pid && t.status !== 'done').length;
}

async function toggleTodo(id) {
  const t = todos.find(x => x.id === id);
  const newStatus = t.status === 'done' ? 'pending' : 'done';
  await patch(`/api/todos/${id}`, { status: newStatus });
  await loadAll();
}

function showTodoModal(todo = null) {
  document.getElementById('todo-form').reset();
  document.getElementById('todo-id').value = '';
  document.getElementById('todo-modal-title').textContent = todo ? 'Todo bearbeiten' : 'Neues Todo';

  const projSelect = document.getElementById('todo-project');
  projSelect.innerHTML = projects.map(p =>
    `<option value="${p.id}" style="color:${p.color}">${escapeHtml(p.name)}</option>`
  ).join('');

  // Render section dropdown
  renderSectionDropdown(todo ? todo.project_id : null, todo ? todo.section_id : null);

  if (todo) {
    document.getElementById('todo-id').value = todo.id;
    document.getElementById('todo-title').value = todo.title;
    document.getElementById('todo-desc').value = todo.description || '';
    document.getElementById('todo-priority').value = todo.priority;
    document.getElementById('todo-status').value = todo.status;
    document.getElementById('todo-project').value = todo.project_id || '';
    document.getElementById('todo-due').value = todo.due_date ? todo.due_date.slice(0, 16) : '';
    const rem = (todo.reminders || [])[0];
    document.getElementById('todo-remind').value = rem ? rem.remind_at.slice(0, 16) : '';
  }

  document.getElementById('todo-modal').classList.add('active');
}

function renderSectionDropdown(projectId, selectedSectionId) {
  const sectionSelect = document.getElementById('todo-section');
  sectionSelect.innerHTML = '<option value="">Keine Section (Unsortiert)</option>';

  if (!projectId) {
    sectionSelect.disabled = true;
    return;
  }

  const projectSections = sections.filter(s => s.project_id === projectId);
  if (!projectSections.length) {
    // Try to fetch sections for this project
    get(`/api/projects/${projectId}/sections`).then(data => {
      const secs = data.sections || [];
      sectionSelect.innerHTML = '<option value="">Keine Section (Unsortiert)</option>' +
        secs.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
      if (selectedSectionId) sectionSelect.value = selectedSectionId;
    }).catch(() => {
      sectionSelect.disabled = true;
    });
    return;
  }

  sectionSelect.innerHTML = '<option value="">Keine Section (Unsortiert)</option>' +
    projectSections.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  sectionSelect.disabled = false;
  if (selectedSectionId) sectionSelect.value = selectedSectionId;
}

// Listen for project change in modal
function onProjectChange() {
  const projectId = parseInt(document.getElementById('todo-project').value);
  renderSectionDropdown(projectId, null);
}

function editTodo(id) {
  const t = todos.find(x => x.id === id);
  if (t) showTodoModal(t);
}

async function saveTodo(e) {
  e.preventDefault();
  const id = document.getElementById('todo-id').value;

  const body = {
    title: document.getElementById('todo-title').value,
    description: document.getElementById('todo-desc').value,
    priority: parseInt(document.getElementById('todo-priority').value),
    status: document.getElementById('todo-status').value,
    project_id: document.getElementById('todo-project').value ? parseInt(document.getElementById('todo-project').value) : null,
    due_date: document.getElementById('todo-due').value ? new Date(document.getElementById('todo-due').value).toISOString() : null,
    remind_at: document.getElementById('todo-remind').value ? new Date(document.getElementById('todo-remind').value).toISOString() : null
  };

  const sectionVal = document.getElementById('todo-section').value;
  if (sectionVal !== '') {
    body.section_id = parseInt(sectionVal);
  } else {
    body.section_id = null;
  }

  if (id) {
    await patch(`/api/todos/${id}`, body);
  } else {
    await post('/api/todos', body);
  }

  closeModal('todo-modal');
  await loadAll();
}

async function deleteTodo(id) {
  if (!confirm('Wirklich löschen?')) return;
  await del(`/api/todos/${id}`);
  await loadAll();
}

async function deleteProject(id, name) {
  const inbox = projects.find(p => p.id === 1);
  const inboxName = inbox ? inbox.name : 'Inbox';
  if (!confirm(`Projekt "${name}" löschen?\n\nAlle Todos werden in "${inboxName}" verschoben.`)) return;
  await del(`/api/projects/${id}`);
  if (currentFilter === String(id)) {
    currentFilter = 'all';
    currentProjectId = null;
  }
  await loadAll();
}

function showProjectModal() {
  closeSidebar();
  document.getElementById('project-form')?.reset();
  document.getElementById('project-id').value = '';
  document.getElementById('project-modal-title').textContent = 'Neues Projekt';
  document.getElementById('project-name').value = '';
  document.getElementById('project-color').value = '#6366f1';
  document.getElementById('project-delete-btn').style.display = 'none';
  document.getElementById('project-modal').classList.add('active');
}

function editProject(id) {
  closeSidebar();
  const p = projects.find(x => x.id === id);
  if (!p) return;
  document.getElementById('project-id').value = p.id;
  document.getElementById('project-modal-title').textContent = 'Projekt bearbeiten';
  document.getElementById('project-name').value = p.name;
  document.getElementById('project-color').value = p.color;
  document.getElementById('project-delete-btn').style.display = id === 1 ? 'none' : 'inline-flex';
  document.getElementById('project-modal').classList.add('active');
}

async function saveProject(e) {
  e.preventDefault();
  const id = document.getElementById('project-id').value;
  const body = {
    name: document.getElementById('project-name').value,
    color: document.getElementById('project-color').value
  };
  if (id) {
    await patch(`/api/projects/${id}`, body);
  } else {
    await post('/api/projects', body);
  }
  closeModal('project-modal');
  await loadAll();
}

function deleteProjectFromModal() {
  const id = document.getElementById('project-id').value;
  const name = document.getElementById('project-name').value;
  if (!id || parseInt(id) === 1) return;
  deleteProject(parseInt(id), name);
  closeModal('project-modal');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

// ─── Utils ───────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  if (!text) return '';
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function formatDate(iso) {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0,0,0,0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateOnly = new Date(d);
  dateOnly.setHours(0,0,0,0);

  if (dateOnly.getTime() === today.getTime()) return 'Heute';
  if (dateOnly.getTime() === tomorrow.getTime()) return 'Morgen';

  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
    + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
  }
  if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const active = document.querySelector('.modal.active');
    if (!active) showTodoModal();
  }
});
