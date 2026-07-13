import { API, RUNTIME_CAPABILITIES, RUNTIME_PLATFORM, verifyInstance } from '../core/config.js';
import { t } from '../i18n/index.js';
import { iconSvg } from '../icons/lucide-icons.js';
import { hideAutoScrollbars } from './auto-scrollbars.js';
import { createNativeBridge } from './native-bridge.js';

let deferredPwaInstallPrompt = null;

function isStandaloneDisplayMode() {
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)')?.matches
    || window.matchMedia?.('(display-mode: fullscreen)')?.matches
    || window.navigator?.standalone
  );
}

function isIOSLikeBrowser() {
  const ua = navigator.userAgent || '';
  const iOSDevice = /iPad|iPhone|iPod/i.test(ua);
  const iPadDesktopMode = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return iOSDevice || iPadDesktopMode;
}

function isWebInstallEligible() {
  return !RUNTIME_CAPABILITIES.native && !isStandaloneDisplayMode();
}

function isBrowserDownloadEligible() {
  return RUNTIME_CAPABILITIES.appDownloads && !isStandaloneDisplayMode();
}

function platformFromNativeRuntime() {
  if (!RUNTIME_CAPABILITIES.nativeAppVersion) return '';
  if (RUNTIME_PLATFORM === 'android') return 'android';
  if (RUNTIME_PLATFORM === 'windows') return 'windows';
  if (RUNTIME_PLATFORM === 'linux') return 'debian';
  return RUNTIME_PLATFORM || 'unknown';
}

async function getNativeAppVersion(nativeBridge) {
  return nativeBridge.getAppVersion();
}

const DOWNLOAD_SHA_RE = /^[a-f0-9]{64}$/;
const DOWNLOAD_VERSION_RE = /^v?\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/;
const DOWNLOADS_BY_PLATFORM = {
  windows: {
    arch: 'x64',
    filenamePrefix: 'nia-todo-v',
    filenameSuffix: '-windows-x64-setup.exe',
    filenameRe: /^nia-todo-v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?-windows-x64-setup\.exe$/,
  },
  android: {
    arch: 'arm64',
    filenamePrefix: 'nia-todo-v',
    filenameSuffix: '-android-arm64.apk',
    filenameRe: /^nia-todo-v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?-android-arm64\.apk$/,
  },
  debian: {
    arch: 'amd64',
    filenamePrefix: 'nia-todo-desktop-v',
    filenameSuffix: '-debian-amd64.deb',
    filenameRe: /^nia-todo-desktop-v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?-debian-amd64\.deb$/,
  },
};

function absoluteDownloadUrl(url) {
  const base = RUNTIME_CAPABILITIES.native && API ? API : location.origin;
  return new URL(url, base).toString();
}

function filenameFromDownloadPath(pathname) {
  const match = String(pathname || '').match(/^\/downloads\/([^/?#]+)$/);
  return match ? match[1] : '';
}

function validateDownloadEntry(app, fallbackVersion = '') {
  if (!app || typeof app !== 'object') return null;
  const platform = String(app.platform || '').toLowerCase();
  const spec = DOWNLOADS_BY_PLATFORM[platform];
  if (!spec) return null;

  const rawUrl = String(app.url || '').trim();
  if (!rawUrl.startsWith('/downloads/')) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl, location.origin);
  } catch {
    return null;
  }
  if (parsed.origin !== location.origin || parsed.search || parsed.hash) return null;

  const filename = filenameFromDownloadPath(parsed.pathname);
  if (!filename || filename.includes('/') || !spec.filenameRe.test(filename)) return null;
  if (app.filename && String(app.filename) !== filename) return null;
  if (app.arch && String(app.arch) !== spec.arch) return null;
  if (!DOWNLOAD_SHA_RE.test(String(app.sha256 || ''))) return null;

  const version = String(app.version || fallbackVersion || '').trim();
  if (!DOWNLOAD_VERSION_RE.test(version)) return null;
  const versionSlug = normalizeVersion(version);
  if (filename !== `${spec.filenamePrefix}${versionSlug}${spec.filenameSuffix}`) return null;

  return {
    platform,
    arch: spec.arch,
    label: app.label || (platform === 'windows' ? 'Windows Setup' : platform === 'debian' ? 'Debian Package' : 'Android APK'),
    version,
    filename,
    url: absoluteDownloadUrl(parsed.pathname),
    sha256: app.sha256 || '',
    sizeBytes: Number.isSafeInteger(app.size_bytes) && app.size_bytes > 0 ? app.size_bytes : null,
  };
}

function downloadsFromManifest(manifest) {
  const version = manifest?.version || manifest?.latest?.version || '';
  const apps = [
    manifest?.latest?.windows,
    manifest?.latest?.android,
    manifest?.latest?.debian,
    ...(Array.isArray(manifest?.apps) ? manifest.apps : []),
  ].filter(Boolean);
  const byPlatform = new Map();
  for (const app of apps) {
    const download = validateDownloadEntry(app, version);
    if (!download || byPlatform.has(download.platform)) continue;
    byPlatform.set(download.platform, download);
  }
  return ['windows', 'android', 'debian'].map((platform) => byPlatform.get(platform)).filter(Boolean);
}

function platformIconClass(platform) {
  if (platform === 'android') return 'app-download-icon-android';
  if (platform === 'windows') return 'app-download-icon-windows';
  if (platform === 'debian') return 'app-download-icon-debian';
  return '';
}

function platformTitle(download) {
  if (download.platform === 'android') return 'Android-App herunterladen';
  if (download.platform === 'windows') return 'Windows-App herunterladen';
  if (download.platform === 'debian') return 'Debian-Paket herunterladen';
  return `${download.label || 'App'} herunterladen`;
}

function platformLabel(platform) {
  if (platform === 'android') return 'Android';
  if (platform === 'windows') return 'Windows';
  if (platform === 'debian') return 'Debian';
  return 'App';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[char]));
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function parseVersion(value) {
  const [core = '', prerelease = ''] = normalizeVersion(value).split('-', 2);
  return {
    core: core.split('.').map((part) => Number.parseInt(part, 10)),
    prerelease: prerelease ? prerelease.split('.') : [],
  };
}

function comparePrerelease(leftParts, rightParts) {
  if (!leftParts.length && !rightParts.length) return 0;
  if (!leftParts.length) return 1;
  if (!rightParts.length) return -1;
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const left = leftParts[index];
    const right = rightParts[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumber = /^\d+$/.test(left) ? Number.parseInt(left, 10) : null;
    const rightNumber = /^\d+$/.test(right) ? Number.parseInt(right, 10) : null;
    if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1;
    if (leftNumber !== null && rightNumber === null) return -1;
    if (leftNumber === null && rightNumber !== null) return 1;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

function compareVersions(a, b) {
  const leftVersion = parseVersion(a);
  const rightVersion = parseVersion(b);
  const length = Math.max(leftVersion.core.length, rightVersion.core.length);
  for (let index = 0; index < length; index += 1) {
    const left = Number.isFinite(leftVersion.core[index]) ? leftVersion.core[index] : 0;
    const right = Number.isFinite(rightVersion.core[index]) ? rightVersion.core[index] : 0;
    if (left !== right) return left > right ? 1 : -1;
  }
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

const dismissedNativeUpdateKeys = new Set();

function nativeUpdateKey(platform, currentVersion, targetVersion) {
  return `${platform || 'unknown'}:${normalizeVersion(currentVersion)}->${normalizeVersion(targetVersion)}`;
}

async function refreshRuntimeInstance() {
  if (!RUNTIME_CAPABILITIES.native || !API) return window.NIA_TODO_RUNTIME?.instance || null;
  try {
    const instance = await verifyInstance(API);
    window.NIA_TODO_RUNTIME = { ...(window.NIA_TODO_RUNTIME || {}), instance };
    return instance;
  } catch (error) {
    console.warn('[Downloads] Native instance refresh failed, using boot-time instance', error);
    return window.NIA_TODO_RUNTIME?.instance || null;
  }
}

function getMinimumNativeClientVersion(instance = window.NIA_TODO_RUNTIME?.instance) {
  return instance?.min_native_client_version || '';
}

function downloadPanelForTarget(target) {
  return target?.closest?.('[data-app-download-panel]') || null;
}

function setDownloadTargetVisible(target, visible) {
  if (!target) return;
  target.style.display = visible ? '' : 'none';
  const panel = downloadPanelForTarget(target);
  if (panel) panel.style.display = visible ? '' : 'none';
}

function setDownloadLaunchersVisible(launchers, visible) {
  launchers.forEach((launcher) => { launcher.style.display = visible ? '' : 'none'; });
}

function updateWebInstallUI() {
  const cards = Array.from(document.querySelectorAll('[data-web-install-card]'));
  if (!cards.length) return;
  const eligible = isWebInstallEligible();
  const ios = eligible && isIOSLikeBrowser();
  const canPrompt = eligible && Boolean(deferredPwaInstallPrompt);
  cards.forEach((card) => { card.style.display = (ios || canPrompt) ? '' : 'none'; });
  document.querySelectorAll('[data-web-install-prompt]').forEach((button) => {
    button.style.display = canPrompt ? '' : 'none';
    button.onclick = async () => {
      if (!deferredPwaInstallPrompt) return;
      const promptEvent = deferredPwaInstallPrompt;
      deferredPwaInstallPrompt = null;
      updateWebInstallUI();
      try {
        await promptEvent.prompt();
        if (promptEvent.userChoice) await promptEvent.userChoice;
      } catch (error) {
        console.warn('[Downloads] Web install prompt failed', error);
      } finally {
        updateWebInstallUI();
      }
    };
  });
  document.querySelectorAll('[data-web-install-fallback]').forEach((hint) => {
    hint.style.display = ios && !canPrompt ? '' : 'none';
  });
  document.querySelectorAll('[data-ios-install-guide]').forEach((guide) => {
    guide.style.display = ios ? '' : 'none';
  });
}

function serverAddressFromUrl(value) {
  try {
    const url = new URL(value || location.origin, location.origin);
    const path = url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/+$/, '') : '';
    return `${url.host}${path}`;
  } catch (_error) {
    return location.host;
  }
}

async function getDownloadServerAddress() {
  const fallback = serverAddressFromUrl(location.origin);
  try {
    const instance = await verifyInstance(location.origin);
    return serverAddressFromUrl(instance?.public_base_url || location.origin);
  } catch (error) {
    console.warn('[Downloads] Server address hint fallback to current host', error);
    return fallback;
  }
}

function renderDownloadServerAddress(address) {
  document.querySelectorAll('[data-app-download-server-host]').forEach((target) => {
    target.textContent = address || serverAddressFromUrl(location.origin);
  });
}

function renderDownloads(target, downloads) {
  if (!target || !downloads?.length) {
    setDownloadTargetVisible(target, false);
    return;
  }
  target.replaceChildren();
  for (const download of downloads) {
    const link = document.createElement('a');
    link.className = `btn btn-secondary app-download-button app-download-button-${download.platform}`;
    link.href = download.url;
    link.download = download.filename;
    link.title = platformTitle(download);

    const icon = document.createElement('span');
    const iconClass = platformIconClass(download.platform);
    if (iconClass) {
      icon.className = `app-download-icon ${iconClass}`;
      icon.setAttribute('aria-hidden', 'true');
    } else {
      icon.innerHTML = iconSvg('download');
    }
    link.appendChild(icon);

    const text = document.createElement('span');
    text.className = 'app-download-text';

    const platform = document.createElement('span');
    platform.className = 'app-download-platform';
    platform.textContent = platformLabel(download.platform);
    text.appendChild(platform);

    const version = document.createElement('span');
    version.className = 'app-download-version';
    version.textContent = download.version || '';
    text.appendChild(version);

    link.appendChild(text);
    target.appendChild(link);
  }
  setDownloadTargetVisible(target, true);
}

function changelogUrl() {
  return RUNTIME_CAPABILITIES.native && API ? `${API.replace(/\/$/, '')}/changelog` : '/changelog';
}

function renderNativeAppVersion(target, platform, currentVersion, nativeBridge) {
  if (!target || !platform || !currentVersion) return;
  target.innerHTML = `
    <span class="native-version-text"><strong>${escapeHtml(t('version.appVersion'))}</strong> ${escapeHtml(platformLabel(platform))} v${escapeHtml(normalizeVersion(currentVersion) || currentVersion)}</span>
    <div class="version-actions native-version-actions">
      <a class="changelog-link version-action-btn" href="${escapeHtml(changelogUrl())}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(t('version.openChangelog'))}">${escapeHtml(t('resource.changelog'))}</a>
    </div>
  `;
  target.style.display = '';
}

function isLoginOverlayVisible() {
  const overlay = document.getElementById('login-overlay');
  return Boolean(overlay && !overlay.classList.contains('hidden') && overlay.getAttribute('aria-hidden') !== 'true');
}

function hasAuthToken() {
  return Boolean(localStorage.getItem('jwt_token') || localStorage.getItem('auth_token'));
}

function deferUntilAfterLogin(callback) {
  const overlay = document.getElementById('login-overlay');
  const ready = () => hasAuthToken() && !isLoginOverlayVisible();
  if (ready()) {
    callback();
    return;
  }
  let done = false;
  let observer = null;
  let timer = null;
  const finishIfReady = () => {
    if (done || !ready()) return;
    done = true;
    observer?.disconnect();
    if (timer) window.clearInterval(timer);
    callback();
  };
  if (overlay) {
    observer = new MutationObserver(finishIfReady);
    observer.observe(overlay, { attributes: true, attributeFilter: ['class', 'aria-hidden', 'style'] });
  }
  timer = window.setInterval(finishIfReady, 500);
}

function showNativeUpdateModal(download, currentVersion, nativeBridge = null, options = {}) {
  if (!download?.url) return;
  if (!hasAuthToken() || isLoginOverlayVisible()) {
    deferUntilAfterLogin(() => showNativeUpdateModal(download, currentVersion, nativeBridge, options));
    return;
  }
  const { forced = false, minVersion = '' } = options;
  const modal = document.getElementById('native-app-update-modal');
  const title = document.getElementById('native-app-update-title');
  const message = document.getElementById('native-app-update-message');
  const current = document.getElementById('native-app-update-current-version');
  const latest = document.getElementById('native-app-update-latest-version');
  const button = document.getElementById('native-app-update-download-btn');
  const laterButton = document.getElementById('native-app-update-later-btn');
  if (title) title.textContent = forced ? t('update.native.requiredTitle') : t('update.native.title');
  if (message) {
    message.textContent = forced
      ? t('update.native.requiredMessage', { version: normalizeVersion(minVersion) || minVersion })
      : t('update.native.optionalMessage');
  }
  if (current) current.textContent = currentVersion || t('update.native.unknownVersion');
  if (latest) latest.textContent = download.version || t('update.native.unknownVersion');
  if (laterButton) {
    laterButton.style.display = forced ? 'none' : '';
    laterButton.onclick = () => {
      dismissedNativeUpdateKeys.add(nativeUpdateKey(download.platform, currentVersion, download.version));
      modal?.classList.remove('active');
      modal?.setAttribute('aria-hidden', 'true');
    };
  }
  if (button) {
    button.href = download.url;
    button.download = download.filename || '';
    button.title = platformTitle(download);
    button.onclick = async (event) => {
      if (!RUNTIME_CAPABILITIES.native || !nativeBridge?.openExternal) return;
      event.preventDefault();
      try {
        await nativeBridge.openExternal(download.url);
      } catch (error) {
        console.warn('[Downloads] Native update download failed', error);
        window.location.href = download.url;
      }
    };
  }
  if (modal) {
    modal.classList.toggle('native-update-required', Boolean(forced));
    modal.classList.add('active');
    modal.removeAttribute('aria-hidden');
  }
}

export function createAppDownloadsFeature() {
  let listenersInstalled = false;
  let nativeChangelogListenerInstalled = false;
  let nativeChangelogOpenInFlight = false;
  let refreshInterval = null;
  let refreshInFlight = null;

  function openAppDownloadsModal() {
    if (!isBrowserDownloadEligible() && !isWebInstallEligible()) return;
    document.getElementById('user-menu')?.classList.remove('active');
    document.getElementById('user-menu-button')?.setAttribute('aria-expanded', 'false');
    const sidebar = document.getElementById('sidebar');
    const sidebarWasOpen = sidebar?.classList.contains('open');
    sidebar?.classList.remove('open');
    document.getElementById('sidebar-overlay')?.classList.remove('active');
    if (sidebarWasOpen && sidebar) hideAutoScrollbars(sidebar);
    const modal = document.getElementById('app-downloads-modal');
    modal?.classList.add('active');
    modal?.removeAttribute('aria-hidden');
    updateWebInstallUI();
    refreshAppDownloads();
  }

  function nativeChangelogUrlForLink(link) {
    const rawHref = link?.getAttribute?.('href') || '';
    try {
      const parsed = new URL(rawHref || link.href || '', window.location.href);
      if (parsed.pathname === '/changelog') return changelogUrl();
    } catch (_error) {
      // Fall back to the configured changelog URL below.
    }
    return changelogUrl();
  }

  function isChangelogLink(link) {
    if (!link) return false;
    if (link.classList?.contains('changelog-link')) return true;
    try {
      const parsed = new URL(link.getAttribute('href') || link.href || '', window.location.href);
      return parsed.pathname === '/changelog';
    } catch (_error) {
      return false;
    }
  }

  function installNativeChangelogLinks(nativeBridge) {
    if (!RUNTIME_CAPABILITIES.native || nativeChangelogListenerInstalled) return;
    nativeChangelogListenerInstalled = true;
    document.addEventListener('click', async (event) => {
      const link = event.target?.closest?.('a[href]');
      if (!isChangelogLink(link)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (nativeChangelogOpenInFlight) return;
      nativeChangelogOpenInFlight = true;
      try {
        await nativeBridge.openExternal(nativeChangelogUrlForLink(link));
      } catch (error) {
        console.warn('[Downloads] Native changelog open failed', error);
      } finally {
        nativeChangelogOpenInFlight = false;
      }
    }, true);
  }

  async function loadDownloadManifest() {
    const baseUrl = RUNTIME_CAPABILITIES.native && API ? `${API}/downloads/app-downloads.json` : '/downloads/app-downloads.json';
    const manifestUrl = new URL(baseUrl, window.location.href);
    manifestUrl.searchParams.set('_', String(Date.now()));
    manifestUrl.searchParams.set('current', normalizeVersion(await createNativeBridge().getAppVersion?.().catch?.(() => '') || 'web') || 'web');
    const response = await fetch(manifestUrl.toString(), { cache: 'no-store' });
    if (!response.ok) throw new Error(`download manifest unavailable: ${response.status}`);
    return response.json();
  }

  async function refreshAppDownloads() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = initAppDownloads().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }

  function installRefreshTriggers() {
    if (listenersInstalled) return;
    listenersInstalled = true;
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredPwaInstallPrompt = event;
      updateWebInstallUI();
    });
    window.addEventListener('appinstalled', () => {
      deferredPwaInstallPrompt = null;
      updateWebInstallUI();
    });
    window.addEventListener('nia-language-change', updateWebInstallUI);
    window.addEventListener('online', () => { refreshAppDownloads(); });
    window.addEventListener('focus', () => { refreshAppDownloads(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshAppDownloads();
    });
    refreshInterval = window.setInterval(() => { refreshAppDownloads(); }, 60 * 60 * 1000);
  }

  let appDownloadLaunchersBound = false;
  function bindAppDownloadLaunchers() {
    if (appDownloadLaunchersBound) return;
    appDownloadLaunchersBound = true;
    document.addEventListener('click', (event) => {
      const launcher = event.target?.closest?.('[data-app-download-launcher]');
      if (!launcher) return;
      event.preventDefault();
      openAppDownloadsModal();
    });
  }

  async function initAppDownloads() {
    const downloadTargets = Array.from(document.querySelectorAll('[data-app-downloads]'));
    const downloadLaunchers = Array.from(document.querySelectorAll('[data-app-download-launcher]'));
    const nativeVersionTargets = Array.from(document.querySelectorAll('[data-native-app-version]'));
    updateWebInstallUI();
    if (!downloadTargets.length && !downloadLaunchers.length && !nativeVersionTargets.length && !document.getElementById('native-app-update-modal')) return;

    const nativeBridge = createNativeBridge();
    installNativeChangelogLinks(nativeBridge);
    const nativePlatform = platformFromNativeRuntime();
    const currentVersion = await getNativeAppVersion(nativeBridge);
    const hasNativeVersion = Boolean(nativePlatform && currentVersion);
    if (hasNativeVersion) {
      nativeVersionTargets.forEach((target) => renderNativeAppVersion(target, nativePlatform, currentVersion, nativeBridge));
    } else {
      nativeVersionTargets.forEach((target) => { target.style.display = 'none'; });
    }

    try {
      const manifest = await loadDownloadManifest();
      const downloads = downloadsFromManifest(manifest);
      if (!downloads.length) throw new Error('app downloads missing');

      if (isBrowserDownloadEligible()) {
        renderDownloadServerAddress(await getDownloadServerAddress());
        downloadTargets.forEach((target) => renderDownloads(target, downloads));
        setDownloadLaunchersVisible(downloadLaunchers, true);
      } else {
        downloadTargets.forEach((target) => setDownloadTargetVisible(target, false));
        setDownloadLaunchersVisible(downloadLaunchers, false);
      }

      const nativeDownload = downloads.find((download) => download.platform === nativePlatform);
      const runtimeInstance = hasNativeVersion ? await refreshRuntimeInstance() : window.NIA_TODO_RUNTIME?.instance;
      const minNativeClientVersion = getMinimumNativeClientVersion(runtimeInstance);
      const updateAvailable = nativeDownload?.version && currentVersion && compareVersions(nativeDownload.version, currentVersion) > 0;
      const updateRequired = nativeDownload?.version && currentVersion && minNativeClientVersion && compareVersions(minNativeClientVersion, currentVersion) > 0;
      const dismissedKey = nativeDownload ? nativeUpdateKey(nativeDownload.platform, currentVersion, nativeDownload.version) : '';
      if (updateRequired) {
        showNativeUpdateModal(nativeDownload, currentVersion, nativeBridge, { forced: true, minVersion: minNativeClientVersion });
      } else if (updateAvailable && !dismissedNativeUpdateKeys.has(dismissedKey)) {
        showNativeUpdateModal(nativeDownload, currentVersion, nativeBridge, { forced: false, minVersion: minNativeClientVersion });
      }
    } catch (error) {
      console.info('[Downloads] No app download available', error);
      downloadTargets.forEach((target) => setDownloadTargetVisible(target, false));
      setDownloadLaunchersVisible(downloadLaunchers, false);
      if (!hasNativeVersion) nativeVersionTargets.forEach((target) => { target.style.display = 'none'; });
    }
  }

  async function startAppDownloads() {
    installRefreshTriggers();
    await refreshAppDownloads();
  }

  function stopAppDownloads() {
    if (refreshInterval) window.clearInterval(refreshInterval);
    refreshInterval = null;
  }

  return { initAppDownloads: startAppDownloads, refreshAppDownloads, stopAppDownloads, openAppDownloadsModal, bindAppDownloadLaunchers };
}
