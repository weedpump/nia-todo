// nia-todo: Frontend app with offline-first PWA + WebSocket realtime sync
import { APP_VERSION, WS_URL } from './core/config.js';
import { escapeHtml, escapeHtmlAttr, formatDate, jsArg, renderMarkdown, truncateWords } from './core/utils.js';
import { authApi, projectsApi, pushApi, sectionsApi, sharingApi, todosApi, workspacesApi } from './api/index.js';
import { createAuthSessionFeature } from './features/auth-session.js';
import { createAppStorage } from './storage/app-storage.js';
import { createApiKeysFeature } from './features/api-keys.js';
import { updateConnectionStatus as renderConnectionStatus } from './features/connection-status.js';
import { createPushNotificationsFeature } from './features/push-notifications.js';
import { createSectionsFeature } from './features/sections.js';
import { createServiceWorkerUpdatesFeature } from './features/service-worker-updates.js';
import { applyTheme, bindSystemThemeListener, cycleTheme, initTheme, setAccentIntensity, setAccentPreset, setTheme, toggleAccentPresetMenu } from './features/theme.js';
import { createUserSettingsFeature } from './features/user-settings.js';
import { createUserMenuFeature } from './features/user-menu.js';
import { createProjectsFeature } from './features/projects.js';
import { createWorkspacesFeature } from './features/workspaces.js';
import { createProjectSharingFeature } from './features/project-sharing.js';
import { createTodosFeature } from './features/todos.js';
import { createSyncFeature } from './features/sync.js';
import { renderTodoItem } from './features/todo-rendering.js';
import { createViewPreferencesFeature } from './features/view-preferences.js';
import { createWebSocketClient } from './features/websocket-client.js';
import { createToastUndoFeature } from './features/toast-undo.js';
import { createDragDropFeature } from './features/drag-drop.js';
import { createConfirmDialogFeature } from './features/confirm-dialog.js';
import { createDesktopIntegration } from './features/desktop-integration.js';
import { createAppDownloadsFeature } from './features/app-downloads.js';
import { createAppRenderingFeature } from './features/app-rendering.js';
import { createNavigationFeature } from './features/navigation.js';
import { createSectionActionsFeature } from './features/section-actions.js';
import { createUiShell } from './features/ui-shell.js';
import { createAppLifecycle } from './features/app-lifecycle.js';
import { exposeLegacyGlobals } from './features/legacy-globals.js';
import { t, translatePage } from './i18n/index.js';
import { hydrateIcons } from './icons/lucide-icons.js';
let todos = [];
let projects = [];
let sections = [];
let workspaces = [];
let currentFilter = 'all';
let currentProjectId = null;
let currentWorkspaceId = null;
let db = null;
let appInitialized = false;
let syncInProgress = false;
let hideDone = localStorage.getItem('nia-hide-done') !== 'false';
let sortMode = localStorage.getItem('nia-sort') || 'priority';
let showProjectWidget = localStorage.getItem('nia-project-widget') !== 'false';
let todayFocus = localStorage.getItem('nia-today-focus') === 'true';
let desktopIntegration = null;

function setTodosState(next) {
  todos = next;
  desktopIntegration?.syncLocalReminders(todos);
}

// ─── Auth / User (JWT) ───────────────────────────────────────────────────────

let currentUser = null;  // { id, username, display_name, token }
const apiKeysFeature = createApiKeysFeature({ authApi });
const pushFeature = createPushNotificationsFeature({ pushApi });
const confirmDialogFeature = createConfirmDialogFeature();
const confirmDanger = confirmDialogFeature.confirmDanger;
const appDownloadsFeature = createAppDownloadsFeature();
const openAppDownloadsModal = appDownloadsFeature.openAppDownloadsModal;
const viewPreferences = createViewPreferencesFeature({
  getHideDone: () => hideDone,
  setHideDone: (value) => { hideDone = value; },
  getSortMode: () => sortMode,
  setSortMode: (value) => { sortMode = value; },
  getShowProjectWidget: () => showProjectWidget,
  setShowProjectWidget: (value) => { showProjectWidget = value; },
  getTodayFocus: () => todayFocus,
  setTodayFocus: (value) => { todayFocus = value; },
  renderTodos: () => renderTodos(),
});
const toggleHideDone = viewPreferences.toggleHideDone;
const updateToggleDoneButton = viewPreferences.updateToggleDoneButton;
const cycleSort = viewPreferences.cycleSort;
const updateSortButton = viewPreferences.updateSortButton;
const sortTodoList = viewPreferences.sortTodoList;
const toggleProjectWidget = viewPreferences.toggleProjectWidget;
const updateProjectWidgetButton = viewPreferences.updateProjectWidgetButton;
const toggleTodayFocus = viewPreferences.toggleTodayFocus;
const updateTodayFocusButton = viewPreferences.updateTodayFocusButton;
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
async function updateConnectionStatusView(wsState = wsClient?.getWsState?.()) {
  let pendingCount = 0;
  try {
    if (db) pendingCount = (await dbGetAll('syncQueue')).length;
  } catch (error) {
    console.warn('Failed to read sync queue for status badge', error);
  }
  renderConnectionStatus(wsState, { pendingCount, syncing: syncInProgressRef.value });
}

async function addToSyncQueue(action, data) {
  const result = await appStorage.addToSyncQueue(action, data);
  updateConnectionStatusView().catch(() => {});
  return result;
}
const syncInProgressRef = { value: syncInProgress };
const syncFeature = createSyncFeature({
  getDb: () => db,
  dbGetAll,
  dbPut,
  dbClear,
  getFromDB,
  deleteFromDB,
  getTodos: () => todos,
  setTodos: setTodosState,
  getProjects: () => projects,
  setProjects: (next) => { projects = next; },
  getSections: () => sections,
  setSections: (next) => { sections = next; },
  getWorkspaces: () => workspaces,
  setWorkspaces: (next) => { workspaces = next; },
  todosApi,
  projectsApi,
  sectionsApi,
  workspacesApi,
});
const todosFeature = createTodosFeature({
  getTodos: () => todos,
  setTodos: setTodosState,
  getProjects: () => projects,
  getCurrentProjectId: () => currentProjectId,
  getCurrentWorkspaceId: () => currentWorkspaceId,
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
  closeModal: (...args) => closeModal(...args),
  confirmDanger,
  showToast: (...args) => showToast(...args),
  setupDescPreview: (...args) => setupDescPreview(...args),
  renderMarkdown,
});
const sharingFeature = createProjectSharingFeature({
  getProjects: () => projects,
  setProjects: (next) => { projects = next; },
  renderProjects: () => renderProjects(),
  renderStats: () => renderStats(),
  renderTodos: () => renderTodos(),
  showToast: (...args) => showToast(...args),
  projectsApi,
});
const projectsFeature = createProjectsFeature({
  getProjects: () => projects,
  getTodos: () => todos,
  setTodos: setTodosState,
  getCurrentProjectId: () => currentProjectId,
  getCurrentWorkspaceId: () => currentWorkspaceId,
  getWorkspaces: () => workspaces,
  setProjects: (next) => { projects = next; },
  dbPut,
  addToSyncQueue,
  deleteFromDB,
  isOnlineForSync,
  syncWithServer,
  renderProjects: () => renderProjects(),
  renderStats: () => renderStats(),
  renderTodos: () => renderTodos(),
  closeModal: (...args) => closeModal(...args),
  confirmDanger,
  showToast: (...args) => showToast(...args),
  showBatchToast: (...args) => showBatchToast(...args),
  projectsApi,
  sharingFeature,
  getCurrentUser: () => currentUser,
});
let workspacesFeature = null;
const userMenuFeature = createUserMenuFeature({ getCurrentUser: () => currentUser });
const userSettingsFeature = createUserSettingsFeature({
  authApi,
  getCurrentUser: () => currentUser,
  setCurrentUser: (next) => { currentUser = next; userMenuFeature.updateUserMenu(); },
  resetApiKeyUi: () => resetApiKeyUi(),
  loadApiKeys: () => loadApiKeys(),
  updatePushSettingsUI: () => updatePushSettingsUI(),
  logout: () => logout(),
});
const authSessionFeature = createAuthSessionFeature({
  authApi,
  getAppInitialized: () => appInitialized,
  setCurrentUser: (next) => { currentUser = next; userMenuFeature.updateUserMenu(); },
  clearCache: () => clearIndexedDB(),
  initApp: () => initApp(),
  refreshFromServer: () => refreshFromServer(),
  renderUserInfo: () => renderUserInfo(),
});
const serviceWorkerUpdates = createServiceWorkerUpdatesFeature({ onMarkTodoDone: (id) => markTodoDone(id) });
const initServiceWorker = serviceWorkerUpdates.initServiceWorker;
const triggerUpdate = serviceWorkerUpdates.triggerUpdate;
const forceReloadApp = serviceWorkerUpdates.forceReloadApp;

const getAuthToken = authSessionFeature.getAuthToken;
const getCsrfToken = authSessionFeature.getCsrfToken;
const getAuthHeaders = authSessionFeature.getAuthHeaders;
const login = authSessionFeature.login;
const checkAuth = authSessionFeature.checkAuth;
const logout = authSessionFeature.logout;
const showLoginOverlay = authSessionFeature.showLoginOverlay;
const hideLoginOverlay = authSessionFeature.hideLoginOverlay;
const handleLogin = authSessionFeature.handleLogin;
const bindLoginForm = authSessionFeature.bindLoginForm;
const renderUserInfo = userSettingsFeature.renderUserInfo;
const openSettingsModal = userSettingsFeature.openSettingsModal;
const changeLanguagePreference = userSettingsFeature.changeLanguagePreference;
const editUserEmail = userSettingsFeature.editUserEmail;
const cancelUserEmailEdit = userSettingsFeature.cancelUserEmailEdit;
const saveUserEmail = userSettingsFeature.saveUserEmail;
const changeUserPassword = userSettingsFeature.changeUserPassword;
const startTwoFactorTotp = userSettingsFeature.startTwoFactorTotp;
const confirmTwoFactorTotp = userSettingsFeature.confirmTwoFactorTotp;
const disableTwoFactor = userSettingsFeature.disableTwoFactor;
const addPasskey = userSettingsFeature.addPasskey;
const regenerateRecoveryCodes = userSettingsFeature.regenerateRecoveryCodes;
const removeTotpDevice = userSettingsFeature.removeTotpDevice;
const removePasskeyDevice = userSettingsFeature.removePasskeyDevice;
const toggleTrustedDevicesList = userSettingsFeature.toggleTrustedDevicesList;
const revokeTrustedDevice = userSettingsFeature.revokeTrustedDevice;
const revokeAllTrustedDevices = userSettingsFeature.revokeAllTrustedDevices;
const editUserDisplayName = userSettingsFeature.editUserDisplayName;
const cancelUserDisplayNameEdit = userSettingsFeature.cancelUserDisplayNameEdit;
const saveUserProfile = userSettingsFeature.saveUserProfile;
const startAvatarUpload = userSettingsFeature.startAvatarUpload;
const cancelAvatarCrop = userSettingsFeature.cancelAvatarCrop;
const saveAvatarCrop = userSettingsFeature.saveAvatarCrop;
const deleteUserAvatar = userSettingsFeature.deleteUserAvatar;
const toggleUserMenu = userMenuFeature.toggleUserMenu;
const closeUserMenu = userMenuFeature.closeUserMenu;
const updateUserMenu = userMenuFeature.updateUserMenu;
const bindUserMenu = userMenuFeature.bindUserMenu;
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
  renderConnectionStatus: (state) => updateConnectionStatusView(state),
  dbGetAll,
  dbPut,
  getFromDB,
  deleteFromDB,
  getTodos: () => todos,
  setTodos: setTodosState,
  getProjects: () => projects,
  setProjects: (next) => { projects = next; },
  getSections: () => sections,
  setSections: (next) => { sections = next; },
  getWorkspaces: () => workspaces,
  setWorkspaces: (next) => { workspaces = next; },
  renderWorkspaces: () => renderWorkspaces(),
  renderProjects: () => renderProjects(),
  renderStats: () => renderStats(),
  renderTodos: () => renderTodos(),
  onAuthOk: () => desktopIntegration?.announceNotificationReadiness(),
  onReminderDue: () => {},
  onSessionInvalidated: () => {
    localStorage.removeItem('nia-mfa-enrollment-required');
    location.reload();
  },
});
const getReconnectDelay = wsClient.getReconnectDelay;
const connectWebSocket = wsClient.connectWebSocket;
const wsSend = wsClient.wsSend;
const startPingInterval = wsClient.startPingInterval;
const stopPingInterval = wsClient.stopPingInterval;
const scheduleReconnect = wsClient.scheduleReconnect;
const disconnectWebSocket = wsClient.disconnectWebSocket;
const updateConnectionStatus = () => updateConnectionStatusView(wsClient.getWsState());
const handleWsMessage = wsClient.handleWsMessage;

function openMobileSearch() {
  const box = document.getElementById('search-box');
  const input = document.getElementById('search-input');
  box?.classList.add('open');
  requestAnimationFrame(() => {
    input?.focus();
    input?.select();
  });
}

function closeMobileSearch() {
  const box = document.getElementById('search-box');
  const input = document.getElementById('search-input');
  if (input?.value) {
    input.value = '';
    renderTodos();
  }
  box?.classList.remove('open');
  input?.blur();
}

function toggleMobileSearch() {
  const box = document.getElementById('search-box');
  if (box?.classList.contains('open')) closeMobileSearch();
  else openMobileSearch();
}

function isTypingTarget(element) {
  const tag = element?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element?.isContentEditable;
}

function bindTodayFocusHotkey() {
  if (document.documentElement.dataset.todayFocusHotkeyBound === '1') return;
  document.documentElement.dataset.todayFocusHotkeyBound = '1';
  document.addEventListener('keydown', (event) => {
    if (event.key?.toLowerCase() !== 'f' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (isTypingTarget(event.target) || document.querySelector('.modal.active')) return;
    event.preventDefault();
    toggleTodayFocus();
  });
}

desktopIntegration = createDesktopIntegration({
  showToast: (...args) => showToast(...args),
  onHotkeyNewTodo: async () => {
    await showTodoModal();
  },
  onHotkeySearch: () => {
    openMobileSearch();
  },
  getCurrentUser: () => currentUser,
});


// ─── IndexedDB ───────────────────────────────────────────────────────────────

// ─── Sync Logic (Kern der Offline→Online Synchronisation) ───────────────────

function isOnlineForSync() {
  return syncFeature.isOnlineForSync(wsClient.getWsState());
}

async function syncWithServer() {
  await updateConnectionStatusView(wsClient.getWsState());
  await syncFeature.syncWithServer({ wsState: wsClient.getWsState(), syncInProgressRef });
  syncInProgress = syncInProgressRef.value;
  await updateConnectionStatusView(wsClient.getWsState());
}

async function refreshFromServer() {
  await updateConnectionStatusView(wsClient.getWsState());
  await syncFeature.refreshFromServer({ wsState: wsClient.getWsState(), syncInProgressRef });
  syncInProgress = syncInProgressRef.value;
  await updateConnectionStatusView(wsClient.getWsState());
  ensureCurrentWorkspace();
  renderWorkspaces();
  renderProjects();
  renderStats();
  renderTodos();
}

const sectionActions = createSectionActionsFeature({
  getTodos: () => todos,
  setTodos: setTodosState,
  getSections: () => sections,
  setSections: (next) => { sections = next; },
  getCurrentProjectId: () => currentProjectId,
  dbPut,
  deleteFromDB,
  addToSyncQueue,
  isOnlineForSync,
  syncWithServer,
  renderTodos: () => renderTodos(),
  confirmDanger,
  sectionsFeature,
});
const renderSectionHeader = sectionActions.renderSectionHeader;
const showAddSectionForm = sectionActions.showAddSectionForm;
const editSectionInline = sectionActions.editSectionInline;
const saveNewSection = sectionActions.saveNewSection;
const saveSectionEdit = sectionActions.saveSectionEdit;
const deleteSection = sectionActions.deleteSection;
const appRendering = createAppRenderingFeature({
  appVersion: APP_VERSION,
  escapeHtml,
  escapeHtmlAttr,
  getTodos: () => todos,
  getProjects: () => projects,
  getSections: () => sections,
  getCurrentFilter: () => currentFilter,
  getCurrentProjectId: () => currentProjectId,
  getCurrentWorkspaceId: () => currentWorkspaceId,
  getHideDone: () => hideDone,
  getTodayFocus: () => todayFocus,
  getShowProjectWidget: () => showProjectWidget,
  getCurrentUser: () => currentUser,
  sortTodoList,
  renderTodoItem,
  renderSectionHeader,
});
const renderVersionInfo = appRendering.renderVersionInfo;
const renderProjects = appRendering.renderProjects;
const renderStats = appRendering.renderStats;
const renderTodos = appRendering.renderTodos;
const countByProject = appRendering.countByProject;
const renderInvites = appRendering.renderInvites;

workspacesFeature = createWorkspacesFeature({
  workspacesApi,
  getWorkspaces: () => workspaces,
  setWorkspaces: (next) => { workspaces = next; },
  getCurrentWorkspaceId: () => currentWorkspaceId,
  setCurrentWorkspaceId: (next) => { currentWorkspaceId = next; },
  dbPut,
  dbClear,
  isOnlineForSync,
  refreshFromServer: () => refreshFromServer(),
  renderProjects: () => renderProjects(),
  renderStats: () => renderStats(),
  renderTodos: () => renderTodos(),
  closeSidebar: () => closeSidebar(),
  confirmDanger,
  showToast: (...args) => showToast(...args),
});
const renderWorkspaces = workspacesFeature.renderWorkspaces;
const switchWorkspace = workspacesFeature.switchWorkspace;
const createWorkspace = workspacesFeature.createWorkspace;
const showWorkspaceModal = workspacesFeature.showWorkspaceModal;
const closeWorkspaceModal = workspacesFeature.closeWorkspaceModal;
const saveWorkspace = workspacesFeature.saveWorkspace;
const deleteWorkspaceFromModal = workspacesFeature.deleteWorkspaceFromModal;
const toggleWorkspaceMenu = workspacesFeature.toggleWorkspaceMenu;
const closeWorkspaceMenu = workspacesFeature.closeWorkspaceMenu;
const loadWorkspacesFromServer = workspacesFeature.loadWorkspacesFromServer;
const ensureCurrentWorkspace = workspacesFeature.ensureCurrentWorkspace;

// Make renderInvites globally available for project-sharing.js
window.renderInvites = renderInvites;
window.loadInvites = () => sharingFeature.loadInvites();

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
  closeSidebar: () => closeSidebar(),
  renderProjects: () => renderProjects(),
  renderStats: () => renderStats(),
  renderTodos: () => renderTodos(),
});
const setFilter = navigationFeature.setFilter;
const loadSectionsForCurrentProject = navigationFeature.loadSectionsForCurrentProject;
const bindNavigationHistory = navigationFeature.bindNavigationHistory;

const showProjectModal = projectsFeature.showProjectModal;
const editProject = projectsFeature.editProject;
const saveProject = projectsFeature.saveProject;
const deleteProject = projectsFeature.deleteProject;
const deleteProjectFromModal = projectsFeature.deleteProjectFromModal;
const clearDoneFromModal = projectsFeature.clearDoneFromModal;
const clearDoneInProject = projectsFeature.clearDoneInProject;

const markTodoDone = todosFeature.markTodoDone;
const markTodoInProgress = todosFeature.markTodoInProgress;
const setTodoStatus = todosFeature.setTodoStatus;
const toggleTodoPin = todosFeature.toggleTodoPin;
const snoozeTodo = todosFeature.snoozeTodo;
async function markTodoDoneFromNative(action) {
  const rawAction = typeof action === 'object' && action ? action : { id: action };
  const rawId = String(rawAction.id || '');
  const actionUserId = rawAction.userId == null ? '' : String(rawAction.userId);
  const startedAt = Date.now();
  while ((!appInitialized || !db) && Date.now() - startedAt < 30000) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!appInitialized || !db) {
    showToast?.(t('notification.action.appNotReady'));
    return false;
  }
  if (actionUserId && currentUser?.id != null && actionUserId !== String(currentUser.id)) {
    console.warn('[NativeAction] Ignored notification action for another user', { actionUserId, currentUserId: currentUser.id });
    showToast?.(t('notification.action.otherUserIgnored'));
    return false;
  }
  const numericId = /^\d+$/.test(rawId) ? Number(rawId) : rawId;
  const todo = todos.find((item) => item.id === numericId || String(item.id) === rawId);
  if (!todo) {
    console.warn('[NativeAction] Todo not found for notification action', { id: rawId, knownIds: todos.map((item) => item.id) });
    showToast?.(t('notification.action.todoNotFound', { id: rawId }));
    return false;
  }
  await markTodoDone(todo.id);
  showToast?.(t('notification.action.todoCompleted'));
  return true;
}

let nativeDoneActionPollTimer = null;
async function consumePendingNativeDoneAction() {
  let action = null;
  try {
    action = desktopIntegration?.consumePendingDoneAction?.();
  } catch (error) {
    console.warn('[NativeAction] Failed to consume pending native done action', error);
    return;
  }
  if (!action?.id) return;
  await markTodoDoneFromNative(action);
}

function startNativeDoneActionPolling() {
  if (nativeDoneActionPollTimer) return;
  consumePendingNativeDoneAction();
  nativeDoneActionPollTimer = setInterval(consumePendingNativeDoneAction, 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) consumePendingNativeDoneAction();
  });
}
const toggleTodo = todosFeature.toggleTodo;
const showTodoModal = todosFeature.showTodoModal;
const onProjectChange = todosFeature.onProjectChange;
const saveTodo = todosFeature.saveTodo;
const editTodo = todosFeature.editTodo;
const deleteTodoFromModal = todosFeature.deleteTodoFromModal;
const deleteTodo = todosFeature.deleteTodo;

const uiShell = createUiShell({
  renderMarkdown,
  showTodoModal: () => showTodoModal(),
});
const toggleSidebar = uiShell.toggleSidebar;
const closeSidebar = uiShell.closeSidebar;
const closeModal = uiShell.closeModal;
const setupDescPreview = uiShell.setupDescPreview;
uiShell.bindSidebarEdgeSwipe();
uiShell.bindTouchFeedback();
uiShell.bindKeyboardShortcuts();

// ─── Drag & Drop ─────────────────────────────────────────────────────────────

const dragDropFeature = createDragDropFeature({
  getTodos: () => todos,
  setTodos: setTodosState,
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
const bindNativePointerDragDrop = dragDropFeature.bindNativePointerDragDrop;

const toastUndoFeature = createToastUndoFeature({
  getDb: () => db,
  getTodos: () => todos,
  setTodos: setTodosState,
  dbPut,
  addToSyncQueue,
  isOnlineForSync,
  syncWithServer,
  renderStats: () => renderStats(),
  renderTodos: () => renderTodos(),
  toggleTodo: (id) => toggleTodo(id),
  onUndoLeaveProject: (data) => sharingFeature.undoLeaveProject(data),
  onUndoRemoveMember: (data) => sharingFeature.undoRemoveMember(data),
  onUndoInvite: (data) => sharingFeature.undoInvite(data),
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

const appLifecycle = createAppLifecycle({
  authApi,
  initTheme,
  checkAuth: () => checkAuth(),
  hideLoginOverlay,
  showLoginOverlay,
  renderUserInfo,
  openSettingsModal: () => openSettingsModal(),
  isMfaEnrollmentRequired: () => Boolean(currentUser?.mfa_enrollment_required || localStorage.getItem('nia-mfa-enrollment-required') === '1'),
  initServiceWorker,
  openDB,
  dbGetAll,
  setTodos: setTodosState,
  setProjects: (next) => { projects = next; },
  setSections: (next) => { sections = next; },
  setWorkspaces: (next) => { workspaces = next; },
  setCurrentFilter: (next) => { currentFilter = next; },
  setCurrentProjectId: (next) => { currentProjectId = next; },
  setCurrentWorkspaceId: (next) => { currentWorkspaceId = next; },
  ensureCurrentWorkspace: () => ensureCurrentWorkspace(),
  setAppInitialized: (next) => { appInitialized = next; },
  connectWebSocket,
  getWsState: () => wsClient.getWsState(),
  isOnlineForSync,
  syncWithServer,
  refreshFromServer,
  updateConnectionStatus,
  renderVersionInfo,
  renderProjects,
  renderStats,
  renderTodos,
  updateToggleDoneButton,
  updateSortButton,
  updateProjectWidgetButton,
  renderWorkspaces,
});
const initApp = async function() {
  await appLifecycle.initApp();
  if (sharingFeature?.loadInvites) {
    sharingFeature.loadInvites();
  }
};
const loadFromLocalDB = appLifecycle.loadFromLocalDB;
const loadAll = appLifecycle.loadAll;

let startupBound = false;

export function startAppModule() {
  window.__niaAppModuleStarted = true;
  if (startupBound) {
    console.log('[boot] startAppModule: already bound');
    return;
  }
  startupBound = true;
  appLifecycle.bindNetworkEvents();
  appLifecycle.bindDomReady();
  bindUserMenu();
  hydrateIcons(document);
  confirmDialogFeature.bindConfirmDialog();
  appDownloadsFeature.initAppDownloads();
  bindNativePointerDragDrop();
  bindTodayFocusHotkey();
  bindNavigationHistory();
  document.addEventListener('click', (event) => {
    const box = document.getElementById('search-box');
    const input = document.getElementById('search-input');
    if (!box?.classList.contains('open') || box.contains(event.target) || input?.value) return;
    box.classList.remove('open');
  });
  desktopIntegration?.init();
  startNativeDoneActionPolling();
  window.addEventListener('nia-language-change', () => {
    translatePage(document);
    applyTheme(localStorage.getItem('theme') || 'system');
    renderProjects();
    renderWorkspaces();
    renderStats();
    renderTodos();
    updateToggleDoneButton();
    updateSortButton();
    updateProjectWidgetButton();
    updateTodayFocusButton();
    hydrateIcons(document);
  });
  setInterval(() => renderStats(), 30 * 1000);

  // Expose legacy inline handlers for module-loaded frontend.
  exposeLegacyGlobals({
  auth: { getAuthToken, getCsrfToken, getAuthHeaders, login, checkAuth, logout, clearIndexedDB, showLoginOverlay, hideLoginOverlay, handleLogin, bindLoginForm },
  apiKeys: { loadApiKeys, renderApiKeys, createApiKey, revokeApiKey, copyApiKey },
  utils: { escapeHtml, escapeHtmlAttr, jsArg, formatDate, renderTodoItem },
  theme: { initTheme, setTheme, applyTheme, cycleTheme, setAccentPreset, setAccentIntensity, toggleAccentPresetMenu },
  websocket: { getReconnectDelay, connectWebSocket, wsSend, startPingInterval, stopPingInterval, scheduleReconnect, disconnectWebSocket, updateConnectionStatus, handleWsMessage },
  storage: { openDB, dbGetAll, dbPut, dbClear, getFromDB, deleteFromDB, clearSyncQueue, addToSyncQueue },
  sync: { isOnlineForSync, syncWithServer, refreshFromServer },
  ui: { toggleSidebar, closeSidebar, closeModal, setupDescPreview, openMobileSearch, closeMobileSearch, toggleMobileSearch },
  lifecycle: { initServiceWorker, triggerUpdate, forceReloadApp, initApp, loadFromLocalDB, loadAll },
  appDownloads: { openAppDownloadsModal },
  rendering: { renderVersionInfo, renderProjects, renderStats, renderTodos, renderSectionHeader, countByProject },
  navigation: { setFilter, loadSectionsForCurrentProject, bindNavigationHistory },
  workspaces: { renderWorkspaces, switchWorkspace, createWorkspace, showWorkspaceModal, closeWorkspaceModal, saveWorkspace, deleteWorkspaceFromModal, toggleWorkspaceMenu, closeWorkspaceMenu, loadWorkspacesFromServer },
  todos: { markTodoDone, markTodoInProgress, markTodoDoneFromNative, setTodoStatus, toggleTodo, toggleTodoPin, snoozeTodo, showTodoModal, onProjectChange, saveTodo, editTodo, deleteTodoFromModal, deleteTodo },
  projects: { showProjectModal, editProject, saveProject, deleteProject, deleteProjectFromModal, clearDoneFromModal, clearDoneInProject },
  sharing: { inviteUserToProject: () => sharingFeature.inviteByUsername(), leaveProjectFromModal: () => sharingFeature.leaveProject(), undoLeaveProject: (data) => sharingFeature.undoLeaveProject(data), undoRemoveMember: (data) => sharingFeature.undoRemoveMember(data), undoInvite: (data) => sharingFeature.undoInvite(data), acceptInvite: (pid, iid) => sharingFeature.acceptInvite(pid, iid), declineInvite: (pid, iid) => sharingFeature.declineInvite(pid, iid), showShareInput: () => sharingFeature.showShareInput() },
  projectSharing: { setProject: (project) => sharingFeature.setProject(project), applyProjectModalState: (project, canEdit, shared) => sharingFeature.applyProjectModalState(project, canEdit, shared), loadInvites: () => sharingFeature.loadInvites() },
  sections: { showAddSectionForm, saveNewSection, editSectionInline, saveSectionEdit, deleteSection },
  dragDrop: { handleTodoDragStart, handleTodoDragEnd, handleTodoDragOver, handleTodoDrop, handleSectionDragStart, handleSectionDragEnd, handleSectionDragOver, handleSectionDrop },
  viewPreferences: { toggleHideDone, updateToggleDoneButton, cycleSort, updateSortButton, sortTodoList, toggleProjectWidget, updateProjectWidgetButton, toggleTodayFocus, updateTodayFocusButton },
  toastUndo: { showToast, showBatchToast, hideToast, undoLastAction, restoreBatchTodos, restoreTodo },
    push: { updatePushStatus, updatePushSettingsUI, enablePushNotifications, disablePushNotifications, sendTestPush },
    desktopIntegration: {
      updateDesktopSetting: (key, value) => desktopIntegration?.updateSetting(key, value),
      updateDesktopServerUrl: (value) => desktopIntegration?.updateServerUrl(value),
      resetDesktopServerUrl: () => desktopIntegration?.resetServerUrl(),
      testDesktopNotification: () => desktopIntegration?.testNotification(),
      updateDesktopHotkey: (action, shortcut) => desktopIntegration?.updateHotkey(action, shortcut),
    },
    userSettings: { renderUserInfo, openSettingsModal, changeLanguagePreference, editUserDisplayName, cancelUserDisplayNameEdit, saveUserProfile, startAvatarUpload, cancelAvatarCrop, saveAvatarCrop, deleteUserAvatar, editUserEmail, cancelUserEmailEdit, saveUserEmail, changeUserPassword, startTwoFactorTotp, confirmTwoFactorTotp, disableTwoFactor, addPasskey, regenerateRecoveryCodes, removeTotpDevice, removePasskeyDevice, toggleTrustedDevicesList, revokeTrustedDevice, revokeAllTrustedDevices },
    userMenu: { toggleUserMenu, closeUserMenu, updateUserMenu },
  });

  bindLoginForm();
}
