const DEFAULT_SETTINGS = {
  minimizeToTray: true,
  autostart: false,
  notifications: true,
  hotkeys: {
    toggleApp: '',
    newTodo: '',
    search: '',
  },
};

function getTauri() {
  return window.__TAURI__ || null;
}

function getInvoke() {
  return getTauri()?.core?.invoke || null;
}

function isNativeApp() {
  return Boolean(getInvoke());
}

function isAndroidApp() {
  return isNativeApp() && /Android/i.test(navigator.userAgent || '');
}

function isDesktopApp() {
  return isNativeApp() && !isAndroidApp();
}

async function invokeDesktop(command, args = {}) {
  const invoke = getInvoke();
  if (!invoke) throw new Error('Tauri API not available');
  return invoke(command, args);
}

function mergeSettings(raw = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    hotkeys: {
      ...DEFAULT_SETTINGS.hotkeys,
      ...(raw.hotkeys || {}),
    },
  };
}

function setChecked(id, value) {
  const el = document.getElementById(id);
  if (el) el.checked = Boolean(value);
}

function setValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value || '';
}

const HOTKEY_INPUTS = {
  toggleApp: 'desktop-hotkey-toggle-app',
  newTodo: 'desktop-hotkey-new-todo',
  search: 'desktop-hotkey-search',
};

const KEY_ALIASES = {
  ' ': 'Space',
  Spacebar: 'Space',
  Esc: 'Escape',
  Del: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Control: 'Ctrl',
  OS: 'Super',
  Meta: 'Super',
};

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'Ctrl', 'Super']);

function isModifierKey(event) {
  return MODIFIER_KEYS.has(event.key) || MODIFIER_KEYS.has(KEY_ALIASES[event.key]);
}

function normalizeHotkeyKey(event) {
  if (isModifierKey(event)) return '';
  if (event.code?.startsWith('Key') && event.code.length === 4) return event.code.slice(3).toUpperCase();
  if (event.code?.startsWith('Digit') && event.code.length === 6) return event.code.slice(5);
  const key = KEY_ALIASES[event.key] || event.key;
  if (!key) return '';
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function hotkeyFromKeyboardEvent(event) {
  if (event.key === 'Backspace' || event.key === 'Delete') return '';
  if (event.repeat) return null;
  const key = normalizeHotkeyKey(event);
  if (!key) return null;
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Super');
  parts.push(key);
  return parts.join('+');
}

function normalizeServerUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Bitte eine http(s)-URL eingeben.');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function setDesktopStatus(text, danger = false) {
  const el = document.getElementById('desktop-settings-status');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = danger ? 'var(--danger)' : 'var(--text-muted)';
}

export function createDesktopIntegration({ wsSend, getWsState, showToast, onHotkeyNewTodo, onHotkeySearch }) {
  let settings = { ...DEFAULT_SETTINGS };

  async function loadSettings() {
    if (!isNativeApp()) return settings;
    try {
      settings = mergeSettings(await invokeDesktop('desktop_get_settings'));
    } catch (error) {
      console.warn('[Desktop] Failed to load settings', error);
    }
    return settings;
  }

  function renderSettings() {
    const native = isNativeApp();
    const desktop = isDesktopApp();
    const section = document.getElementById('desktop-settings-section');
    const browserPushSection = document.getElementById('browser-push-settings-section');
    const desktopOnlySections = document.querySelectorAll('[data-desktop-only]');
    if (browserPushSection) browserPushSection.style.display = native ? 'none' : '';
    desktopOnlySections.forEach((el) => { el.style.display = desktop ? '' : 'none'; });
    if (!section) return;
    section.style.display = native ? '' : 'none';
    if (!native) return;
    setChecked('desktop-minimize-to-tray', settings.minimizeToTray);
    setChecked('desktop-autostart', settings.autostart);
    setChecked('desktop-notifications', settings.notifications);
    const serverUrl = document.getElementById('desktop-server-url');
    if (serverUrl) serverUrl.value = settings.serverUrl || location.origin;
    setValue('desktop-hotkey-toggle-app', settings.hotkeys?.toggleApp);
    setValue('desktop-hotkey-new-todo', settings.hotkeys?.newTodo);
    setValue('desktop-hotkey-search', settings.hotkeys?.search);
  }

  async function init() {
    if (!isNativeApp()) {
      renderSettings();
      return;
    }
    if (isDesktopApp()) bindHotkeyCaptureInputs();
    await loadSettings();
    renderSettings();
    if (isDesktopApp()) bindHotkeyEvents();
    announceNotificationReadiness();
  }

  async function updateSetting(key, value) {
    if (!isNativeApp()) return;
    const nextValue = Boolean(value);
    settings[key] = nextValue;
    renderSettings();
    setDesktopStatus('Speichere...');
    try {
      settings = mergeSettings(await invokeDesktop('desktop_set_setting', { key, value: nextValue }));
      renderSettings();
      setDesktopStatus('Gespeichert.');
      if (key === 'notifications') announceNotificationReadiness();
    } catch (error) {
      setDesktopStatus(error?.message || String(error), true);
      await loadSettings();
      renderSettings();
    }
  }

  async function ensureNativeNotificationPermission() {
    if (!isNativeApp()) return true;
    try {
      const state = await invokeDesktop('desktop_request_notification_permission');
      return state === 'granted';
    } catch (error) {
      console.warn('[Native] Notification permission request failed', error);
    }
    return false;
  }

  async function announceNotificationReadiness() {
    if (!isNativeApp() || !settings.notifications) return;
    await ensureNativeNotificationPermission();
    if (getWsState() === 'connected') {
      wsSend({ type: 'desktop_notify_ready', enabled: true });
    }
  }

  async function notifyReminder(reminder) {
    if (!isNativeApp() || !settings.notifications) return;
    if (!await ensureNativeNotificationPermission()) return;
    const title = reminder?.title || '⏰ Erinnerung';
    const body = reminder?.body || reminder?.todo_title || 'Todo-Erinnerung';
    try {
      await invokeDesktop('desktop_notify', { title, body });
    } catch (error) {
      console.warn('[Desktop] Notification failed', error);
      showToast?.('Desktop-Benachrichtigung fehlgeschlagen');
    }
  }

  async function updateServerUrl(value) {
    if (!isNativeApp()) return;
    try {
      const serverUrl = normalizeServerUrl(value);
      settings = mergeSettings(await invokeDesktop('desktop_set_server_url', { serverUrl }));
      setDesktopStatus('Server gespeichert. App lädt neu...');
      setTimeout(() => location.replace(serverUrl), 250);
    } catch (error) {
      setDesktopStatus(error?.message || String(error), true);
    }
  }

  async function resetServerUrl() {
    if (!isNativeApp()) return;
    try {
      await invokeDesktop('desktop_clear_server_url');
      setDesktopStatus('Server zurückgesetzt. App lädt neu...');
      setTimeout(() => location.replace('tauri://localhost/'), 250);
    } catch (error) {
      setDesktopStatus(error?.message || String(error), true);
    }
  }

  async function testNotification() {
    if (!isNativeApp()) return;
    if (!await ensureNativeNotificationPermission()) {
      setDesktopStatus('Benachrichtigungsberechtigung wurde nicht erteilt.', true);
      return;
    }
    try {
      await invokeDesktop('desktop_notify', {
        title: '🔔 nia-todo',
        body: 'Desktop-Benachrichtigungen funktionieren.',
      });
      setDesktopStatus('Test-Benachrichtigung gesendet.');
    } catch (error) {
      setDesktopStatus(error?.message || String(error), true);
    }
  }

  async function updateHotkey(action, shortcut) {
    if (!isDesktopApp()) return;
    setDesktopStatus('Speichere Hotkey...');
    try {
      settings = mergeSettings(await invokeDesktop('desktop_set_hotkey', { action, shortcut: shortcut || '' }));
      renderSettings();
      setDesktopStatus('Hotkey gespeichert.');
    } catch (error) {
      setDesktopStatus(error?.message || String(error), true);
      await loadSettings();
      renderSettings();
    }
  }

  let hotkeyCaptureBound = false;
  function bindHotkeyCaptureInputs() {
    if (hotkeyCaptureBound) return;
    hotkeyCaptureBound = true;
    for (const [action, id] of Object.entries(HOTKEY_INPUTS)) {
      const input = document.getElementById(id);
      if (!input) continue;
      input.readOnly = true;
      input.addEventListener('focus', () => {
        input.placeholder = 'Tastenkombination drücken…';
        input.classList.add('recording-hotkey');
        setDesktopStatus('Tastenkombination drücken. Backspace/Entf löscht den Hotkey.');
      });
      input.addEventListener('blur', () => {
        input.placeholder = '';
        input.classList.remove('recording-hotkey');
      });
      input.addEventListener('keydown', async (event) => {
        if (event.key === 'Tab') return;
        event.preventDefault();
        event.stopPropagation();
        const shortcut = hotkeyFromKeyboardEvent(event);
        if (shortcut === null) return;
        input.value = shortcut;
        await updateHotkey(action, shortcut);
        input.blur();
      });
    }
  }

  let hotkeyEventsBound = false;
  async function bindHotkeyEvents() {
    if (hotkeyEventsBound) return;
    const listen = getTauri()?.event?.listen;
    if (!listen) return;
    hotkeyEventsBound = true;
    await listen('desktop-hotkey', (event) => {
      const action = event?.payload?.action;
      if (action === 'newTodo') {
        onHotkeyNewTodo?.();
      } else if (action === 'search') {
        onHotkeySearch?.();
      }
    });
  }

  return {
    isDesktopApp,
    isNativeApp,
    isAndroidApp,
    init,
    loadSettings,
    renderSettings,
    updateSetting,
    announceNotificationReadiness,
    notifyReminder,
    updateServerUrl,
    resetServerUrl,
    testNotification,
    updateHotkey,
  };
}
