// nia-todo: Frontend app mit Offline-First PWA + WebSocket Echtzeit-Sync
import { APP_VERSION, WS_URL } from './core/config.js';
import { escapeHtml, escapeHtmlAttr, formatDate, jsArg, renderMarkdown, truncateWords } from './core/utils.js';
import { authApi, projectsApi, pushApi, sectionsApi, todosApi } from './api/index.js';
import * as indexedDb from './storage/indexed-db.js';
import * as syncQueue from './sync/queue.js';
import { createApiKeysFeature } from './features/api-keys.js';
import { createPushNotificationsFeature } from './features/push-notifications.js';
import { createServiceWorkerUpdatesFeature } from './features/service-worker-updates.js';
import { applyTheme, bindSystemThemeListener, cycleTheme, initTheme, setTheme } from './features/theme.js';
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
let hideDone = localStorage.getItem('nia-hide-done') === 'true';
let sortMode = localStorage.getItem('nia-sort') || 'order';
let undoAction = null;
let undoTimer = null;
let pendingUndoBatch = null; // For batch operations like clear-done

// ─── Auth / User (JWT) ───────────────────────────────────────────────────────

let currentUser = null;  // { id, username, display_name, token }
const apiKeysFeature = createApiKeysFeature({ authApi });
const pushFeature = createPushNotificationsFeature({ pushApi });
const serviceWorkerUpdates = createServiceWorkerUpdatesFeature({ onMarkTodoDone: markTodoDone });

function getAuthToken() {
  // Prefer JWT, fallback to legacy session token
  return localStorage.getItem('jwt_token') || localStorage.getItem('auth_token');
}

function getCsrfToken() {
  return localStorage.getItem('csrf_token');
}

function getAuthHeaders() {
  const token = getAuthToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    // New JWT tokens contain a dot (JWT signature separator)
    if (token.includes('.')) {
      headers['Authorization'] = 'Bearer ' + token;
    } else {
      // Legacy session token
      headers['X-Session-Token'] = token;
    }
  }
  // Add CSRF token for state-changing requests
  const csrf = getCsrfToken();
  if (csrf) {
    headers['X-CSRF-Token'] = csrf;
  }
  return headers;
}

async function login(username, password) {
  const data = await authApi.login(username, password);
  currentUser = data.user;
  currentUser.token = data.access_token;
  localStorage.setItem('jwt_token', data.access_token);
  // Store CSRF token for Double-Submit Cookie pattern
  if (data.csrf_token) {
    localStorage.setItem('csrf_token', data.csrf_token);
  }
  
  // Check if user changed - if so, clear cache
  const lastUserId = localStorage.getItem('last_user_id');
  const newUserId = String(data.user.id);
  if (lastUserId && lastUserId !== newUserId) {
    console.log('User changed from', lastUserId, 'to', newUserId, '- clearing cache');
    await clearIndexedDB();
  }
  localStorage.setItem('last_user_id', newUserId);
  
  return data;
}

async function checkAuth() {
  const token = getAuthToken();
  if (!token) return false;
  try {
    const user = await authApi.me();
    currentUser = user;
    currentUser.token = token;
    
    // Check if user changed - if so, clear cache and reload
    const lastUserId = localStorage.getItem('last_user_id');
    const newUserId = String(user.id);
    if (lastUserId && lastUserId !== newUserId) {
      console.log('User changed from', lastUserId, 'to', newUserId, '- clearing cache');
      await clearIndexedDB();
      localStorage.setItem('last_user_id', newUserId);
      location.reload();
      return false;
    }
    localStorage.setItem('last_user_id', newUserId);
    
    return true;
  } catch (e) {
    return false;
  }
}

async function logout() {
  try {
    const token = getAuthToken();
    if (token) {
      await authApi.logout();
    }
  } catch (e) {
    // Ignore errors
  }
  currentUser = null;
  localStorage.removeItem('jwt_token');
  localStorage.removeItem('auth_token');
  localStorage.removeItem('last_user_id');
  localStorage.removeItem('csrf_token');
  
  // Clear IndexedDB cache to prevent data leaking between users
  await clearIndexedDB();
  
  location.reload();
}

async function clearIndexedDB() {
  await indexedDb.closeAndDeleteDatabase();
  db = null;
}

function showLoginOverlay() {
  document.getElementById('login-overlay').classList.remove('hidden');
}

function hideLoginOverlay() {
  document.getElementById('login-overlay').classList.add('hidden');
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';

  try {
    await login(username, password);
    hideLoginOverlay();
    renderUserInfo();
    // Initialize app if not already done
    if (!appInitialized) {
      await initApp();
    }
    // Reload data for this user
    await refreshFromServer();
  } catch (err) {
    errorEl.textContent = err.message || 'Login fehlgeschlagen';
  }
}

function renderUserInfo() {
  const nameEl = document.getElementById('user-name');
  const settingsNameEl = document.getElementById('settings-user-name');
  if (nameEl && currentUser) {
    nameEl.textContent = currentUser.display_name || currentUser.username;
  }
  if (settingsNameEl && currentUser) {
    settingsNameEl.textContent = currentUser.display_name || currentUser.username;
  }
  // Admin link removed - accessible only via direct URL
}

function openSettingsModal() {
  document.getElementById('settings-old-password').value = '';
  document.getElementById('settings-new-password').value = '';
  document.getElementById('settings-confirm-password').value = '';
  document.getElementById('settings-pw-error').textContent = '';
  document.getElementById('settings-pw-success').textContent = '';
  // Reset API key UI
  resetApiKeyUi();
  document.getElementById('settings-modal')?.classList.add('active');
  loadApiKeys();
  updatePushSettingsUI();
}

async function changeUserPassword() {
  const oldPw = document.getElementById('settings-old-password').value;
  const newPw = document.getElementById('settings-new-password').value;
  const confirmPw = document.getElementById('settings-confirm-password').value;

  document.getElementById('settings-pw-error').textContent = '';
  document.getElementById('settings-pw-success').textContent = '';

  if (!oldPw || !newPw || !confirmPw) {
    document.getElementById('settings-pw-error').textContent = 'Alle Felder sind erforderlich';
    return;
  }
  if (newPw !== confirmPw) {
    document.getElementById('settings-pw-error').textContent = 'Passwörter stimmen nicht überein';
    return;
  }

  try {
    await authApi.changePassword(oldPw, newPw);
    document.getElementById('settings-pw-success').textContent = 'Passwort geändert! Du wirst abgemeldet...';
    setTimeout(() => logout(), 1500);
  } catch(e) {
    document.getElementById('settings-pw-error').textContent = e.message;
  }
}

// ─── API Keys ────────────────────────────────────────────────────────────────

const resetApiKeyUi = apiKeysFeature.resetApiKeyUi;
const loadApiKeys = apiKeysFeature.loadApiKeys;
const renderApiKeys = apiKeysFeature.renderApiKeys;
const createApiKey = apiKeysFeature.createApiKey;
const revokeApiKey = apiKeysFeature.revokeApiKey;
const copyApiKey = apiKeysFeature.copyApiKey;

// ─── Theme System ───────────────────────────────────────────────────────────

bindSystemThemeListener();

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
    const token = getAuthToken();
    const wsUrl = WS_URL;
    ws = new WebSocket(wsUrl);

    ws.onopen = async () => {
      console.log('[WS] ✅ Connected');
      wsState = 'connected';
      reconnectAttempts = 0;
      updateConnectionStatus();

      // Send auth token as first message
      const token = getAuthToken();
      if (token) {
        wsSend({ type: 'auth', token: token });
      }

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

  if (wsState === 'connected') {
    indicator.style.display = 'none';
    indicator.className = 'status-online';
  } else {
    indicator.style.display = 'inline-block';
    indicator.className = 'status-offline';
    indicator.textContent = '';
  }
}

async function handleWsMessage(msg) {
  switch (msg.type) {
    case 'auth_ok':
      break;
    case 'auth_fail':
      console.warn('[WS] Auth failed');
      break;
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
            const queue = await dbGetAll('syncQueue');
            const pendingChanges = queue.find(q =>
              q.action === 'UPDATE_TODO' && q.data.id === todo.id
            );
            if (!pendingChanges) {
              const localTime = new Date(local.updated_at || 0).getTime();
              const serverTime = new Date(todo.updated_at || 0).getTime();
              if (serverTime >= localTime) {
                await dbPut('todos', todo);
              }
            }
          }
        }
        todos = await dbGetAll('todos');
      }
      if (msg.projects) {
        for (const project of msg.projects) {
          const local = await getFromDB('projects', project.id);
          if (!local) {
            await dbPut('projects', project);
          } else {
            const queue = await dbGetAll('syncQueue');
            const pendingChanges = queue.find(q =>
              q.action === 'UPDATE_PROJECT' && q.data.id === project.id
            );
            if (!pendingChanges) {
              const localTime = new Date(local.updated_at || 0).getTime();
              const serverTime = new Date(project.updated_at || 0).getTime();
              if (serverTime >= localTime) {
                await dbPut('projects', project);
              }
            }
          }
        }
        projects = await dbGetAll('projects');
      }
      if (msg.sections) {
        for (const section of msg.sections) {
          const local = await getFromDB('sections', section.id);
          if (!local) {
            await dbPut('sections', section);
          } else {
            const queue = await dbGetAll('syncQueue');
            const pendingChanges = queue.find(q =>
              q.action === 'UPDATE_SECTION' && q.data.id === section.id
            );
            if (!pendingChanges) {
              const localTime = new Date(local.updated_at || 0).getTime();
              const serverTime = new Date(section.updated_at || 0).getTime();
              if (serverTime >= localTime) {
                await dbPut('sections', section);
              }
            }
          }
        }
        sections = await dbGetAll('sections');
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
          // Only add if not already present (avoids race with syncWithServer)
          const alreadyAdded = todos.find(t => t.id === msg.payload.id);
          if (!alreadyAdded) todos.push(msg.payload);
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
        // Remove temp project with same name to avoid duplicates
        const tempProject = projects.find(p =>
          p.name === msg.payload.name &&
          String(p.id).startsWith('temp-')
        );
        if (tempProject) {
          projects = projects.filter(p => p.id !== tempProject.id);
        }
        const existing = projects.find(p => p.id === msg.payload.id);
        if (existing) {
          // Server response for our create → replace temp entry
          projects = projects.map(p => p.id === msg.payload.id ? msg.payload : p);
        } else {
          // Broadcast from another client → add to list
          projects.push(msg.payload);
        }
        renderProjects();
        renderStats();
        renderTodos();
      }
      break;
    case 'project_update':
      if (msg.payload) {
        const local = await getFromDB('projects', msg.payload.id);
        if (local) {
          const localTime = new Date(local.updated_at || 0).getTime();
          const serverTime = new Date(msg.payload.updated_at || 0).getTime();
          if (serverTime >= localTime) {
            await dbPut('projects', msg.payload);
            projects = projects.map(p => p.id === msg.payload.id ? msg.payload : p);
            renderProjects();
            renderStats();
            renderTodos();
          }
        } else {
          await dbPut('projects', msg.payload);
          projects = projects.map(p => p.id === msg.payload.id ? msg.payload : p);
          renderProjects();
          renderStats();
          renderTodos();
        }
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
    case 'section_create':
      if (msg.payload) {
        await dbPut('sections', msg.payload);
        // Remove temp section with same name+project to avoid duplicates
        const tempSection = sections.find(s =>
          s.name === msg.payload.name &&
          s.project_id === msg.payload.project_id &&
          String(s.id).startsWith('temp-')
        );
        if (tempSection) {
          sections = sections.filter(s => s.id !== tempSection.id);
        }
        const existing = sections.find(s => s.id === msg.payload.id);
        if (!existing) {
          sections.push(msg.payload);
        } else {
          sections = sections.map(s => s.id === msg.payload.id ? msg.payload : s);
        }
        renderTodos();
      }
      break;
    case 'section_update':
      if (msg.payload) {
        const local = await getFromDB('sections', msg.payload.id);
        if (local) {
          const localTime = new Date(local.updated_at || 0).getTime();
          const serverTime = new Date(msg.payload.updated_at || 0).getTime();
          if (serverTime >= localTime) {
            await dbPut('sections', msg.payload);
            sections = sections.map(s => s.id === msg.payload.id ? msg.payload : s);
            renderTodos();
          }
        } else {
          await dbPut('sections', msg.payload);
          sections = sections.map(s => s.id === msg.payload.id ? msg.payload : s);
          renderTodos();
        }
      }
      break;
    case 'section_delete':
      if (msg.payload?.id) {
        await deleteFromDB('sections', msg.payload.id);
        sections = sections.filter(s => s.id !== msg.payload.id);
        // Move todos in this section to unsorted
        for (const todo of todos) {
          if (todo.section_id === msg.payload.id) {
            todo.section_id = null;
            await dbPut('todos', todo);
          }
        }
        renderTodos();
      }
      break;
    default:
      console.log('WS: unknown message type', msg.type);
  }
}

// ─── IndexedDB ───────────────────────────────────────────────────────────────

async function openDB() {
  db = await indexedDb.openDatabase();
  return db;
}

function dbGetAll(storeName) {
  return indexedDb.getAll(storeName);
}

function dbPut(storeName, item) {
  return indexedDb.put(storeName, item);
}

function dbClear(storeName) {
  return indexedDb.clear(storeName);
}

function getFromDB(storeName, id) {
  return indexedDb.get(storeName, id);
}

function deleteFromDB(storeName, id) {
  return indexedDb.remove(storeName, id);
}

async function clearSyncQueue() {
  await syncQueue.clearQueue();
}

function addToSyncQueue(action, data) {
  return syncQueue.enqueue(action, data);
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
        const res = await todosApi.create(item.data);
        // Remove temp entry from local DB and todos array
        if (item.data._tempId) {
          await deleteFromDB('todos', item.data._tempId);
          todos = todos.filter(t => t.id !== item.data._tempId);
        }
        await dbPut('todos', res);
        // Only add if not already in array (avoids race with broadcast)
        const alreadyInArray = todos.find(t => t.id === res.id);
        if (!alreadyInArray) todos.push(res);
        successCount++;
      } else if (item.action === 'UPDATE_TODO') {
        try {
          await todosApi.update(item.data.id, item.data.changes);
          const localTodo = await getFromDB('todos', item.data.id);
          if (localTodo) {
            const updated = { ...localTodo, ...item.data.changes, updated_at: new Date().toISOString() };
            await dbPut('todos', updated);
          }
          successCount++;
        } catch (err) {
          if (err.message && err.message.includes('404')) {
            console.warn('Todo', item.data.id, 'not found on server, skipping');
          } else {
            throw err;
          }
        }
      } else if (item.action === 'DELETE_TODO') {
        try {
          await todosApi.delete(item.data.id);
          await deleteFromDB('todos', item.data.id);
          successCount++;
        } catch (err) {
          if (err.message && err.message.includes('404')) {
            console.warn('Todo', item.data.id, 'already deleted, skipping');
          } else {
            throw err;
          }
        }
      } else if (item.action === 'CREATE_PROJECT') {
        const res = await projectsApi.create(item.data);
        // Remove temp entry from local DB and projects array
        if (item.data._tempId) {
          await deleteFromDB('projects', item.data._tempId);
          projects = projects.filter(p => p.id !== item.data._tempId);
        }
        await dbPut('projects', res);
        // Only add if not already in array (avoids race with broadcast)
        const alreadyInArray = projects.find(p => p.id === res.id);
        if (!alreadyInArray) projects.push(res);
        successCount++;
      } else if (item.action === 'DELETE_PROJECT') {
        try {
          await projectsApi.delete(item.data.id);
          await deleteFromDB('projects', item.data.id);
          successCount++;
        } catch (err) {
          if (err.message && err.message.includes('404')) {
            console.warn('Project', item.data.id, 'already deleted, skipping');
          } else {
            throw err;
          }
        }
      } else if (item.action === 'UPDATE_PROJECT') {
        try {
          await projectsApi.update(item.data.id, item.data.changes);
          const localProject = await getFromDB('projects', item.data.id);
          if (localProject) {
            const updated = { ...localProject, ...item.data.changes, updated_at: new Date().toISOString() };
            await dbPut('projects', updated);
          }
          successCount++;
        } catch (err) {
          if (err.message && err.message.includes('404')) {
            console.warn('Project', item.data.id, 'not found on server, skipping');
          } else {
            throw err;
          }
        }
      } else if (item.action === 'CREATE_SECTION') {
        const res = await sectionsApi.create(item.data.project_id, item.data);
        if (item.data._tempId) {
          await deleteFromDB('sections', item.data._tempId);
          sections = sections.filter(s => s.id !== item.data._tempId);
        }
        await dbPut('sections', res);
        // Only add if not already in array (avoids race with broadcast)
        const alreadyInArray = sections.find(s => s.id === res.id);
        if (!alreadyInArray) sections.push(res);
        successCount++;
      } else if (item.action === 'UPDATE_SECTION') {
        try {
          await sectionsApi.update(item.data.id, item.data.changes);
          const localSection = await getFromDB('sections', item.data.id);
          if (localSection) {
            const updated = { ...localSection, ...item.data.changes, updated_at: new Date().toISOString() };
            await dbPut('sections', updated);
          }
          successCount++;
        } catch (err) {
          if (err.message && err.message.includes('404')) {
            console.warn('Section', item.data.id, 'not found on server, skipping');
          } else {
            throw err;
          }
        }
      } else if (item.action === 'DELETE_SECTION') {
        try {
          await sectionsApi.delete(item.data.id);
          await deleteFromDB('sections', item.data.id);
          successCount++;
        } catch (err) {
          if (err.message && err.message.includes('404')) {
            console.warn('Section', item.data.id, 'already deleted, skipping');
          } else {
            throw err;
          }
        }
      }

      // Erfolgreich synched → aus Queue entfernen
      await deleteFromDB('syncQueue', item.id);
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
    const [todosData, projectsData, sectionsData] = await Promise.all([
      todosApi.list(),
      projectsApi.list(),
      sectionsApi.listAll()
    ]);

    const serverTodos = todosData.todos || [];
    const serverProjects = projectsData.projects || [];
    const serverSections = sectionsData.sections || [];

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

    // 3. Projekte mergen: Server gewinnt nur wenn neuer ODER keine pending changes
    for (const project of serverProjects) {
      const localProject = await getFromDB('projects', project.id);
      if (!localProject) {
        await dbPut('projects', project);
      } else {
        const queue = await dbGetAll('syncQueue');
        const pendingChanges = queue.find(q =>
          q.action === 'UPDATE_PROJECT' && q.data.id === project.id
        );
        if (!pendingChanges) {
          const localTime = new Date(localProject.updated_at || 0).getTime();
          const serverTime = new Date(project.updated_at || 0).getTime();
          if (serverTime >= localTime) {
            await dbPut('projects', project);
          }
        }
      }
    }

    // 4. Sections mergen
    for (const section of serverSections) {
      const localSection = await getFromDB('sections', section.id);
      if (!localSection) {
        await dbPut('sections', section);
      } else {
        const queue = await dbGetAll('syncQueue');
        const pendingChanges = queue.find(q =>
          q.action === 'UPDATE_SECTION' && q.data.id === section.id
        );
        if (!pendingChanges) {
          const localTime = new Date(localSection.updated_at || 0).getTime();
          const serverTime = new Date(section.updated_at || 0).getTime();
          if (serverTime >= localTime) {
            await dbPut('sections', section);
          }
        }
      }
    }

    // 5. Lokale Daten neu laden
    todos = await dbGetAll('todos');
    projects = await dbGetAll('projects');
    sections = await dbGetAll('sections');

    renderProjects();
    renderStats();
    renderTodos();

    console.log('Refreshed from server:', todos.length, 'todos', projects.length, 'projects', sections.length, 'sections');
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

const initServiceWorker = serviceWorkerUpdates.initServiceWorker;
const triggerUpdate = serviceWorkerUpdates.triggerUpdate;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  console.log('App starting...');

  // Initialize theme BEFORE auth check so login overlay has correct theme
  initTheme();

  // Check setup status first
  try {
    const setupData = await authApi.setupStatus();
    if (!setupData.setup_complete) {
      window.location.href = '/setup';
      return;
    }
  } catch (e) {
    console.log('Setup check failed, continuing');
  }

  // Auth check
  const authed = await checkAuth();
  if (authed) {
    hideLoginOverlay();
    renderUserInfo();
    await initApp();
  } else {
    showLoginOverlay();
  }
});

async function initApp() {
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

  // Restore last filter from localStorage AFTER data is loaded
  const savedFilter = localStorage.getItem('nia-last-filter');
  if (savedFilter) {
    currentFilter = savedFilter;
    if (!['all','pending','in_progress','done'].includes(savedFilter)) {
      currentProjectId = parseInt(savedFilter);
    }
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
  updateToggleDoneButton();
  updateSortButton();

  initTheme();

  console.log('App initialized');
}

function renderVersionInfo() {
  const el = document.getElementById('version-info');
  if (el) {
    el.textContent = APP_VERSION;
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
  
  // Sort roots: Inbox first, then alphabetisch
  rootProjects.sort((a, b) => {
    if (a.id === 1) return -1;
    if (b.id === 1) return 1;
    return a.name.localeCompare(b.name);
  });
  
  // Recursive render function
  function renderProjectTree(project, depth = 0) {
    const indent = depth * 16;
    const hasChildren = project.children && project.children.length > 0;
    
    let html = '';
    html += `<div class="project-tree-item" style="padding-left: ${indent}px">`;
    html += `<div class="nav-item-with-action">`;
    html += `<button class="nav-btn ${currentFilter === String(project.id) ? 'active' : ''}" onclick="setFilter('${project.id}')">`;
    html += `<span class="project-dot" style="background:${escapeHtmlAttr(project.color)}"></span>`;
    html += `${escapeHtml(project.name)}`;
    html += `<span class="badge">${countByProject(project.id, true)}</span>`;
    html += `</button>`;
    html += `<button class="nav-edit" onclick="event.stopPropagation(); editProject(${project.id})" title="Bearbeiten">`;
    html += `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    html += `</button>`;
    html += `</div>`;
    html += `</div>`;
    
    // Render children alphabetically
    if (hasChildren) {
      project.children.sort((a, b) => a.name.localeCompare(b.name));
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

  el.innerHTML = '';
  const stats = [
    { cls: 'total', num: total, label: 'Gesamt' },
    { cls: 'pending', num: pending, label: 'Offen' },
    { cls: 'pending', num: inprog, label: 'In Arbeit' },
    { cls: 'due', num: overdue, label: 'Überfällig' },
    { cls: 'done', num: done, label: 'Erledigt' }
  ];
  stats.forEach(s => {
    const div = document.createElement('div');
    div.className = 'stat-card ' + s.cls;
    const span = document.createElement('span');
    span.className = 'stat-num';
    span.textContent = s.num;
    div.appendChild(span);
    div.appendChild(document.createTextNode(' ' + s.label));
    el.appendChild(div);
  });
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
  // Apply sort
  filtered = sortTodoList(filtered);

  if (currentProjectId) {
    let html = '';

    const validSectionIds = new Set(sections.map(s => s.id));

    // Status-Filter für Projekt-Ansicht anwenden (außer "Alle")
    if (currentFilter !== 'all' && ['pending','in_progress','done'].includes(currentFilter)) {
      filtered = filtered.filter(t => t.status === currentFilter);
    }
    // Erledigte ausblenden wenn Toggle aktiv (außer explizit "Erledigt"-Filter)
    if (hideDone && currentFilter !== 'done') {
      filtered = filtered.filter(t => t.status !== 'done');
    }

    for (const section of sections) {
      const sectionTodos = filtered.filter(t => t.section_id === section.id);
      html += renderSectionHeader(section);
      html += `<div class="section-todos" data-section-id="${escapeHtmlAttr(section.id)}" ondragover="handleTodoDragOver(event)" ondrop="handleTodoDrop(event)">`;
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

  const groups = {
    in_progress: '🔥 In Arbeit',
    pending: '⏳ Offen',
    done: '✅ Erledigt'
  };

  // Auf aktuellen Status-Filter begrenzen (außer "Alle")
  if (currentFilter !== 'all' && groups[currentFilter]) {
    filtered = filtered.filter(t => t.status === currentFilter);
  }
  // Erledigte ausblenden wenn Toggle aktiv (außer explizit "Erledigt"-Filter)
  if (hideDone && currentFilter !== 'done') {
    filtered = filtered.filter(t => t.status !== 'done');
  }

  let html = '';
  for (const [status, title] of Object.entries(groups)) {
    // Nur passende Status-Gruppen anzeigen
    if (currentFilter !== 'all' && currentFilter !== status) continue;
    const statusItems = filtered.filter(t => t.status === status);
    if (!statusItems.length) continue;

    html += `<div class="todo-group">
      <div class="todo-group-title">${title} (${statusItems.length})</div>`;

    // Nach Projekt gruppieren
    const byProject = new Map();
    for (const t of statusItems) {
      const pid = t.project_id || 0;
      if (!byProject.has(pid)) byProject.set(pid, []);
      byProject.get(pid).push(t);
    }

    // Projekte in definierter Reihenfolge (Inbox zuerst, dann alphabetisch)
    const projectOrder = Array.from(byProject.keys()).sort((a, b) => {
      if (a === 1) return -1;
      if (b === 1) return 1;
      const pa = projects.find(p => p.id === a);
      const pb = projects.find(p => p.id === b);
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
          <div class="project-group-todos">
            ${items.map(t => renderTodoItem(t)).join('')}
          </div>
        </div>`;
      } else {
        // Kein Projekt zugewiesen
        html += `<div class="project-group">
          <div class="project-group-header">
            <span class="project-dot" style="background:var(--text-muted)"></span>
            <span class="project-group-name">Unsortiert</span>
            <span class="project-group-count">${items.length}</span>
          </div>
          <div class="project-group-todos">
            ${items.map(t => renderTodoItem(t)).join('')}
          </div>
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

function renderSectionHeader(section) {
  if (section) {
    const count = todos.filter(t => t.section_id === section.id && t.project_id === currentProjectId).length;
    return `
      <div class="section-header" data-section-id="${escapeHtmlAttr(section.id)}" draggable="true"
        ondragstart="handleSectionDragStart(event)" ondragend="handleSectionDragEnd(event)"
        ondragover="handleSectionDragOver(event)" ondrop="handleSectionDrop(event)">
        <span class="section-name" onclick="editSectionInline(${jsArg(section.id)})">${escapeHtml(section.name)}</span>
        <span class="section-count">${count}</span>
        <button class="section-delete" onclick="event.stopPropagation(); deleteSection(${jsArg(section.id)})" title="Löschen">✕</button>
      </div>
    `;
  } else {
    const unsortedCount = todos.filter(t => !t.section_id && t.project_id === currentProjectId).length;
    return `
      <div class="section-header section-unsorted" data-section-id="null"
        ondragover="handleSectionDragOver(event)" ondrop="handleSectionDrop(event)">
        <span class="section-name">Unsortiert</span>
        <span class="section-count">${unsortedCount}</span>
      </div>
    `;
  }
}

function renderTodoItem(t) {
  const isOverdue = t.due_date && t.status !== 'done' && new Date(t.due_date) < new Date();
  const dueStr = t.due_date ? formatDate(t.due_date) : '';
  const prioEmoji = {1: '🔴', 2: '🟡', 3: '🟢', 4: '⚪'}[t.priority] || '⚪';
  const hasMeta = dueStr || t.remind_at;
  const desc = t.description ? truncateWords(t.description, 12) : '';
  const hasDesc = desc && desc.length > 0;

  return `
    <div class="todo-item ${t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'in-progress' : ''}" data-id="${t.id}" draggable="true" onclick="editTodo(${t.id})"
      ondragstart="handleTodoDragStart(event)" ondragend="handleTodoDragEnd(event)">
      <div class="todo-check" onclick="event.stopPropagation(); toggleTodo(${t.id})">
        ${t.status === 'done' ? '✓' : t.status === 'in_progress' ? '●' : ''}
      </div>
      <div class="todo-body ${hasMeta || hasDesc ? 'has-meta' : ''}">
        <div class="todo-main">
          <span class="todo-prio" title="Priorität">${prioEmoji}</span>
          <span class="todo-title">${escapeHtml(t.title)}</span>
        </div>
        ${hasMeta || hasDesc ? `
        <div class="todo-meta-row">
          ${dueStr ? `<span class="todo-due ${isOverdue ? 'overdue' : ''}">📅 ${dueStr}${isOverdue ? ' (überfällig)' : ''}</span>` : ''}
          ${desc ? `<span class="todo-desc-preview">${renderMarkdown(desc)}</span>` : ''}
        </div>
        ` : ''}
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
  
  // Save to localStorage for persistence
  localStorage.setItem('nia-last-filter', filter);
  
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
      const data = await sectionsApi.listByProject(currentProjectId);
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

async function markTodoDone(id) {
  if (!appInitialized || !db) return;

  const t = todos.find(x => x.id === id);
  if (!t || t.status === 'done') return;

  // Update local
  const updatedTodo = { ...t, status: 'done', updated_at: new Date().toISOString() };
  await dbPut('todos', updatedTodo);

  // UI updaten
  todos = todos.map(todo => todo.id === id ? updatedTodo : todo);
  renderStats();
  renderTodos();

  // Toast mit Undo
  showToast('Todo erledigt', { type: 'status', id });

  // Immer in Queue (offline-first)
  await addToSyncQueue('UPDATE_TODO', { id, changes: { status: 'done' } });

  // Sofort syncen wenn online
  if (isOnlineForSync()) {
    await syncWithServer();
  }
}

async function toggleTodo(id) {
  if (!appInitialized || !db) return;

  const t = todos.find(x => x.id === id);
  if (!t) return;

  const cycle = { pending: 'in_progress', in_progress: 'done', done: 'pending' };
  const newStatus = cycle[t.status] || 'pending';

  // Update local
  const updatedTodo = { ...t, status: newStatus, updated_at: new Date().toISOString() };
  await dbPut('todos', updatedTodo);

  // UI updaten
  todos = todos.map(todo => todo.id === id ? updatedTodo : todo);
  renderStats();
  renderTodos();

  // Toast mit Undo
  if (newStatus === 'done') {
    showToast('Todo erledigt', { type: 'status', id });
  } else if (t.status === 'done' && newStatus === 'pending') {
    showToast('Todo wiedereröffnet', { type: 'status', id });
  }

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
    
    rootProjects.sort((a, b) => {
      if (a.id === 1) return -1;
      if (b.id === 1) return 1;
      return a.name.localeCompare(b.name);
    });
    
    // Recursive function to add options with indentation
    function addProjectOptions(projectNode, depth = 0) {
      const indent = '\u00A0'.repeat(depth * 2) + (depth > 0 ? '└─ ' : '');
      const opt = document.createElement('option');
      opt.value = projectNode.id;
      opt.style.color = projectNode.color;
      opt.textContent = indent + projectNode.name;
      projSelect.appendChild(opt);
      
      if (projectNode.children && projectNode.children.length > 0) {
        projectNode.children.sort((a, b) => a.name.localeCompare(b.name));
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
      const d = new Date(todo.due_date);
      document.getElementById('todo-due').value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    }
    // Handle both old format (remind_at string) and server format (reminders array)
    const reminderDate = todo.remind_at || (todo.reminders && todo.reminders[0] && todo.reminders[0].remind_at);
    if (reminderDate) {
      const d = new Date(reminderDate);
      document.getElementById('todo-remind').value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    }
  } else {
    // Neues Todo: Aktuelles Projekt oder Inbox vorauswählen
    const defaultProjectId = currentProjectId || 1;
    document.getElementById('todo-project').value = defaultProjectId;
    await onProjectChange(null);
  }

  document.getElementById('todo-delete-btn').style.display = todo ? '' : 'none';

  // Setup live markdown preview for description
  setupDescPreview();

  document.getElementById('todo-modal')?.classList.add('active');
}

function setupDescPreview() {
  const textarea = document.getElementById('todo-desc');
  const preview = document.getElementById('todo-desc-preview');
  if (!textarea || !preview) return;
  
  // Initial render
  preview.innerHTML = renderMarkdown(textarea.value);
  
  // Update on input
  textarea.addEventListener('input', () => {
    preview.innerHTML = renderMarkdown(textarea.value);
  });
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
      const data = await sectionsApi.listByProject(projectId);
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

  const todo = todos.find(t => t.id === id);
  if (!todo) return;

  await deleteFromDB('todos', id);
  todos = todos.filter(t => t.id !== id);
  renderStats();
  renderTodos();
  closeModal('todo-modal');

  showToast('Todo gelöscht', { type: 'delete', id, data: { ...todo } });

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
    
    rootProjects.sort((a, b) => {
      if (a.id === 1) return -1;
      if (b.id === 1) return 1;
      return a.name.localeCompare(b.name);
    });
    
    // Recursive function
    function addProjectOptions(projectNode, depth = 0) {
      // Skip current project being edited (can't be own parent)
      if (project && projectNode.id === project.id) return;
      // Skip Inbox (cannot be parent of subprojects)
      if (projectNode.id === 1) return;
      
      const indent = '\u00A0'.repeat(depth * 2) + (depth > 0 ? '└─ ' : '');
      const option = document.createElement('option');
      option.value = projectNode.id;
      option.textContent = indent + projectNode.name;
      parentSelect.appendChild(option);
      
      if (projectNode.children && projectNode.children.length > 0) {
        projectNode.children.sort((a, b) => a.name.localeCompare(b.name));
        projectNode.children.forEach(child => addProjectOptions(child, depth + 1));
      }
    }
    
    rootProjects.forEach(p => addProjectOptions(p));
    
    parentSelect.value = parentId || (project ? project.parent_id : '') || '';
  }

  // Hide parent dropdown for Inbox (cannot be moved under another project)
  const parentFormGroup = document.getElementById('project-parent-id')?.closest('.form-group');
  if (parentFormGroup) {
    parentFormGroup.style.display = (project && project.id === 1) ? 'none' : '';
  }

  if (project) {
    document.getElementById('project-id').value = project.id;
    document.getElementById('project-name').value = project.name;
    document.getElementById('project-color').value = project.color;
    if (parentSelect) parentSelect.value = project.parent_id || '';
  }

  document.getElementById('project-delete-btn').style.display = (project && project.id !== 1) ? '' : 'none';
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

async function clearDoneFromModal() {
  const id = document.getElementById('project-id').value;
  if (!id) return;
  const projectId = parseInt(id);
  const project = projects.find(p => p.id === projectId);
  if (!project) return;

  const doneCount = todos.filter(t => t.project_id === projectId && t.status === 'done').length;
  if (doneCount === 0) {
    showToast('Keine erledigten Todos in diesem Projekt');
    return;
  }

  if (!confirm(`${doneCount} erledigte Todo(s) in "${project.name}" löschen?`)) return;

  try {
    const r = await projectsApi.clearDone(projectId);
    if (r.ok) {
      const result = await r.json();
      // Remove done todos from local array
      todos = todos.filter(t => !(t.project_id === projectId && t.status === 'done'));
      renderStats();
      renderTodos();
      showToast(`${result.deleted_count} erledigte Todo(s) gelöscht`);
    } else {
      showToast('Fehler beim Löschen');
    }
  } catch (err) {
    console.error('Clear done error:', err);
    showToast('Fehler beim Löschen');
  }
}

async function clearDoneInProject() {
  if (!currentProjectId) return;
  const project = projects.find(p => p.id === currentProjectId);
  if (!project) return;

  const doneTodos = todos.filter(t => t.project_id === currentProjectId && t.status === 'done');
  if (doneTodos.length === 0) {
    showToast('Keine erledigten Todos in diesem Projekt');
    return;
  }

  if (!confirm(`${doneTodos.length} erledigte Todo(s) in "${project.name}" löschen?`)) return;

  try {
    const result = await projectsApi.clearDone(currentProjectId);
      // Store batch data for undo before removing from array
      const deletedData = doneTodos.map(t => ({ ...t }));
      // Remove done todos from local array
      todos = todos.filter(t => !(t.project_id === currentProjectId && t.status === 'done'));
      renderStats();
      renderTodos();
      // Show toast with batch undo
      showBatchToast(`${result.deleted_count} erledigte Todo(s) gelöscht`, { todos: deletedData, projectId: currentProjectId });
  } catch (err) {
    console.error('Clear done error:', err);
    showToast('Fehler beim Löschen');
  }
}

// ─── Modal Helpers ───────────────────────────────────────────────────────────

function closeModal(modalId) {
  document.getElementById(modalId)?.classList.remove('active');
}

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

  const now = new Date().toISOString();
  const tempId = 'temp-section-' + Date.now();
  const sectionData = {
    id: tempId,
    name,
    project_id: currentProjectId,
    sort_order: sections.length,
    created_at: now,
    updated_at: now
  };

  // Lokale DB sofort updaten
  await dbPut('sections', sectionData);
  sections.push(sectionData);
  renderTodos();

  // In Sync-Queue
  await addToSyncQueue('CREATE_SECTION', { ...sectionData, _tempId: tempId });

  // Sofort syncen wenn online
  if (isOnlineForSync()) {
    await syncWithServer();
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

  const section = sections.find(s => s.id === id);
  if (!section) return;

  const now = new Date().toISOString();
  const updated = { ...section, name, updated_at: now };
  await dbPut('sections', updated);
  sections = sections.map(s => s.id === id ? updated : s);
  renderTodos();

  await addToSyncQueue('UPDATE_SECTION', { id, changes: { name } });

  if (isOnlineForSync()) {
    await syncWithServer();
  }
}

async function deleteSection(id) {
  if (!confirm('Section wirklich löschen? Todos werden zu "Unsortiert" verschoben.')) return;

  const section = sections.find(s => s.id === id);
  if (!section) return;

  // Sofort lokal löschen + Todos auf Unsortiert
  sections = sections.filter(s => s.id !== id);
  await deleteFromDB('sections', id);
  for (const t of todos) {
    if (t.section_id === id) {
      t.section_id = null;
      t.updated_at = new Date().toISOString();
      await dbPut('todos', t);
    }
  }
  renderTodos();

  // Sync-Queue
  await addToSyncQueue('DELETE_SECTION', { id });

  if (isOnlineForSync()) {
    await syncWithServer();
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
      await todosApi.update(todo.id, { section_id: newSectionId });
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
        await todosApi.update(todo.id, { section_id: newSectionId });
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
        await sectionsApi.update(sections[i].id, { sort_order: i });
      } catch (err) {
        console.error('Sort section failed', err);
      }
    }
  }

  renderTodos();
}

function toggleHideDone() {
  hideDone = !hideDone;
  localStorage.setItem('nia-hide-done', hideDone ? 'true' : 'false');
  updateToggleDoneButton();
  renderTodos();
}

function updateToggleDoneButton() {
  const btn = document.getElementById('toggle-done-btn');
  if (!btn) return;
  if (hideDone) {
    btn.classList.remove('active');
    btn.textContent = '🚫';
    btn.title = 'Erledigte anzeigen';
  } else {
    btn.classList.add('active');
    btn.textContent = '✅';
    btn.title = 'Erledigte ausblenden';
  }
}

function cycleSort() {
  const modes = ['order', 'priority', 'alpha'];
  const idx = modes.indexOf(sortMode);
  sortMode = modes[(idx + 1) % modes.length];
  localStorage.setItem('nia-sort', sortMode);
  updateSortButton();
  renderTodos();
}

function updateSortButton() {
  const btn = document.getElementById('sort-toggle-btn');
  if (!btn) return;
  const config = {
    order: { icon: '⇅', title: 'Sortierung: Reihenfolge' },
    priority: { icon: 'P1', title: 'Sortierung: Priorität (hoch→niedrig)' },
    alpha: { icon: 'AZ', title: 'Sortierung: Alphabetisch (A→Z)' }
  };
  const c = config[sortMode] || config.order;
  btn.textContent = c.icon;
  btn.title = c.title;
}

function sortTodoList(list) {
  if (sortMode === 'priority') {
    const prioOrder = { 1: 0, 2: 1, 3: 2, 4: 3 };
    return [...list].sort((a, b) => {
      const pa = prioOrder[a.priority] ?? 4;
      const pb = prioOrder[b.priority] ?? 4;
      if (pa !== pb) return pa - pb;
      return (a.sort_order ?? 0) - (b.sort_order ?? 0);
    });
  }
  if (sortMode === 'alpha') {
    return [...list].sort((a, b) =>
      (a.title || '').toLowerCase().localeCompare((b.title || '').toLowerCase())
    );
  }
  // Default: Reihenfolge (sort_order)
  return [...list].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
}

function showToast(message, action) {
  const container = document.getElementById('toast-container');
  const msgEl = document.getElementById('toast-message');
  if (!container || !msgEl) return;
  msgEl.textContent = message;
  undoAction = action;
  container.style.display = 'flex';
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = setTimeout(hideToast, 5000);
}

function showBatchToast(message, batchData) {
  const container = document.getElementById('toast-container');
  const msgEl = document.getElementById('toast-message');
  if (!container || !msgEl) return;
  msgEl.textContent = message;
  pendingUndoBatch = batchData;
  undoAction = { type: 'batch_delete' };
  container.style.display = 'flex';
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    pendingUndoBatch = null;
    hideToast();
  }, 5000);
}

function hideToast() {
  const container = document.getElementById('toast-container');
  if (container) container.style.display = 'none';
  undoAction = null;
  if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
}

function undoLastAction() {
  if (!undoAction) return;
  if (undoAction.type === 'status') {
    toggleTodo(undoAction.id);
  } else if (undoAction.type === 'delete') {
    restoreTodo(undoAction.id, undoAction.data);
  } else if (undoAction.type === 'batch_delete' && pendingUndoBatch) {
    restoreBatchTodos();
  }
  hideToast();
}

// ─── Deleted Todo Restore ──────────────────────────────────────────────────

async function restoreBatchTodos() {
  if (!pendingUndoBatch || !db) return;
  const { todos: deletedTodos } = pendingUndoBatch;
  for (const todoData of deletedTodos) {
    await dbPut('todos', todoData);
    const existing = todos.find(t => t.id === todoData.id);
    if (!existing) {
      todos.push(todoData);
    } else {
      todos = todos.map(t => t.id === todoData.id ? todoData : t);
    }
  }
  renderStats();
  renderTodos();
  pendingUndoBatch = null;
  if (isOnlineForSync()) {
    for (const todoData of deletedTodos) {
      await addToSyncQueue('UPDATE_TODO', { id: todoData.id, changes: { status: todoData.status } });
    }
    await syncWithServer();
  }
}

async function restoreTodo(id, data) {
  if (!db) return;
  await dbPut('todos', data);
  todos.push(data);
  renderStats();
  renderTodos();
  if (isOnlineForSync()) {
    await addToSyncQueue('UPDATE_TODO', { id, changes: data });
    await syncWithServer();
  }
}

// ─── Push Notifications ────────────────────────────────────────────────────

const updatePushStatus = pushFeature.updatePushStatus;
const updatePushSettingsUI = pushFeature.updatePushSettingsUI;
const enablePushNotifications = pushFeature.enablePushNotifications;
const disablePushNotifications = pushFeature.disablePushNotifications;
const sendTestPush = pushFeature.sendTestPush;

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'n' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
    e.preventDefault();
    showTodoModal();
    setTimeout(() => document.getElementById('todo-title')?.focus(), 50);
  }
  if (e.key === 'Escape') {
    closeModal('todo-modal');
    closeModal('project-modal');
  }
});

// Expose legacy inline handlers for module-loaded frontend.
Object.assign(window, {
  getAuthToken,
  getCsrfToken,
  getAuthHeaders,
  login,
  checkAuth,
  logout,
  clearIndexedDB,
  showLoginOverlay,
  hideLoginOverlay,
  handleLogin,
  renderUserInfo,
  openSettingsModal,
  changeUserPassword,
  loadApiKeys,
  renderApiKeys,
  escapeHtml,
  escapeHtmlAttr,
  jsArg,
  createApiKey,
  revokeApiKey,
  copyApiKey,
  initTheme,
  setTheme,
  applyTheme,
  getReconnectDelay,
  connectWebSocket,
  wsSend,
  startPingInterval,
  stopPingInterval,
  scheduleReconnect,
  disconnectWebSocket,
  updateConnectionStatus,
  handleWsMessage,
  openDB,
  dbGetAll,
  dbPut,
  dbClear,
  getFromDB,
  deleteFromDB,
  clearSyncQueue,
  addToSyncQueue,
  isOnlineForSync,
  syncWithServer,
  refreshFromServer,
  toggleSidebar,
  closeSidebar,
  initServiceWorker,
  triggerUpdate,
  initApp,
  renderVersionInfo,
  loadFromLocalDB,
  loadAll,
  renderProjects,
  renderStats,
  renderTodos,
  renderSectionHeader,
  renderTodoItem,
  setFilter,
  loadSectionsForCurrentProject,
  countByProject,
  markTodoDone,
  toggleTodo,
  showTodoModal,
  setupDescPreview,
  onProjectChange,
  saveTodo,
  editTodo,
  deleteTodoFromModal,
  deleteTodo,
  showProjectModal,
  editProject,
  saveProject,
  deleteProject,
  deleteProjectFromModal,
  clearDoneFromModal,
  clearDoneInProject,
  closeModal,
  formatDate,
  showAddSectionForm,
  saveNewSection,
  editSectionInline,
  saveSectionEdit,
  deleteSection,
  handleTodoDragStart,
  handleTodoDragEnd,
  handleTodoDragOver,
  handleTodoDrop,
  handleSectionDragStart,
  handleSectionDragEnd,
  handleSectionDragOver,
  handleSectionDrop,
  toggleHideDone,
  updateToggleDoneButton,
  cycleSort,
  updateSortButton,
  sortTodoList,
  showToast,
  showBatchToast,
  hideToast,
  undoLastAction,
  restoreBatchTodos,
  restoreTodo,
  cycleTheme,
  updatePushStatus,
  updatePushSettingsUI,
  enablePushNotifications,
  disablePushNotifications,
  sendTestPush,
});
