import { RUNTIME_CAPABILITIES, normalizeServerUrl as normalizeRuntimeServerUrl } from '../core/config.js';
import { t } from '../i18n/index.js';
import { createNativeBridge } from './native-bridge.js';

const DEFAULT_SETTINGS = {
  minimizeToTray: true,
  autostart: false,
  startMinimizedToTray: false,
  notifications: true,
  hotkeys: {
    toggleApp: '',
    newTodo: '',
    search: '',
  },
};

function isNativeApp() {
  return RUNTIME_CAPABILITIES.native;
}

function isAndroidApp() {
  return RUNTIME_CAPABILITIES.android;
}

function isDesktopApp() {
  return RUNTIME_CAPABILITIES.desktop;
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

function setDesktopStatus(text, danger = false) {
  document.querySelectorAll('[data-desktop-settings-status]').forEach((el) => {
    el.textContent = text || '';
    el.style.color = danger ? 'var(--danger)' : 'var(--text-muted)';
  });
}

export function createDesktopIntegration({ showToast, onHotkeyNewTodo, onHotkeySearch, getCurrentUser }) {
  const nativeBridge = createNativeBridge();
  let settings = { ...DEFAULT_SETTINGS };
  let latestTodos = [];
  let reminderScheduleTimer = null;
  let settingsControlsBound = false;
  let settingsLoaded = !isNativeApp();

  async function loadSettings() {
    if (!isNativeApp()) return settings;
    try {
      settings = mergeSettings(await nativeBridge.getSettings());
    } catch (error) {
      console.warn('[Desktop] Failed to load settings', error);
    } finally {
      settingsLoaded = true;
    }
    return settings;
  }

  function ensureLoginServerControls() {
    if (!RUNTIME_CAPABILITIES.nativeSettings || document.getElementById('login-native-server-switch')) return;
    const loginBox = document.querySelector('#login-overlay .login-box');
    if (!loginBox) return;
    const panel = document.createElement('div');
    panel.className = 'login-native-server-panel';
    panel.innerHTML = `
      <button type="button" class="btn btn-secondary login-native-server-toggle" id="login-native-server-switch" data-i18n-key="settings.desktop.server.change">${t('settings.desktop.server.change')}</button>
      <div class="desktop-settings-status login-native-server-status" data-desktop-settings-status></div>
    `;
    loginBox.appendChild(panel);
    panel.querySelector('#login-native-server-switch')?.addEventListener('click', () => resetServerUrl());
  }

  function bindSettingsControls() {
    if (settingsControlsBound) return;
    const bindings = [
      ['desktop-minimize-to-tray', 'minimizeToTray'],
      ['desktop-autostart', 'autostart'],
      ['desktop-start-minimized-to-tray', 'startMinimizedToTray'],
      ['desktop-notifications', 'notifications'],
    ];
    let boundAny = false;
    for (const [id, key] of bindings) {
      const el = document.getElementById(id);
      if (!el) continue;
      boundAny = true;
      el.addEventListener('change', () => updateSetting(key, el.checked));
    }
    if (boundAny) settingsControlsBound = true;
  }

  function renderSettings() {
    const native = RUNTIME_CAPABILITIES.nativeSettings;
    const desktop = RUNTIME_CAPABILITIES.nativeHotkeys;
    const section = document.getElementById('desktop-settings-section');
    const appSection = document.getElementById('settings-section-app');
    const appNav = document.getElementById('settings-nav-app');
    const browserPushSection = document.getElementById('browser-push-settings-section');
    const notificationSection = document.getElementById('settings-section-notifications');
    const notificationNav = document.getElementById('settings-nav-notifications');
    const desktopOnlySections = document.querySelectorAll('[data-desktop-only]');
    if (browserPushSection) browserPushSection.style.display = native ? 'none' : '';
    if (notificationSection) notificationSection.style.display = native ? 'none' : '';
    if (notificationNav) notificationNav.style.display = native ? 'none' : '';
    desktopOnlySections.forEach((el) => { el.style.display = desktop ? '' : 'none'; });
    if (!section) return;
    section.style.display = native ? '' : 'none';
    if (appSection) appSection.style.display = native ? '' : 'none';
    if (appNav) appNav.style.display = native ? '' : 'none';
    if (!native) return;
    ensureLoginServerControls();
    bindSettingsControls();
    setChecked('desktop-minimize-to-tray', settings.minimizeToTray);
    setChecked('desktop-autostart', settings.autostart);
    setChecked('desktop-start-minimized-to-tray', settings.startMinimizedToTray);
    setChecked('desktop-notifications', settings.notifications);
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
    syncLocalReminders(latestTodos, { immediate: true });
    announceNotificationReadiness();
  }

  async function updateSetting(key, value) {
    if (!isNativeApp()) return;
    const nextValue = Boolean(value);
    settings[key] = nextValue;
    renderSettings();
    setDesktopStatus(t('common.saving'));
    try {
      settings = mergeSettings(await nativeBridge.setSetting(key, nextValue));
      renderSettings();
      setDesktopStatus(t('common.saved'));
      if (key === 'notifications') syncLocalReminders(latestTodos, { immediate: true });
    } catch (error) {
      setDesktopStatus(error?.message || String(error), true);
      await loadSettings();
      renderSettings();
    }
  }

  async function ensureNativeNotificationPermission() {
    if (!isNativeApp()) return true;
    try {
      const state = await nativeBridge.requestNotificationPermission();
      return state === 'granted' || state === 'prompt';
    } catch (error) {
      console.warn('[Native] Notification permission request failed', error);
    }
    return false;
  }

  async function announceNotificationReadiness() {
    // Native apps schedule Todo reminders locally. Server push/WebSocket
    // notification readiness is intentionally browser/PWA-only now.
    if (!isNativeApp()) return;
    if (!settingsLoaded) await loadSettings();
    if (!settings.notifications) return;
    if (await ensureNativeNotificationPermission()) {
      syncLocalReminders(latestTodos, { immediate: true });
    }
  }

  async function notifyReminder(reminder) {
    if (!isNativeApp() || !settings.notifications) return;
    if (!await ensureNativeNotificationPermission()) return;
    const title = reminder?.title || t('settings.desktop.reminder.title');
    const body = reminder?.body || reminder?.todo_title || t('settings.desktop.reminder.body');
    try {
      const sent = await nativeBridge.notify(title, body);
      if (!sent) showToast?.(t('settings.desktop.notifications.permissionMissing'));
    } catch (error) {
      console.warn('[Native] Notification failed', error);
      showToast?.(t('settings.desktop.notifications.failed'));
    }
  }

  function reminderTime(todo) {
    return todo?.remind_at || todo?.reminders?.[0]?.remind_at || null;
  }

  function reminderTitle(todo) {
    return t('settings.desktop.reminder.title');
  }

  function reminderBody(todo) {
    return todo?.title || todo?.body || todo?.todo_title || t('settings.desktop.reminder.body');
  }

  function buildReminderSchedules(todos = []) {
    const now = Date.now();
    const currentUser = getCurrentUser?.();
    const userId = currentUser?.id == null ? '' : String(currentUser.id);
    return todos
      .filter((todo) => todo && todo.status !== 'done')
      .map((todo) => {
        const dueAt = Date.parse(reminderTime(todo));
        if (!Number.isFinite(dueAt) || dueAt <= now) return null;
        return {
          id: String(todo.id),
          title: reminderTitle(todo),
          body: reminderBody(todo),
          dueAtMs: dueAt,
          userId,
        };
      })
      .filter(Boolean);
  }

  function buildLocationReminderSchedules(todos = []) {
    const currentUser = getCurrentUser?.();
    const userId = currentUser?.id == null ? '' : String(currentUser.id);
    return todos
      .filter((todo) => todo && todo.status !== 'done')
      .flatMap((todo) => {
        const locationReminders = Object.prototype.hasOwnProperty.call(todo, 'location_reminder')
          ? (todo.location_reminder ? [todo.location_reminder] : [])
          : (todo.location_reminders || []);
        return locationReminders.map((locationReminder) => {
        if (!locationReminder || locationReminder.enabled === 0 || locationReminder.enabled === false) return null;
        const address = String(locationReminder.address || '').trim();
        const triggerType = locationReminder.trigger_type || locationReminder.triggerType;
        if (!address) return null;
        if (!['arrival', 'departure'].includes(triggerType)) return null;
        return {
          id: `location-${locationReminder.id || todo.id}`,
          todoId: String(todo.id),
          title: t('todo.location.notificationTitle'),
          body: reminderBody(todo),
          triggerType,
          address,
          userId,
        };
        });
      })
      .filter(Boolean);
  }

  async function ensureNativeLocationPermission(required = false) {
    if (!required || !RUNTIME_CAPABILITIES.android) return true;
    try {
      const state = nativeBridge.locationPermissionState?.() || 'unsupported';
      if (state === 'granted') return true;
      const requested = nativeBridge.requestLocationPermission?.() || state;
      return requested === 'granted';
    } catch (error) {
      console.warn('[Native] Location permission request failed', error);
      return false;
    }
  }

  async function scheduleLocalRemindersNow() {
    if (!isNativeApp()) return;
    const reminders = settings.notifications ? buildReminderSchedules(latestTodos) : [];
    const locationReminders = settings.notifications ? buildLocationReminderSchedules(latestTodos) : [];
    if (!RUNTIME_CAPABILITIES.nativeNotifications) return;
    if (!settings.notifications) {
      try {
        await nativeBridge.clearReminders();
      } catch (error) {
        console.warn('[Native] Failed to clear local reminders', error);
      }
      return;
    }
    try {
      if (!await ensureNativeNotificationPermission()) return;
      await nativeBridge.scheduleReminders(reminders);
      // Always hand location schedules to Android first. The native layer stores
      // them even without location permission, so onResume/onPermissionResult can
      // register geofences after the user grants access.
      const scheduledLocations = await nativeBridge.scheduleLocationReminders?.(locationReminders);
      if (locationReminders.length) {
        const hasLocationPermission = await ensureNativeLocationPermission(true);
        if (hasLocationPermission && Number(scheduledLocations) < locationReminders.length) {
          const retriedLocations = await nativeBridge.scheduleLocationReminders?.(locationReminders);
          if (Number(retriedLocations) < locationReminders.length) console.warn('[Native] Some location reminders were not scheduled', { scheduledLocations: retriedLocations, expected: locationReminders.length });
        }
      }
    } catch (error) {
      console.warn('[Native] Failed to schedule local reminders', error);
    }
  }

  function syncLocalReminders(todos = [], { immediate = false } = {}) {
    latestTodos = Array.isArray(todos) ? todos : [];
    if (!RUNTIME_CAPABILITIES.nativeNotifications) return;
    if (!settingsLoaded) return;
    if (reminderScheduleTimer) {
      clearTimeout(reminderScheduleTimer);
      reminderScheduleTimer = null;
    }
    if (immediate) {
      scheduleLocalRemindersNow();
      return;
    }
    reminderScheduleTimer = setTimeout(() => {
      reminderScheduleTimer = null;
      scheduleLocalRemindersNow();
    }, 250);
  }

  async function updateServerUrl(value) {
    if (!isNativeApp()) return;
    try {
      const serverUrl = normalizeRuntimeServerUrl(value);
      settings = mergeSettings(await nativeBridge.setServerUrl(serverUrl));
      setDesktopStatus(t('settings.desktop.server.savedReloading'));
      setTimeout(() => location.reload(), 250);
    } catch (error) {
      setDesktopStatus(error?.message || String(error), true);
    }
  }

  async function resetServerUrl() {
    if (!isNativeApp()) return;
    try {
      await nativeBridge.clearServerUrl();
      setDesktopStatus(t('settings.desktop.server.selectionOpening'));
      setTimeout(() => location.reload(), 250);
    } catch (error) {
      setDesktopStatus(error?.message || String(error), true);
    }
  }

  async function testNotification() {
    if (!isNativeApp()) return;
    if (!await ensureNativeNotificationPermission()) {
      setDesktopStatus(t('settings.desktop.notifications.permissionNotGranted'), true);
      return;
    }
    try {
      const title = 'nia-todo';
      const body = t('settings.desktop.notifications.testBody');
      const sent = await nativeBridge.notify(title, body);
      setDesktopStatus(sent ? t('settings.desktop.notifications.testSent') : t('settings.desktop.notifications.permissionMissing'), !sent);
    } catch (error) {
      setDesktopStatus(error?.message || String(error), true);
    }
  }

  async function updateHotkey(action, shortcut) {
    if (!isDesktopApp()) return;
    setDesktopStatus(t('settings.desktop.hotkeys.saving'));
    try {
      settings = mergeSettings(await nativeBridge.setHotkey(action, shortcut));
      renderSettings();
      setDesktopStatus(t('settings.desktop.hotkeys.saved'));
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
        input.placeholder = t('settings.desktop.hotkeys.pressShortcut');
        input.classList.add('recording-hotkey');
        setDesktopStatus(t('settings.desktop.hotkeys.recordingHint'));
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
    hotkeyEventsBound = true;
    await nativeBridge.listenHotkeys((event) => {
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
    syncLocalReminders,
    updateServerUrl,
    resetServerUrl,
    testNotification,
    updateHotkey,
  };
}
