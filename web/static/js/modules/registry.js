import { recipesModule } from './recipes.js';
import { shoppingModule } from './shopping.js';
import { tasksModule } from './tasks.js';

export const REGISTERED_MODULE_IDS = Object.freeze(["tasks", "shopping", "recipes"]);

const MODULE_DEFINITIONS = new Map([
  [tasksModule.id, tasksModule],
  [shoppingModule.id, shoppingModule],
  [recipesModule.id, recipesModule],
]);

export const MODULES = Object.freeze(REGISTERED_MODULE_IDS.map(moduleId => {
  const module = MODULE_DEFINITIONS.get(moduleId);
  if (!module) throw new Error(`Missing registered module definition: ${moduleId}`);
  return module;
}));

export const MODULE_STORAGE_KEY = 'nia-active-module';
export const LEGACY_MODULE_STORAGE_KEY = 'nia-active-module-preview';

export function getModule(moduleId) {
  return MODULES.find(module => module.id === moduleId) || MODULES[0];
}

export function isModuleId(moduleId) {
  return MODULES.some(module => module.id === moduleId);
}

export function readStoredModule(storage = globalThis.localStorage) {
  try {
    const stored = storage?.getItem?.(MODULE_STORAGE_KEY)
      || storage?.getItem?.(LEGACY_MODULE_STORAGE_KEY);
    return isModuleId(stored) ? stored : 'tasks';
  } catch {
    return 'tasks';
  }
}

export function persistModule(moduleId, storage = globalThis.localStorage) {
  if (!isModuleId(moduleId)) return;
  try {
    storage?.setItem?.(MODULE_STORAGE_KEY, moduleId);
    storage?.removeItem?.(LEGACY_MODULE_STORAGE_KEY);
  } catch {
    // Keep the current in-memory module when storage is unavailable.
  }
}
