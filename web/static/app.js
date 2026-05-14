// nia-todo: Frontend app mit Offline-First PWA + Robust Sync
const API = '';
const DB_NAME = 'nia-todo-db';
const DB_VERSION = 3;

let todos = [];
let projects = [];
let sections = [];
let currentFilter = 'all';
let currentProjectId = null;
let dragSrcTodoId = null;
let isOnline = navigator.onLine;
let db = null;
let dbReady = null;
let appInitialized = false;
let syncInProgress = false;
let swRegistration = null;
let updateAvailable = false;
const APP_VERSION = 'v0.1.0';

// ─── IndexedDB ───────────────────────────────────────────────────────────────

function openDB() {
  dbReady = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onupgradeneeded = (event) => {
      db = event.target.result;
      if (!db.objectStoreNames.contains('todos')) {
        db.createObjectStore('todos', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('sections')) {
        db.createObjectStore('sections', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('syncQueue')) {
        db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
      }
    };
    
    request.onsuccess = (event) => {
      db = event.target.result;
      console.log('IndexedDB opened');
      resolve(db);
    };
    
    request.onerror = () => {
      console.error('IndexedDB open failed', request.error);
      reject(request.error);
    };
  });
  return dbReady;
}

function dbGetAll(storeName) {
  return new Promise((resolve) => {
    if (!db) { resolve([]); return; }
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve([]);
  });
}

function dbPut(storeName, item) {
  return new Promise((resolve) => {
    if (!db) { resolve(); return; }
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.put(item);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve();
  });
}

function dbClear(storeName) {
  return new Promise((resolve) => {
    if (!db) { resolve(); return; }
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
}

function getFromDB(storeName, id) {
  return new Promise((resolve) => {
    if (!db) { resolve(null); return; }
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

function deleteFromDB(storeName, id) {
  return new Promise((resolve) => {
    if (!db) { resolve(); return; }
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
}

async function clearSyncQueue() {
  if (!db) return;
  const tx = db.transaction('syncQueue', 'readwrite');
  const store = tx.objectStore('syncQueue');
  await new Promise((resolve) => {
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
  });
}

function addToSyncQueue(action, data) {
  return dbPut('syncQueue', { action, data, timestamp: Date.now() });
}

// ─── Sync Logic (Kern der Offline→Online Synchronisation) ───────────────────

async function syncWithServer() {
  if (!isOnline || !db || syncInProgress) return;
  syncInProgress = true;
  
  const queue = await dbGetAll('syncQueue');
  if (!queue.length) {
    syncInProgress = false;
    return;
  }
  
  console.log('Syncing', queue.length, 'pending actions');
  let successCount = 0;
  let failCount = 0;
  
  for (const item of queue) {
    try {
      if (item.action === 'CREATE_TODO') {
        const res = await post('/api/todos', item.data);
        // Neue Todos: Temp-ID mit Server-ID ersetzen
        if (item.data._tempId) {
          await deleteFromDB('todos', item.data._tempId);
        }
        await dbPut('todos', res);
        successCount++;
      } else if (item.action === 'UPDATE_TODO') {
        await patch(`/api/todos/${item.data.id}`, item.data.changes);
        successCount++;
      } else if (item.action === 'DELETE_TODO') {
        await del(`/api/todos/${item.data.id}`);
        await deleteFromDB('todos', item.data.id);
        successCount++;
      } else if (item.action === 'CREATE_PROJECT') {
        const res = await post('/api/projects', item.data);
        await dbPut('projects', res);
        successCount++;
      }
      
      // Erfolgreich synched → aus Queue entfernen
      if (db) {
        const tx = db.transaction('syncQueue', 'readwrite');
        tx.objectStore('syncQueue').delete(item.id);
      }
    } catch (err) {
      console.error('Sync failed for action', item.action, err);
      failCount++;
    }
  }
  
  console.log(`Sync complete: ${successCount} success, ${failCount} failed`);
  syncInProgress = false;
}

async function refreshFromServer() {
  if (!isOnline || !db) {
    console.log('Offline - using local data');
    return;
  }
  
  try {
    // 1. ZUERST: Lokale Änderungen pushen (damit Server den neuesten Stand hat)
    await syncWithServer();
    
    // 2. DANN: Server-Daten holen und mergen (nicht überschreiben!)
    const [todosData, projectsData] = await Promise.all([
      get('/api/todos'),
      get('/api/projects')
    ]);
    
    const serverTodos = todosData.todos || [];
    const serverProjects = projectsData.projects || [];
    
    // 3. Merge-Strategie: Server hat Vorrang für Konflikte, aber lokale Änderungen bleiben erhalten
    // Wir speichern Server-Daten und markieren sie als "frisch"
    for (const todo of serverTodos) {
      const localTodo = await getFromDB('todos', todo.id);
      if (!localTodo) {
        // Neue Todo vom Server → hinzufügen
        await dbPut('todos', todo);
      } else {
        // Todo existiert lokal → Server hat Vorrang (außer es ist in der Sync-Queue)
        const queue = await dbGetAll('syncQueue');
        const pendingChanges = queue.find(q => 
          q.action === 'UPDATE_TODO' && q.data.id === todo.id
        );
        
        if (!pendingChanges) {
          // Keine lokalen Änderungen → Server-Daten übernehmen
          await dbPut('todos', todo);
        }
        // Sonst: Lokale Änderungen behalten, werden beim nächsten Sync gepusht
      }
    }
    
    // Projekte einfach überschreiben (keine lokalen Projekt-Änderungen erwartet)
    for (const project of serverProjects) {
      await dbPut('projects', project);
    }
    
    // 4. Lokale Daten neu laden
    todos = await dbGetAll('todos');
    projects = await dbGetAll('projects');
    
    renderProjects();
    renderStats();
    renderTodos();
    
    console.log('Refreshed from server:', todos.length, 'todos');
  } catch (err) {
    console.error('Refresh failed:', err);
  }
}

// ─── Online/Offline Detection ────────────────────────────────────────────────

window.addEventListener('online', async () => {
  console.log('Device went online');
  isOnline = true;
  updateOnlineStatus();
  
  // WICHTIG: Zuerst lokale Änderungen pushen, DANN Server-Daten holen
  await syncWithServer();
  await refreshFromServer();
});

window.addEventListener('offline', () => {
  console.log('Device went offline');
  isOnline = false;
  updateOnlineStatus();
});

function updateOnlineStatus() {
  const indicator = document.getElementById('online-status');
  if (indicator) {
    indicator.textContent = isOnline ? '🟢 Online' : '🔴 Offline';
    indicator.className = isOnline ? 'status-online' : 'status-offline';
  }
}

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

// ─── Update-Checker ───────────────────────────────────────────────────────────

async function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    swRegistration = reg;
    console.log('SW registered:', reg.scope);
    
    // Prüfe auf Updates beim Start
    checkForUpdate(reg);
    
    // Prüfe alle 30 Min auf Updates
    setInterval(() => checkForUpdate(reg), 30 * 60 * 1000);
    
    // Wenn ein neuer SW wartet (updatefound event)
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      console.log('SW: New version found, waiting for install...');
      
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          // Neue Version ist bereit!
          console.log('SW: New version ready for update');
          updateAvailable = true;
          showUpdateButton();
        }
      });
    });
    
    // controllerchange = neuer SW hat übernommen
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      console.log('SW: New controller active, reloading...');
      window.location.reload();
    });
    
  } catch (err) {
    console.error('SW registration failed:', err);
  }
}

async function checkForUpdate(reg) {
  try {
    await reg.update();
    console.log('SW: Update check done');
  } catch (err) {
    console.error('SW: Update check failed', err);
  }
}

function showUpdateButton() {
  const el = document.getElementById('update-btn');
  if (el) {
    el.style.display = 'flex';
    console.log('Update button shown');
  }
}

async function triggerUpdate() {
  console.log('Triggering app update...');
  
  // 1. IndexedDB sichern (optional - wir behalten Daten ja)
  
  // 2. Service Worker zum Aktivieren zwingen
  if (swRegistration && swRegistration.waiting) {
    swRegistration.waiting.postMessage({ action: 'skipWaiting' });
  }
  
  // 3. Cache leeren und Seite neu laden
  // Der controllerchange Event macht das Reload
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  console.log('App starting...');
  
  // Service Worker registrieren (mit Update-Check)
  await initServiceWorker();
  
  try {
    await openDB();
    console.log('DB ready');
  } catch (err) {
    console.error('DB init failed:', err);
  }
  
  try {
    await loadFromLocalDB();
    console.log('Local data loaded');
  } catch (err) {
    console.error('Local load failed:', err);
  }
  
  appInitialized = true;
  
  if (isOnline) {
    console.log('Online at startup - syncing...');
    refreshFromServer().catch(err => console.error('Server refresh failed:', err));
  }
  
  updateOnlineStatus();
  
  // Version in Sidebar anzeigen
  renderVersionInfo();
  
  console.log('App initialized');
});

function renderVersionInfo() {
  const el = document.getElementById('version-info');
  if (el) {
    el.innerHTML = `
      <span class="version-text">${APP_VERSION}</span>
    `;
  }
}

async function loadFromLocalDB() {
  todos = await dbGetAll('todos');
  projects = await dbGetAll('projects');
  sections = await dbGetAll('sections');
  renderProjects();
  renderStats();
  renderTodos();
}

async function loadAll() {
  await loadFromLocalDB();
  if (isOnline) {
    await refreshFromServer();
  }
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

// ─── Render ──────────────────────────────────────────────────────────────────

function renderProjects() {
  const el = document.getElementById('project-list');
  if (!el) return;
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
  const el = document.getElementById('stats-bar');
  if (!el) return;
  const total = todos.length;
  const pending = todos.filter(t => t.status === 'pending').length;
  const inprog = todos.filter(t => t.status === 'in_progress').length;
  const done = todos.filter(t => t.status === 'done').length;
  const overdue = todos.filter(t => t.status !== 'done' && t.due_date && new Date(t.due_date) < new Date()).length;

  document.getElementById('count-all').textContent = total;
  document.getElementById('count-pending').textContent = pending;
  document.getElementById('count-in_progress').textContent = inprog;
  document.getElementById('count-done').textContent = done;

  el.innerHTML = `
    <div class="stat-card total"><span class="stat-num">${total}</span> Gesamt</div>
    <div class="stat-card pending"><span class="stat-num">${pending}</span> Offen</div>
    <div class="stat-card pending"><span class="stat-num">${inprog}</span> In Arbeit</div>
    <div class="stat-card due"><span class="stat-num">${overdue}</span> Überfällig</div>
    <div class="stat-card done"><span class="stat-num">${done}</span> Erledigt</div>
  `;
}

function renderTodos() {
  const el = document.getElementById('todo-list');
  if (!el) return;
  const search = document.getElementById('search-input')?.value?.toLowerCase() || '';

  let filtered = todos;
  if (search) {
    filtered = filtered.filter(t =>
      (t.title || '').toLowerCase().includes(search) ||
      (t.description || '').toLowerCase().includes(search)
    );
  }

  if (currentProjectId) {
    let html = '';

    for (const section of sections) {
      const sectionTodos = filtered.filter(t => t.section_id === section.id);
      if (!sectionTodos.length) continue;
      html += renderSectionHeader(section);
      html += `<div class="section-todos" data-section-id="${section.id}">`;
      html += sectionTodos.map(t => renderTodoItem(t)).join('');
      html += `</div>`;
    }

    const unsorted = filtered.filter(t => !t.section_id);
    if (unsorted.length || sections.length) {
      html += renderSectionHeader(null);
      html += `<div class="section-todos" data-section-id="null">`;
      html += unsorted.map(t => renderTodoItem(t)).join('');
      html += `</div>`;
    }

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
      <div class="section-header" data-section-id="${section.id}">
        <span class="section-name">${escapeHtml(section.name)}</span>
        <span class="section-count">${todos.filter(t => t.section_id === section.id).length}</span>
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
    <div class="todo-item ${t.status === 'done' ? 'done' : ''}" data-id="${t.id}" onclick="editTodo(${t.id})">
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
      </div>
      <div class="todo-actions" onclick="event.stopPropagation()">
        <button onclick="deleteTodo(${t.id})" title="Löschen">🗑️</button>
      </div>
    </div>
  `;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function setFilter(filter) {
  currentFilter = filter;
  currentProjectId = (!['all','pending','in_progress','done'].includes(filter)) ? parseInt(filter) : null;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  event.target.closest('.nav-btn')?.classList.add('active');
  closeSidebar();
  
  loadSectionsForCurrentProject().then(() => {
    renderTodos();
  });
}

async function loadSectionsForCurrentProject() {
  sections = [];
  if (!currentProjectId) return;
  
  try {
    const allSections = await dbGetAll('sections');
    sections = allSections.filter(s => s.project_id === currentProjectId);
  } catch (e) {
    console.error('Failed to load sections from local DB', e);
  }
  
  if (isOnline) {
    try {
      const data = await get(`/api/projects/${currentProjectId}/sections`);
      sections = data.sections || [];
      for (const s of sections) {
        await dbPut('sections', s);
      }
    } catch (e) {
      console.error('Failed to load sections from server', e);
    }
  }
}

function countByProject(pid) {
  return todos.filter(t => t.project_id === pid && t.status !== 'done').length;
}

async function toggleTodo(id) {
  if (!appInitialized || !db) return;
  
  const t = todos.find(x => x.id === id);
  if (!t) return;
  
  const newStatus = t.status === 'done' ? 'pending' : 'done';
  
  // Update local
  const updatedTodo = { ...t, status: newStatus, updated_at: new Date().toISOString() };
  await dbPut('todos', updatedTodo);
  
  // UI updaten
  todos = todos.map(todo => todo.id === id ? updatedTodo : todo);
  renderStats();
  renderTodos();
  
  // Server sync
  if (isOnline) {
    try {
      await patch(`/api/todos/${id}`, { status: newStatus });
    } catch (err) {
      console.error('Sync failed', err);
      await addToSyncQueue('UPDATE_TODO', { id, changes: { status: newStatus } });
    }
  } else {
    await addToSyncQueue('UPDATE_TODO', { id, changes: { status: newStatus } });
  }
}

function showTodoModal(todo = null) {
  document.getElementById('todo-form')?.reset();
  document.getElementById('todo-id').value = '';
  document.getElementById('todo-modal-title').textContent = todo ? 'Todo bearbeiten' : 'Neues Todo';

  const projSelect = document.getElementById('todo-project');
  if (projSelect) {
    projSelect.innerHTML = projects.map(p =>
      `<option value="${p.id}" style="color:${p.color}">${escapeHtml(p.name)}</option>`
    ).join('');
  }

  if (todo) {
    document.getElementById('todo-id').value = todo.id;
    document.getElementById('todo-title').value = todo.title;
    document.getElementById('todo-desc').value = todo.description || '';
    document.getElementById('todo-priority').value = todo.priority;
    document.getElementById('todo-status').value = todo.status;
    document.getElementById('todo-project').value = todo.project_id || '';
    
    if (todo.due_date) {
      document.getElementById('todo-due').value = new Date(todo.due_date).toISOString().slice(0, 16);
    }
  }
  
  document.getElementById('todo-modal')?.classList.add('active');
}

async function saveTodo(event) {
  event.preventDefault();
  if (!appInitialized || !db) return;
  
  const id = document.getElementById('todo-id').value;
  const todoData = {
    title: document.getElementById('todo-title').value,
    description: document.getElementById('todo-desc').value,
    priority: parseInt(document.getElementById('todo-priority').value),
    project_id: document.getElementById('todo-project').value ? parseInt(document.getElementById('todo-project').value) : null,
    status: document.getElementById('todo-status').value,
    due_date: document.getElementById('todo-due').value ? new Date(document.getElementById('todo-due').value).toISOString() : null,
    remind_at: document.getElementById('todo-remind').value ? new Date(document.getElementById('todo-remind').value).toISOString() : null
  };

  if (id) {
    // Bestehendes Todo aktualisieren
    const existing = todos.find(t => t.id === parseInt(id));
    if (existing) {
      const updated = { ...existing, ...todoData, updated_at: new Date().toISOString() };
      await dbPut('todos', updated);
      todos = todos.map(t => t.id === parseInt(id) ? updated : t);
      
      if (isOnline) {
        try {
          await patch(`/api/todos/${id}`, todoData);
        } catch (err) {
          console.error('Server sync failed', err);
          await addToSyncQueue('UPDATE_TODO', { id: parseInt(id), changes: todoData });
        }
      } else {
        await addToSyncQueue('UPDATE_TODO', { id: parseInt(id), changes: todoData });
      }
    }
  } else {
    // Neues Todo erstellen
    const tempId = 'temp-' + Date.now();
    const newTodo = {
      id: tempId,
      ...todoData,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      reminders: [],
      labels: []
    };
    await dbPut('todos', newTodo);
    todos.push(newTodo);
    
    if (isOnline) {
      try {
        const serverTodo = await post('/api/todos', todoData);
        // Temp-ID durch Server-ID ersetzen
        await deleteFromDB('todos', tempId);
        serverTodo.id = serverTodo.id;
        await dbPut('todos', serverTodo);
        todos = todos.map(t => t.id === tempId ? serverTodo : t);
      } catch (err) {
        console.error('Server sync failed', err);
        await addToSyncQueue('CREATE_TODO', { ...todoData, _tempId: tempId });
      }
    } else {
      await addToSyncQueue('CREATE_TODO', { ...todoData, _tempId: tempId });
    }
  }
  
  renderProjects();
  renderStats();
  renderTodos();
  closeModal('todo-modal');
}

function editTodo(id) {
  const todo = todos.find(t => t.id === id);
  if (todo) showTodoModal(todo);
}

async function deleteTodo(id) {
  if (!confirm('Todo wirklich löschen?')) return;
  
  await deleteFromDB('todos', id);
  todos = todos.filter(t => t.id !== id);
  renderStats();
  renderTodos();
  closeModal('todo-modal');
  
  if (isOnline) {
    try {
      await del(`/api/todos/${id}`);
    } catch (err) {
      console.error('Server delete failed', err);
      await addToSyncQueue('DELETE_TODO', { id });
    }
  } else {
    await addToSyncQueue('DELETE_TODO', { id });
  }
}

function showProjectModal(project = null) {
  document.getElementById('project-form')?.reset();
  document.getElementById('project-id').value = '';
  document.getElementById('project-modal-title').textContent = project ? 'Projekt bearbeiten' : 'Neues Projekt';
  
  if (project) {
    document.getElementById('project-id').value = project.id;
    document.getElementById('project-name').value = project.name;
    document.getElementById('project-color').value = project.color;
  }
  
  document.getElementById('project-modal')?.classList.add('active');
}

function editProject(id) {
  const project = projects.find(p => p.id === id);
  if (project) showProjectModal(project);
}

async function saveProject(event) {
  event.preventDefault();
  
  const id = document.getElementById('project-id').value;
  const projectData = {
    name: document.getElementById('project-name').value,
    color: document.getElementById('project-color').value,
    sort_order: projects.length
  };

  if (isOnline) {
    try {
      if (id) {
        await patch(`/api/projects/${id}`, projectData);
      } else {
        const res = await post('/api/projects', projectData);
        await dbPut('projects', res);
        projects.push(res);
      }
      await refreshFromServer();
      closeModal('project-modal');
    } catch (err) {
      console.error('Save failed', err);
      alert('Fehler beim Speichern: ' + err.message);
    }
  } else {
    alert('Offline - Projekt kann nicht erstellt werden');
  }
}

async function deleteProject(id) {
  if (!confirm('Projekt wirklich löschen?')) return;
  
  if (isOnline) {
    try {
      await del(`/api/projects/${id}`);
      await refreshFromServer();
      closeModal('project-modal');
    } catch (err) {
      console.error('Delete failed', err);
      alert('Fehler beim Löschen');
    }
  } else {
    alert('Offline - Projekt kann nicht gelöscht werden');
  }
}

function deleteProjectFromModal() {
  const id = document.getElementById('project-id').value;
  if (id) deleteProject(parseInt(id));
}

// ─── Modal Helpers ───────────────────────────────────────────────────────────

function closeModal(modalId) {
  document.getElementById(modalId)?.classList.remove('active');
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  if (date.toDateString() === today.toDateString()) {
    return 'Heute ' + date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  } else if (date.toDateString() === tomorrow.toDateString()) {
    return 'Morgen ' + date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  } else {
    return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' + 
           date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'n' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
    e.preventDefault();
    showTodoModal();
  }
  if (e.key === 'Escape') {
    closeModal('todo-modal');
    closeModal('project-modal');
  }
});
