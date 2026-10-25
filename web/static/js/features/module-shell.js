import { t, translatePage } from '../i18n/index.js';
import { getModule, MODULES, moduleDefaultPath, moduleFromPath, persistModule, readStoredModule } from '../modules/registry.js';
import { resolveWorkspaceModuleId, visibleModulesForWorkspace } from '../modules/visibility.js';

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

function cleanModulePath(path) {
  const value = String(path || '/');
  return value.startsWith('/') ? value : `/${value}`;
}

export function createModuleShell({ onActiveModuleChange, getWorkspace = () => null } = {}) {
  const controllers = new Map();
  const instances = new Map();
  const searchValues = new Map();
  let activeModuleId = 'tasks';
  let visibleModules = MODULES;
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
      for (const [slotName, panel] of Object.entries(instance.slots)) {
        panel.hidden = !PERSISTENT_MODULE_SLOTS.has(slotName) && !isActive;
      }
    }

    active.render?.();
    setSearchContract(active);
    if (lifecycle) {
      active.activate?.();
      controllers.get(active.id)?.onActivate?.();
    }
    onActiveModuleChange?.(active.id);
  }

  function applyLocation({ normalize = false } = {}) {
    const pathModule = moduleFromPath(location.pathname);
    const previousModuleId = activeModuleId;
    const search = document.getElementById('search-input');
    if (search) searchValues.set(previousModuleId, search.value);
    visibleModules = visibleModulesForWorkspace(getWorkspace());
    activeModuleId = resolveWorkspaceModuleId(pathModule || readStoredModule(), getWorkspace());
    persistModule(activeModuleId);

    if ((pathModule && pathModule !== activeModuleId) || (!pathModule && normalize)) {
      const path = moduleDefaultPath(activeModuleId);
      history.replaceState({ ...(history.state || {}), niaModuleRoute: true, moduleId: activeModuleId }, '', path);
    }

    if (previousModuleId !== activeModuleId) {
      getModule(previousModuleId).deactivate?.();
      controllers.get(previousModuleId)?.onDeactivate?.();
    }
    renderActiveModule();
  }

  function navigate(path, { replace = false } = {}) {
    const nextPath = cleanModulePath(path);
    const requestedModuleId = moduleFromPath(nextPath) || visibleModules[0].id;
    const nextModuleId = resolveWorkspaceModuleId(requestedModuleId, getWorkspace());
    const resolvedPath = requestedModuleId === nextModuleId ? nextPath : moduleDefaultPath(nextModuleId);
    const previousModuleId = activeModuleId;
    const search = document.getElementById('search-input');
    if (search) searchValues.set(previousModuleId, search.value);

    if (previousModuleId !== nextModuleId) {
      getModule(previousModuleId).deactivate?.();
      controllers.get(previousModuleId)?.onDeactivate?.();
    }

    activeModuleId = nextModuleId;
    persistModule(activeModuleId);
    const state = { ...(history.state || {}), niaModuleRoute: true, moduleId: activeModuleId };
    if (replace) history.replaceState(state, '', resolvedPath);
    else history.pushState(state, '', resolvedPath);
    renderActiveModule();
  }

  function navigateToModule(moduleId) {
    navigate(moduleDefaultPath(moduleId));
  }

  function applyWorkspace(workspace = getWorkspace()) {
    const previousModuleId = activeModuleId;
    visibleModules = visibleModulesForWorkspace(workspace);
    activeModuleId = resolveWorkspaceModuleId(activeModuleId, workspace);
    if (previousModuleId !== activeModuleId) {
      getModule(previousModuleId).deactivate?.();
      controllers.get(previousModuleId)?.onDeactivate?.();
      history.replaceState({ ...(history.state || {}), niaModuleRoute: true, moduleId: activeModuleId }, '', moduleDefaultPath(activeModuleId));
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
    window.addEventListener('popstate', () => applyLocation());
    window.addEventListener('nia-language-change', handleLanguageChange);
  }

  const api = {
    bind,
    navigate,
    navigateToModule,
    registerController,
    handleSearch,
    render: renderActiveModule,
    applyWorkspace,
    getActiveModule: () => activeModuleId,
    getVisibleModules: () => visibleModules,
  };
  return api;
}
