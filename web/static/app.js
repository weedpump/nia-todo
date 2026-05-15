// nia-todo: Frontend app mit Offline-First PWA + WebSocket Echtzeit-Sync
const API = '';
const WS_URL = (() => {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
})();

const DB_NAME = 'nia-todo-db';
const DB_VERSION = 3;

let todos = [];
let projects = [];
let sections = [];
let currentFilter = 'all';
let currentProjectId = null;
let dragSrcTodoId = null;
let dragSrcSectionId = null;
let db = null;
let dbReady = null;
let appInitialized = false;
let syncInProgress = false;
let swRegistration = null;
let updateAvailable = false;
const APP_VERSION = 'v0.3.1-dev';

// ─── WebSocket ───────────────────────────────────────────────────────────────
let ws = null;
let wsState = 'disconnected'; // connected, connecting, reconnecting, disconnected
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 1000;
let pingInterval = null;
let reconnectTimer = null;
let wsIntentionalClose = false;

function getReconnectDelay() {
  const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), 30000);
  const jitter = Math.random() * 1000;
  return delay + jitter;
}

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    console.log('[WS] Already connecting or open');
    return;
  }
  if (wsIntentionalClose) {
    console.log('[WS] Intentionally closed, skipping reconnect');
    return;
  }

  wsState = reconnectAttempts > 0 ? 'reconnecting' : 'connecting';
  updateConnectionStatus();
  console.log('[WS] Connecting to ' + WS_URL + ' (attempt ' + (reconnectAttempts + 1) + ')');

  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = async () => {
      console.log('[WS] ✅ Connected');
      wsState = 'connected';
      reconnectAttempts = 0;
      updateConnectionStatus();

      // ERST: Lokale Änderungen pushen (wenn Queue vorhanden)
      try {
        await syncWithServer();
      } catch (e) {
        console.error('Pre-sync failed', e);
      }

      // DANN: Full sync vom Server holen
      wsSend({ type: 'sync_request' });

      // Start ping interval
      startPingInterval();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (e) {
        console.error('WS: parse error', e);
      }
    };

    ws.onclose = (event) => {
      console.log('[WS] ❌ Closed (code=' + event.code + ', reason=' + (event.reason || 'none') + ')');
      stopPingInterval();
      ws = null;
      if (!wsIntentionalClose) {
        wsState = 'disconnected';
        updateConnectionStatus();
        scheduleReconnect();
      }
    };

    ws.onerror = (err) => {
      console.error('[WS] 💥 Error:', err);
      wsState = 'disconnected';
      updateConnectionStatus();
    };
  } catch (e) {
    console.error('[WS] Failed to create WebSocket:', e);
    wsState = 'disconnected';
    updateConnectionStatus();
    scheduleReconnect();
  }
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function startPingInterval() {
  stopPingInterval();
  pingInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      wsSend({ type: 'ping' });
    }
  }, 30000);
}

function stopPingInterval() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn('WS: max reconnect attempts reached');
    return;
  }
  const delay = getReconnectDelay();
  reconnectAttempts++;
  console.log(`WS: reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function disconnectWebSocket() {
  wsIntentionalClose = true;
  stopPingInterval();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  wsState = 'disconnected';
  updateConnectionStatus();
}

function updateConnectionStatus() {
  const indicator = document.getElementById('online-status');
  if (!indicator) return;

  // Nur connected/disconnected anzeigen — keine Zwischenzustände (flackern!)
  if (wsState === 'connected') {
    indicator.textContent = '🟢 Online';
    indicator.className = 'status-online';
    indicator.style.display = 'inline-flex';
  } else {
    // Alles andere = Offline (disconnected, connecting, reconnecting)
    indicator.textContent = '🔴 Offline';
    indicator.className = 'status-offline';
  }
}

async function handleWsMessage(msg) {
  switch (msg.type) {
    case 'pong':
      // keepalive response — nothing to do
      break;
    case 'sync_response':
      // Full data sync from server — nur wenn Server neuer
      if (msg.todos) {
        for (const todo of msg.todos) {
          const local = await getFromDB('todos', todo.id);
          if (!local) {
            await dbPut('todos', todo);
          } else {
            const localTime = new Date(local.updated_at || 0).getTime();
            const serverTime = new Date(todo.updated_at || 0).getTime();
            if (serverTime >= localTime) {
              await dbPut('todos', todo);
            }
          }
        }
        todos = await dbGetAll('todos');
      }
      if (msg.projects) {
        for (const project of msg.projects) {
          await dbPut('projects', project);
        }
        projects = msg.projects;
      }
      renderProjects();
      renderStats();
      renderTodos();
      break;
    case 'todo_create':
      if (msg.payload) {
        await dbPut('todos', msg.payload);
        // Check if we have a temp todo in queue for this server response
        const queue = await dbGetAll('syncQueue');
        const pendingCreate = queue.find(q =>
          q.action === 'CREATE_TODO' && q.data._tempId
        );
        if (pendingCreate) {
          // Replace temp todo with real server version
          await deleteFromDB('todos', pendingCreate.data._tempId);
          todos = todos.filter(t => t.id !== pendingCreate.data._tempId);
          todos.push(msg.payload);
        } else {
          // Broadcast from another client → add to list
          const existing = todos.find(t => t.id === msg.payload.id);
          if (!existing) todos.push(msg.payload);
        }
        renderProjects();
        renderStats();
        renderTodos();
      }
      break;
    case 'todo_update':
      if (msg.payload) {
        const local = await getFromDB('todos', msg.payload.id);
        if (local) {
          const localTime = new Date(local.updated_at || 0).getTime();
          const serverTime = new Date(msg.payload.updated_at || 0).getTime();
          if (serverTime < localTime) {
            // Lokale Version ist neuer → nicht überschreiben
            break;
          }
        }
        await dbPut('todos', msg.payload);
        todos = todos.map(t => t.id === msg.payload.id ? msg.payload : t);
        renderProjects();
        renderStats();
        renderTodos();
      }
      break;
    case 'todo_delete':
      if (msg.payload?.id) {
        await deleteFromDB('todos', msg.payload.id);
        todos = todos.filter(t => t.id !== msg.payload.id);
        renderProjects();
        renderStats();
        renderTodos();
      }
      break;
    case 'project_create':
      if (msg.payload) {
        await dbPut('projects', msg.payload);
        const existing = projects.find(p => p.id === msg.payload.id);
        if (existing) {
          // Server response for our create → replace temp entry
          projects = projects.map(p => p.id === msg.payload.id ? msg.payload : p);
        } else {
          // Broadcast from another client → add to list
          projects.push(msg.payload);
        }
        renderProjects();
      }
      break;
    case 'project_update':
      if (msg.payload) {
        await dbPut('projects', msg.payload);
        projects = projects.map(p => p.id === msg.payload.id ? msg.payload : p);
        renderProjects();
      }
      break;
    case 'project_delete':
      if (msg.payload?.id) {
        await deleteFromDB('projects', msg.payload.id);
        projects = projects.filter(p => p.id !== msg.payload.id);
        renderProjects();
        renderStats();
        renderTodos();
      }
      break;
    default:
      console.log('WS: unknown message type', msg.type);
  }
}

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
  return dbPut('syncQueue', { action, data, timestamp: Date.now(), localUpdatedAt: new Date().toISOString() });
}

// ─── Sync Logic (Kern der Offline→Online Synchronisation) ───────────────────

function isOnlineForSync() {
  // Use WebSocket state as primary online indicator; fallback to navigator.onLine
  return wsState === 'connected' || (typeof navigator !== 'undefined' && navigator.onLine);
}

async function syncWithServer() {
  if (!isOnlineForSync() || !db || syncInProgress) return;
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
        // Remove temp entry from local DB and todos array
        if (item.data._tempId) {
          await deleteFromDB('todos', item.data._tempId);
          todos = todos.filter(t => t.id !== item.data._tempId);
        }
        await dbPut('todos', res);
        todos.push(res);
        successCount++;
      } else if (item.action === 'UPDATE_TODO') {
        await patch(`/api/todos/${item.data.id}`, item.data.changes);
        // Lokale DB mit neuem updated_at aktualisieren
        const localTodo = await getFromDB('todos', item.data.id);
        if (localTodo) {
          const updated = { ...localTodo, ...item.data.changes, updated_at: new Date().toISOString() };
          await dbPut('todos', updated);
        }
        successCount++;
      } else if (item.action === 'DELETE_TODO') {
        await del(`/api/todos/${item.data.id}`);
        await deleteFromDB('todos', item.data.id);
        successCount++;
      } else if (item.action === 'CREATE_PROJECT') {
        const res = await post('/api/projects', item.data);
        // Remove temp entry from local DB and projects array
        if (item.data._tempId) {
          await deleteFromDB('projects', item.data._tempId);
          projects = projects.filter(p => p.id !== item.data._tempId);
        }
        await dbPut('projects', res);
        projects.push(res);
        successCount++;
      } else if (item.action === 'DELETE_PROJECT') {
        await del(`/api/projects/${item.data.id}`);
        await deleteFromDB('projects', item.data.id);
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
  if (!isOnlineForSync() || !db) {
    console.log('Offline - using local data');
    return;
  }

  try {
    // 1. Server-Daten holen
    const [todosData, projectsData] = await Promise.all([
      get('/api/todos'),
      get('/api/projects')
    ]);

    const serverTodos = todosData.todos || [];
    const serverProjects = projectsData.projects || [];

    // 2. Merge-Strategie: updated_at Vergleich, Server gewinnt nur wenn neuer
    for (const todo of serverTodos) {
      const localTodo = await getFromDB('todos', todo.id);
      if (!localTodo) {
        await dbPut('todos', todo);
      } else {
        const queue = await dbGetAll('syncQueue');
        const pendingChanges = queue.find(q =>
          q.action === 'UPDATE_TODO' && q.data.id === todo.id
        );
        if (!pendingChanges) {
          const localTime = new Date(localTodo.updated_at || 0).getTime();
          const serverTime = new Date(todo.updated_at || 0).getTime();
          if (serverTime >= localTime) {
            await dbPut('todos', todo);
          }
        }
      }
    }

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

// ─── Online/Offline Detection (WebSocket-basiert) ────────────────────────────

// Use WebSocket connection state instead of browser navigator.onLine
// The old online/offline listeners are kept as fallback only
window.addEventListener('online', async () => {
  console.log('Browser reports online');
  if (wsState === 'disconnected') {
    connectWebSocket();
  }
  // Nur sync (Queue verarbeiten), KEIN refreshFromServer
  // refreshFromServer würde Server-Daten holen und potenziell überschreiben
  await syncWithServer();
});

window.addEventListener('offline', () => {
  console.log('Browser reports offline');
});

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

    if (reg.waiting) {
      console.log('SW: Update waiting from previous session');
      updateAvailable = true;
      showUpdateButton();
    }

    checkForUpdate(reg);
    setInterval(() => checkForUpdate(reg), 30 * 60 * 1000);

    // Sofort checken wenn PWA wieder in Vordergrund kommt
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && swRegistration) {
        console.log('SW: Visibility changed → checking for update');
        checkForUpdate(swRegistration);
      }
    });

    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      console.log('SW: New version found, installing...');

      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed') {
          console.log('SW: New version ready for update');
          updateAvailable = true;
          showUpdateButton();
        }
      });
    });

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
  if (swRegistration && swRegistration.waiting) {
    swRegistration.waiting.postMessage({ action: 'skipWaiting' });
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  console.log('App starting...');

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

  // Start WebSocket connection
  connectWebSocket();

  if (isOnlineForSync()) {
    console.log('Online at startup - syncing...');
    refreshFromServer().catch(err => console.error('Server refresh failed:', err));
  }

  updateConnectionStatus();
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
  if (isOnlineForSync()) {
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
  
  // Build tree structure
  const projectMap = new Map();
  projects.forEach(p => projectMap.set(p.id, { ...p, children: [] }));
  
  const rootProjects = [];
  projectMap.forEach(p => {
    if (p.parent_id === null || p.parent_id === undefined) {
      rootProjects.push(p);
    } else {
      const parent = projectMap.get(p.parent_id);
      if (parent) {
        parent.children.push(p);
      }
    }
  });
  
  // Sort roots by sort_order
  rootProjects.sort((a, b) => a.sort_order - b.sort_order);
  
  // Recursive render function
  function renderProjectTree(project, depth = 0) {
    const indent = depth * 16;
    const hasChildren = project.children && project.children.length > 0;
    
    let html = '';
    html += `<div class="project-tree-item" style="padding-left: ${indent}px">`;
    html += `<div class="nav-item-with-action">`;
    html += `<button class="nav-btn ${currentFilter === String(project.id) ? 'active' : ''}" onclick="setFilter('${project.id}')">`;
    html += `<span class="project-dot" style="background:${project.color}"></span>`;
    html += `${escapeHtml(project.name)}`;
    html += `<span class="badge">${countByProject(project.id, true)}</span>`;
    html += `</button>`;
    html += `<button class="nav-edit" onclick="event.stopPropagation(); editProject(${project.id})" title="Bearbeiten">`;
    html += `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    html += `</button>`;
    html += `</div>`;
    html += `</div>`;
    
    // Render children always (no toggle needed)
    if (hasChildren) {
      project.children.sort((a, b) => a.sort_order - b.sort_order);
      project.children.forEach(child => {
        html += renderProjectTree(child, depth + 1);
      });
    }
    
    return html;
  }
  
  el.innerHTML = rootProjects.map(p => renderProjectTree(p)).join('');
}

// Track expanded state for project tree
let expandedProjects = new Set();

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
  if (currentProjectId) {
    filtered = filtered.filter(t => t.project_id === currentProjectId);
  }
  if (search) {
    filtered = filtered.filter(t =>
      (t.title || '').toLowerCase().includes(search) ||
      (t.description || '').toLowerCase().includes(search)
    );
  }

  if (currentProjectId) {
    let html = '';

    const validSectionIds = new Set(sections.map(s => s.id));

    // Status-Filter für Projekt-Ansicht anwenden (außer "Alle")
    if (currentFilter !== 'all' && ['pending','in_progress','done'].includes(currentFilter)) {
      filtered = filtered.filter(t => t.status === currentFilter);
    }

    for (const section of sections) {
      const sectionTodos = filtered.filter(t => t.section_id === section.id);
      html += renderSectionHeader(section);
      html += `<div class="section-todos" data-section-id="${section.id}" ondragover="handleTodoDragOver(event)" ondrop="handleTodoDrop(event)">`;
      html += sectionTodos.map(t => renderTodoItem(t)).join('');
      html += `</div>`;
    }

    // Verwaiste Todos (gelöschte Section) → Unsortiert
    const unsorted = filtered.filter(t => !t.section_id || !validSectionIds.has(t.section_id));
    if (unsorted.length || sections.length) {
      html += renderSectionHeader(null);
      html += `<div class="section-todos" data-section-id="null" ondragover="handleTodoDragOver(event)" ondrop="handleTodoDrop(event)">`;
      html += unsorted.map(t => renderTodoItem(t)).join('');
      html += `</div>`;
    }

    // ➕ Neue Section Button
    html += `<div class="add-section-row"><button class="btn-add-section" onclick="showAddSectionForm()">➕ Neue Section</button></div>`;

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

  // Auf aktuellen Status-Filter begrenzen (außer "Alle")
  if (currentFilter !== 'all' && groups[currentFilter]) {
    filtered = filtered.filter(t => t.status === currentFilter);
  }

  let html = '';
  for (const [status, title] of Object.entries(groups)) {
    // Nur passende Status-Gruppen anzeigen
    if (currentFilter !== 'all' && currentFilter !== status) continue;
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
      <div class="section-header" data-section-id="${section.id}" draggable="true"
        ondragstart="handleSectionDragStart(event)" ondragend="handleSectionDragEnd(event)"
        ondragover="handleSectionDragOver(event)" ondrop="handleSectionDrop(event)">
        <span class="section-name" onclick="editSectionInline(${section.id})">${escapeHtml(section.name)}</span>
        <span class="section-count">${todos.filter(t => t.section_id === section.id).length}</span>
        <button class="section-delete" onclick="event.stopPropagation(); deleteSection(${section.id})" title="Löschen">✕</button>
      </div>
    `;
  } else {
    const unsortedCount = todos.filter(t => !t.section_id && t.project_id === currentProjectId).length;
    return `
      <div class="section-header section-unsorted" data-section-id="null"
        ondragover="handleSectionDragOver(event)" ondrop="handleSectionDrop(event)">
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
    <div class="todo-item ${t.status === 'done' ? 'done' : ''}" data-id="${t.id}" draggable="true" onclick="editTodo(${t.id})"
      ondragstart="handleTodoDragStart(event)" ondragend="handleTodoDragEnd(event)">
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

  if (isOnlineForSync()) {
    try {
      const data = await get(`/api/projects/${currentProjectId}/sections`);
      const serverSections = data.sections || [];

      // Server-Sections in DB speichern
      for (const s of serverSections) {
        await dbPut('sections', s);
      }

      // Cleanup: gelöschte Sections aus DB entfernen
      const serverIds = new Set(serverSections.map(s => s.id));
      const allLocal = await dbGetAll('sections');
      const localProjectSections = allLocal.filter(s => s.project_id === currentProjectId);
      for (const local of localProjectSections) {
        if (!serverIds.has(local.id)) {
          await deleteFromDB('sections', local.id);
        }
      }

      sections = serverSections;
      return;
    } catch (e) {
      console.error('Failed to load sections from server', e);
    }
  }

  // Fallback: aus lokaler DB laden
  try {
    const allSections = await dbGetAll('sections');
    sections = allSections.filter(s => s.project_id === currentProjectId);
  } catch (e) {
    console.error('Failed to load sections from local DB', e);
  }
}

function countByProject(pid, includeSubprojects = false) {
  if (!includeSubprojects) {
    return todos.filter(t => t.project_id === pid && t.status !== 'done').length;
  }
  
  // Recursively count todos in subprojects
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

  // Immer in Queue (offline-first)
  await addToSyncQueue('UPDATE_TODO', { id, changes: { status: newStatus } });

  // Sofort syncen wenn online
  if (isOnlineForSync()) {
    await syncWithServer();
  }
}

async function showTodoModal(todo = null) {
  document.getElementById('todo-form')?.reset();
  document.getElementById('todo-id').value = '';
  document.getElementById('todo-modal-title').textContent = todo ? 'Todo bearbeiten' : 'Neues Todo';

  const projSelect = document.getElementById('todo-project');
  if (projSelect) {
    // Build tree structure for dropdown (same as project modal)
    projSelect.innerHTML = '';
    
    const projectMap = new Map();
    projects.forEach(p => projectMap.set(p.id, { ...p, children: [] }));
    
    const rootProjects = [];
    projectMap.forEach(p => {
      if (p.parent_id === null || p.parent_id === undefined) {
        rootProjects.push(p);
      } else {
        const parent = projectMap.get(p.parent_id);
        if (parent) {
          parent.children.push(p);
        }
      }
    });
    
    rootProjects.sort((a, b) => a.sort_order - b.sort_order);
    
    // Recursive function to add options with indentation
    function addProjectOptions(projectNode, depth = 0) {
      const indent = '\u00A0'.repeat(depth * 2) + (depth > 0 ? '└─ ' : '');
      const opt = document.createElement('option');
      opt.value = projectNode.id;
      opt.style.color = projectNode.color;
      opt.textContent = indent + projectNode.name;
      projSelect.appendChild(opt);
      
      if (projectNode.children && projectNode.children.length > 0) {
        projectNode.children.sort((a, b) => a.sort_order - b.sort_order);
        projectNode.children.forEach(child => addProjectOptions(child, depth + 1));
      }
    }
    
    rootProjects.forEach(p => addProjectOptions(p));
  }

  if (todo) {
    document.getElementById('todo-id').value = todo.id;
    document.getElementById('todo-title').value = todo.title;
    document.getElementById('todo-desc').value = todo.description || '';
    document.getElementById('todo-priority').value = todo.priority;
    document.getElementById('todo-status').value = todo.status;
    document.getElementById('todo-project').value = todo.project_id || '';
    await onProjectChange(todo.section_id); // ← Sections laden UND Section vorauswählen

    if (todo.due_date) {
      document.getElementById('todo-due').value = new Date(todo.due_date).toISOString().slice(0, 16);
    }
  }

  document.getElementById('todo-delete-btn').style.display = todo ? '' : 'none';

  document.getElementById('todo-modal')?.classList.add('active');
}

async function onProjectChange(selectedSectionId = null) {
  const projectId = document.getElementById('todo-project').value;
  const sectionSelect = document.getElementById('todo-section');
  if (!sectionSelect) return;

  sectionSelect.innerHTML = '<option value="">Keine Section (Unsortiert)</option>';
  sectionSelect.disabled = true;

  if (!projectId) return;

  try {
    let projectSections;
    if (isOnlineForSync()) {
      const data = await get(`/api/projects/${projectId}/sections`);
      projectSections = data.sections || [];
      // Cleanup DB: gelöschte Sections entfernen
      const serverIds = new Set(projectSections.map(s => s.id));
      const allLocal = await dbGetAll('sections');
      const localProjectSections = allLocal.filter(s => s.project_id === parseInt(projectId));
      for (const local of localProjectSections) {
        if (!serverIds.has(local.id)) {
          await deleteFromDB('sections', local.id);
        }
      }
      for (const s of projectSections) {
        await dbPut('sections', s);
      }
    } else {
      const allSections = await dbGetAll('sections');
      projectSections = allSections.filter(s => s.project_id === parseInt(projectId));
    }

    for (const s of projectSections) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      sectionSelect.appendChild(opt);
    }
    sectionSelect.disabled = false;

    if (selectedSectionId !== null) {
      sectionSelect.value = selectedSectionId;
    }
  } catch (e) {
    console.error('Failed to load sections for project', e);
  }
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
    section_id: document.getElementById('todo-section').value ? parseInt(document.getElementById('todo-section').value) : null,
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

      // Immer Queue (offline-first)
      await addToSyncQueue('UPDATE_TODO', { id: parseInt(id), changes: todoData });
      if (isOnlineForSync()) {
        await syncWithServer();
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

    // Render immediately for instant feedback (user sees temp todo)
    renderProjects();
    renderStats();
    renderTodos();
    closeModal('todo-modal');

    // Sync in background - will replace temp with real todo
    await addToSyncQueue('CREATE_TODO', { ...todoData, _tempId: tempId });
    if (isOnlineForSync()) {
      await syncWithServer();
    }
    // No re-render needed - todo_create handler will update UI
  }

  // Only render here for updates (create already rendered above)
  if (id) {
    renderProjects();
    renderStats();
    renderTodos();
    closeModal('todo-modal');
  }
}

function editTodo(id) {
  const todo = todos.find(t => t.id === id);
  if (todo) showTodoModal(todo);
}

function deleteTodoFromModal() {
  const id = document.getElementById('todo-id').value;
  if (id) deleteTodo(parseInt(id));
}

async function deleteTodo(id) {
  if (!confirm('Todo wirklich löschen?')) return;

  await deleteFromDB('todos', id);
  todos = todos.filter(t => t.id !== id);
  renderStats();
  renderTodos();
  closeModal('todo-modal');

  // Immer Queue (offline-first)
  await addToSyncQueue('DELETE_TODO', { id });
  if (isOnlineForSync()) {
    await syncWithServer();
  }
}

function showProjectModal(project = null, parentId = null) {
  document.getElementById('project-form')?.reset();
  document.getElementById('project-id').value = '';
  document.getElementById('project-modal-title').textContent = project ? 'Projekt bearbeiten' : (parentId ? 'Neues Subproject' : 'Neues Projekt');

  const parentSelect = document.getElementById('project-parent-id');
  if (parentSelect) {
    parentSelect.innerHTML = '<option value="">-- Kein Eltern-Projekt --</option>';
    
    // Step 1: Create ALL nodes first (without children arrays)
    const projectMap = new Map();
    projects.forEach(p => {
      projectMap.set(p.id, { id: p.id, name: p.name, parent_id: p.parent_id, sort_order: p.sort_order, color: p.color });
    });
    
    // Step 2: Add children arrays to all nodes
    projectMap.forEach(p => {
      p.children = [];
    });
    
    // Step 3: NOW assign children to parents (all parents exist now!)
    const rootProjects = [];
    projectMap.forEach(p => {
      if (p.parent_id === null || p.parent_id === undefined) {
        rootProjects.push(p);
      } else {
        const parent = projectMap.get(p.parent_id);
        if (parent) {
          parent.children.push(p);
        }
      }
    });
    
    rootProjects.sort((a, b) => a.sort_order - b.sort_order);
    
    // Recursive function
    function addProjectOptions(projectNode, depth = 0) {
      // Skip current project being edited (can't be own parent)
      if (project && projectNode.id === project.id) return;
      
      // FIX: \u00A0 = Non-Breaking Space, wird in <option> nicht kollabiert
      const indent = '\u00A0'.repeat(depth * 2) + (depth > 0 ? '└─ ' : '');
      const option = document.createElement('option');
      option.value = projectNode.id;
      option.textContent = indent + projectNode.name;
      parentSelect.appendChild(option);
      
      if (projectNode.children && projectNode.children.length > 0) {
        projectNode.children.sort((a, b) => a.sort_order - b.sort_order);
        projectNode.children.forEach(child => addProjectOptions(child, depth + 1));
      }
    }
    
    rootProjects.forEach(p => addProjectOptions(p));
    
    parentSelect.value = parentId || (project ? project.parent_id : '') || '';
  }

  if (project) {
    document.getElementById('project-id').value = project.id;
    document.getElementById('project-name').value = project.name;
    document.getElementById('project-color').value = project.color;
    if (parentSelect) parentSelect.value = project.parent_id || '';
  }

  document.getElementById('project-delete-btn').style.display = project ? '' : 'none';
  document.getElementById('project-modal')?.classList.add('active');
}

function editProject(id) {
  const project = projects.find(p => p.id === id);
  if (project) showProjectModal(project);
}

async function saveProject(event) {
  event.preventDefault();

  const id = document.getElementById('project-id').value;
  const parentIdVal = document.getElementById('project-parent-id')?.value;
  const projectData = {
    name: document.getElementById('project-name').value,
    color: document.getElementById('project-color').value,
    sort_order: projects.length,
    parent_id: parentIdVal ? parseInt(parentIdVal) : null
  };

  if (id) {
    // Update
    const existing = projects.find(p => p.id === parseInt(id));
    if (existing) {
      const updated = { ...existing, ...projectData, updated_at: new Date().toISOString() };
      await dbPut('projects', updated);
      projects = projects.map(p => p.id === parseInt(id) ? updated : p);
      await addToSyncQueue('UPDATE_PROJECT', { id: parseInt(id), changes: projectData });
      if (isOnlineForSync()) await syncWithServer();
      closeModal('project-modal');
      renderProjects();
    }
  } else {
    // Create
    const tempId = 'temp-project-' + Date.now();
    const newProject = { id: tempId, ...projectData, created_at: new Date().toISOString() };
    await dbPut('projects', newProject);
    projects.push(newProject);
    await addToSyncQueue('CREATE_PROJECT', { ...projectData, _tempId: tempId });
    if (isOnlineForSync()) await syncWithServer();
    closeModal('project-modal');
    renderProjects();
  }
}

async function deleteProject(id) {
  if (!confirm('Projekt wirklich löschen?')) return;

  await deleteFromDB('projects', id);
  projects = projects.filter(p => p.id !== id);
  renderProjects();
  renderStats();
  closeModal('project-modal');

  // Verschiebe Todos zu Default-Projekt
  for (const t of todos) {
    if (t.project_id === id) {
      t.project_id = 1;
      t.section_id = null;
      await dbPut('todos', t);
      await addToSyncQueue('UPDATE_TODO', { id: t.id, changes: { project_id: 1, section_id: null } });
    }
  }

  await addToSyncQueue('DELETE_PROJECT', { id });
  if (isOnlineForSync()) await syncWithServer();
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

// ─── Section CRUD ────────────────────────────────────────────────────────────

function showAddSectionForm() {
  const el = document.querySelector('.add-section-row');
  if (!el) return;
  el.innerHTML = `
    <div class="inline-section-form">
      <input type="text" id="new-section-name" placeholder="Section-Name" autocomplete="off"
        onkeydown="if(event.key==='Enter')saveNewSection();if(event.key==='Escape')renderTodos();">
      <button onclick="saveNewSection()" title="Speichern">✓</button>
      <button onclick="renderTodos()" title="Abbrechen">✕</button>
    </div>
  `;
  document.getElementById('new-section-name')?.focus();
}

async function saveNewSection() {
  const name = document.getElementById('new-section-name')?.value?.trim();
  if (!name || !currentProjectId) return;

  const sectionData = { name, project_id: currentProjectId, sort_order: sections.length };

  if (isOnlineForSync()) {
    try {
      const res = await post(`/api/projects/${currentProjectId}/sections`, sectionData);
      await dbPut('sections', res);
      sections.push(res);
      renderTodos();
    } catch (err) {
      console.error('Create section failed', err);
      alert('Fehler beim Erstellen der Section');
    }
  } else {
    alert('Offline - Section kann nicht erstellt werden');
  }
}

function editSectionInline(id) {
  const section = sections.find(s => s.id === id);
  if (!section) return;

  const header = document.querySelector(`.section-header[data-section-id="${id}"]`);
  if (!header) return;

  header.innerHTML = `
    <div class="inline-edit-form" style="flex:1;gap:6px;">
      <input type="text" id="edit-section-name-${id}" value="${escapeHtml(section.name)}" autocomplete="off" style="flex:1;"
        onkeydown="if(event.key==='Enter')saveSectionEdit(${id});if(event.key==='Escape')renderTodos();">
      <button onclick="saveSectionEdit(${id})" title="Speichern">✓</button>
      <button onclick="renderTodos()" title="Abbrechen">✕</button>
    </div>
  `;
  document.getElementById(`edit-section-name-${id}`)?.focus();
}

async function saveSectionEdit(id) {
  const name = document.getElementById(`edit-section-name-${id}`)?.value?.trim();
  if (!name) return;

  if (isOnlineForSync()) {
    try {
      await patch(`/api/sections/${id}`, { name });
      const section = sections.find(s => s.id === id);
      if (section) section.name = name;
      renderTodos();
    } catch (err) {
      console.error('Update section failed', err);
      alert('Fehler beim Speichern');
    }
  } else {
    alert('Offline - Section kann nicht bearbeitet werden');
  }
}

async function deleteSection(id) {
  if (!confirm('Section wirklich löschen? Todos werden zu "Unsortiert" verschoben.')) return;

  if (isOnlineForSync()) {
    try {
      await del(`/api/sections/${id}`);
      sections = sections.filter(s => s.id !== id);
      await deleteFromDB('sections', id); // ← Auch aus IndexedDB entfernen
      for (const t of todos) {
        if (t.section_id === id) t.section_id = null;
      }
      renderTodos();
    } catch (err) {
      console.error('Delete section failed', err);
      alert('Fehler beim Löschen');
    }
  } else {
    alert('Offline - Section kann nicht gelöscht werden');
  }
}

// ─── Drag & Drop ─────────────────────────────────────────────────────────────

function handleTodoDragStart(e) {
  dragSrcTodoId = parseInt(e.target.dataset.id);
  e.target.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'todo:' + dragSrcTodoId);
}

function handleTodoDragEnd(e) {
  e.target.classList.remove('dragging');
  document.querySelectorAll('.section-todos.drag-over, .section-header.drag-over').forEach(el => {
    el.classList.remove('drag-over');
  });
  dragSrcTodoId = null;
}

function handleTodoDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const container = e.target.closest('.section-todos');
  if (container) container.classList.add('drag-over');
}

async function handleTodoDrop(e) {
  e.preventDefault();
  const container = e.target.closest('.section-todos');
  if (!container) return;
  container.classList.remove('drag-over');

  const targetSectionId = container.dataset.sectionId;
  if (!dragSrcTodoId) return;

  const todo = todos.find(t => t.id === dragSrcTodoId);
  if (!todo) return;

  const newSectionId = targetSectionId === 'null' ? null : parseInt(targetSectionId);
  if (todo.section_id === newSectionId) return;

  todo.section_id = newSectionId;
  renderTodos();

  if (isOnlineForSync()) {
    try {
      await patch(`/api/todos/${todo.id}`, { section_id: newSectionId });
    } catch (err) {
      console.error('Move todo failed', err);
    }
  }
}

function handleSectionDragStart(e) {
  dragSrcSectionId = parseInt(e.target.dataset.sectionId);
  e.target.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'section:' + dragSrcSectionId);
}

function handleSectionDragEnd(e) {
  e.target.classList.remove('dragging');
  document.querySelectorAll('.section-header.drag-over').forEach(el => el.classList.remove('drag-over'));
  dragSrcSectionId = null;
}

function handleSectionDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const header = e.target.closest('.section-header');
  if (header) header.classList.add('drag-over');
}

async function handleSectionDrop(e) {
  e.preventDefault();
  const header = e.target.closest('.section-header');
  if (!header) return;
  header.classList.remove('drag-over');

  const targetSectionId = header.dataset.sectionId;

  // ── Handle TODO drop on section header ──
  if (dragSrcTodoId) {
    const todo = todos.find(t => t.id === dragSrcTodoId);
    if (!todo) return;
    const newSectionId = targetSectionId === 'null' ? null : parseInt(targetSectionId);
    if (todo.section_id === newSectionId) return;
    todo.section_id = newSectionId;
    renderTodos();
    if (isOnlineForSync()) {
      try {
        await patch(`/api/todos/${todo.id}`, { section_id: newSectionId });
      } catch (err) {
        console.error('Move todo failed', err);
      }
    }
    return;
  }

  // ── Handle SECTION reorder ──
  if (targetSectionId === 'null' || !dragSrcSectionId || dragSrcSectionId === parseInt(targetSectionId)) return;

  const srcIdx = sections.findIndex(s => s.id === dragSrcSectionId);
  const targetIdx = sections.findIndex(s => s.id === parseInt(targetSectionId));
  if (srcIdx === -1 || targetIdx === -1) return;

  const [moved] = sections.splice(srcIdx, 1);
  sections.splice(targetIdx, 0, moved);

  // Update sort_order
  for (let i = 0; i < sections.length; i++) {
    sections[i].sort_order = i;
    if (isOnlineForSync()) {
      try {
        await patch(`/api/sections/${sections[i].id}`, { sort_order: i });
      } catch (err) {
        console.error('Sort section failed', err);
      }
    }
  }

  renderTodos();
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
