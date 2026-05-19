// nia-todo: Frontend app mit Offline-First PWA + WebSocket Echtzeit-Sync
import { APP_VERSION, WS_URL } from './core/config.js';
import { escapeHtml, escapeHtmlAttr, formatDate, jsArg, renderMarkdown, truncateWords } from './core/utils.js';
import { authApi, projectsApi, pushApi, sectionsApi, todosApi } from './api/index.js';
import { createAuthSessionFeature } from './features/auth-session.js';
import { createAppStorage } from './storage/app-storage.js';
import { createApiKeysFeature } from './features/api-keys.js';
import { updateConnectionStatus as renderConnectionStatus } from './features/connection-status.js';
import { createPushNotificationsFeature } from './features/push-notifications.js';
import { createSectionsFeature } from './features/sections.js';
import { createServiceWorkerUpdatesFeature } from './features/service-worker-updates.js';
import { applyTheme, bindSystemThemeListener, cycleTheme, initTheme, setTheme } from './features/theme.js';
import { createUserSettingsFeature } from './features/user-settings.js';
import { createProjectsFeature } from './features/projects.js';
import { createTodosFeature } from './features/todos.js';
import { createSyncFeature } from './features/sync.js';
import { renderTodoItem } from './features/todo-rendering.js';
import { createViewPreferencesFeature } from './features/view-preferences.js';
import { createWebSocketClient } from './features/websocket-client.js';
import { createToastUndoFeature } from './features/toast-undo.js';
import { createDragDropFeature } from './features/drag-drop.js';
import { createAppRenderingFeature } from './features/app-rendering.js';
import { createNavigationFeature } from './features/navigation.js';
let todos = [];
let projects = [];
let sections = [];
let currentFilter = 'all';
let currentProjectId = null;
let db = null;
let dbReady = null;
let appInitialized = false;
let syncInProgress = false;
let hideDone = localStorage.getItem('nia-hide-done') === 'true';
let sortMode = localStorage.getItem('nia-sort') || 'order';

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
const toggleHideDone = viewPreferences.toggleHideDone;
const updateToggleDoneButton = viewPreferences.updateToggleDoneButton;
const cycleSort = viewPreferences.cycleSort;
const updateSortButton = viewPreferences.updateSortButton;
const sortTodoList = viewPreferences.sortTodoList;
const sectionsFeature = createSectionsFeature({
  getTodos: () => todos,
  getCurrentProjectId: () => currentProjectId,
  getSections: () => sections,
  renderTodos: () => renderTodos(),
});
const appStorage = createAppStorage({ setDb: (next) => { db = next; } });
const openDB = appStorage.openDB;
const clearIndexedDB = appStorage.clearIndexedDB;
const dbGetAll = appStorage.dbGetAll;
const dbPut = appStorage.dbPut;
const dbClear = appStorage.dbClear;
const getFromDB = appStorage.getFromDB;
const deleteFromDB = appStorage.deleteFromDB;
const clearSyncQueue = appStorage.clearSyncQueue;
const addToSyncQueue = appStorage.addToSyncQueue;
const syncInProgressRef = { value: syncInProgress };
const syncFeature = createSyncFeature({
  getDb: () => db,
  dbGetAll,
  dbPut,
  getFromDB,
  deleteFromDB,
  getTodos: () => todos,
  setTodos: (next) => { todos = next; },
  getProjects: () => projects,
  setProjects: (next) => { projects = next; },
  getSections: () => sections,
  setSections: (next) => { sections = next; },
  todosApi,
  projectsApi,
  sectionsApi,
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
  showToast: (...args) => showToast(...args),
  setupDescPreview,
  renderMarkdown,
  loadSectionsForCurrentProject: (selectedSectionId) => loadSectionsForCurrentProject(selectedSectionId),
});
const projectsFeature = createProjectsFeature({
  getProjects: () => projects,
  getTodos: () => todos,
  getCurrentProjectId: () => currentProjectId,
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
  showToast: (...args) => showToast(...args),
  showBatchToast: (...args) => showBatchToast(...args),
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
const authSessionFeature = createAuthSessionFeature({
  authApi,
  getAppInitialized: () => appInitialized,
  setCurrentUser: (next) => { currentUser = next; },
  clearCache: () => clearIndexedDB(),
  initApp: () => initApp(),
  refreshFromServer: () => refreshFromServer(),
  renderUserInfo: () => renderUserInfo(),
});
const serviceWorkerUpdates = createServiceWorkerUpdatesFeature({ onMarkTodoDone: (id) => markTodoDone(id) });
const initServiceWorker = serviceWorkerUpdates.initServiceWorker;
const triggerUpdate = serviceWorkerUpdates.triggerUpdate;

const getAuthToken = authSessionFeature.getAuthToken;
const getCsrfToken = authSessionFeature.getCsrfToken;
const getAuthHeaders = authSessionFeature.getAuthHeaders;
const login = authSessionFeature.login;
const checkAuth = authSessionFeature.checkAuth;
const logout = authSessionFeature.logout;
const showLoginOverlay = authSessionFeature.showLoginOverlay;
const hideLoginOverlay = authSessionFeature.hideLoginOverlay;
const handleLogin = authSessionFeature.handleLogin;
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
const wsClient = createWebSocketClient({
  wsUrl: WS_URL,
  getAuthToken: () => getAuthToken(),
  syncWithServer: () => syncWithServer(),
  renderConnectionStatus,
  dbGetAll,
  dbPut,
  getFromDB,
  deleteFromDB,
  getTodos: () => todos,
  setTodos: (next) => { todos = next; },
  getProjects: () => projects,
  setProjects: (next) => { projects = next; },
  getSections: () => sections,
  setSections: (next) => { sections = next; },
  renderProjects: () => renderProjects(),
  renderStats: () => renderStats(),
  renderTodos: () => renderTodos(),
});
const getReconnectDelay = wsClient.getReconnectDelay;
const connectWebSocket = wsClient.connectWebSocket;
const wsSend = wsClient.wsSend;
const startPingInterval = wsClient.startPingInterval;
const stopPingInterval = wsClient.stopPingInterval;
const scheduleReconnect = wsClient.scheduleReconnect;
const disconnectWebSocket = wsClient.disconnectWebSocket;
const updateConnectionStatus = wsClient.updateConnectionStatus;
const handleWsMessage = wsClient.handleWsMessage;


// ─── IndexedDB ───────────────────────────────────────────────────────────────

// ─── Sync Logic (Kern der Offline→Online Synchronisation) ───────────────────

function isOnlineForSync() {
  return syncFeature.isOnlineForSync(wsClient.getWsState());
}

async function syncWithServer() {
  syncInProgressRef.value = syncInProgress;
  await syncFeature.syncWithServer({ wsState: wsClient.getWsState(), syncInProgressRef });
  syncInProgress = syncInProgressRef.value;
}

async function refreshFromServer() {
  syncInProgressRef.value = syncInProgress;
  await syncFeature.refreshFromServer({ wsState: wsClient.getWsState(), syncInProgressRef });
  syncInProgress = syncInProgressRef.value;
}

window.addEventListener('online', async () => {
  console.log('Browser reports online');
  if (wsClient.getWsState() === 'disconnected') connectWebSocket();
  await syncWithServer();
});

window.addEventListener('offline', () => {
  console.log('Browser reports offline');
});

function toggleSidebar() {
  document.getElementById('sidebar')?.classList.toggle('open');
  document.getElementById('sidebar-overlay')?.classList.toggle('active');
}

function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('active');
}

function closeModal(modalId) {
  document.getElementById(modalId)?.classList.remove('active');
}

function setupDescPreview() {
  const textarea = document.getElementById('todo-desc');
  const preview = document.getElementById('todo-desc-preview');
  if (!textarea || !preview) return;
  preview.innerHTML = renderMarkdown(textarea.value);
  textarea.oninput = () => { preview.innerHTML = renderMarkdown(textarea.value); };
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
  if (isOnlineForSync()) await refreshFromServer();
}

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

const renderSectionHeader = sectionsFeature.renderSectionHeader;
const appRendering = createAppRenderingFeature({
  appVersion: APP_VERSION,
  escapeHtml,
  escapeHtmlAttr,
  getTodos: () => todos,
  getProjects: () => projects,
  getSections: () => sections,
  getCurrentFilter: () => currentFilter,
  getCurrentProjectId: () => currentProjectId,
  getHideDone: () => hideDone,
  sortTodoList,
  renderTodoItem,
  renderSectionHeader,
});
const renderVersionInfo = appRendering.renderVersionInfo;
const renderProjects = appRendering.renderProjects;
const renderStats = appRendering.renderStats;
const renderTodos = appRendering.renderTodos;
const countByProject = appRendering.countByProject;

// ─── Actions ─────────────────────────────────────────────────────────────────

const navigationFeature = createNavigationFeature({
  sectionsApi,
  getCurrentProjectId: () => currentProjectId,
  setCurrentProjectId: (next) => { currentProjectId = next; },
  setCurrentFilter: (next) => { currentFilter = next; },
  setSections: (next) => { sections = next; },
  isOnlineForSync,
  dbGetAll,
  dbPut,
  deleteFromDB,
  closeSidebar,
  renderTodos: () => renderTodos(),
});
const setFilter = navigationFeature.setFilter;
const loadSectionsForCurrentProject = navigationFeature.loadSectionsForCurrentProject;

const showAddSectionForm = sectionsFeature.showAddSectionForm;
const editSectionInline = sectionsFeature.editSectionInline;

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
    updated_at: now,
  };

  await dbPut('sections', sectionData);
  sections = [...sections, sectionData];
  renderTodos();

  await addToSyncQueue('CREATE_SECTION', { ...sectionData, _tempId: tempId });
  if (isOnlineForSync()) await syncWithServer();
}

async function saveSectionEdit(id) {
  const name = document.getElementById(`edit-section-name-${id}`)?.value?.trim();
  if (!name) return;

  const section = sections.find(s => s.id === id);
  if (!section) return;

  const updated = { ...section, name, updated_at: new Date().toISOString() };
  await dbPut('sections', updated);
  sections = sections.map(s => s.id === id ? updated : s);
  renderTodos();

  await addToSyncQueue('UPDATE_SECTION', { id, changes: { name } });
  if (isOnlineForSync()) await syncWithServer();
}

async function deleteSection(id) {
  if (!confirm('Section wirklich löschen? Todos werden zu "Unsortiert" verschoben.')) return;

  const section = sections.find(s => s.id === id);
  if (!section) return;

  sections = sections.filter(s => s.id !== id);
  await deleteFromDB('sections', id);
  for (const todo of todos) {
    if (todo.section_id === id) {
      todo.section_id = null;
      todo.updated_at = new Date().toISOString();
      await dbPut('todos', todo);
    }
  }
  renderTodos();

  await addToSyncQueue('DELETE_SECTION', { id });
  if (isOnlineForSync()) await syncWithServer();
}

const showProjectModal = projectsFeature.showProjectModal;
const editProject = projectsFeature.editProject;
const saveProject = projectsFeature.saveProject;
const deleteProject = projectsFeature.deleteProject;
const deleteProjectFromModal = projectsFeature.deleteProjectFromModal;
const clearDoneFromModal = projectsFeature.clearDoneFromModal;
const clearDoneInProject = projectsFeature.clearDoneInProject;

const markTodoDone = todosFeature.markTodoDone;
const toggleTodo = todosFeature.toggleTodo;
const showTodoModal = todosFeature.showTodoModal;
const onProjectChange = todosFeature.onProjectChange;
const saveTodo = todosFeature.saveTodo;
const editTodo = todosFeature.editTodo;
const deleteTodoFromModal = todosFeature.deleteTodoFromModal;
const deleteTodo = todosFeature.deleteTodo;
// ─── Drag & Drop ─────────────────────────────────────────────────────────────

const dragDropFeature = createDragDropFeature({
  getTodos: () => todos,
  setTodos: (next) => { todos = next; },
  getSections: () => sections,
  setSections: (next) => { sections = next; },
  isOnlineForSync,
  todosApi,
  sectionsApi,
  renderTodos: () => renderTodos(),
});
const handleTodoDragStart = dragDropFeature.handleTodoDragStart;
const handleTodoDragEnd = dragDropFeature.handleTodoDragEnd;
const handleTodoDragOver = dragDropFeature.handleTodoDragOver;
const handleTodoDrop = dragDropFeature.handleTodoDrop;
const handleSectionDragStart = dragDropFeature.handleSectionDragStart;
const handleSectionDragEnd = dragDropFeature.handleSectionDragEnd;
const handleSectionDragOver = dragDropFeature.handleSectionDragOver;
const handleSectionDrop = dragDropFeature.handleSectionDrop;

const toastUndoFeature = createToastUndoFeature({
  getDb: () => db,
  getTodos: () => todos,
  setTodos: (next) => { todos = next; },
  dbPut,
  addToSyncQueue,
  isOnlineForSync,
  syncWithServer,
  renderStats: () => renderStats(),
  renderTodos: () => renderTodos(),
  toggleTodo: (id) => toggleTodo(id),
});
const showToast = toastUndoFeature.showToast;
const showBatchToast = toastUndoFeature.showBatchToast;
const hideToast = toastUndoFeature.hideToast;
const undoLastAction = toastUndoFeature.undoLastAction;
const restoreBatchTodos = toastUndoFeature.restoreBatchTodos;
const restoreTodo = toastUndoFeature.restoreTodo;

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
