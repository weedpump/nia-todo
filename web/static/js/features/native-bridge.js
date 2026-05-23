import { RUNTIME_CAPABILITIES, getTauri, getTauriInvoke } from '../core/config.js';

export function createNativeBridge() {
  const android = () => window.NiaAndroidNative || null;
  const androidSystemBars = () => window.NiaAndroidSystemBars || null;
  const tauri = () => getTauri();
  const invoke = () => getTauriInvoke();

  function isNative() {
    return RUNTIME_CAPABILITIES.native;
  }

  function isAndroid() {
    return RUNTIME_CAPABILITIES.android;
  }

  function isDesktop() {
    return RUNTIME_CAPABILITIES.desktop;
  }

  function hasAndroidMethod(name) {
    return isAndroid() && typeof android()?.[name] === 'function';
  }

  async function invokeTauri(command, args = {}) {
    const fn = invoke();
    if (!fn) throw new Error('Tauri API not available');
    return fn(command, args);
  }

  async function getSettings() {
    if (!isNative()) return null;
    return invokeTauri('desktop_get_settings');
  }

  async function setSetting(key, value) {
    if (!isNative()) return null;
    return invokeTauri('desktop_set_setting', { key, value });
  }

  async function setServerUrl(serverUrl) {
    if (!isNative()) return null;
    return invokeTauri('desktop_set_server_url', { serverUrl });
  }

  async function clearServerUrl() {
    if (!isNative()) return null;
    return invokeTauri('desktop_clear_server_url');
  }

  async function setHotkey(action, shortcut) {
    if (!RUNTIME_CAPABILITIES.nativeHotkeys) return null;
    return invokeTauri('desktop_set_hotkey', { action, shortcut: shortcut || '' });
  }

  async function requestNotificationPermission() {
    if (!RUNTIME_CAPABILITIES.nativeNotifications) return 'unsupported';
    if (hasAndroidMethod('requestNotificationPermission')) {
      return android().requestNotificationPermission() || android().notificationPermissionState?.() || 'granted';
    }
    if (isDesktop()) return invokeTauri('desktop_request_notification_permission');
    return 'unsupported';
  }

  function notificationPermissionState() {
    if (hasAndroidMethod('notificationPermissionState')) return android().notificationPermissionState() || 'prompt';
    return RUNTIME_CAPABILITIES.nativeNotifications ? 'prompt' : 'unsupported';
  }

  async function notify(title, body) {
    if (!RUNTIME_CAPABILITIES.nativeNotifications) return false;
    if (hasAndroidMethod('notify')) return Boolean(android().notify(title, body));
    if (isDesktop()) {
      await invokeTauri('desktop_notify', { title, body });
      return true;
    }
    return false;
  }

  async function scheduleReminders(reminders) {
    if (!RUNTIME_CAPABILITIES.nativeNotifications) return 0;
    if (hasAndroidMethod('scheduleReminders')) {
      return Number(android().scheduleReminders(JSON.stringify(reminders || []))) || 0;
    }
    if (isDesktop()) return invokeTauri('desktop_schedule_reminders', { reminders: reminders || [] });
    return 0;
  }

  async function clearReminders() {
    return scheduleReminders([]);
  }

  async function openExternal(url) {
    if (!isNative() || !url) return false;
    if (hasAndroidMethod('openExternal')) return Boolean(android().openExternal(String(url)));
    if (isDesktop()) {
      await invokeTauri('desktop_open_url', { url: String(url) });
      return true;
    }
    return false;
  }

  function consumePendingDoneAction() {
    if (!hasAndroidMethod('consumePendingDoneAction')) return null;
    const raw = android().consumePendingDoneAction();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed?.id) return null;
      return { id: String(parsed.id), userId: parsed.userId ? String(parsed.userId) : '', createdAtMs: Number(parsed.createdAtMs) || 0 };
    } catch (error) {
      console.warn('[Native] Invalid Android done action payload', error);
      return null;
    }
  }

  function setSystemBarsTheme(theme) {
    if (!isAndroid()) return;
    android()?.setTheme?.(theme);
    androidSystemBars()?.setTheme?.(theme);
  }

  async function getAppVersion() {
    if (!RUNTIME_CAPABILITIES.nativeAppVersion) return '';
    if (hasAndroidMethod('appVersion')) {
      try {
        return String(android().appVersion() || '');
      } catch (error) {
        console.warn('[Native] Android app version unavailable', error);
        return '';
      }
    }
    try {
      const version = await tauri()?.app?.getVersion?.();
      if (version) return String(version);
    } catch (error) {
      console.warn('[Native] Tauri app version unavailable', error);
    }
    try {
      return String(await invokeTauri('desktop_get_app_version') || '');
    } catch (error) {
      console.warn('[Native] Desktop app version unavailable', error);
      return '';
    }
  }

  async function listenHotkeys(callback) {
    if (!RUNTIME_CAPABILITIES.nativeHotkeys) return null;
    const listen = tauri()?.event?.listen;
    if (!listen) return null;
    return listen('desktop-hotkey', callback);
  }

  return {
    isNative,
    isAndroid,
    isDesktop,
    hasAndroidMethod,
    getSettings,
    setSetting,
    setServerUrl,
    clearServerUrl,
    setHotkey,
    requestNotificationPermission,
    notificationPermissionState,
    notify,
    scheduleReminders,
    clearReminders,
    openExternal,
    consumePendingDoneAction,
    setSystemBarsTheme,
    getAppVersion,
    listenHotkeys,
  };
}
