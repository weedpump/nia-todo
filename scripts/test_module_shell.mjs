#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  LEGACY_MODULE_STORAGE_KEY,
  MODULES,
  REGISTERED_MODULE_IDS,
  MODULE_STORAGE_KEY,
  moduleDefaultPath,
  moduleFromPath,
  persistModule,
  readStoredModule,
} from '../web/static/js/modules/registry.js';
import { createEmptyModule } from '../web/static/js/modules/module-factory.js';
import {
  disabledModuleIdsForUser,
  enabledModulesForUser,
  normalizeDisabledModuleIds,
  resolveEnabledModuleId,
  storedDisabledModuleIdsForUser,
} from '../web/static/js/modules/visibility.js';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

assert.deepEqual(MODULES.map(module => module.id), ['tasks', 'shopping', 'recipes']);
assert.deepEqual([...REGISTERED_MODULE_IDS], MODULES.map(module => module.id));
const templateModule = createEmptyModule({
  id: 'example',
  labelKey: 'module.tasks.label',
  descriptionKey: 'module.tasks.description',
  icon: 'tasks',
  defaultPath: '/example',
});
assert.equal(templateModule.id, 'example');
assert.equal(templateModule.searchEnabled, true);
assert.equal(typeof templateModule.mount, 'function');
for (const module of MODULES) {
  assert.equal(typeof module.mount, 'function', `${module.id} must implement the shared mount contract`);
  assert.equal(typeof module.searchPlaceholderKey, 'string', `${module.id} must define its search contract`);
}
assert.equal(moduleDefaultPath('tasks'), '/tasks');
assert.equal(moduleDefaultPath('shopping'), '/shopping');
assert.equal(moduleDefaultPath('recipes'), '/recipes');
assert.equal(moduleFromPath('/tasks'), 'tasks');
assert.equal(moduleFromPath('/shopping'), 'shopping');
assert.equal(moduleFromPath('/recipes'), 'recipes');
assert.equal(moduleFromPath('/'), null);
assert.equal(moduleFromPath('/unknown'), null);
assert.deepEqual(normalizeDisabledModuleIds(['recipes', 'tasks', 'recipes', 'unknown']), ['tasks', 'recipes']);
assert.deepEqual(normalizeDisabledModuleIds(['tasks', 'shopping', 'recipes']), ['shopping', 'recipes'], 'at least one module must remain enabled');
assert.deepEqual(disabledModuleIdsForUser({ disabled_modules: '["tasks"]' }), ['tasks']);
assert.deepEqual(storedDisabledModuleIdsForUser({ disabled_modules: ['future-module', 'tasks', 'future-module'] }), ['future-module', 'tasks']);
assert.deepEqual(enabledModulesForUser({ disabled_modules: ['tasks'] }).map(module => module.id), ['shopping', 'recipes']);
assert.equal(resolveEnabledModuleId('tasks', { disabled_modules: ['tasks'] }), 'shopping');
assert.equal(resolveEnabledModuleId('recipes', { disabled_modules: ['tasks'] }), 'recipes');

const values = new Map([[LEGACY_MODULE_STORAGE_KEY, 'shopping']]);
const storage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: key => values.delete(key),
};
assert.equal(readStoredModule(storage), 'shopping');
persistModule('recipes', storage);
assert.equal(values.get(MODULE_STORAGE_KEY), 'recipes');
assert.equal(values.has(LEGACY_MODULE_STORAGE_KEY), false);
assert.equal(readStoredModule(storage), 'recipes');
persistModule('invalid', storage);
assert.equal(values.get(MODULE_STORAGE_KEY), 'recipes');
assert.equal(readStoredModule({ getItem: () => { throw new Error('blocked'); } }), 'tasks');

const appSource = read('web/static/js/app.js');
const shellSource = read('web/static/js/features/module-shell.js');
const switcherSource = read('web/static/js/features/module-switcher.js');
const registrySource = read('web/static/js/modules/registry.js');
const tasksSource = read('web/static/js/modules/tasks.js');
const taskDialogsSource = read('web/static/js/modules/tasks-dialogs.js');
const taskSettingsSource = read('web/static/js/modules/tasks-settings.js');
const taskShortcutsSource = read('web/static/js/modules/tasks-shortcuts.js');
const workspacesSource = read('web/static/js/features/workspaces.js');
const todosSource = read('web/static/js/features/todos.js');
const shoppingSource = read('web/static/js/modules/shopping.js');
const recipesSource = read('web/static/js/modules/recipes.js');
const indexSource = read('web/index.html');
const moduleCss = read('web/static/css/14-module-content.css');

assert(appSource.includes("import { createModuleShell } from './features/module-shell.js';"), 'app must import the module shell');
assert(appSource.indexOf('moduleShell.bind();') < appSource.indexOf('appLifecycle.bindDomReady();'), 'module DOM must mount before feature bindings and app initialization');
assert(appSource.includes("moduleShell.registerController('tasks'"), 'tasks behavior must connect through the module controller contract');
assert(appSource.includes('moduleShell?.handleSearch?.(value)'), 'shared search must delegate to the active module');
assert(switcherSource.includes("from '../modules/registry.js'"), 'module switcher must use the shared registry');
assert(switcherSource.includes('onModuleChange?.(activeModuleId)'), 'module switcher must delegate navigation');
assert(registrySource.includes("from './tasks.js'"), 'tasks must be registered as a module definition');
assert(registrySource.includes("from './shopping.js'"), 'shopping must be registered as a module definition');
assert(registrySource.includes("from './recipes.js'"), 'recipes must be registered as a module definition');
assert(shellSource.includes('module.mount?.({ slots, shell: api })'), 'module shell must mount every module through the shared slot contract');
assert(shellSource.includes('translatePage(panel)'), 'dynamically mounted module markup must enter the active i18n lifecycle');
assert(shellSource.includes('active.activate?.()'), 'self-contained modules must be able to own activation behavior');
assert(shellSource.includes('getModule(previousModuleId).deactivate?.()'), 'self-contained modules must be able to own deactivation behavior');
assert(shellSource.includes('getModule(activeModuleId).onSearch?.(value)'), 'self-contained modules must receive shared search events');
assert(shellSource.includes('controllers.get(activeModuleId)?.onSearch?.(value)'), 'module shell must route search to the active controller');
assert(shellSource.includes("window.addEventListener('popstate'"), 'module shell must react to browser history');
assert(shellSource.includes('if (normalize || previousModuleId !== activeModuleId) renderActiveModule();'), 'same-module UI history changes must not reactivate and rerender the active module');
assert(shellSource.includes('history.pushState('), 'module navigation must create browser history entries');
assert(shellSource.includes('history.replaceState('), 'startup must normalize the module URL without adding history');
assert(shellSource.includes("const PERSISTENT_MODULE_SLOTS = new Set(['settingsNav', 'settings', 'desktopHotkeys'])"), 'registered module settings must remain available independently of the active module');
assert(shellSource.includes('resolveEnabledModuleId('), 'module navigation must resolve disabled modules against account preferences');
assert(switcherSource.includes('getModules().map('), 'module switcher must render only account-enabled modules');
assert(tasksSource.includes('workspaces: true'), 'tasks must declare workspace capability');
assert(!shoppingSource.includes('workspaces: true'), 'shopping must not declare workspace capability');
assert(!recipesSource.includes('workspaces: true'), 'recipes must not declare workspace capability');
assert(shellSource.includes("document.getElementById('workspace-switcher')"), 'the shell must control workspace switcher visibility');

for (const slotId of ['module-sidebar-slot', 'module-topbar-slot', 'module-main-slot', 'module-floating-slot', 'module-user-menu-slot', 'module-shortcuts-slot', 'module-settings-nav-slot', 'module-settings-slot', 'module-desktop-hotkeys-slot']) {
  assert(indexSource.includes(`id="${slotId}"`), `shared shell must expose ${slotId}`);
}
assert(!indexSource.includes('id="project-list"'), 'task navigation must no longer be static app-shell markup');
assert(!indexSource.includes('id="todo-list"'), 'task content must no longer be static app-shell markup');
assert(tasksSource.includes('id="project-list"'), 'tasks module must own project navigation');
assert(tasksSource.includes('id="todo-list"'), 'tasks module must own task content');
for (const modalId of ['dashboard-preferences-modal', 'todo-modal', 'project-modal', 'attachment-preview-modal', 'android-location-permission-modal']) {
  assert(!indexSource.includes(`id="${modalId}"`), `${modalId} must no longer be static app-shell markup`);
  assert(taskDialogsSource.includes(`id="${modalId}"`), `tasks module must own ${modalId}`);
}
assert(tasksSource.includes('id="module-user-menu-slot"') === false, 'tasks must fill the provided user-menu slot rather than define the shell slot');
const shortcutsModalSource = indexSource.slice(indexSource.indexOf('id="shortcuts-modal"'), indexSource.indexOf('id="app-downloads-modal"'));
assert(shortcutsModalSource.includes('shortcuts.switchWorkspace'), 'workspace shortcuts must remain available in the shared shell');
assert(!shortcutsModalSource.includes('shortcuts.newTodo'), 'task shortcuts must not remain static shell content');
assert(taskShortcutsSource.includes('shortcuts.newTodo'), 'tasks module must own task-specific shortcuts');
assert(workspacesSource.includes('workspaceIndexFromShortcut(event)'), 'workspace switching must remain a shared app shortcut');
assert(!workspacesSource.includes('getActiveModule'), 'workspace shortcuts must not be restricted to the tasks module');
for (const settingId of ['settings-section-default-reminder', 'settings-section-attachments', 'settings-section-places', 'settings-section-braindump', 'desktop-hotkey-new-todo', 'desktop-hotkey-search']) {
  assert(!indexSource.includes(`id="${settingId}"`), `${settingId} must not remain static shell content`);
  assert(taskSettingsSource.includes(`id="${settingId}"`), `tasks module must own ${settingId}`);
}
assert(moduleCss.includes('.module-slot-panel[hidden]'), 'inactive module panels must be hidden by the shared slot system');
assert(shoppingSource.includes('createEmptyModule'), 'shopping must remain an empty registered module');
assert(recipesSource.includes('createEmptyModule'), 'recipes must remain an empty registered module');
assert(!existsSync(new URL('web/static/js/modules/shopping-preview.js', root)), 'shopping feature implementation must not exist yet');
assert(!indexSource.includes('shopping-list-modal'), 'shopping-specific dialogs must not exist yet');
assert(!moduleCss.includes('.shopping-item'), 'shopping-specific component styling must not exist yet');
assert(!indexSource.includes('id="workspace-module-list"'), 'module visibility must not be configured in workspace settings');
assert(!workspacesSource.includes('hidden_modules'), 'workspace payloads must not persist module visibility');
assert(indexSource.includes('id="settings-section-modules"'), 'account module visibility must live in settings');
assert(indexSource.includes('data-settings-section="settings-section-modules"><span data-icon="blocks"'), 'module settings navigation must use the bundled Lucide blocks icon');
assert(!indexSource.includes('data-icon="layout-grid"'), 'module settings navigation must not use an icon missing from the bundled Lucide set');
assert(registrySource.includes('REGISTERED_MODULE_IDS = Object.freeze(["tasks", "shopping", "recipes"])'), 'the central registry must expose server-readable authoritative module ids');
assert(taskSettingsSource.includes('data-module-settings-group="tasks"'), 'task settings must be visibly grouped as module-specific settings');
assert(shellSource.includes('const searchValues = new Map()'), 'the shell must preserve search state per module');
assert(!shellSource.includes("if (search?.value) search.value = ''"), 'module navigation must not discard another module search state');
assert(appSource.includes("moduleShell?.getActiveModule?.() !== 'tasks'"), 'native task hotkeys must be inactive outside the tasks module');
assert(todosSource.includes("if (getActiveModule() !== 'tasks') return;"), 'todo list shortcuts must be inactive outside the tasks module');
assert(appSource.includes('onDeactivate: () => todosFeature.resetTodoShortcutTarget()'), 'leaving tasks must clear the todo shortcut target');

const requiredKeys = ['module.placeholder.body', 'module.placeholder.search', 'settings.modules.title', 'settings.modules.hint', 'settings.modules.oneRequired'];
const forbiddenKeys = ['shopping.searchPlaceholder', 'recipes.searchPlaceholder', 'shopping.list.new', 'shopping.item.add', 'shopping.sample.weekly'];
for (const locale of ['cs', 'de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'zh-CN']) {
  const dictionary = JSON.parse(read(`web/static/i18n/${locale}.json`));
  for (const key of requiredKeys) {
    assert.equal(typeof dictionary[key], 'string', `${locale} must contain ${key}`);
    assert(dictionary[key].trim(), `${locale} ${key} must not be empty`);
  }
  for (const key of forbiddenKeys) assert.equal(dictionary[key], undefined, `${locale} must not contain premature ${key}`);
}

console.log('✅ V4 module platform contract, task module migration, empty modules, routes, and i18n passed');
