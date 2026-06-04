import { RUNTIME_CAPABILITIES, getTauri, getTauriInvoke } from '../core/config.js';
import { t } from '../i18n/index.js';

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
    try {
      return await fn(command, args);
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error(typeof error === 'string' ? error : JSON.stringify(error));
    }
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

  async function scheduleLocationReminders(reminders) {
    if (!RUNTIME_CAPABILITIES.android || !hasAndroidMethod('scheduleLocationReminders')) return 0;
    return Number(android().scheduleLocationReminders(JSON.stringify(reminders || []))) || 0;
  }

  async function clearReminders() {
    await scheduleLocationReminders([]);
    return scheduleReminders([]);
  }

  function locationPermissionState() {
    if (!RUNTIME_CAPABILITIES.android || !hasAndroidMethod('locationPermissionState')) return 'unsupported';
    return android().locationPermissionState() || 'prompt';
  }

  function requestLocationPermission() {
    if (!RUNTIME_CAPABILITIES.android || !hasAndroidMethod('requestLocationPermission')) return 'unsupported';
    return android().requestLocationPermission() || locationPermissionState();
  }

  function hapticFeedback(pattern = 12) {
    if (hasAndroidMethod('hapticFeedback')) return Boolean(android().hapticFeedback(Number(pattern) || 12));
    return false;
  }

  function parseAndroidJsonResult(raw, fallbackError = 'Android bridge call failed') {
    try {
      return JSON.parse(String(raw || '{}'));
    } catch {
      return { ok: false, error: String(raw || fallbackError) };
    }
  }

  function supportsAudioRecording() {
    return hasAndroidMethod('startAudioRecording') && hasAndroidMethod('stopAudioRecording');
  }

  function startAudioRecording() {
    if (!supportsAudioRecording()) return { ok: false, error: 'Android audio bridge unavailable' };
    return parseAndroidJsonResult(android().startAudioRecording(), 'Android audio recording failed');
  }

  function stopAudioRecording() {
    if (!supportsAudioRecording()) return { ok: false, error: 'Android audio bridge unavailable' };
    return parseAndroidJsonResult(android().stopAudioRecording(), 'Android audio recording failed');
  }

  function audioAmplitude() {
    if (!hasAndroidMethod('audioAmplitude')) return 0;
    return Number(android().audioAmplitude() || 0);
  }

  const androidPasskeyRequests = new Map();
  const ANDROID_PASSKEY_TIMEOUT_MS = 90_000;

  function supportsNativePasskeys() {
    if (!RUNTIME_CAPABILITIES.nativePasskeys) return false;
    if (isAndroid()) {
      if (!hasAndroidMethod('passkeyRegister') || !hasAndroidMethod('passkeyAuthenticate')) return false;
      if (hasAndroidMethod('supportsPasskeys')) return Boolean(android().supportsPasskeys());
      return true;
    }
    return Boolean(invoke());
  }

  function ensureAndroidPasskeyCallback() {
    if (typeof window.__niaAndroidPasskeyComplete === 'function') return;
    Object.defineProperty(window, '__niaAndroidPasskeyComplete', {
      configurable: false,
      writable: false,
      value: (requestId, success, payload) => {
        const key = String(requestId);
        const pending = androidPasskeyRequests.get(key);
        if (!pending) return;
        clearTimeout(pending.timeoutId);
        androidPasskeyRequests.delete(key);
        if (success) {
          try {
            pending.resolve(typeof payload === 'string' ? JSON.parse(payload) : payload);
          } catch (_error) {
            pending.reject(new Error(t('native.passkey.invalidAndroidJson')));
          }
        } else {
          pending.reject(new Error(payload || t('native.passkey.androidCallFailed')));
        }
      },
    });
  }

  function invokeAndroidPasskey(method, origin, publicKey) {
    if (!hasAndroidMethod(method)) throw new Error(t('native.passkey.androidBridgeUnavailable'));
    ensureAndroidPasskeyCallback();
    const requestId = globalThis.crypto?.randomUUID?.() || `passkey-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        androidPasskeyRequests.delete(requestId);
        reject(new Error(t('native.passkey.androidCallTimedOut')));
      }, ANDROID_PASSKEY_TIMEOUT_MS);
      androidPasskeyRequests.set(requestId, { resolve, reject, timeoutId });
      try {
        android()[method](requestId, String(origin || ''), JSON.stringify(publicKey || {}));
      } catch (error) {
        clearTimeout(timeoutId);
        androidPasskeyRequests.delete(requestId);
        reject(error);
      }
    });
  }

  async function passkeyRegister(origin, publicKey) {
    if (!supportsNativePasskeys()) throw new Error(t('native.passkey.bridgeUnavailable'));
    if (isAndroid()) return invokeAndroidPasskey('passkeyRegister', origin, publicKey);
    return invokeTauri('desktop_passkey_register', { origin, options: publicKey });
  }

  async function passkeyAuthenticate(origin, publicKey) {
    if (!supportsNativePasskeys()) throw new Error(t('native.passkey.bridgeUnavailable'));
    if (isAndroid()) return invokeAndroidPasskey('passkeyAuthenticate', origin, publicKey);
    return invokeTauri('desktop_passkey_authenticate', { origin, options: publicKey });
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
    scheduleLocationReminders,
    clearReminders,
    locationPermissionState,
    requestLocationPermission,
    hapticFeedback,
    supportsAudioRecording,
    startAudioRecording,
    stopAudioRecording,
    audioAmplitude,
    supportsNativePasskeys,
    passkeyRegister,
    passkeyAuthenticate,
    openExternal,
    consumePendingDoneAction,
    setSystemBarsTheme,
    getAppVersion,
    listenHotkeys,
  };
}
