import { MODULES } from './registry.js';

const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const MAX_DISABLED_MODULE_IDS = 128;

export function storedDisabledModuleIdsForUser(user) {
  let values = user?.disabled_modules;
  if (typeof values === 'string') {
    try {
      values = JSON.parse(values);
    } catch {
      values = [];
    }
  }
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  return values.slice(0, MAX_DISABLED_MODULE_IDS).filter(moduleId => {
    if (typeof moduleId !== 'string' || !MODULE_ID_PATTERN.test(moduleId) || seen.has(moduleId)) return false;
    seen.add(moduleId);
    return true;
  });
}

export function normalizeDisabledModuleIds(moduleIds) {
  const values = storedDisabledModuleIdsForUser({ disabled_modules: moduleIds });
  const knownIds = MODULES.map(module => module.id);
  const requested = new Set(values.filter(moduleId => knownIds.includes(moduleId)));
  const disabled = knownIds.filter(moduleId => requested.has(moduleId));
  return disabled.length === knownIds.length ? disabled.slice(1) : disabled;
}

export function disabledModuleIdsForUser(user) {
  return normalizeDisabledModuleIds(storedDisabledModuleIdsForUser(user));
}

export function enabledModulesForUser(user) {
  const disabled = new Set(disabledModuleIdsForUser(user));
  return MODULES.filter(module => !disabled.has(module.id));
}

export function resolveEnabledModuleId(moduleId, user) {
  const enabled = enabledModulesForUser(user);
  return enabled.some(module => module.id === moduleId) ? moduleId : enabled[0].id;
}
