import { t, translatePage } from '../i18n/index.js';
import { getModule, isModuleId, MODULES, persistModule, readStoredModule } from '../modules/registry.js';
import { enabledModulesForUser, resolveEnabledModuleId } from '../modules/visibility.js';

const SLOT_ROOT_IDS = Object.freeze({
  sidebar: 'module-sidebar-slot',
  topbar: 'module-topbar-slot',
  main: 'module-main-slot',
  floating: 'module-floating-slot',
  userMenu: 'module-user-menu-slot',
  shortcuts: 'module-shortcuts-slot',
  settingsNav: 'module-settings-nav-slot',
  settings: 'module-settings-slot',
  desktopHotkeys: 'module-desktop-hotkeys-slot',
});
const PERSISTENT_MODULE_SLOTS = new Set(['settingsNav', 'settings', 'desktopHotkeys']);

export function appBaseUrl(location = globalThis.location) {
  const search = String(location?.search || '');
  return search ? `/${search.startsWith('?') ? search : `?${search}`}` : '/';
}

export function moduleIdFromNavigation({
  state = globalThis.history?.state,
  storage = globalThis.localStorage,
} = {}) {
  const stateModuleId = state?.niaModuleRoute === true && isModuleId(state.moduleId)
    ? state.moduleId
    : null;
  return stateModuleId || readStoredModule(storage);
}

function moduleHistoryState(moduleId, state = globalThis.history?.state) {
  return { ...(state || {}), niaModuleRoute: true, moduleId };
}

export function createModuleShell({ onActiveModuleChange, getUser = () => null } = {}) {
  const controllers = new Map();
  const instances = new Map();
  const searchValues = new Map();
  let activeModuleId = 'tasks';
  let enabledModules = MODULES;
  let mounted = false;
  let bound = false;

  function createPanel(slotName, moduleId) {
    const panel = document.createElement('div');
    panel.className = `module-slot-panel module-slot-panel-${slotName}`;
    panel.dataset.modulePanel = moduleId;
    panel.dataset.moduleSlot = slotName;
    panel.hidden = true;
    return panel;
  }

  function mountModules() {
    if (mounted) return;
    const roots = Object.fromEntries(
      Object.entries(SLOT_ROOT_IDS).map(([slotName, id]) => [slotName, document.getElementById(id)]),
    );
    if (Object.values(roots).some(root => !root)) return;

    for (const module of MODULES) {
      const slots = {};
      for (const [slotName, root] of Object.entries(roots)) {
        const panel = createPanel(slotName, module.id);
        root.appendChild(panel);
        slots[slotName] = panel;
      }
      module.mount?.({ slots, shell: api });
      for (const panel of Object.values(slots)) translatePage(panel);
      instances.set(module.id, { module, slots });
    }
    mounted = true;
  }

  function setSearchContract(module) {
    const input = document.getElementById('search-input');
    const toggle = document.getElementById('search-toggle-btn');
    if (!input) return;
    const key = module.searchPlaceholderKey || 'common.search';
    const enabled = module.searchEnabled !== false;
    input.dataset.i18nPlaceholderKey = key;
    input.setAttribute('placeholder', t(key));
    input.value = searchValues.get(module.id) || '';
    input.disabled = !enabled;
    toggle?.toggleAttribute('disabled', !enabled);
  }

  function renderActiveModule({ lifecycle = true } = {}) {
    mountModules();
    const app = document.getElementById('app');
    const active = getModule(activeModuleId);
    if (!app || !mounted) return;

    app.dataset.activeModule = active.id;
    for (const [moduleId, instance] of instances) {
      const isActive = moduleId === active.id;
      const isEnabled = enabledModules.some(module => module.id === moduleId);
      for (const [slotName, panel] of Object.entries(instance.slots)) {
        panel.hidden = PERSISTENT_MODULE_SLOTS.has(slotName) ? !isEnabled : !isActive;
      }
    }

    const workspaceSwitcher = document.getElementById('workspace-switcher');
    if (workspaceSwitcher) workspaceSwitcher.hidden = active.capabilities?.workspaces !== true;
    const moduleSwitcher = document.getElementById('module-switcher');
    if (moduleSwitcher) moduleSwitcher.hidden = false;

    active.render?.();
    setSearchContract(active);
    if (lifecycle) {
      active.activate?.();
      controllers.get(active.id)?.onActivate?.();
    }
    onActiveModuleChange?.(active.id);
  }

  function applyLocation({ normalize = false, state = history.state } = {}) {
    const previousModuleId = activeModuleId;
    const search = document.getElementById('search-input');
    if (search) searchValues.set(previousModuleId, search.value);
    enabledModules = enabledModulesForUser(getUser());
    activeModuleId = resolveEnabledModuleId(moduleIdFromNavigation({ state }), getUser());
    persistModule(activeModuleId);

    const stateNeedsNormalization = state?.niaModuleRoute !== true || state?.moduleId !== activeModuleId;
    const visibleUrlNeedsCleanup = location.pathname !== '/' || Boolean(location.hash);
    if (normalize || stateNeedsNormalization || visibleUrlNeedsCleanup) {
      history.replaceState(moduleHistoryState(activeModuleId, state), '', appBaseUrl(location));
    }

    if (previousModuleId !== activeModuleId) {
      getModule(previousModuleId).deactivate?.();
      controllers.get(previousModuleId)?.onDeactivate?.();
    }
    if (normalize || previousModuleId !== activeModuleId) renderActiveModule();
  }

  function navigateToModule(moduleId, { replace = false } = {}) {
    const requestedModuleId = isModuleId(moduleId) ? moduleId : enabledModules[0].id;
    const nextModuleId = resolveEnabledModuleId(requestedModuleId, getUser());
    const previousModuleId = activeModuleId;
    const search = document.getElementById('search-input');
    if (search) searchValues.set(previousModuleId, search.value);

    if (previousModuleId !== nextModuleId) {
      getModule(previousModuleId).deactivate?.();
      controllers.get(previousModuleId)?.onDeactivate?.();
    }

    activeModuleId = nextModuleId;
    persistModule(activeModuleId);
    const state = moduleHistoryState(activeModuleId);
    if (replace) history.replaceState(state, '', appBaseUrl(location));
    else history.pushState(state, '', appBaseUrl(location));
    renderActiveModule();
  }

  function applyModulePreferences() {
    const previousModuleId = activeModuleId;
    enabledModules = enabledModulesForUser(getUser());
    activeModuleId = resolveEnabledModuleId(activeModuleId, getUser());
    if (previousModuleId !== activeModuleId) {
      getModule(previousModuleId).deactivate?.();
      controllers.get(previousModuleId)?.onDeactivate?.();
      history.replaceState(moduleHistoryState(activeModuleId), '', appBaseUrl(location));
      persistModule(activeModuleId);
    }
    renderActiveModule();
  }

  function registerController(moduleId, controller = {}) {
    controllers.set(moduleId, controller);
  }

  function handleSearch(value = document.getElementById('search-input')?.value || '') {
    searchValues.set(activeModuleId, value);
    getModule(activeModuleId).onSearch?.(value);
    controllers.get(activeModuleId)?.onSearch?.(value);
  }

  function handleLanguageChange() {
    const active = getModule(activeModuleId);
    active.render?.();
    setSearchContract(active);
    active.onLanguageChange?.();
    controllers.get(activeModuleId)?.onLanguageChange?.();
    onActiveModuleChange?.(active.id);
  }

  function bind() {
    if (bound) return;
    bound = true;
    mountModules();
    applyLocation({ normalize: true });
    window.addEventListener('popstate', event => applyLocation({ state: event.state }));
    window.addEventListener('nia-language-change', handleLanguageChange);
  }

  const api = {
    bind,
    navigateToModule,
    registerController,
    handleSearch,
    render: renderActiveModule,
    applyModulePreferences,
    getActiveModule: () => activeModuleId,
    getEnabledModules: () => enabledModules,
  };
  return api;
}
