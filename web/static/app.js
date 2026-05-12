// nia-todo: Frontend app
const API = '';

let todos = [];
let projects = [];
let labels = [];
let currentFilter = 'all';
let currentProjectId = null;

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
  await Promise.all([loadProjects(), loadLabels(), loadTodos()]);
  renderProjects();
  renderLabels();
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
    // it's a project id
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

async function loadLabels() {
  const data = await get('/api/labels');
  labels = data.labels || [];
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
      ${p.id > 4 ? `<button class="nav-delete" onclick="deleteProject(${p.id}, '${escapeHtml(p.name)}')" title="Löschen">×</button>` : ''}
    </div>
  `).join('');
}

function renderLabels() {
  const el = document.getElementById('label-list');
  el.innerHTML = labels.map(l => `
    <div class="nav-item-with-action">
      <button class="nav-btn" onclick="setLabelFilter(${l.id})">
        <span class="project-dot" style="background:${l.color}"></span>
        ${escapeHtml(l.name)}
      </button>
      <button class="nav-delete" onclick="deleteLabel(${l.id}, '${escapeHtml(l.name)}')" title="Löschen">×</button>
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

  // Group by status
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

function renderTodoItem(t) {
  const isOverdue = t.due_date && t.status !== 'done' && new Date(t.due_date) < new Date();
  const dueStr = t.due_date ? formatDate(t.due_date) : '';
  const prioEmoji = {1: '🔴', 2: '🟡', 3: '🟢', 4: '⚪'}[t.priority] || '⚪';
  const project = projects.find(p => p.id === t.project_id);
  const labelTags = (t.labels || []).map(l =>
    `<span class="todo-label-tag" style="background:${l.color}33;color:${l.color}">${escapeHtml(l.name)}</span>`
  ).join('');

  return `
    <div class="todo-item ${t.status === 'done' ? 'done' : ''}" data-id="${t.id}">
      <div class="todo-check" onclick="toggleTodo(${t.id})">
        ${t.status === 'done' ? '✓' : ''}
      </div>
      <div class="todo-body">
        <div class="todo-title">${escapeHtml(t.title)}</div>
        <div class="todo-meta">
          ${t.project_id && project ? `<span style="color:${project.color}">● ${escapeHtml(project.name)}</span>` : ''}
          <span class="todo-prio">${prioEmoji}</span>
          ${dueStr ? `<span class="todo-due ${isOverdue ? 'overdue' : ''}">📅 ${dueStr}${isOverdue ? ' (überfällig)' : ''}</span>` : ''}
          ${labelTags}
        </div>
        ${t.description ? `<div style="margin-top:4px;font-size:13px;color:var(--text-muted)">${escapeHtml(t.description)}</div>` : ''}
      </div>
      <div class="todo-actions">
        <button onclick="editTodo(${t.id})" title="Bearbeiten">✏️</button>
        <button onclick="deleteTodo(${t.id})" title="Löschen">🗑️</button>
      </div>
    </div>
  `;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function setFilter(filter) {
  currentFilter = filter;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  event.target.closest('.nav-btn')?.classList.add('active');
  closeSidebar();
  loadAll();
}

function setLabelFilter(labelId) {
  // TODO: implement label filtering in backend
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

  // Populate project dropdown
  const projSelect = document.getElementById('todo-project');
  projSelect.innerHTML = projects.map(p =>
    `<option value="${p.id}" style="color:${p.color}">${escapeHtml(p.name)}</option>`
  ).join('');

  // Populate label picker
  const labelEl = document.getElementById('todo-labels');
  labelEl.innerHTML = labels.map(l => `
    <span class="label-chip" data-id="${l.id}" style="background:${l.color}33;color:${l.color};border-color:${l.color}"
      onclick="toggleLabelChip(this)">
      ${escapeHtml(l.name)}
    </span>
  `).join('');

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
    (todo.labels || []).forEach(l => {
      const chip = labelEl.querySelector(`[data-id="${l.id}"]`);
      if (chip) chip.classList.add('selected');
    });
  }

  document.getElementById('todo-modal').classList.add('active');
}

function toggleLabelChip(el) {
  el.classList.toggle('selected');
}

function editTodo(id) {
  const t = todos.find(x => x.id === id);
  if (t) showTodoModal(t);
}

async function saveTodo(e) {
  e.preventDefault();
  const id = document.getElementById('todo-id').value;
  const labelChips = document.querySelectorAll('#todo-labels .label-chip.selected');
  const labelIds = Array.from(labelChips).map(el => parseInt(el.dataset.id));

  const body = {
    title: document.getElementById('todo-title').value,
    description: document.getElementById('todo-desc').value,
    priority: parseInt(document.getElementById('todo-priority').value),
    status: document.getElementById('todo-status').value,
    project_id: document.getElementById('todo-project').value ? parseInt(document.getElementById('todo-project').value) : null,
    due_date: document.getElementById('todo-due').value ? new Date(document.getElementById('todo-due').value).toISOString() : null,
    remind_at: document.getElementById('todo-remind').value ? new Date(document.getElementById('todo-remind').value).toISOString() : null,
    label_ids: labelIds
  };

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
  if (!confirm(`Projekt "${name}" wirklich löschen? Todos werden ins Inbox verschoben.`)) return;
  await del(`/api/projects/${id}`);
  if (currentFilter === String(id)) currentFilter = 'all';
  await loadAll();
}

async function deleteLabel(id, name) {
  if (!confirm(`Label "${name}" wirklich löschen?`)) return;
  await del(`/api/labels/${id}`);
  await loadAll();
}

function showProjectModal() {
  document.getElementById('project-modal').classList.add('active');
}

async function saveProject(e) {
  e.preventDefault();
  await post('/api/projects', {
    name: document.getElementById('project-name').value,
    color: document.getElementById('project-color').value
  });
  closeModal('project-modal');
  document.getElementById('project-name').value = '';
  await loadAll();
}

function showLabelModal() {
  document.getElementById('label-modal').classList.add('active');
}

async function saveLabel(e) {
  e.preventDefault();
  await post('/api/labels', {
    name: document.getElementById('label-name').value,
    color: document.getElementById('label-color').value
  });
  closeModal('label-modal');
  document.getElementById('label-name').value = '';
  await loadAll();
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
