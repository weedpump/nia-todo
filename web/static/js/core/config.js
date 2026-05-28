import { t } from '../i18n/index.js';

export let API = '';
export let WS_URL = websocketUrlFromBase(location.origin);
export const DB_NAME = 'nia-todo-db';
export const DB_VERSION = 4;
export const APP_VERSION = 'v2.5.3';

export function getTauri() {
  return window.__TAURI__ || null;
}

export function getTauriInvoke() {
  return getTauri()?.core?.invoke || null;
}

export function hasNativeLaunchParam() {
  return new URLSearchParams(location.search).get('nativeApp') === 'tauri';
}

export function getNativePlatform() {
  if (/Android/i.test(navigator.userAgent || '')) return 'android';
  if (/Windows/i.test(navigator.userAgent || '')) return 'windows';
  if (/Macintosh|Mac OS X/i.test(navigator.userAgent || '')) return 'macos';
  if (/Linux/i.test(navigator.userAgent || '')) return 'linux';
  return 'unknown';
}

export const RUNTIME_MODE = (() => {
  if (hasNativeLaunchParam() || getTauriInvoke()) return 'native';
  return 'browser';
})();

export const RUNTIME_PLATFORM = RUNTIME_MODE === 'native' ? getNativePlatform() : 'browser';

export const RUNTIME_CAPABILITIES = Object.freeze({
  native: RUNTIME_MODE === 'native',
  browser: RUNTIME_MODE === 'browser',
  tauri: Boolean(getTauriInvoke()) || hasNativeLaunchParam(),
  android: RUNTIME_MODE === 'native' && RUNTIME_PLATFORM === 'android',
  desktop: RUNTIME_MODE === 'native' && RUNTIME_PLATFORM !== 'android',
  browserPush: RUNTIME_MODE === 'browser',
  nativeSettings: RUNTIME_MODE === 'native',
  nativeNotifications: RUNTIME_MODE === 'native',
  nativeHotkeys: RUNTIME_MODE === 'native' && RUNTIME_PLATFORM !== 'android',
  nativeTray: RUNTIME_MODE === 'native' && RUNTIME_PLATFORM !== 'android',
  appDownloads: RUNTIME_MODE === 'browser',
  nativeAppVersion: RUNTIME_MODE === 'native',
  nativeAppUpdates: RUNTIME_MODE === 'native',
  nativePasskeys: RUNTIME_MODE === 'native' && (
    (RUNTIME_PLATFORM === 'windows' && Boolean(getTauriInvoke())) ||
    (RUNTIME_PLATFORM === 'android' && Boolean(window.NiaAndroidNative?.passkeyRegister))
  ),
});

export function isNativeRuntime() {
  return RUNTIME_CAPABILITIES.native;
}

export function normalizeServerUrl(value) {
  let raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error(t('nativeSetup.error.serverRequired'));
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch (_error) {
    throw new Error(t('nativeSetup.error.invalidServerHostname'));
  }
  const localHttp = url.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) throw new Error(t('nativeSetup.error.httpsRequired'));
  if (url.username || url.password) throw new Error(t('nativeSetup.error.noCredentials'));
  if (!url.hostname || url.hostname.includes(' ')) throw new Error(t('nativeSetup.error.invalidServerHostname'));
  url.hash = '';
  url.search = '';
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function websocketUrlFromBase(baseUrl) {
  const url = new URL(baseUrl || location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function apiResourceUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return parsed.toString();
  } catch (_error) {
    // Relative path.
  }
  if (RUNTIME_CAPABILITIES.native && API && raw.startsWith('/')) {
    return new URL(raw, API).toString();
  }
  return raw;
}

export async function verifyInstance(serverUrl) {
  const base = normalizeServerUrl(serverUrl);
  let response;
  try {
    response = await fetch(`${base}/api/instance`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      cache: 'no-store',
    });
  } catch (_error) {
    throw new Error(t('nativeSetup.error.serverUnreachable'));
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || t('nativeSetup.error.verificationFailed', { status: response.status }));
  if (data?.app !== 'nia-todo') throw new Error(t('nativeSetup.notNiaTodoServer'));
  return data;
}

export async function initRuntimeConfig() {
  if (!isNativeRuntime()) return { mode: RUNTIME_MODE, platform: RUNTIME_PLATFORM, capabilities: RUNTIME_CAPABILITIES, apiBaseUrl: API, wsUrl: WS_URL, instance: null };
  const invoke = getTauriInvoke();
  if (!invoke) return { mode: RUNTIME_MODE, platform: RUNTIME_PLATFORM, capabilities: RUNTIME_CAPABILITIES, apiBaseUrl: API, wsUrl: WS_URL, instance: null };
  const settings = await invoke('desktop_get_settings').catch(() => null);
  const serverUrl = settings?.serverUrl ? normalizeServerUrl(settings.serverUrl) : '';
  if (!serverUrl) return { mode: RUNTIME_MODE, platform: RUNTIME_PLATFORM, capabilities: RUNTIME_CAPABILITIES, apiBaseUrl: API, wsUrl: WS_URL, instance: null };
  if (RUNTIME_PLATFORM === 'android' && window.NiaAndroidNative?.setConfiguredServerUrl) {
    const configured = window.NiaAndroidNative.setConfiguredServerUrl(serverUrl);
    if (!configured) throw new Error(t('nativeSetup.error.androidPasskeyBridgeBindFailed'));
  }
  API = serverUrl;
  WS_URL = websocketUrlFromBase(serverUrl);
  const instance = await verifyInstance(serverUrl).catch((error) => ({ error: error?.message || String(error) }));
  return { mode: RUNTIME_MODE, platform: RUNTIME_PLATFORM, capabilities: RUNTIME_CAPABILITIES, apiBaseUrl: API, wsUrl: WS_URL, instance };
}
