import { createRoutingMemoryFeature } from './features/routing-memory.js';
import { createRecipeShoppingTransferController } from './features/recipe-shopping-pending.js';
import { createRecipeShoppingTransferFeature } from './features/recipe-shopping-transfer.js';
// nia-todo: Frontend app with offline-first PWA + WebSocket realtime sync
import { APP_VERSION, RUNTIME_CAPABILITIES, WS_URL, apiResourceUrl } from './core/config.js';
import { escapeHtml, escapeHtmlAttr, formatDate, jsArg, renderMarkdown, truncateWords, updateCachedUserMetadata } from './core/utils.js';
import { authApi, householdsApi, placesApi, projectsApi, pushApi, sectionsApi, sharingApi, shoppingApi, todosApi, workspacesApi, serverUpdatesApi } from './api/index.js';
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
import { createHouseholdsFeature } from './features/households.js';
import { createProjectsFeature } from './features/projects.js';
import { createWorkspacesFeature } from './features/workspaces.js';
import { createProjectSharingFeature } from './features/project-sharing.js';
import { createTodosFeature } from './features/todos.js';
import { createSyncFeature } from './features/sync.js';
import { acquireSyncCommitLock, beginSyncQueueWrite, enrichTaskQueueBoundary } from './features/todo-pending.js';
import { runEntityPrivacyEviction } from './features/entity-access-privacy.js';
import { createSyncController } from './features/sync-controller.js';
import { renderTodoItem } from './features/todo-rendering.js';
import { createViewPreferencesFeature } from './features/view-preferences.js';
import { createCompletedVisibilityFeature } from './features/completed-visibility.js';
import { getEffectiveDashboardPreferences, loadDashboardPreferences, saveDashboardPreferences } from './features/dashboard-preferences.js';
import { createDashboardPreferencesFeature } from './features/dashboard-preferences-dialog.js';
import { createDashboardPreferencesSync } from './features/dashboard-preferences-sync.js';
import { createDashboardDrilldownFeature } from './features/dashboard-drilldown.js';
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
import { recipesApi } from './api/recipes.js';
import { createRecipeController } from './features/recipe-mutations.js';
import { createRecipeViewFeature } from './features/recipe-view.js';
import { createRecipeImportFeature } from './features/recipe-import.js';
import { createRecipeEditorFeature } from './features/recipe-editor.js';
import { createRecipeImagesFeature, prepareRecipeImage } from './features/recipe-images.js';
import { createCookbooksController } from './features/cookbooks.js';
import { createEntityMutationQueue } from './features/entity-metadata.js';
import { entityIdentity, resolveEntityIdentity } from './core/entity-identity.js';
import { createCookbookNavigationFeature } from './features/cookbook-navigation.js';
import { createCookbookDetailsFeature } from './features/cookbook-details.js';
import { createShoppingNavigationFeature } from './features/shopping-navigation.js';
import { createShoppingItemsController } from './features/shopping-items.js';
import { createShoppingItemEditorFeature } from './features/shopping-item-editor.js';
import { createShoppingStoresController } from './features/shopping-stores.js';
import { createShoppingStoreEditorFeature } from './features/shopping-store-editor.js';
import { createShoppingListDetailsFeature } from './features/shopping-list-details.js';
import { createSectionActionsFeature } from './features/section-actions.js';
import { createSectionRootRegistry } from './features/section-ui.js';
import { createShoppingSectionsAdapter } from './features/shopping-sections.js';
import { createShoppingViewPreferencesFeature } from './features/shopping-view-preferences.js';
import { createBrainDumpLiveFeature } from './features/braindump-live.js';
import { createUiShell } from './features/ui-shell.js';
import { createModuleShell } from './features/module-shell.js';
import { createModuleSwitcher } from './features/module-switcher.js';
import { createDateTimePickerFeature } from './features/date-time-picker.js';
import { createAppLifecycle } from './features/app-lifecycle.js';
import { createOidcNoticeFeature } from './features/oidc-notice.js';
import { createServerUpdateIndicator } from './features/server-update-indicator.js';
import { createAboutFeature } from './features/about.js';
import { createShortcutHelpFeature } from './features/shortcut-help.js';
import { bindUiHistory } from './features/ui-history.js';
import { exposeRuntimeGlobals } from './features/runtime-globals.js';
import { removeCachedAvatar } from './core/authenticated-image.js';
import { promptSecurityText } from './features/security-dialogs.js';
import { t, translatePage } from './i18n/index.js';
import { hydrateIcons } from './icons/lucide-icons.js';
let todos = [];
let projects = [];
let sections = [];
let workspaces = [];
let shoppingLists = [];
let shoppingStores = [];
let cookbooks = [];
let authenticatedRuntimeEpoch = 0;
let routingMemory = null;
let currentFilter = 'all';
let currentProjectId = null;
let currentWorkspaceId = null;
let db = null;
let appInitialized = false;
let syncInProgress = false;
let hideDone = localStorage.getItem('nia-hide-done') !== 'false';
let sortMode = localStorage.getItem('nia-sort') || 'priority';
let dashboardPreferences = loadDashboardPreferences(localStorage);
let dashboardDrilldown = null;
let showProjectWidget = dashboardPreferences.showProjectWidgets;
let todayFocus = localStorage.getItem('nia-today-focus') === 'true';
let minimalTodos = localStorage.getItem('nia-minimal-todos') === 'true';
let desktopIntegration = null;
let syncController = null;
let dashboardPreferencesSyncFeature = null;
let moduleShell = null;
let moduleSwitcher = null;
let shoppingNavigationFeature = null;
let shoppingListDetailsFeature = null;
let shoppingItemEditorFeature = null;
let shoppingStoreEditorFeature = null;
let shoppingViewPreferencesFeature = null;
let completedVisibilityFeature = null;
let cookbookNavigationFeature = null;
let cookbookDetailsFeature = null;
let recipeViewFeature = null;
let recipeEditorFeature = null;
let recipeImportFeature = null;
let recipeShoppingTransferFeature = null;

function renderCookbooks() { cookbookNavigationFeature?.render(); recipeShoppingTransferFeature?.reconcile(); }
function remapCookbookId(from, to) {
  recipeImportFeature?.remapCookbookId(from, to);
  cookbookDetailsFeature?.remapCookbookId(from, to);
  cookbookNavigationFeature?.remapCookbookId(from, to);
}
function remapRecipeId(from, to) {
  recipeEditorFeature?.remapRecipeId(from, to);
  recipeViewFeature?.remapRecipeId(from, to);
}
function setCookbooksState(next) {
  const previousRecipes = cookbooks.flatMap(book => book.recipes || []);
  const books = Array.isArray(next) ? next : [];
  const remaps = [];
  for (const recipe of books.flatMap(book => book.recipes || [])) {
    if (currentUser?.id == null || String(recipe.created_by_user_id) !== String(currentUser.id) || recipe.client_mutation_id == null) continue;
    const old = previousRecipes.find(old => String(old.id).startsWith('temp-')
      && String(old.created_by_user_id) === String(currentUser?.id)
      && old.client_mutation_id === recipe.client_mutation_id && String(old.id) !== String(recipe.id));
    if (old) remaps.push([old.id, recipe.id]);
  }
  if (cookbookNavigationFeature) cookbookNavigationFeature.replaceCookbooks(books);
  else cookbooks = books;
  for (const [from, to] of remaps) remapRecipeId(from, to);
  cookbookDetailsFeature?.reconcileCookbooksChanged();
  recipeEditorFeature?.reconcile();
  recipeImportFeature?.reconcile();
  recipeShoppingTransferFeature?.reconcile();
}
function getEntitySessionIdentity() {
  return currentUser ? `${currentUser.id}:${authenticatedRuntimeEpoch}` : null;
}

function renderShopping() {
  shoppingNavigationFeature?.render();
  shoppingItemEditorFeature?.reconcile?.();
  shoppingViewPreferencesFeature?.updateButton?.();
  completedVisibilityFeature?.updateButtons?.();
}

function setShoppingListsState(next, { reconcileDetails = true } = {}) {
  const previousActiveListId = shoppingNavigationFeature?.getActiveListId?.() ?? null;
  shoppingLists = Array.isArray(next) ? next : [];
  void routingMemory?.refresh();
  shoppingNavigationFeature?.replaceLists(shoppingLists);
  shoppingItemEditorFeature?.reconcile?.();
  recipeShoppingTransferFeature?.reconcile();
  if (!reconcileDetails) return;
  const detailsOwnTransition = shoppingListDetailsFeature?.reconcileListsChanged?.() || false;
  const activeListId = shoppingNavigationFeature?.getActiveListId?.() ?? null;
  const selectionChanged = String(previousActiveListId ?? '') !== String(activeListId ?? '');
  if (!detailsOwnTransition && selectionChanged && moduleShell?.getActiveModule?.() === 'shopping') {
    shoppingNavigationFeature?.normalizeActiveListNavigation();
    shoppingNavigationFeature?.focusActiveListAction();
  }
}

function setShoppingStoresState(next) {
  shoppingStores = Array.isArray(next) ? next : [];
  recipeShoppingTransferFeature?.reconcile();
  renderShopping();
}

function getCurrentWorkspace() {
  return workspaces.find(workspace => String(workspace.id) === String(currentWorkspaceId)) || null;
}

function setWorkspacesState(next) {
  workspaces = next;
  moduleSwitcher?.render();
}

function setCurrentWorkspaceState(next) {
  currentWorkspaceId = next;
  dashboardPreferences = loadDashboardPreferences(localStorage, currentWorkspaceId);
  showProjectWidget = dashboardPreferences.showProjectWidgets;
  moduleSwitcher?.render();
}

const {
  getFocusFilters,
  getFocusFiltersExpanded,
  getFocusProjectMenuOpen,
  getFocusProjectSearch,
  bindFocusProjectMenuDismissal,
} = createFocusFiltersFeature({ renderTodos: () => renderTodos() });

function setTodosState(next, { nativeReminderSnapshotAuthoritative = true } = {}) {
  todos = next;
  desktopIntegration?.syncLocalReminders(todos, { authoritative: nativeReminderSnapshotAuthoritative });
}

// ─── Auth / User (JWT) ───────────────────────────────────────────────────────

let currentUser = null;  // { id, username, display_name, token }
routingMemory = createRoutingMemoryFeature({
  getActorId: () => currentUser?.id ?? null, getSessionIdentity: getEntitySessionIdentity,
  getLists: () => shoppingLists, getStores: () => shoppingStores,
  getProjects: () => projects, getSections: () => sections,
  getEnabled: () => currentUser?.braindump_learning_enabled !== false && currentUser?.braindump_learning_enabled !== 0,
  onEnabledChange: enabled => {
    if (!currentUser || currentUser.braindump_learning_enabled === enabled) return;
    currentUser = { ...currentUser, braindump_learning_enabled: enabled };
    try {
      const cached = JSON.parse(localStorage.getItem('cached_user') || 'null');
      if (cached && String(cached.id) === String(currentUser.id)) localStorage.setItem('cached_user', JSON.stringify({ ...cached, braindump_learning_enabled: enabled }));
    } catch { /* A later authenticated refresh replaces invalid user metadata. */ }
  },
});

function persistCachedAvatarMetadata(payload) {
  if (!currentUser?.id) return;
  try {
    const cached = JSON.parse(localStorage.getItem('cached_user') || 'null');
    if (!cached || String(cached.id) !== String(currentUser.id)) return;
    localStorage.setItem('cached_user', JSON.stringify({
      ...cached,
      avatar_url: payload.avatar_url ?? null,
      avatar_updated_at: payload.avatar_updated_at ?? null,
    }));
  } catch (_error) {
    // The next successful auth refresh will replace malformed cached metadata.
  }
}
const apiKeysFeature = createApiKeysFeature({ authApi });
const pushFeature = createPushNotificationsFeature({ pushApi });
const confirmDialogFeature = createConfirmDialogFeature();
const dateTimePickerFeature = createDateTimePickerFeature();
const confirmDanger = confirmDialogFeature.confirmDanger;
const sectionRegistry = createSectionRootRegistry();
const alertInfo = confirmDialogFeature.alertInfo;
const appDownloadsFeature = createAppDownloadsFeature();
const serverUpdateIndicator = createServerUpdateIndicator({ serverUpdatesApi });
const serviceWorkerUpdates = createServiceWorkerUpdatesFeature({ appVersion: APP_VERSION });
const aboutFeature = createAboutFeature({
  appVersion: APP_VERSION,
  serverUpdatesApi,
  openAppDownloadsModal: options => appDownloadsFeature.openAppDownloadsModal(options),
  getClientUpdateStatus: async () => {
    if (RUNTIME_CAPABILITIES.native) {
      return appDownloadsFeature.readNativeAppUpdateStatus();
    }
    return serviceWorkerUpdates.refreshUpdateStatus();
  },
});
const shortcutHelpFeature = createShortcutHelpFeature();
const bindAppDownloadLaunchers = appDownloadsFeature.bindAppDownloadLaunchers;
const whatsNewFeature = createWhatsNewFeature({
  appVersion: APP_VERSION,
  getCurrentUser: () => currentUser,
});
const brainDumpLiveFeature = createBrainDumpLiveFeature({
  getActorId: () => currentUser?.id ?? null,
  onAccessChange: () => { recipeEditorFeature?.reconcile(); recipeImportFeature?.reconcile(); },
  routingMemory,
  loadTaskSections: () => dbGetAll('sections'),
  getProjects: () => projects,
  getSections: () => sections,
  getCurrentWorkspaceId: () => currentWorkspaceId,
  getLauncherRoot: () => document.getElementById('module-floating-slot'),
  getActiveModule: () => moduleShell?.getActiveModule?.() || 'tasks',
  getSupportedModules: () => (moduleShell?.getEnabledModules?.() || [])
    .map(module => module.id).filter(id => ['tasks', 'shopping'].includes(id)),
  getShoppingLists: () => shoppingLists,
  getShoppingStores: () => shoppingStores,
  createShoppingCandidates: async (candidates, { isCurrent = () => true } = {}) => {
    const listId = candidates[0]?.shopping_list_id;
    if (listId == null || !candidates.length
      || candidates.some(candidate => String(candidate.shopping_list_id) !== String(listId))) {
      throw new Error(t('capture.target.required'));
    }
    const created = await shoppingItemsController.createManyForList({
      listId,
      isCurrent,
      items: candidates.map(candidate => ({
        name: candidate.title,
        quantity_value: candidate.quantity_value,
        quantity_unit: candidate.quantity_unit,
        section_id: candidate.shopping_section_id,
        store_ids: candidate.shopping_store_ids || [],
        client_mutation_id: candidate.client_mutation_id,
        braindump_route: candidate.braindump_route,
        ...(candidate.routing_feedback ? { routing_feedback: candidate.routing_feedback } : {}),
      })),
    });
    if (!Array.isArray(created) || created.length !== candidates.length) {
      throw new Error(t('capture.target.required'));
    }
    return created;
  },
  placesApi,
});
const viewPreferences = createViewPreferencesFeature({
  getSortMode: () => sortMode,
  setSortMode: (value) => { sortMode = value; },
  getShowProjectWidget: () => showProjectWidget,
  saveShowProjectWidget: (value) => {
    dashboardPreferences = saveDashboardPreferences(localStorage, {
      ...dashboardPreferences,
      showProjectWidgets: value,
    }, currentWorkspaceId);
    showProjectWidget = dashboardPreferences.showProjectWidgets;
  },
  getTodayFocus: () => todayFocus,
  setTodayFocus: (value) => { todayFocus = value; },
  getMinimalTodos: () => minimalTodos,
  setMinimalTodos: (value) => { minimalTodos = value; },
  renderTodos: () => renderTodos(),
  renderStats: () => renderStats(),
});
completedVisibilityFeature = createCompletedVisibilityFeature({
  getHidden: () => hideDone,
  setHidden: value => { hideDone = value; },
  translate: t,
  renderTasks: () => renderTodos(),
  renderShopping: () => renderShopping(),
});
const updateToggleDoneButton = completedVisibilityFeature.updateButtons;
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

async function addToSyncQueue(action, data, { reserved = false } = {}) {
  const finishQueueWrite = reserved ? () => {} : await beginSyncQueueWrite(syncInProgressRef);
  try {
    const enrichedData = enrichTaskQueueBoundary(action, data, { todos, sections, projects });
    const result = await appStorage.addToSyncQueue(action, enrichedData);
    updateConnectionStatusView().catch(() => {});
    return result;
  } finally {
    finishQueueWrite();
  }
}
async function runSyncQueueMutation(operation) {
  const finishQueueWrite = await beginSyncQueueWrite(syncInProgressRef);
  const boundaryState = {
    todos: [...todos],
    sections: [...sections],
    projects: [...projects],
  };
  try {
    return await operation((action, data) => addToSyncQueue(
      action,
      enrichTaskQueueBoundary(action, data, boundaryState),
      { reserved: true },
    ));
  } finally {
    finishQueueWrite();
  }
}
async function commitTodoUpdatesWithQueue(operation) {
  const finishQueueWrite = await beginSyncQueueWrite(syncInProgressRef);
  const boundaryState = {
    todos: [...todos],
    sections: [...sections],
    projects: [...projects],
  };
  try {
    return await operation(updates => appStorage.commitTodoUpdatesWithQueue(updates.map(update => ({
      ...update,
      queueData: enrichTaskQueueBoundary('UPDATE_TODO', {
        id: update.todo.id,
        project_id: update.todo.project_id,
        changes: update.changes,
      }, boundaryState),
    }))));
  } finally {
    finishQueueWrite();
  }
}
async function commitShoppingMutation(buildMutation) {
  const session = getEntitySessionIdentity();
  if (session == null) return null;
  const finishQueueWrite = await beginSyncQueueWrite(syncInProgressRef);
  try {
    if (session !== getEntitySessionIdentity()) return null;
    const mutation = typeof buildMutation === 'function' ? buildMutation() : buildMutation;
    if (!mutation) return null;
    await appStorage.commitShoppingMutation(mutation);
    return session === getEntitySessionIdentity() ? mutation : null;
  } finally {
    finishQueueWrite();
  }
}
const enqueueShoppingListMutation = createEntityMutationQueue({ getSessionIdentity: getEntitySessionIdentity });
const syncInProgressRef = { value: syncInProgress };
const enqueueCookbookMutation = createEntityMutationQueue({ getSessionIdentity: getEntitySessionIdentity });
async function commitCookbookMutation(buildMutation) {
  const finishQueueWrite = await beginSyncQueueWrite(syncInProgressRef);
  try {
    const mutation = buildMutation();
    if (!mutation) return null;
    await appStorage.commitCookbookMutation(mutation);
    updateConnectionStatusView().catch(() => {});
    return mutation;
  } finally { finishQueueWrite(); }
}
async function commitRecipeMutation(buildMutation) {
  const finishQueueWrite = await beginSyncQueueWrite(syncInProgressRef);
  try {
    const mutation = buildMutation();
    if (!mutation) return null;
    await appStorage.commitRecipeMutation(mutation);
    updateConnectionStatusView().catch(() => {});
    return mutation;
  } finally { finishQueueWrite(); }
}
async function commitRecipeShoppingTransfer(buildMutation) {
  const session = getEntitySessionIdentity();
  const finishQueueWrite = await beginSyncQueueWrite(syncInProgressRef);
  try {
    if (session == null || session !== getEntitySessionIdentity()) return null;
    const mutation = typeof buildMutation === 'function' ? await buildMutation() : buildMutation;
    if (!mutation || session !== getEntitySessionIdentity()) return null;
    const result = await appStorage.commitRecipeShoppingTransfer(mutation);
    updateConnectionStatusView().catch(() => {});
    return result;
  } finally { finishQueueWrite(); }
}
const activeBackgroundSyncOperations = new Set();

function trackBackgroundSyncOperation(operation) {
  if (!currentUser) return Promise.resolve();
  const accountId = String(currentUser.id);
  const task = Promise.resolve().then(() => {
    if (!currentUser || String(currentUser.id) !== accountId) return;
    return operation();
  });
  activeBackgroundSyncOperations.add(task);
  task.then(
    () => activeBackgroundSyncOperations.delete(task),
    () => activeBackgroundSyncOperations.delete(task),
  );
  return task;
}

async function waitForBackgroundSyncOperations() {
  while (activeBackgroundSyncOperations.size) {
    await Promise.allSettled([...activeBackgroundSyncOperations]);
  }
}

const syncFeature = createSyncFeature({
  onTodoIdRemap: (from, to) => {
    todosFeature.remapTodoId(from, to);
    toastUndoFeature.remapTodoId(from, to);
  },
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
  onProjectIdRemap: (from, to) => {
    todosFeature.remapPendingTargetId('project', from, to);
    navigationFeature.remapProjectId(from, to);
  },
  onSectionIdRemap: (from, to) => todosFeature.remapPendingTargetId('section', from, to),
  evictPendingProjectEntities: appStorage.evictPendingProjectEntities,
  commitTaskParentReplay: appStorage.commitTaskParentReplay,
  commitCreationTombstoneReplay: appStorage.commitCreationTombstoneReplay,
  getSections: () => sections,
  setSections: (next) => { sections = next; },
  getWorkspaces: () => workspaces,
  setWorkspaces: setWorkspacesState,
  getCookbooks: () => cookbooks,
  setCookbooks: setCookbooksState,
  getActorId: () => currentUser?.id ?? null,
  onCookbookIdRemap: remapCookbookId,
  getShoppingLists: () => shoppingLists,
  setShoppingLists: setShoppingListsState,
  getShoppingStores: () => shoppingStores,
  setShoppingStores: setShoppingStoresState,
  todosApi,
  projectsApi,
  sectionsApi,
  workspacesApi,
  recipesApi,
  commitCookbookReplay: appStorage.commitCookbookReplay,
  markCookbookMutationAttempt: appStorage.markCookbookMutationAttempt,
  commitRecipeReplay: appStorage.commitRecipeReplay,
  markRecipeMutationAttempt: appStorage.markRecipeMutationAttempt,
  markRecipeShoppingTransferAttempt: appStorage.markRecipeShoppingTransferAttempt,
  onRecipeShoppingTransferState: () => { recipeShoppingTransferFeature?.reconcile(); updateConnectionStatusView().catch(() => {}); },
  onRecipeIdRemap: remapRecipeId,
  renderCookbooks,
  onCookbookSnapshotCommitted: (serverBooks, revokedIds) => cookbookNavigationFeature?.commitAuthoritativeSnapshot(serverBooks, revokedIds),
  shoppingApi,
  commitShoppingReplay: appStorage.commitShoppingReplay,
  renderStats: () => renderStats(),
  renderTodos: () => renderTodos(),
  renderShopping: () => renderShopping(),
});
const todosFeature = createTodosFeature({
  routingMemory,
  getSessionIdentity: () => currentUser ? `${currentUser.id}:${Number(syncInProgressRef.privacyGeneration || 0)}` : null,
  getTodos: () => todos,
  setTodos: setTodosState,
  getProjects: () => projects,
  getSections: () => sections,
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
  runSyncQueueMutation,
  commitTodoUpdatesWithQueue,
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
  syncDateTimePickers: () => dateTimePickerFeature.syncAll(),
  openDateTimePicker: (trigger, options) => dateTimePickerFeature.open(trigger, options),
  getActiveModule: () => moduleShell?.getActiveModule?.() || 'tasks',
  syncInProgressRef,
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
  loadAuthoritativeProjection: async () => {
    const result = await refreshFromServer();
    if (!result?.refreshed) throw new Error('Authoritative project projection was not refreshed');
    return { projects };
  },
  removePendingEntities: async (pendingIds, { signal, getAccessibleEntities } = {}) => {
    let projectedState;
    return runEntityPrivacyEviction({
      syncInProgressRef,
      acquireCommitLock: acquireSyncCommitLock,
      signal,
      evict: () => {
        projectedState = {
          projects: [...projects],
          sections: [...sections],
          todos: [...todos],
        };
        return appStorage.evictPendingProjectEntities(pendingIds, {
          signal,
          ...projectedState,
          ...(getAccessibleEntities?.() || {}),
        });
      },
      publish: evicted => {
        const blockedProjects = new Set(evicted.projectIds.map(String));
        const blockedSections = new Set(evicted.sectionIds.map(String));
        const blockedTodos = new Set(evicted.todoIds.map(String));
        projects = projects.filter(project => !blockedProjects.has(String(project.id)));
        sections = sections.filter(section => !blockedSections.has(String(section.id)));
        setTodosState(todos.filter(todo => !blockedTodos.has(String(todo.id))));
        renderProjects();
        renderStats();
        renderTodos();
      },
    });
  },
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
  dbGetAll,
  addToSyncQueue,
  runSyncQueueMutation,
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
  getAccessSnapshot: () => window.niaAccessSnapshot || { household: null, householdInvites: [] },
  syncInProgressRef,
});
let workspacesFeature = null;
let householdsFeature = null;
const userMenuFeature = createUserMenuFeature({
  getCurrentUser: () => currentUser,
  openSettingsModal: () => openSettingsModal(),
  openHouseholdSettings: () => openHouseholdSettings(),
  openShortcutHelpModal: options => shortcutHelpFeature.openShortcutHelpModal(options),
  openAboutModal: options => aboutFeature.openAboutModal(options),
  cycleTheme: () => cycleTheme(),
  toggleAccentPresetMenu: (event) => toggleAccentPresetMenu(event),
  cycleSort: () => cycleSort(),
  toggleProjectWidget: () => toggleProjectWidget(),
  logout: () => logout(),
});
const userSettingsFeature = createUserSettingsFeature({
  routingMemory,
  authApi,
  placesApi,
  getCurrentUser: () => currentUser,
  setCurrentUser: (next) => { currentUser = next; userMenuFeature.updateUserMenu(); },
  onModulePreferencesChange: () => {
    moduleShell?.applyModulePreferences();
    moduleSwitcher?.render();
    recipeShoppingTransferFeature?.reconcile();
    renderCookbooks();
  },
  resetApiKeyUi: () => resetApiKeyUi(),
  loadApiKeys: () => loadApiKeys(),
  updatePushSettingsUI: () => updatePushSettingsUI(),
  logout: () => logout(),
});
async function disconnectAuthenticatedRuntime() {
  authenticatedRuntimeEpoch += 1;
  routingMemory?.clear();
  recipeEditorFeature?.deactivate();
  recipeImportFeature?.deactivate();
  recipeShoppingTransferFeature?.deactivate();
  syncInProgressRef.privacyGeneration = Number(syncInProgressRef.privacyGeneration || 0) + 1;
  const privacyDrains = [
    sharingFeature.suspendAccessPrivacy(),
    shoppingNavigationFeature.suspendAccessPrivacy(),
    cookbookNavigationFeature.suspendAccessPrivacy(),
  ];
  const websocketDrain = disconnectWebSocket();
  await Promise.all([
    Promise.all(privacyDrains),
    Promise.allSettled([websocketDrain, waitForBackgroundSyncOperations()]),
  ]);
}

const authSessionFeature = createAuthSessionFeature({
  authApi,
  getAppInitialized: () => appInitialized,
  setCurrentUser: (next) => { currentUser = next; userMenuFeature.updateUserMenu(); },
  onCurrentUserChange: () => {
    void routingMemory?.refresh();
    moduleShell?.applyModulePreferences();
    moduleSwitcher?.render();
    recipeShoppingTransferFeature?.reconcile();
    renderCookbooks();
  },
  clearCache: async () => {
    appInitialized = false;
    todos = [];
    projects = [];
    sections = [];
    workspaces = [];
    shoppingLists = [];
    shoppingStores = [];
    cookbooks = [];
    currentProjectId = null;
    currentFilter = 'all';
    currentWorkspaceId = null;
    dashboardDrilldown = null;
    localStorage.setItem('nia-last-filter', 'all');
    localStorage.removeItem('nia-shopping-active-list');
    localStorage.removeItem('nia-recipes-active-cookbook');
    localStorage.removeItem('nia-current-workspace');
    renderProjects();
    renderStats();
    renderTodos();
    renderShopping();
    renderCookbooks();
    await clearIndexedDB();
  },
  initApp: () => initApp(),
  refreshFromServer: () => refreshFromServer(),
  renderUserInfo: () => renderUserInfo(),
  disconnectRealtime: () => disconnectAuthenticatedRuntime(),
});
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
const showSettingsPage = userSettingsFeature.showSettingsPage;
const loadSavedPlaces = userSettingsFeature.loadSavedPlaces;
const updateUserMenu = userMenuFeature.updateUserMenu;
const bindUserMenu = userMenuFeature.bindUserMenu;
householdsFeature = createHouseholdsFeature({
  householdsApi,
  getCurrentUser: () => currentUser,
  getAccessSnapshot: () => window.niaAccessSnapshot || { household: null, householdInvites: [] },
  setAccessSnapshot: snapshot => { window.niaAccessSnapshot = snapshot; },
  showSettingsPage,
  confirmDanger,
  promptText: promptSecurityText,
  onChanged: () => refreshFromServer(),
});
const openHouseholdSettings = async () => {
  await openSettingsModal('household');
};
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
  syncInProgressRef,
  hasUnsettledSync: () => activeBackgroundSyncOperations.size > 0,
  waitForSyncSettlement: () => waitForBackgroundSyncOperations(),
  refreshFromServer: () => refreshFromServer(),
  renderConnectionStatus: (state) => updateConnectionStatusView(state),
  dbGetAll,
  dbPut,
  getFromDB,
  deleteFromDB,
  commitShoppingReplay: appStorage.commitShoppingReplay,
  commitCookbookReplay: appStorage.commitCookbookReplay,
  onRecipeIdRemap: remapRecipeId,
  getTodos: () => todos,
  setTodos: setTodosState,
  getProjects: () => projects,
  setProjects: (next) => { projects = next; },
  getSections: () => sections,
  setSections: (next) => { sections = next; },
  getWorkspaces: () => workspaces,
  setWorkspaces: setWorkspacesState,
  getCookbooks: () => cookbooks,
  setCookbooks: setCookbooksState,
  getActorId: () => currentUser?.id ?? null,
  onCookbookIdRemap: remapCookbookId,
  getShoppingLists: () => shoppingLists,
  setShoppingLists: setShoppingListsState,
  getShoppingStores: () => shoppingStores,
  setShoppingStores: setShoppingStoresState,
  renderWorkspaces: () => renderWorkspaces(),
  renderProjects: () => renderProjects(),
  renderStats: () => renderStats(),
  renderTodos: () => renderTodos(),
  renderShopping: () => renderShopping(),
  onAuthOk: () => {
    desktopIntegration?.announceNotificationReadiness();
    dashboardPreferencesSyncFeature?.refresh();
  },
  onReminderDue: () => {},
  onSessionInvalidated: () => {
    localStorage.removeItem('nia-mfa-enrollment-required');
    location.reload();
  },
  onServerUpdateStatus: (status) => serverUpdateIndicator.applyStatus(status),
  onDashboardPreferencesUpdate: payload => dashboardPreferencesSyncFeature?.applyRemote(payload),
  onModulePreferencesUpdate: payload => {
    if (!currentUser) return;
    currentUser = { ...currentUser, disabled_modules: payload.disabled_modules || [] };
    updateCachedUserMetadata(currentUser.id, { disabled_modules: currentUser.disabled_modules });
    moduleShell?.applyModulePreferences();
    moduleSwitcher?.render();
    recipeShoppingTransferFeature?.reconcile();
    renderCookbooks();
    renderUserInfo();
  },
  onAccessSnapshot: snapshot => {
    window.niaAccessSnapshot = snapshot;
    sharingFeature?.setInvites?.(snapshot.projectInvites || []);
    if (Object.prototype.hasOwnProperty.call(snapshot, 'shoppingInvites')) {
      shoppingNavigationFeature?.setInvites?.(snapshot.shoppingInvites || []);
    }
    if (Object.prototype.hasOwnProperty.call(snapshot, 'cookbookInvites')) {
      cookbookNavigationFeature?.setInvites(snapshot.cookbookInvites || []);
    }
    window.dispatchEvent(new CustomEvent('nia:access-snapshot', { detail: snapshot }));
  },
  onEntitySnapshotsCommitted: snapshots => {
    if (Array.isArray(snapshots?.cookbooks)) cookbookNavigationFeature?.commitAuthoritativeSnapshot(snapshots.cookbooks, snapshots.revokedCookbookIds || []);
    if (Array.isArray(snapshots?.projects)) sharingFeature?.commitAuthoritativeSnapshot?.(snapshots.projects, snapshots.revokedProjectIds || [], snapshots.taskAccessSnapshot);
    if (Array.isArray(snapshots?.shoppingLists)) {
      shoppingNavigationFeature?.commitAuthoritativeSnapshot?.(
        snapshots.shoppingLists,
        snapshots.revokedShoppingListIds || [],
      );
    }
  },
  onAvatarUpdate: async payload => {
    if (!currentUser) return;
    const previousAvatarUrl = currentUser.avatar_url;
    if (!payload.avatar_url && previousAvatarUrl) {
      await removeCachedAvatar(apiResourceUrl(previousAvatarUrl), { userId: currentUser.id });
    }
    currentUser = { ...currentUser, ...payload };
    persistCachedAvatarMetadata(payload);
    updateUserMenu();
    renderUserInfo();
    renderStats();
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
  onSearch: value => moduleShell?.handleSearch?.(value),
  toggleTodayFocus: () => toggleTodayFocus(),
  toggleMinimalTodos: () => toggleMinimalTodos(),
  getActiveModule: () => moduleShell?.getActiveModule?.() || 'tasks',
});

desktopIntegration = createDesktopIntegration({
  showToast: (...args) => showToast(...args),
  onHotkeyNewTodo: async () => {
    if (moduleShell?.getActiveModule?.() !== 'tasks') return;
    await showTodoModal();
  },
  onHotkeySearch: () => {
    if (moduleShell?.getActiveModule?.() !== 'tasks') return;
    openMobileSearch();
  },
  getCurrentUser: () => currentUser,
  confirmDanger,
  removeAllLocationReminders: () => todosFeature.removeAllLocationReminders(),
  syncTodoChanges: () => isOnlineForSync() ? syncWithServer() : Promise.resolve(),
});


// ─── IndexedDB ───────────────────────────────────────────────────────────────

// ─── Sync Logic (Kern der Offline→Online Synchronisation) ───────────────────

function isOnlineForSync() {
  return syncController.isOnlineForSync();
}

async function syncWithServer() {
  return trackBackgroundSyncOperation(() => syncController.syncWithServer());
}

async function refreshFromServer() {
  return trackBackgroundSyncOperation(() => syncController.refreshFromServer());
}

const calendarViewFeature = createCalendarViewFeature({
  escapeHtml,
  escapeHtmlAttr,
  renderTodos: () => renderTodos(),
  openTodo: (id) => todosFeature.editTodo(id),
  setTodoStatus: (id, status) => todosFeature.setTodoStatus(id, status),
});

const sectionActions = createSectionActionsFeature({
  routingMemory,
  getTodos: () => todos,
  setTodos: setTodosState,
  getProjects: () => projects,
  getSections: () => sections,
  setSections: (next) => { sections = next; },
  getCurrentProjectId: () => currentProjectId,
  dbPut,
  dbGetAll,
  deleteFromDB,
  addToSyncQueue,
  runSyncQueueMutation,
  isOnlineForSync,
  syncWithServer,
  renderTodos: () => renderTodos(),
  renderProjects: () => renderProjects(),
  confirmDanger,
  completedCount: () => todos.filter(todo => Number(todo.project_id) === Number(currentProjectId) && todo.status === 'done').length,
  clearCompleted: () => projectsFeature.clearDoneInProject(),
  onCompletedEmpty: () => showToast(t('project.done.empty')),
  onCompletedError: error => {
    console.error('Clear done error:', error);
    showToast(t('project.done.deleteFailed'));
  },
  completedLabels: {
    clearCompletedTitle: () => t('project.done.deleteTitle'),
    clearCompletedMessage: ({ count }) => t('project.done.deleteMessage', {
      count,
      project: projects.find(project => Number(project.id) === Number(currentProjectId))?.name || '',
    }),
    clearCompletedConfirm: () => t('project.done.deleteConfirm'),
  },
  sectionsFeature,
  sectionRegistry,
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
  getShowProjectWidget: () => showProjectWidget
    && getEffectiveDashboardPreferences(dashboardPreferences, { minimal: minimalTodos }).showProjectWidgets,
  getDashboardPreferences: () => dashboardPreferences,
  getDashboardDrilldown: () => dashboardDrilldown,
  getMinimalTodos: () => minimalTodos,
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

workspacesFeature = createWorkspacesFeature({
  workspacesApi,
  getWorkspaces: () => workspaces,
  setWorkspaces: setWorkspacesState,
  getCurrentWorkspaceId: () => currentWorkspaceId,
  setCurrentWorkspaceId: setCurrentWorkspaceState,
  dbPut,
  dbClear,
  isOnlineForSync,
  refreshFromServer: () => refreshFromServer(),
  renderProjects: () => renderProjects(),
  renderStats: () => renderStats(),
  renderTodos: () => renderTodos(),
  closeSidebar: (options) => closeSidebar(options),
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
  onAuthoritativeRefreshCommitted: () => {
    sharingFeature?.commitAuthoritativeSnapshot?.(projects);
    shoppingNavigationFeature?.commitAuthoritativeSnapshot?.(shoppingLists);
    cookbookNavigationFeature?.commitAuthoritativeSnapshot(cookbooks);
  },
});
const bindWorkspaceControls = workspacesFeature.bindWorkspaceControls;
const ensureCurrentWorkspace = workspacesFeature.ensureCurrentWorkspace;

// ─── Actions ─────────────────────────────────────────────────────────────────

const navigationFeature = createNavigationFeature({
  sectionsApi,
  getProjects: () => projects,
  getCurrentProjectId: () => currentProjectId,
  getCurrentFilter: () => currentFilter,
  setCurrentProjectId: (next) => { currentProjectId = next; },
  setCurrentFilter: (next) => { currentFilter = next; },
  clearDashboardDrilldown: () => { dashboardDrilldown = null; },
  setSections: (next) => { sections = next; },
  isOnlineForSync,
  dbGetAll,
  dbPut,
  deleteFromDB,
  closeSidebar: (options) => closeSidebar(options),
  renderProjects: () => renderProjects(),
  renderStats: () => renderStats(),
  renderTodos: () => renderTodos(),
  showProjectModal: () => showProjectModal(),
  editProject: id => projectsFeature.editProject(id),
  syncInProgressRef,
});
const setFilter = navigationFeature.setFilter;
const loadSectionsForCurrentProject = navigationFeature.loadSectionsForCurrentProject;
const bindNavigationActions = navigationFeature.bindNavigationActions;
const bindNavigationHistory = navigationFeature.bindNavigationHistory;
const dashboardDrilldownFeature = createDashboardDrilldownFeature({
  setDashboardDrilldown: value => { dashboardDrilldown = value; },
  setFilter,
});
const bindDashboardDrilldownActions = dashboardDrilldownFeature.bindDashboardDrilldownActions;

const showProjectModal = projectsFeature.showProjectModal;
const deleteProject = projectsFeature.deleteProject;
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
  showTodoModal: () => {
    const activeModule = moduleShell?.getActiveModule?.();
    if (activeModule === 'tasks') return showTodoModal();
    if (activeModule === 'shopping') return shoppingItemEditorFeature?.show?.();
    return undefined;
  },
});
moduleShell = createModuleShell({
  onActiveModuleChange: moduleId => {
    moduleSwitcher?.syncActiveModule(moduleId);
    brainDumpLiveFeature.refreshLauncher?.();
  },
  getUser: () => currentUser,
});
moduleSwitcher = createModuleSwitcher({
  getModules: () => moduleShell.getEnabledModules(),
  onModuleChange: moduleId => {
    moduleShell.navigateToModule(moduleId);
    uiShell.closeSidebar({ preserveHistory: true });
  },
});
const shoppingSectionsAdapter = createShoppingSectionsAdapter({
  getActorId: () => currentUser?.id ?? null,
  getLists: () => shoppingLists,
  setLists: next => setShoppingListsState(next, { reconcileDetails: false }),
  getActiveListId: () => shoppingNavigationFeature?.getActiveListId?.(),
  getRoot: () => document.querySelector('[data-section-root="shopping"]'),
  commitMutation: commitShoppingMutation,
  enqueueListMutation: enqueueShoppingListMutation,
  canReorder: () => shoppingNavigationFeature?.canReorderSections?.() !== false,
  render: () => shoppingNavigationFeature?.render?.(),
  isOnlineForSync,
  syncWithServer,
  onError: (error, context) => {
    console.error('Shopping section mutation failed', error);
    if (context?.action === 'clear-completed') showToast(t('shopping.done.deleteFailed'));
  },
  onCompletedEmpty: () => showToast(t('shopping.done.empty')),
  onCompletedSuccess: result => showToast(t('shopping.done.deleted', { count: result.deleted_count })),
  labels: {
    deleteMessage: () => t('shopping.section.deleteMessage'),
    clearCompletedTitle: () => t('shopping.done.deleteTitle'),
    clearCompletedMessage: ({ count }) => t('shopping.done.deleteMessage', {
      count,
      list: shoppingLists.find(list => String(list.id) === String(shoppingNavigationFeature?.getActiveListId?.()))?.name || '',
    }),
    clearCompletedConfirm: () => t('shopping.done.deleteConfirm'),
  },
});
const shoppingItemsController = createShoppingItemsController({
  getActorId: () => currentUser?.id ?? null,
  routingMemory,
  getLists: () => shoppingLists,
  setLists: next => setShoppingListsState(next, { reconcileDetails: false }),
  getStores: () => shoppingStores,
  getActiveListId: () => shoppingNavigationFeature?.getActiveListId?.(),
  commitMutation: commitShoppingMutation,
  enqueueListMutation: enqueueShoppingListMutation,
  render: () => shoppingNavigationFeature?.render?.(),
  isOnlineForSync,
  syncWithServer,
  onError: error => console.error('Shopping item mutation failed', error),
  onEdit: (listId, itemId, triggerElement) => shoppingItemEditorFeature?.showEdit?.(listId, itemId, triggerElement),
});
shoppingSectionsAdapter.itemDrag = shoppingItemsController.dragAdapter;
const shoppingStoresController = createShoppingStoresController({
  getActorId: () => currentUser?.id ?? null,
  getStores: () => shoppingStores,
  setStores: setShoppingStoresState,
  commitMutation: commitShoppingMutation,
  enqueueListMutation: enqueueShoppingListMutation,
  resolveListIdentity: listIdentity => entityIdentity(resolveEntityIdentity(shoppingLists, listIdentity, { actorId: currentUser?.id }), currentUser?.id),
  resolveListId: listIdentity => resolveEntityIdentity(shoppingLists, listIdentity, { actorId: currentUser?.id })?.id ?? null,
  isOnlineForSync,
  syncWithServer,
  onError: error => console.error('Shopping store mutation failed', error),
});
shoppingStoreEditorFeature = createShoppingStoreEditorFeature({
  getActorId: () => currentUser?.id ?? null,
  getLists: () => shoppingLists,
  getStores: () => shoppingStores,
  storeController: shoppingStoresController,
  confirmDanger,
  onError: error => console.error('Shopping store editor failed', error),
});
shoppingStoreEditorFeature.bind();
shoppingNavigationFeature = createShoppingNavigationFeature({
  getActorId: () => currentUser?.id ?? null,
  getLists: () => shoppingLists,
  getStores: () => shoppingStores,
  closeSidebar: options => uiShell.closeSidebar(options),
  onAdd: () => window.dispatchEvent(new CustomEvent('nia:shopping-list-add-request')),
  onDetail: id => window.dispatchEvent(new CustomEvent('nia:shopping-list-detail-request', { detail: { id } })),
  onStoreEdit: (listId, storeId, trigger) => shoppingStoreEditorFeature?.showEdit?.(listId, storeId, trigger),
  onListIdRemap: (fromId, toId) => shoppingListDetailsFeature?.remapListId(fromId, toId),
  onRender: () => shoppingViewPreferencesFeature?.updateButton?.(),
  onPrimaryActionAvailabilityChange: available => {
    const action = document.querySelector('[data-shopping-item-action="open-create"]');
    if (!action) return;
    action.hidden = available !== true;
    action.disabled = available !== true;
  },
  sectionRegistry,
  sectionAdapter: shoppingSectionsAdapter,
  itemController: shoppingItemsController,
  storeController: shoppingStoresController,
  getHideDone: () => hideDone,
  shoppingApi,
  loadAuthoritativeProjection: async () => {
    const result = await refreshFromServer();
    if (!result?.refreshed) throw new Error('Authoritative shopping projection was not refreshed');
    return shoppingLists;
  },
  removePendingEntities: async (pendingIds, { signal } = {}) => {
    const ids = pendingIds || [];
    const blocked = new Set(ids.map(id => String(id)));
    if (!blocked.size) return;
    return runEntityPrivacyEviction({
      syncInProgressRef,
      acquireCommitLock: acquireSyncCommitLock,
      signal,
      evict: () => appStorage.evictPendingShoppingEntities(ids, { signal }),
      publish: () => {
        const remainingLists = shoppingLists.filter(list => !blocked.has(String(list.id)));
        const remainingStores = shoppingStores.filter(store => !blocked.has(String(store.shopping_list_id)));
        if (remainingLists.length !== shoppingLists.length) {
          setShoppingListsState(remainingLists, { reconcileDetails: false });
        }
        if (remainingStores.length !== shoppingStores.length) {
          setShoppingStoresState(remainingStores);
        }
      },
    });
  },
});
shoppingNavigationFeature.bind();
shoppingViewPreferencesFeature = createShoppingViewPreferencesFeature({
  getActorId: () => currentUser?.id ?? null,
  getLists: () => shoppingLists,
  setLists: next => setShoppingListsState(next, { reconcileDetails: false }),
  getActiveListId: () => shoppingNavigationFeature?.getActiveListId?.(),
  commitMutation: commitShoppingMutation,
  enqueueListMutation: enqueueShoppingListMutation,
  render: renderShopping,
  isOnlineForSync,
  syncWithServer,
  onError: error => console.error('Shopping view preference mutation failed', error),
});
shoppingListDetailsFeature = createShoppingListDetailsFeature({
  getActorId: () => currentUser?.id ?? null,
  getLists: () => shoppingLists,
  setLists: next => setShoppingListsState(next, { reconcileDetails: false }),
  commitMutation: commitShoppingMutation,
  enqueueListMutation: enqueueShoppingListMutation,
  isOnlineForSync,
  syncWithServer,
  selectList: id => shoppingNavigationFeature.selectList(id),
  confirmDanger,
  normalizeActiveListNavigation: () => shoppingNavigationFeature.normalizeActiveListNavigation(),
  focusActiveListAction: () => shoppingNavigationFeature.focusActiveListAction(),
  getAccessSnapshot: () => window.niaAccessSnapshot || null,
  shoppingApi,
});
shoppingItemEditorFeature = createShoppingItemEditorFeature({
  getActorId: () => currentUser?.id ?? null,
  routingMemory,
  getLists: () => shoppingLists,
  getActiveListId: () => shoppingNavigationFeature?.getActiveListId?.(),
  getStores: () => shoppingStores,
  storeController: shoppingStoresController,
  itemController: shoppingItemsController,
  showToast: (...args) => showToast(...args),
  confirmDanger,
  onStoreEdit: (listId, storeId, triggerElement) => shoppingStoreEditorFeature?.showEdit?.(listId, storeId, triggerElement),
  onError: error => console.error('Shopping item editor failed', error),
});
shoppingItemEditorFeature.bind();
async function removeCookbookAccess(ids, { signal, getAccessibleEntities, isCurrent = () => true } = {}) {
  const session = getEntitySessionIdentity();
  let blocked = new Set();
  return runEntityPrivacyEviction({
    syncInProgressRef, acquireCommitLock: acquireSyncCommitLock, signal,
    evict: async () => {
      if (session == null || session !== getEntitySessionIdentity() || !isCurrent()) return;
      const accessible = new Set((getAccessibleEntities?.()?.accessibleCookbookIds || []).map(String));
      blocked = new Set(ids.map(String).filter(id => !accessible.has(id)));
      if (blocked.size) await appStorage.evictPendingCookbookEntities([...blocked], { signal });
    },
    publish: () => {
      if (session === getEntitySessionIdentity() && isCurrent() && blocked.size) {
        setCookbooksState(cookbooks.filter(book => !blocked.has(String(book.id))));
      }
    },
  });
}
async function refreshCookbooks() {
  const result = await refreshFromServer();
  if (!result?.refreshed) throw new Error('Authoritative cookbook projection was not refreshed');
  return cookbooks;
}
const cookbooksController = createCookbooksController({
  getCookbooks: () => cookbooks, setCookbooks: setCookbooksState,
  getCurrentUser: () => currentUser, getSessionIdentity: getEntitySessionIdentity,
  getAccessSnapshot: () => window.niaAccessSnapshot || null,
  commitMutation: commitCookbookMutation, enqueueCookbookMutation,
  isOnlineForSync, syncWithServer,
});
cookbookNavigationFeature = createCookbookNavigationFeature({
  getActorId: () => currentUser?.id ?? null,
  getCookbooks: () => cookbooks, setCookbooks: next => { cookbooks = next; },
  cookbookApi: recipesApi, closeSidebar: options => uiShell.closeSidebar(options),
  onAdd: () => cookbookDetailsFeature?.showCookbookModal(),
  onDetail: id => cookbookDetailsFeature?.showCookbookModal(cookbooks.find(book => String(book.id) === String(id))),
  onDeactivate: () => {
    cookbookDetailsFeature?.deactivate();
    recipeEditorFeature?.deactivate();
    recipeImportFeature?.deactivate();
    recipeShoppingTransferFeature?.deactivate();
    recipeViewFeature?.deactivate();
  },
  onCookbookIdRemap: remapCookbookId,
  loadAuthoritativeProjection: refreshCookbooks, removePendingEntities: removeCookbookAccess,
});
cookbookNavigationFeature.bind();
cookbookDetailsFeature = createCookbookDetailsFeature({
  getCookbooks: () => cookbooks, cookbookController: cookbooksController, cookbookApi: recipesApi,
  getSessionIdentity: getEntitySessionIdentity, getAccessSnapshot: () => window.niaAccessSnapshot || null,
  getPendingMutations: () => dbGetAll('syncQueue'),
  isOnlineForSync, syncWithServer, confirmDanger, enqueueCookbookMutation, refreshCookbooks,
  removeCookbookAccess: (id, options) => removeCookbookAccess([id], options),
  selectCookbook: id => cookbookNavigationFeature.selectCookbook(id),
  normalizeActiveCookbookNavigation: () => cookbookNavigationFeature.normalizeActiveCookbookNavigation(),
  focusActiveCookbookAction: () => cookbookNavigationFeature.focusActiveCookbookAction(),
});
const recipeImagesFeature = createRecipeImagesFeature({
  getCookbooks: () => cookbooks, getCurrentUser: () => currentUser,
  getSessionIdentity: getEntitySessionIdentity, syncInProgressRef,
});
const recipeController = createRecipeController({
  getCookbooks: () => cookbooks, setCookbooks: setCookbooksState,
  getSessionIdentity: getEntitySessionIdentity, getCurrentUser: () => currentUser,
  commitMutation: commitRecipeMutation, enqueueCookbookMutation, recipesApi,
  isOnlineForSync, syncWithServer,
});
const canUseShoppingForTransfer = () => Boolean(currentUser && moduleShell?.getEnabledModules?.().some(module => module.id === 'shopping'));
const recipeShoppingTransferController = createRecipeShoppingTransferController({
  getCookbooks: () => cookbooks, getLists: () => shoppingLists, getStores: () => shoppingStores,
  getCurrentUser: () => currentUser, getSessionIdentity: getEntitySessionIdentity,
  readQueue: () => dbGetAll('syncQueue'), commit: commitRecipeShoppingTransfer,
  isOnlineForSync, syncWithServer,
});
recipeShoppingTransferFeature = createRecipeShoppingTransferFeature({
  routingMemory,
  getCookbooks: () => cookbooks, getLists: () => shoppingLists, getStores: () => shoppingStores,
  getCurrentUser: () => currentUser, getSessionIdentity: getEntitySessionIdentity,
  canUseShopping: canUseShoppingForTransfer,
  transfer: recipeShoppingTransferController.transfer,
  readPendingTransfers: recipeShoppingTransferController.listPending,
  cancelTransfer: recipeShoppingTransferController.cancel,
  onQueued: () => showToast(t('recipe.transfer.queued')),
});
recipeViewFeature = createRecipeViewFeature({
  getCookbooks: () => cookbooks,
  getActiveCookbookId: () => cookbookNavigationFeature.getActiveCookbookId(),
  getActorId: () => currentUser?.id ?? null, getSessionIdentity: getEntitySessionIdentity,
  recipeController, confirmDanger,
  onCreate: book => recipeEditorFeature?.showCreate(book.id),
  onImport: book => recipeImportFeature?.show(book.id),
  onEdit: recipe => recipeEditorFeature?.showEdit(recipe.id),
  canTransfer: canUseShoppingForTransfer,
  onTransfer: (recipe, options) => recipeShoppingTransferFeature?.show(recipe, options),
  loadRecipeImage: recipeImagesFeature.load, releaseRecipeImage: recipeImagesFeature.release,
});
recipeEditorFeature = createRecipeEditorFeature({
  api: recipesApi,
  getBrainDumpAccess: () => Boolean(currentUser?.braindump_enabled && brainDumpLiveFeature.hasAccess?.()),
  getCookbooks: () => cookbooks, recipeController, getSessionIdentity: getEntitySessionIdentity,
  confirmDanger, prepareRecipeImage, loadRecipeImage: recipeImagesFeature.load,
  releaseRecipeImage: recipeImagesFeature.release,
  onSaved: recipe => recipeViewFeature.selectRecipe(recipe.id),
  onDeleted: () => recipeViewFeature.showOverview({ replaceHistory: true }),
});
recipeImportFeature = createRecipeImportFeature({
  getBrainDumpAccess: () => Boolean(currentUser?.braindump_enabled && brainDumpLiveFeature.hasAccess?.()),
  api: recipesApi, editor: recipeEditorFeature, getCookbooks: () => cookbooks,
  getActiveCookbookId: () => cookbookNavigationFeature.getActiveCookbookId(),
  getSessionIdentity: getEntitySessionIdentity,
  isOnline: () => navigator.onLine !== false,
});
cookbookNavigationFeature.setRecipeView(recipeViewFeature);
const refreshTasksModule = () => {
  renderProjects();
  renderStats();
  renderTodos();
  sharingFeature.renderInvites();
  updateToggleDoneButton();
  updateSortButton();
  updateProjectWidgetButton();
  updateTodayFocusButton();
  updateMinimalTodosButton();
};
moduleShell.registerController('tasks', {
  onActivate: refreshTasksModule,
  onDeactivate: () => todosFeature.resetTodoShortcutTarget(),
  onLanguageChange: refreshTasksModule,
  onSearch: () => {
    renderStats();
    renderTodos();
  },
});
moduleShell.registerController('shopping', {
  onActivate: () => {
    shoppingNavigationFeature.activate();
    shoppingItemEditorFeature.reconcile();
    shoppingViewPreferencesFeature.updateButton();
  },
  onDeactivate: () => shoppingNavigationFeature.deactivate(),
  onLanguageChange: renderShopping,
  onSearch: value => shoppingNavigationFeature.setSearchQuery(value),
});
moduleShell.registerController('recipes', {
  onActivate: () => cookbookNavigationFeature.activate(),
  onDeactivate: () => cookbookNavigationFeature.deactivate(),
  onLanguageChange: renderCookbooks,
  onSearch: value => cookbookNavigationFeature.setSearchQuery(value),
});
const closeSidebar = uiShell.closeSidebar;
const closeModal = uiShell.closeModal;
const setupDescPreview = uiShell.setupDescPreview;
const bindModalCloseControls = uiShell.bindModalCloseControls;
const bindSidebarControls = uiShell.bindSidebarControls;
uiShell.bindSidebarEdgeSwipe();
uiShell.bindTouchFeedback();
dateTimePickerFeature.bind();
uiShell.bindKeyboardShortcuts();

// ─── Drag & Drop ─────────────────────────────────────────────────────────────

const dragDropFeature = createDragDropFeature({
  getSections: () => sections,
  setSections: (next) => { sections = next; },
  isOnlineForSync,
  sectionsApi,
  renderTodos: () => renderTodos(),
  sectionRegistry,
  taskSectionAdapter: sectionActions.adapter,
});
const bindStandardDragDrop = dragDropFeature.bindStandardDragDrop;
const bindNativePointerDragDrop = dragDropFeature.bindNativePointerDragDrop;

const { consumeOidcErrorNotice } = createOidcNoticeFeature({
  t,
  showLoginOverlay,
  alertInfo,
});

const toastUndoFeature = createToastUndoFeature({
  getSessionIdentity: () => currentUser ? `${currentUser.id}:${Number(syncInProgressRef.privacyGeneration || 0)}` : null,
  getDb: () => db,
  getTodos: () => todos,
  getProjects: () => projects,
  setTodos: setTodosState,
  dbPut,
  dbGetAll,
  deleteFromDB,
  addToSyncQueue,
  runSyncQueueMutation,
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
function applyLocalDashboardPreferences(workspaceId, next) {
  const saved = saveDashboardPreferences(localStorage, next, workspaceId);
  if (String(workspaceId) === String(currentWorkspaceId)) {
    dashboardPreferences = saved;
    showProjectWidget = dashboardPreferences.showProjectWidgets;
    updateProjectWidgetButton();
  }
  return saved;
}

dashboardPreferencesSyncFeature = createDashboardPreferencesSync({
  api: authApi,
  storage: localStorage,
  getUserId: () => currentUser?.id,
  getWorkspaces: () => workspaces,
  getPreferences: workspaceId => loadDashboardPreferences(localStorage, workspaceId),
  setPreferences: applyLocalDashboardPreferences,
  renderDashboard: () => {
    renderStats();
    renderTodos();
  },
});
const dashboardPreferencesFeature = createDashboardPreferencesFeature({
  getPreferences: workspaceId => loadDashboardPreferences(localStorage, workspaceId),
  setPreferences: (workspaceId, next) => {
    const saved = applyLocalDashboardPreferences(workspaceId, next);
    dashboardPreferencesSyncFeature.saveWorkspace(workspaceId, saved);
  },
  getProjects: () => projects,
  getWorkspaces: () => workspaces,
  getCurrentWorkspaceId: () => currentWorkspaceId,
  getSyncEnabled: () => dashboardPreferencesSyncFeature.isEnabled(),
  setSyncEnabled: enabled => dashboardPreferencesSyncFeature.setEnabled(enabled),
  renderDashboard: () => {
    renderStats();
    renderTodos();
  },
  showToast,
});
const bindDashboardPreferencesActions = dashboardPreferencesFeature.bindDashboardPreferencesActions;

// ─── Push Notifications ────────────────────────────────────────────────────

const updatePushStatus = pushFeature.updatePushStatus;
const updatePushSettingsUI = pushFeature.updatePushSettingsUI;
const bindPushActions = pushFeature.bindPushActions;

async function refreshEntityInvitations() {
  const results = await Promise.all([
    sharingFeature.loadInvites(),
    shoppingNavigationFeature.loadInvites(),
    cookbookNavigationFeature.loadInvites(),
  ]);
  const failed = results.find(result => result?.ok === false && !result?.stale);
  return failed || { ok: true, results };
}

const appLifecycle = createAppLifecycle({
  authApi,
  initTheme,
  checkAuth: (options) => checkAuth(options),
  hideLoginOverlay,
  showLoginOverlay,
  renderUserInfo,
  openSettingsModal: () => openSettingsModal(),
  isMfaEnrollmentRequired: () => Boolean(currentUser?.mfa_enrollment_required || localStorage.getItem('nia-mfa-enrollment-required') === '1'),
  initServiceWorker,
  openDB: async () => {
    const database = await openDB();
    if (database) {
      sharingFeature.resumeAccessPrivacy();
      shoppingNavigationFeature.resumeAccessPrivacy();
      cookbookNavigationFeature.resumeAccessPrivacy();
      wsClient.resumeWebSocket();
    }
    return database;
  },
  dbGetAll,
  setTodos: setTodosState,
  setProjects: (next) => { projects = next; },
  setSections: (next) => { sections = next; },
  setWorkspaces: setWorkspacesState,
  setShoppingLists: setShoppingListsState,
  setShoppingStores: setShoppingStoresState,
  setCookbooks: setCookbooksState,
  setCurrentFilter: (next) => { currentFilter = next; },
  setCurrentProjectId: (next) => { currentProjectId = next; },
  setCurrentWorkspaceId: setCurrentWorkspaceState,
  ensureCurrentWorkspace: () => ensureCurrentWorkspace(),
  setAppInitialized: (next) => { appInitialized = next; },
  connectWebSocket,
  disconnectRealtime: () => disconnectAuthenticatedRuntime(),
  getWsState: () => wsClient.getWsState(),
  isAuthenticated: () => Boolean(currentUser),
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
  refreshInvites: () => trackBackgroundSyncOperation(() => refreshEntityInvitations()),
  onAppReady: () => {
    dashboardPreferencesSyncFeature.initialize();
    serverUpdateIndicator.loadStatus();
    brainDumpLiveFeature.init({ forceAccess: true });
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
  moduleShell.bind();
  moduleSwitcher.bind();
  shoppingListDetailsFeature.bind();
  cookbookDetailsFeature.bind();
  recipeViewFeature.bind();
  recipeEditorFeature.bind();
  recipeImportFeature.bind();
  recipeShoppingTransferFeature.bind();
  appLifecycle.bindNetworkEvents();
  appLifecycle.bindDomReady();
  bindUserMenu();
  bindUserSettingsActions();
  householdsFeature.bind();
  bindApiKeyActions();
  bindPushActions();
  desktopIntegration?.bindDesktopActions?.();
  hydrateIcons(document);
  confirmDialogFeature.bindConfirmDialog();
  consumeOidcErrorNotice();
  bindServiceWorkerUpdateButtons();
  bindAppDownloadLaunchers();
  shortcutHelpFeature.bindShortcutHelpActions();
  aboutFeature.bindAboutActions();
  whatsNewFeature.bindWhatsNewActions();
  appDownloadsFeature.initAppDownloads();
  brainDumpLiveFeature.init();
  bindStandardDragDrop();
  bindNativePointerDragDrop();
  bindMobileSearchEvents();
  bindTopbarPreferenceButtons();
  completedVisibilityFeature.bind();
  shoppingViewPreferencesFeature.bind();
  bindDashboardPreferencesActions();
  window.addEventListener('online', () => dashboardPreferencesSyncFeature.refresh());
  bindTodayFocusHotkey();
  bindSidebarControls();
  bindModalCloseControls();
  bindToastControls();
  bindWorkspaceControls();
  bindTodoActions();
  sharingFeature.bindProjectSharingActions();
  bindSectionActions();
  bindNavigationActions();
  bindDashboardDrilldownActions();
  bindUiHistory();
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
    renderWorkspaces();
    hydrateIcons(document);
  });
  setInterval(() => {
    if (moduleShell.getActiveModule() === 'tasks') renderStats();
  }, 30 * 1000);

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
  rendering: { renderVersionInfo, renderProjects, renderStats, renderTodos, renderSectionHeader, countByProject },
  navigation: { setFilter, loadSectionsForCurrentProject, bindNavigationHistory },
  todos: { markTodoDone, markTodoInProgress, deleteTodoComment, deleteTodoAttachment, saveTodo, editTodo, deleteTodoFromModal },
  projects: { showProjectModal, deleteProject, clearDoneFromModal },
  projectSharing: { setProject: (project) => sharingFeature.setProject(project), loadInvites: () => refreshEntityInvitations() },
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
  serviceWorkerUpdates.removeReloadMarkersFromVisibleUrl();
}
