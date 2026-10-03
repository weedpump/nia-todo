import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    language: 'en-US',
    languages: ['en-US'],
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    platform: 'Linux x86_64',
    maxTouchPoints: 0,
  },
});
globalThis.location = {
  origin: 'tauri://localhost',
  search: '?nativeApp=tauri',
  protocol: 'tauri:',
  host: 'localhost',
};
globalThis.document = {
  documentElement: { lang: '' },
  querySelectorAll() { return []; },
};
globalThis.window = new EventTarget();

const dictionaries = {
  en: {
    'settings.desktop.hotkeys.toggleApp': 'Show/hide nia-todo',
    'settings.desktop.hotkeys.newTodo': 'New nia-todo todo',
    'settings.desktop.hotkeys.search': 'nia-todo search',
  },
  de: {
    'settings.desktop.hotkeys.toggleApp': 'nia-todo anzeigen/verstecken',
    'settings.desktop.hotkeys.newTodo': 'Neues nia-todo Todo',
    'settings.desktop.hotkeys.search': 'nia-todo Suche',
  },
};
globalThis.fetch = async (url) => {
  const language = String(url).match(/\/([^/]+)\.json$/)?.[1];
  return {
    ok: Boolean(dictionaries[language]),
    async json() { return dictionaries[language]; },
  };
};

const invokeCalls = [];
let rejectFirstInvoke;
window.__TAURI_INTERNALS__ = {
  invoke(command, args) {
    invokeCalls.push({ command, args });
    if (invokeCalls.length === 1) {
      return new Promise((_resolve, reject) => { rejectFirstInvoke = reject; });
    }
    return Promise.resolve({});
  },
};

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let nextTimerId = 1;
globalThis.setTimeout = (callback) => {
  const id = nextTimerId++;
  queueMicrotask(callback);
  return id;
};
globalThis.clearTimeout = () => {};

try {
  const i18n = await import('../web/static/js/i18n/index.js');
  await i18n.initI18n();
  const hotkeyDescriptions = await import('../web/static/js/features/desktop-hotkey-descriptions.js');
  hotkeyDescriptions.bindDesktopHotkeyDescriptionSync();

  const initialSync = hotkeyDescriptions.syncDesktopHotkeyDescriptions();
  assert.equal(invokeCalls.length, 1);
  assert.equal(invokeCalls[0].args.descriptions.toggleApp, 'Show/hide nia-todo');

  await i18n.setLanguagePreference('de');
  rejectFirstInvoke(new Error('expected transient native failure'));
  await initialSync;

  for (let index = 0; index < 10 && invokeCalls.length < 2; index += 1) {
    await Promise.resolve();
  }

  assert.equal(invokeCalls.length, 2, 'A failed native sync must retry the latest pending language');
  assert.equal(invokeCalls[1].command, 'desktop_sync_hotkey_descriptions');
  assert.deepEqual(invokeCalls[1].args.descriptions, {
    toggleApp: 'nia-todo anzeigen/verstecken',
    newTodo: 'Neues nia-todo Todo',
    search: 'nia-todo Suche',
  });
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

console.log('✅ Desktop hotkey description synchronization regression passed');
