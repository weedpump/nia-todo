import { MODULES } from './registry.js';

const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const MAX_WORKSPACE_MODULE_IDS = 128;

export function storedHiddenModuleIdsForWorkspace(workspace) {
  let values = workspace?.hidden_modules;
  if (typeof values === 'string') {
    try {
      values = JSON.parse(values);
    } catch {
      values = [];
    }
  }
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  return values.slice(0, MAX_WORKSPACE_MODULE_IDS).filter(moduleId => {
    if (typeof moduleId !== 'string' || !MODULE_ID_PATTERN.test(moduleId) || seen.has(moduleId)) return false;
    seen.add(moduleId);
    return true;
  });
}

export function normalizeHiddenModuleIds(moduleIds) {
  const values = storedHiddenModuleIdsForWorkspace({ hidden_modules: moduleIds });
  const knownIds = MODULES.map(module => module.id);
  const requested = new Set(values.filter(moduleId => knownIds.includes(moduleId)));
  const hidden = knownIds.filter(moduleId => requested.has(moduleId));
  return hidden.length === knownIds.length ? hidden.slice(1) : hidden;
}

export function hiddenModuleIdsForWorkspace(workspace) {
  return normalizeHiddenModuleIds(storedHiddenModuleIdsForWorkspace(workspace));
}

export function visibleModulesForWorkspace(workspace) {
  const hidden = new Set(hiddenModuleIdsForWorkspace(workspace));
  return MODULES.filter(module => !hidden.has(module.id));
}

export function resolveWorkspaceModuleId(moduleId, workspace) {
  const visible = visibleModulesForWorkspace(workspace);
  return visible.some(module => module.id === moduleId) ? moduleId : visible[0].id;
}
