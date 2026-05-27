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
  if (value === 'this.value') return event?.target?.value;
  if (value === 'this.checked') return Boolean(event?.target?.checked);
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

let legacyInputBridgeBound = false;
function bindNativeLegacyInputBridge() {
  if (legacyInputBridgeBound || !RUNTIME_CAPABILITIES.native) return;
  legacyInputBridgeBound = true;

  document.addEventListener('input', (event) => {
    if (event.target?.id === 'search-input') window.renderTodos?.();
  }, true);

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (!target?.id) return;
    if (target.id === 'new-section-name') {
      if (event.key === 'Enter') {
        event.preventDefault();
        window.saveNewSection?.();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        window.renderTodos?.();
      }
      return;
    }
    const editMatch = target.id.match(/^edit-section-name-(.+)$/);
    if (editMatch) {
      if (event.key === 'Enter') {
        event.preventDefault();
        window.saveSectionEdit?.(editMatch[1]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        window.renderTodos?.();
      }
    }
  }, true);
}

function bindNativeLegacyEventBridge(eventName, attributeName) {
  document.addEventListener(eventName, (event) => {
    const target = event.target?.closest?.(`[${attributeName}]`);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    runLegacyInlineAction(target.getAttribute(attributeName), event);
  }, true);
}

let legacyInlineBridgeBound = false;
function bindNativeLegacyInlineBridge() {
  if (legacyInlineBridgeBound || !RUNTIME_CAPABILITIES.native) return;
  legacyInlineBridgeBound = true;
  bindNativeLegacyEventBridge('click', 'onclick');
  bindNativeLegacyEventBridge('change', 'onchange');
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
  appDownloads,
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
    ...appDownloads,
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
  bindNativeLegacyInlineBridge();
  bindNativeLegacyInputBridge();
}
