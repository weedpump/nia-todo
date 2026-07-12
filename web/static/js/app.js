// nia-todo: Frontend app with offline-first PWA + WebSocket realtime sync
import { APP_VERSION, WS_URL } from './core/config.js';
import { escapeHtml, escapeHtmlAttr, formatDate, jsArg, renderMarkdown, truncateWords } from './core/utils.js';
import { authApi, placesApi, projectsApi, pushApi, sectionsApi, sharingApi, todosApi, workspacesApi } from './api/index.js';
import { createAuthSessionFeature } from './features/auth-session.js';
import { createAppStorage } from './storage/app-storage.js';
import { createApiKeysFeature } from './features/api-keys.js';
import { updateConnectionStatus as renderConnectionStatus } from './features/connection-status.js';
import { createPushNotificationsFeature } from './features/push-notifications.js';
import { createSectionsFeature } from './features/sections.js';
import { createServiceWorkerUpdatesFeature } from './features/service-worker-updates.js';
import { applyTheme, bindSystemThemeListener, bindThemeOptionButtons, cycleTheme, initTheme, toggleAccentPresetMenu } from './features/theme.js';
import { createUserSettingsFeature } from './features/user-settings.js';
import { createUserMenuFeature } from './features/user-menu.js';
import { createProjectsFeature } from './features/projects.js';
import { createWorkspacesFeature } from './features/workspaces.js';
import { createProjectSharingFeature } from './features/project-sharing.js';
import { createTodosFeature } from './features/todos.js';
import { createSyncFeature } from './features/sync.js';
import { createSyncController } from './features/sync-controller.js';
import { renderTodoItem } from './features/todo-rendering.js';
import { createViewPreferencesFeature } from './features/view-preferences.js';
import { createMobileSearchFeature } from './features/mobile-search.js';
import { createFocusFiltersFeature } from './features/focus-filters.js';
import { createWebSocketClient } from './features/websocket-client.js';
import { createToastUndoFeature } from './features/toast-undo.js';
import { createDragDropFeature } from './features/drag-drop.js';
import { createConfirmDialogFeature } from './features/confirm-dialog.js';
import { createDesktopIntegration } from './features/desktop-integration.js';
import { createAppDownloadsFeature } from './features/app-downloads.js';
import { createWhatsNewFeature } from './features/whats-new.js';
import { createAppRenderingFeature } from './features/app-rendering.js';
import { createCalendarViewFeature } from './features/calendar-view.js';
import { createNavigationFeature } from './features/navigation.js';
import { createSectionActionsFeature } from './features/section-actions.js';
import { createBrainDumpLiveFeature } from './features/braindump-live.js';
import { createUiShell } from './features/ui-shell.js';
import { createAppLifecycle } from './features/app-lifecycle.js';
import { createOidcNoticeFeature } from './features/oidc-notice.js';
import { exposeRuntimeGlobals } from './features/runtime-globals.js';
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
let minimalTodos = localStorage.getItem('nia-minimal-todos') === 'true';
let desktopIntegration = null;
let syncController = null;

const {
  getFocusFilters,
  getFocusFiltersExpanded,
  getFocusProjectMenuOpen,
  getFocusProjectSearch,
  bindFocusProjectMenuDismissal,
} = createFocusFiltersFeature({ renderTodos: () => renderTodos() });

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
const alertInfo = confirmDialogFeature.alertInfo;
const appDownloadsFeature = createAppDownloadsFeature();
const bindAppDownloadLaunchers = appDownloadsFeature.bindAppDownloadLaunchers;
const whatsNewFeature = createWhatsNewFeature({
  appVersion: APP_VERSION,
  getCurrentUser: () => currentUser,
});
const brainDumpLiveFeature = createBrainDumpLiveFeature({
  getProjects: () => projects,
  getSections: () => sections,
  getCurrentWorkspaceId: () => currentWorkspaceId,
  placesApi,
});
const viewPreferences = createViewPreferencesFeature({
  getHideDone: () => hideDone,
  setHideDone: (value) => { hideDone = value; },
  getSortMode: () => sortMode,
  setSortMode: (value) => { sortMode = value; },
  getShowProjectWidget: () => showProjectWidget,
  setShowProjectWidget: (value) => { showProjectWidget = value; },
  getTodayFocus: () => todayFocus,
  setTodayFocus: (value) => { todayFocus = value; },
  getMinimalTodos: () => minimalTodos,
  setMinimalTodos: (value) => { minimalTodos = value; },
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
const toggleMinimalTodos = viewPreferences.toggleMinimalTodos;
const updateMinimalTodosButton = viewPreferences.updateMinimalTodosButton;
const bindTopbarPreferenceButtons = viewPreferences.bindTopbarPreferenceButtons;
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
  renderStats: () => renderStats(),
  renderTodos: () => renderTodos(),
});
const todosFeature = createTodosFeature({
  getTodos: () => todos,
  setTodos: setTodosState,
  getProjects: () => projects,
  getCurrentProjectId: () => currentProjectId,
  getCurrentWorkspaceId: () => currentWorkspaceId,
  getCurrentUser: () => currentUser,
  setCurrentUser: (next) => { currentUser = next; userMenuFeature.updateUserMenu(); },
  getAppInitialized: () => appInitialized,
  getDb: () => db,
  dbPut,
  dbGetAll,
  deleteFromDB,
  addToSyncQueue,
  isOnlineForSync,
  syncWithServer,
  todosApi,
  sectionsApi,
  placesApi,
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
  confirmDanger,
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
const userMenuFeature = createUserMenuFeature({
  getCurrentUser: () => currentUser,
  openSettingsModal: () => openSettingsModal(),
  cycleTheme: () => cycleTheme(),
  toggleAccentPresetMenu: (event) => toggleAccentPresetMenu(event),
  cycleSort: () => cycleSort(),
  toggleHideDone: () => toggleHideDone(),
  toggleProjectWidget: () => toggleProjectWidget(),
  logout: () => logout(),
});
const userSettingsFeature = createUserSettingsFeature({
  authApi,
  placesApi,
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
const serviceWorkerUpdates = createServiceWorkerUpdatesFeature();
const initServiceWorker = serviceWorkerUpdates.initServiceWorker;
const bindServiceWorkerUpdateButtons = serviceWorkerUpdates.bindServiceWorkerUpdateButtons;

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
const bindUserSettingsActions = userSettingsFeature.bindUserSettingsActions;
const openSettingsModal = userSettingsFeature.openSettingsModal;
const loadSavedPlaces = userSettingsFeature.loadSavedPlaces;
const updateUserMenu = userMenuFeature.updateUserMenu;
const bindUserMenu = userMenuFeature.bindUserMenu;
// ─── API Keys ────────────────────────────────────────────────────────────────

const resetApiKeyUi = apiKeysFeature.resetApiKeyUi;
const loadApiKeys = apiKeysFeature.loadApiKeys;
const renderApiKeys = apiKeysFeature.renderApiKeys;
const revokeApiKey = apiKeysFeature.revokeApiKey;
const bindApiKeyActions = apiKeysFeature.bindApiKeyActions;

// ─── Theme System ───────────────────────────────────────────────────────────

bindSystemThemeListener();
bindThemeOptionButtons();

// ─── WebSocket ───────────────────────────────────────────────────────────────
const wsClient = createWebSocketClient({
  wsUrl: WS_URL,
  getAuthToken: () => getAuthToken(),
  syncWithServer: () => syncWithServer(),
  refreshFromServer: () => refreshFromServer(),
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

const {
  openMobileSearch,
  bindMobileSearchEvents,
  bindTodayFocusHotkey,
} = createMobileSearchFeature({
  renderStats: () => renderStats(),
  renderTodos: () => renderTodos(),
  toggleTodayFocus: () => toggleTodayFocus(),
  toggleMinimalTodos: () => toggleMinimalTodos(),
});

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
  return syncController.isOnlineForSync();
}

async function syncWithServer() {
  await syncController.syncWithServer();
}

async function refreshFromServer() {
  await syncController.refreshFromServer();
}

const calendarViewFeature = createCalendarViewFeature({
  escapeHtml,
  escapeHtmlAttr,
  renderTodos: () => renderTodos(),
  openTodo: (id) => todosFeature.editTodo(id),
  setTodoStatus: (id, status) => todosFeature.setTodoStatus(id, status),
});

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
const bindSectionActions = sectionActions.bindSectionActions;
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
  getFocusFilters,
  getFocusFiltersExpanded,
  getFocusProjectMenuOpen,
  getFocusProjectSearch,
  sortTodoList,
  renderTodoItem,
  renderSectionHeader,
  renderCalendarView: calendarViewFeature.renderCalendarView,
  cleanupCalendarView: calendarViewFeature.cleanupCalendarView,
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
syncController = createSyncController({
  syncFeature,
  syncInProgressRef,
  getWsState: () => wsClient.getWsState(),
  updateConnectionStatusView,
  setSyncInProgress: (next) => { syncInProgress = next; },
  ensureCurrentWorkspace: () => ensureCurrentWorkspace(),
  renderWorkspaces: () => renderWorkspaces(),
  renderProjects: () => renderProjects(),
  renderStats: () => renderStats(),
  renderTodos: () => renderTodos(),
});
const bindWorkspaceControls = workspacesFeature.bindWorkspaceControls;
const ensureCurrentWorkspace = workspacesFeature.ensureCurrentWorkspace;

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
  showProjectModal: () => showProjectModal(),
});
const setFilter = navigationFeature.setFilter;
const loadSectionsForCurrentProject = navigationFeature.loadSectionsForCurrentProject;
const bindNavigationActions = navigationFeature.bindNavigationActions;
const bindNavigationHistory = navigationFeature.bindNavigationHistory;

const showProjectModal = projectsFeature.showProjectModal;
const deleteProject = projectsFeature.deleteProject;
const bindProjectActions = projectsFeature.bindProjectActions;
const clearDoneFromModal = projectsFeature.clearDoneFromModal;

const markTodoDone = todosFeature.markTodoDone;
const markTodoInProgress = todosFeature.markTodoInProgress;
const setTodoStatus = todosFeature.setTodoStatus;
const toggleTodoPin = todosFeature.toggleTodoPin;
const deleteTodoComment = todosFeature.deleteTodoComment;
const deleteTodoAttachment = todosFeature.deleteTodoAttachment;
const snoozeTodo = todosFeature.snoozeTodo;
const duplicateTodo = todosFeature.duplicateTodo;
const toggleTodo = todosFeature.toggleTodo;
const showTodoModal = todosFeature.showTodoModal;
const bindTodoActions = todosFeature.bindTodoActions;
const saveTodo = todosFeature.saveTodo;
const editTodo = todosFeature.editTodo;
const deleteTodoFromModal = todosFeature.deleteTodoFromModal;
const deleteTodo = todosFeature.deleteTodo;

const uiShell = createUiShell({
  renderMarkdown,
  showTodoModal: () => showTodoModal(),
});
const closeSidebar = uiShell.closeSidebar;
const closeModal = uiShell.closeModal;
const setupDescPreview = uiShell.setupDescPreview;
const bindModalCloseControls = uiShell.bindModalCloseControls;
const bindSidebarControls = uiShell.bindSidebarControls;
uiShell.bindSidebarEdgeSwipe();
uiShell.bindTouchFeedback();
uiShell.bindDateTimePickerOpeners();
uiShell.bindKeyboardShortcuts();

// ─── Drag & Drop ─────────────────────────────────────────────────────────────

const dragDropFeature = createDragDropFeature({
  getTodos: () => todos,
  setTodos: setTodosState,
  getProjects: () => projects,
  getSections: () => sections,
  setSections: (next) => { sections = next; },
  isOnlineForSync,
  todosApi,
  sectionsApi,
  renderTodos: () => renderTodos(),
  renderProjects: () => renderProjects(),
  dbGetAll,
  dbPut,
  addToSyncQueue,
});
const bindStandardDragDrop = dragDropFeature.bindStandardDragDrop;
const bindNativePointerDragDrop = dragDropFeature.bindNativePointerDragDrop;

const { consumeOidcErrorNotice } = createOidcNoticeFeature({
  t,
  showLoginOverlay,
  alertInfo,
});

const toastUndoFeature = createToastUndoFeature({
  getDb: () => db,
  getTodos: () => todos,
  setTodos: setTodosState,
  dbPut,
  dbGetAll,
  deleteFromDB,
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
const bindToastControls = toastUndoFeature.bindToastControls;
const restoreBatchTodos = toastUndoFeature.restoreBatchTodos;
const restoreTodo = toastUndoFeature.restoreTodo;

// ─── Push Notifications ────────────────────────────────────────────────────

const updatePushStatus = pushFeature.updatePushStatus;
const updatePushSettingsUI = pushFeature.updatePushSettingsUI;
const bindPushActions = pushFeature.bindPushActions;

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
  updateTodayFocusButton,
  updateMinimalTodosButton,
  renderWorkspaces,
  refreshInvites: () => sharingFeature?.loadInvites?.(),
  onAppReady: () => {
    brainDumpLiveFeature.init();
    whatsNewFeature.maybeShowWhatsNew().catch((error) => {
      console.warn("What's new content unavailable:", error);
    });
  },
});
const initApp = async function() {
  await appLifecycle.initApp();
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
  bindUserSettingsActions();
  bindApiKeyActions();
  bindPushActions();
  desktopIntegration?.bindDesktopActions?.();
  hydrateIcons(document);
  confirmDialogFeature.bindConfirmDialog();
  consumeOidcErrorNotice();
  bindServiceWorkerUpdateButtons();
  bindAppDownloadLaunchers();
  whatsNewFeature.bindWhatsNewActions();
  appDownloadsFeature.initAppDownloads();
  brainDumpLiveFeature.init();
  bindStandardDragDrop();
  bindNativePointerDragDrop();
  bindMobileSearchEvents();
  bindTopbarPreferenceButtons();
  bindTodayFocusHotkey();
  bindSidebarControls();
  bindModalCloseControls();
  bindToastControls();
  bindWorkspaceControls();
  bindTodoActions();
  sharingFeature.bindProjectSharingActions();
  bindProjectActions();
  bindSectionActions();
  bindNavigationActions();
  bindNavigationHistory();
  bindFocusProjectMenuDismissal();
  document.addEventListener('click', (event) => {
    const box = document.getElementById('search-box');
    const input = document.getElementById('search-input');
    if (!box?.classList.contains('open') || box.contains(event.target) || input?.value) return;
    box.classList.remove('open');
  });
  desktopIntegration?.init();
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
    updateMinimalTodosButton();
    hydrateIcons(document);
  });
  setInterval(() => renderStats(), 30 * 1000);

  // Expose runtime globals needed by native integrations and cross-module callbacks.
  exposeRuntimeGlobals({
  auth: { getAuthToken, getCsrfToken, getAuthHeaders, login, checkAuth, logout, clearIndexedDB, showLoginOverlay, hideLoginOverlay, handleLogin, bindLoginForm },
  apiKeys: { loadApiKeys, renderApiKeys, revokeApiKey },
  utils: { escapeHtml, escapeHtmlAttr, jsArg, formatDate, renderTodoItem },
  theme: { initTheme, applyTheme, cycleTheme, toggleAccentPresetMenu },
  websocket: { getReconnectDelay, connectWebSocket, wsSend, startPingInterval, stopPingInterval, scheduleReconnect, disconnectWebSocket, updateConnectionStatus, handleWsMessage },
  storage: { openDB, dbGetAll, dbPut, dbClear, getFromDB, deleteFromDB, clearSyncQueue, addToSyncQueue },
  sync: { isOnlineForSync, syncWithServer, refreshFromServer },
  ui: { closeSidebar, closeModal, setupDescPreview, openMobileSearch },
  lifecycle: { initServiceWorker, initApp, loadFromLocalDB, loadAll },
  rendering: { renderVersionInfo, renderProjects, renderStats, renderTodos, renderSectionHeader, countByProject, renderInvites },
  navigation: { setFilter, loadSectionsForCurrentProject, bindNavigationHistory },
  todos: { markTodoDone, markTodoInProgress, deleteTodoComment, deleteTodoAttachment, saveTodo, editTodo, deleteTodoFromModal },
  projects: { showProjectModal, deleteProject, clearDoneFromModal },
  projectSharing: { setProject: (project) => sharingFeature.setProject(project), applyProjectModalState: (project, canEdit, shared) => sharingFeature.applyProjectModalState(project, canEdit, shared), loadInvites: () => sharingFeature.loadInvites() },
  viewPreferences: { updateToggleDoneButton, updateSortButton, sortTodoList, updateProjectWidgetButton },
  toastUndo: { showToast, showBatchToast, restoreBatchTodos, restoreTodo },
    push: { updatePushStatus, updatePushSettingsUI },
    desktopIntegration: {
      updateDesktopSetting: (key, value) => desktopIntegration?.updateSetting(key, value),
      updateDesktopServerUrl: (value) => desktopIntegration?.updateServerUrl(value),
      resetDesktopServerUrl: () => desktopIntegration?.resetServerUrl(),
      updateDesktopHotkey: (action, shortcut) => desktopIntegration?.updateHotkey(action, shortcut),
    },
    userSettings: { renderUserInfo, openSettingsModal, loadSavedPlaces },
    userMenu: { updateUserMenu },
  });

  bindLoginForm();
}
