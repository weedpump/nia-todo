// nia-todo: Frontend app mit Offline-First PWA + WebSocket Echtzeit-Sync
import { APP_VERSION, WS_URL } from './core/config.js';
import { escapeHtml, escapeHtmlAttr, formatDate, jsArg, renderMarkdown, truncateWords } from './core/utils.js';
import { authApi, projectsApi, pushApi, sectionsApi, todosApi } from './api/index.js';
import * as indexedDb from './storage/indexed-db.js';
import * as syncQueue from './sync/queue.js';
import { createApiKeysFeature } from './features/api-keys.js';
import { updateConnectionStatus as renderConnectionStatus } from './features/connection-status.js';
import { createPushNotificationsFeature } from './features/push-notifications.js';
import { createSectionsFeature } from './features/sections.js';
import { createServiceWorkerUpdatesFeature } from './features/service-worker-updates.js';
import { applyTheme, bindSystemThemeListener, cycleTheme, initTheme, setTheme } from './features/theme.js';
import { createUserSettingsFeature } from './features/user-settings.js';
import { createProjectsFeature } from './features/projects.js';
import { createTodosFeature } from './features/todos.js';
import { renderTodoItem } from './features/todo-rendering.js';
import { createViewPreferencesFeature } from './features/view-preferences.js';
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
const viewPreferences = createViewPreferencesFeature({
  getHideDone: () => hideDone,
  setHideDone: (value) => { hideDone = value; },
  getSortMode: () => sortMode,
  setSortMode: (value) => { sortMode = value; },
  renderTodos: () => renderTodos(),
});
const sectionsFeature = createSectionsFeature({
  getTodos: () => todos,
  getCurrentProjectId: () => currentProjectId,
  getSections: () => sections,
  renderTodos: () => renderTodos(),
});
const todosFeature = createTodosFeature({
  getTodos: () => todos,
  setTodos: (next) => { todos = next; },
  getProjects: () => projects,
  getCurrentProjectId: () => currentProjectId,
  getAppInitialized: () => appInitialized,
  getDb: () => db,
  dbPut,
  dbGetAll,
  deleteFromDB,
  addToSyncQueue,
  isOnlineForSync,
  syncWithServer,
  sectionsApi,
  renderProjects: () => renderProjects(),
  renderStats: () => renderStats(),
  renderTodos: () => renderTodos(),
  closeModal,
  showToast,
  setupDescPreview,
  renderMarkdown,
  loadSectionsForCurrentProject: (selectedSectionId) => loadSectionsForCurrentProject(selectedSectionId),
});
const projectsFeature = createProjectsFeature({
  getProjects: () => projects,
  getTodos: () => todos,
  setProjects: (next) => { projects = next; },
  dbPut,
  addToSyncQueue,
  deleteFromDB,
  isOnlineForSync,
  syncWithServer,
  renderProjects: () => renderProjects(),
  renderStats: () => renderStats(),
  renderTodos: () => renderTodos(),
  closeModal,
  showToast,
  showBatchToast,
  projectsApi,
});
const userSettingsFeature = createUserSettingsFeature({
  authApi,
  getCurrentUser: () => currentUser,
  resetApiKeyUi: () => resetApiKeyUi(),
  loadApiKeys: () => loadApiKeys(),
  updatePushSettingsUI: () => updatePushSettingsUI(),
  logout: () => logout(),
});
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

const renderUserInfo = userSettingsFeature.renderUserInfo;
const openSettingsModal = userSettingsFeature.openSettingsModal;
const changeUserPassword = userSettingsFeature.changeUserPassword;
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
  renderConnectionStatus(wsState);
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

const renderSectionHeader = sectionsFeature.renderSectionHeader;
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

const markTodoDone = todosFeature.markTodoDone;
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

const toggleHideDone = viewPreferences.toggleHideDone;
const updateToggleDoneButton = viewPreferences.updateToggleDoneButton;
const cycleSort = viewPreferences.cycleSort;
const updateSortButton = viewPreferences.updateSortButton;
const sortTodoList = viewPreferences.sortTodoList;
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
