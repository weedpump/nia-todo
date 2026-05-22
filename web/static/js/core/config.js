export let API = '';
export let WS_URL = websocketUrlFromBase(location.origin);
export const DB_NAME = 'nia-todo-db';
export const DB_VERSION = 4;
export const APP_VERSION = 'v1.7.4-dev';

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
});

export function isNativeRuntime() {
  return RUNTIME_CAPABILITIES.native;
}

export function normalizeServerUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Bitte eine http(s)-URL eingeben.');
  if (url.username || url.password) throw new Error('Server-URL darf keine Zugangsdaten enthalten.');
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

export async function verifyInstance(serverUrl) {
  const base = normalizeServerUrl(serverUrl);
  const response = await fetch(`${base}/api/instance`, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || `Server-Verifikation fehlgeschlagen (${response.status})`);
  if (data?.app !== 'nia-todo') throw new Error('Das ist kein kompatibler nia-todo Server.');
  return data;
}

export async function initRuntimeConfig() {
  if (!isNativeRuntime()) return { mode: RUNTIME_MODE, platform: RUNTIME_PLATFORM, capabilities: RUNTIME_CAPABILITIES, apiBaseUrl: API, wsUrl: WS_URL, instance: null };
  const invoke = getTauriInvoke();
  if (!invoke) return { mode: RUNTIME_MODE, platform: RUNTIME_PLATFORM, capabilities: RUNTIME_CAPABILITIES, apiBaseUrl: API, wsUrl: WS_URL, instance: null };
  const settings = await invoke('desktop_get_settings').catch(() => null);
  const serverUrl = settings?.serverUrl ? normalizeServerUrl(settings.serverUrl) : '';
  if (!serverUrl) return { mode: RUNTIME_MODE, platform: RUNTIME_PLATFORM, capabilities: RUNTIME_CAPABILITIES, apiBaseUrl: API, wsUrl: WS_URL, instance: null };
  API = serverUrl;
  WS_URL = websocketUrlFromBase(serverUrl);
  const instance = await verifyInstance(serverUrl).catch((error) => ({ error: error?.message || String(error) }));
  return { mode: RUNTIME_MODE, platform: RUNTIME_PLATFORM, capabilities: RUNTIME_CAPABILITIES, apiBaseUrl: API, wsUrl: WS_URL, instance };
}
