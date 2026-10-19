import { RUNTIME_CAPABILITIES, RUNTIME_PLATFORM, getTauri, getTauriInvoke } from '../core/config.js';
import { t } from '../i18n/index.js';

const androidUpdateRequests = new Map();
const androidUpdaterCalls = new Map();
const androidLocationPermissionCalls = new Map();
const ANDROID_UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const ANDROID_UPDATER_CALL_TIMEOUT_MS = 15_000;
const ANDROID_LOCATION_PERMISSION_CALL_TIMEOUT_MS = 15_000;

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

  async function syncHotkeyDescriptions(descriptions) {
    if (!RUNTIME_CAPABILITIES.nativeHotkeys) return null;
    return invokeTauri('desktop_sync_hotkey_descriptions', { descriptions });
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
    if (!hasAndroidLocationPermissionBridge()) return 0;
    const payload = await callAndroidLocationPermission('schedule', { schedules: reminders || [] }, null);
    return Number(payload?.count) || 0;
  }

  async function clearReminders() {
    await scheduleLocationReminders([]);
    return scheduleReminders([]);
  }

  const androidLocationPermission = () => window.NiaAndroidLocationPermission || null;

  function hasAndroidLocationPermissionBridge() {
    return isAndroid() && typeof androidLocationPermission()?.postMessage === 'function';
  }

  function ensureAndroidLocationPermissionCallbacks() {
    if (typeof window.__niaAndroidLocationPermissionResponse === 'function') return;
    Object.defineProperty(window, '__niaAndroidLocationPermissionResponse', {
      configurable: false,
      writable: false,
      value: (requestId, success, payload) => {
        const key = String(requestId);
        const pending = androidLocationPermissionCalls.get(key);
        if (!pending) return;
        if (pending.timeoutId !== null) clearTimeout(pending.timeoutId);
        androidLocationPermissionCalls.delete(key);
        if (success) pending.resolve(payload);
        else pending.reject(new Error(payload?.error || 'Android location permission bridge call failed'));
      },
    });
  }

  function callAndroidLocationPermission(action, payload = {}, timeoutMs = ANDROID_LOCATION_PERMISSION_CALL_TIMEOUT_MS) {
    if (!hasAndroidLocationPermissionBridge()) return Promise.reject(new Error('Android location permission bridge unavailable'));
    ensureAndroidLocationPermissionCallbacks();
    const requestId = globalThis.crypto?.randomUUID?.() || `android-location-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timeoutId = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
          androidLocationPermissionCalls.delete(requestId);
          reject(new Error('Android location permission bridge call timed out'));
        }, timeoutMs)
        : null;
      androidLocationPermissionCalls.set(requestId, { resolve, reject, timeoutId });
      try {
        androidLocationPermission().postMessage(JSON.stringify({ requestId, action, ...payload }));
      } catch (error) {
        if (timeoutId !== null) clearTimeout(timeoutId);
        androidLocationPermissionCalls.delete(requestId);
        reject(error);
      }
    });
  }

  async function locationPermissionState() {
    if (!hasAndroidLocationPermissionBridge()) return 'unsupported';
    const payload = await callAndroidLocationPermission('state');
    return String(payload?.state || 'prompt');
  }

  async function locationPermissionGuidanceState() {
    if (!hasAndroidLocationPermissionBridge()) return 'unsupported';
    const payload = await callAndroidLocationPermission('guidanceState');
    return String(payload?.state || 'prompt');
  }

  async function declineLocationPermissionGuidance() {
    if (!hasAndroidLocationPermissionBridge()) return false;
    const payload = await callAndroidLocationPermission('decline');
    return Boolean(payload?.declined);
  }

  async function resetLocationPermissionGuidance() {
    if (!hasAndroidLocationPermissionBridge()) return false;
    const payload = await callAndroidLocationPermission('resetGuidance');
    return Boolean(payload?.reset);
  }

  async function backgroundLocationPermissionOptionLabel() {
    if (!hasAndroidLocationPermissionBridge()) return '';
    const payload = await callAndroidLocationPermission('optionLabel');
    return String(payload?.label || '');
  }

  async function backgroundLocationPermissionMode() {
    if (!hasAndroidLocationPermissionBridge()) return 'unsupported';
    const payload = await callAndroidLocationPermission('mode');
    return String(payload?.mode || 'unsupported');
  }

  async function requestLocationPermission() {
    if (!hasAndroidLocationPermissionBridge()) return 'unsupported';
    const payload = await callAndroidLocationPermission('request');
    return String(payload?.state || 'prompt');
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

  const androidUpdater = () => window.NiaAndroidUpdater || null;

  function hasAndroidUpdater() {
    return isAndroid() && typeof androidUpdater()?.postMessage === 'function';
  }

  function ensureAndroidUpdateCallbacks() {
    if (typeof window.__niaAndroidUpdateProgress !== 'function') {
      Object.defineProperty(window, '__niaAndroidUpdateProgress', {
        configurable: false,
        writable: false,
        value: (requestId, progress) => {
          androidUpdateRequests.get(String(requestId))?.onProgress?.(progress || {});
        },
      });
    }
    if (typeof window.__niaAndroidUpdateComplete !== 'function') {
      Object.defineProperty(window, '__niaAndroidUpdateComplete', {
        configurable: false,
        writable: false,
        value: (requestId, success, payload) => {
          const key = String(requestId);
          const pending = androidUpdateRequests.get(key);
          if (!pending) return;
          clearTimeout(pending.timeoutId);
          androidUpdateRequests.delete(key);
          if (success) pending.resolve(Boolean(payload?.started));
          else pending.reject(new Error(payload?.error || 'Android update failed'));
        },
      });
    }
    if (typeof window.__niaAndroidUpdaterResponse !== 'function') {
      Object.defineProperty(window, '__niaAndroidUpdaterResponse', {
        configurable: false,
        writable: false,
        value: (requestId, success, payload) => {
          const key = String(requestId);
          const pending = androidUpdaterCalls.get(key);
          if (!pending) return;
          clearTimeout(pending.timeoutId);
          androidUpdaterCalls.delete(key);
          if (success) pending.resolve(payload);
          else pending.reject(new Error(payload?.error || 'Android updater bridge call failed'));
        },
      });
    }
  }

  function callAndroidUpdater(action, payload = {}) {
    if (!hasAndroidUpdater()) return Promise.reject(new Error('Android updater bridge unavailable'));
    ensureAndroidUpdateCallbacks();
    const requestId = globalThis.crypto?.randomUUID?.() || `android-updater-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        androidUpdaterCalls.delete(requestId);
        reject(new Error('Android updater bridge call timed out'));
      }, ANDROID_UPDATER_CALL_TIMEOUT_MS);
      androidUpdaterCalls.set(requestId, { resolve, reject, timeoutId });
      try {
        androidUpdater().postMessage(JSON.stringify({ requestId, action, ...payload }));
      } catch (error) {
        clearTimeout(timeoutId);
        androidUpdaterCalls.delete(requestId);
        reject(error);
      }
    });
  }

  async function androidUpdatePermissionState() {
    if (!hasAndroidUpdater()) return 'unsupported';
    const payload = await callAndroidUpdater('permissionState');
    return String(payload?.state || 'prompt');
  }

  async function openAndroidUpdatePermissionSettings() {
    if (!hasAndroidUpdater()) return false;
    const payload = await callAndroidUpdater('openPermissionSettings');
    return Boolean(payload?.opened);
  }

  function installAndroidUpdate(download, onProgress = () => {}) {
    if (!hasAndroidUpdater()) return Promise.reject(new Error('Android update bridge unavailable'));
    ensureAndroidUpdateCallbacks();
    const requestId = globalThis.crypto?.randomUUID?.() || `android-update-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        androidUpdateRequests.delete(requestId);
        try { androidUpdater().postMessage(JSON.stringify({ requestId, action: 'cancel' })); } catch (_error) {}
        reject(new Error('Android update timed out'));
      }, ANDROID_UPDATE_TIMEOUT_MS);
      androidUpdateRequests.set(requestId, { resolve, reject, onProgress, timeoutId });
      try {
        androidUpdater().postMessage(JSON.stringify({
          requestId,
          action: 'install',
          url: String(download?.url || ''),
          filename: String(download?.filename || ''),
          expectedSha256: String(download?.sha256 || ''),
          expectedSize: Number(download?.sizeBytes || 0),
          expectedVersion: String(download?.version || '').replace(/^v/i, ''),
        }));
      } catch (error) {
        clearTimeout(timeoutId);
        androidUpdateRequests.delete(requestId);
        reject(error);
      }
    });
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

  async function downloadToDownloads(url, filename, headers = {}) {
    if (isAndroid() && hasAndroidMethod('downloadToDownloads')) {
      const result = parseAndroidJsonResult(
        android().downloadToDownloads(String(url || ''), String(filename || 'attachment'), JSON.stringify(headers || {})),
        'Android download failed',
      );
      if (!result.ok) throw new Error(result.error || 'Android download failed');
      return result;
    }
    if (isDesktop()) {
      return invokeTauri('desktop_download_attachment', {
        url: String(url || ''),
        filename: String(filename || 'attachment'),
        headers: headers || {},
      });
    }
    return false;
  }

  async function cancelAttachmentDownloadsForPrivacy() {
    if (isAndroid() && hasAndroidMethod('cancelAttachmentDownloadsForPrivacy')) {
      return Boolean(android().cancelAttachmentDownloadsForPrivacy());
    }
    return true;
  }

  async function installUpdate() {
    if (!isDesktop() || RUNTIME_PLATFORM !== 'windows') {
      throw new Error('Native in-place updates are currently available on Windows only');
    }
    return invokeTauri('desktop_install_update');
  }

  async function installDebianUpdate(download) {
    if (!isDesktop() || RUNTIME_PLATFORM !== 'linux') {
      throw new Error('Native Debian updates are only available in the Linux desktop app');
    }
    return invokeTauri('desktop_install_debian_update', {
      update: {
        url: String(download?.url || ''),
        filename: String(download?.filename || ''),
        version: String(download?.version || '').replace(/^v/, ''),
        sha256: String(download?.sha256 || ''),
        sizeBytes: Number(download?.sizeBytes || 0),
        signature: String(download?.signature || ''),
      },
    });
  }

  async function listenNativeUpdateProgress(callback) {
    if (!isDesktop() || !['windows', 'linux'].includes(RUNTIME_PLATFORM) || typeof callback !== 'function') return null;
    const listen = tauri()?.event?.listen;
    if (!listen) return null;
    return listen('native-update-progress', (event) => callback(event?.payload || {}));
  }


  function ensureOidcCallbackBridge() {
    if (typeof window.__niaNativeOidcCallback !== 'function') {
      Object.defineProperty(window, '__niaNativeOidcCallback', {
        configurable: false,
        writable: false,
        value: (url) => {
          window.__niaPendingNativeOidcCallback = String(url || '');
          window.dispatchEvent(new CustomEvent('nia-native-oidc-callback', { detail: { url: String(url || '') } }));
        },
      });
    }
  }

  async function listenOidcCallbacks(callback) {
    if (!isNative() || typeof callback !== 'function') return null;
    ensureOidcCallbackBridge();
    let lastDelivered = '';
    const deliver = (url) => {
      const value = String(url || '');
      if (!value || value === lastDelivered) return;
      lastDelivered = value;
      callback(value);
    };
    const onWindowEvent = (event) => deliver(event?.detail?.url || '');
    window.addEventListener('nia-native-oidc-callback', onWindowEvent);
    if (window.__niaPendingNativeOidcCallback) {
      const pending = window.__niaPendingNativeOidcCallback;
      window.__niaPendingNativeOidcCallback = '';
      setTimeout(() => deliver(pending), 0);
    }
    let androidPollTimer = null;
    let androidPollStopTimer = null;
    const consumeAndroidPending = () => {
      if (!isAndroid() || !hasAndroidMethod('consumePendingOidcCallback')) return;
      try {
        const pending = android().consumePendingOidcCallback();
        if (pending) deliver(pending);
      } catch (_error) {}
    };
    consumeAndroidPending();
    if (isAndroid() && hasAndroidMethod('consumePendingOidcCallback')) {
      window.addEventListener('focus', consumeAndroidPending);
      document.addEventListener('visibilitychange', consumeAndroidPending);
      androidPollTimer = setInterval(consumeAndroidPending, 500);
      androidPollStopTimer = setTimeout(() => {
        if (androidPollTimer) clearInterval(androidPollTimer);
        androidPollTimer = null;
      }, 60_000);
    }
    let unlistenTauri = null;
    if (isDesktop()) {
      invokeTauri('desktop_consume_pending_oidc_callback').then((pending) => {
        deliver(pending);
      }).catch(() => {});
    }
    if (isDesktop() && tauri()?.event?.listen) {
      unlistenTauri = await tauri().event.listen('native-oidc-callback', (event) => {
        deliver(event?.payload?.url || event?.payload || '');
      }).catch(() => null);
    }
    return () => {
      window.removeEventListener('nia-native-oidc-callback', onWindowEvent);
      window.removeEventListener('focus', consumeAndroidPending);
      document.removeEventListener('visibilitychange', consumeAndroidPending);
      if (androidPollTimer) clearInterval(androidPollTimer);
      if (androidPollStopTimer) clearTimeout(androidPollStopTimer);
      if (typeof unlistenTauri === 'function') unlistenTauri();
    };
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
    syncHotkeyDescriptions,
    setHotkey,
    requestNotificationPermission,
    notificationPermissionState,
    notify,
    scheduleReminders,
    scheduleLocationReminders,
    clearReminders,
    locationPermissionState,
    locationPermissionGuidanceState,
    declineLocationPermissionGuidance,
    resetLocationPermissionGuidance,
    backgroundLocationPermissionOptionLabel,
    backgroundLocationPermissionMode,
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
    downloadToDownloads,
    cancelAttachmentDownloadsForPrivacy,
    androidUpdatePermissionState,
    openAndroidUpdatePermissionSettings,
    installAndroidUpdate,
    installUpdate,
    installDebianUpdate,
    listenNativeUpdateProgress,
    listenOidcCallbacks,
    setSystemBarsTheme,
    getAppVersion,
    listenHotkeys,
  };
}
