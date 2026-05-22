import { RUNTIME_CAPABILITIES } from '../core/config.js';

function splitTopLevel(value, separator = ';') {
  const parts = [];
  let current = '';
  let quote = null;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const prev = value[i - 1];
    if (quote) {
      current += char;
      if (char === quote && prev !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === separator && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseLegacyArg(raw, event) {
  const value = raw.trim();
  if (!value) return undefined;
  if (value === 'event') return event;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"');
  }
  const elementValue = value.match(/^document\.getElementById\(['"]([^'"]+)['"]\)\.value$/);
  if (elementValue) return document.getElementById(elementValue[1])?.value;
  return value;
}

function runLegacyInlineAction(source, event) {
  for (const statement of splitTopLevel(String(source || ''), ';')) {
    if (statement === 'event.stopPropagation()') {
      event.stopPropagation();
      continue;
    }
    if (statement === 'location.reload()') {
      location.reload();
      continue;
    }
    const clickTarget = statement.match(/^document\.getElementById\(['"]([^'"]+)['"]\)\.click\(\)$/);
    if (clickTarget) {
      document.getElementById(clickTarget[1])?.click();
      continue;
    }
    const call = statement.match(/^([A-Za-z_$][\w$]*)\((.*)\)$/);
    if (!call) {
      console.warn('[LegacyClickBridge] Unsupported inline action', statement);
      continue;
    }
    const fn = window[call[1]];
    if (typeof fn !== 'function') {
      console.warn('[LegacyClickBridge] Missing global function', call[1]);
      continue;
    }
    const args = call[2].trim() ? splitTopLevel(call[2], ',').map(arg => parseLegacyArg(arg, event)) : [];
    fn(...args);
  }
}

let legacyClickBridgeBound = false;
function bindAndroidLegacyClickBridge() {
  if (legacyClickBridgeBound || !RUNTIME_CAPABILITIES.android) return;
  legacyClickBridgeBound = true;
  document.addEventListener('click', (event) => {
    const target = event.target?.closest?.('[onclick]');
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    runLegacyInlineAction(target.getAttribute('onclick'), event);
  }, true);
}

export function exposeLegacyGlobals({
  auth,
  apiKeys,
  userSettings,
  userMenu,
  utils,
  theme,
  websocket,
  storage,
  sync,
  ui,
  lifecycle,
  rendering,
  navigation,
  workspaces,
  todos,
  projects,
  sharing,
  projectSharing,
  sections,
  dragDrop,
  viewPreferences,
  toastUndo,
  push,
  desktopIntegration,
}) {
  Object.assign(window, {
    ...auth,
    ...apiKeys,
    ...userSettings,
    ...userMenu,
    ...utils,
    ...theme,
    ...websocket,
    ...storage,
    ...sync,
    ...ui,
    ...lifecycle,
    ...rendering,
    ...navigation,
    ...workspaces,
    ...todos,
    ...projects,
    ...sharing,
    ...projectSharing,
    ...sections,
    ...dragDrop,
    ...viewPreferences,
    ...toastUndo,
    ...push,
    ...desktopIntegration,
  });
  bindAndroidLegacyClickBridge();
}
