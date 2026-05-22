import { RUNTIME_CAPABILITIES, RUNTIME_PLATFORM } from '../core/config.js';
import { iconSvg } from '../icons/lucide-icons.js';
import { createNativeBridge } from './native-bridge.js';

function isStandaloneDisplayMode() {
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)')?.matches
    || window.matchMedia?.('(display-mode: fullscreen)')?.matches
    || window.navigator?.standalone
  );
}

function isBrowserDownloadEligible() {
  return RUNTIME_CAPABILITIES.appDownloads && !isStandaloneDisplayMode();
}

function platformFromNativeRuntime() {
  if (!RUNTIME_CAPABILITIES.nativeAppVersion) return '';
  if (RUNTIME_PLATFORM === 'android') return 'android';
  if (RUNTIME_PLATFORM === 'windows') return 'windows';
  return RUNTIME_PLATFORM || 'unknown';
}

async function getNativeAppVersion(nativeBridge) {
  return nativeBridge.getAppVersion();
}

function downloadsFromManifest(manifest) {
  const version = manifest.version || manifest.latest?.version || '';
  const apps = [
    manifest?.latest?.windows,
    manifest?.latest?.android,
    ...(Array.isArray(manifest?.apps) ? manifest.apps : []),
  ].filter(Boolean);
  const byPlatform = new Map();
  for (const app of apps) {
    if (!app?.platform || !app?.url || byPlatform.has(app.platform)) continue;
    byPlatform.set(app.platform, { ...app, version: app.version || version });
  }
  return ['windows', 'android'].map((platform) => byPlatform.get(platform)).filter(Boolean);
}

function platformIconClass(platform) {
  if (platform === 'android') return 'app-download-icon-android';
  if (platform === 'windows') return 'app-download-icon-windows';
  return '';
}

function platformTitle(download) {
  if (download.platform === 'android') return 'Android-App herunterladen';
  if (download.platform === 'windows') return 'Windows-App herunterladen';
  return `${download.label || 'App'} herunterladen`;
}

function platformLabel(platform) {
  if (platform === 'android') return 'Android';
  if (platform === 'windows') return 'Windows';
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

function renderDownloads(target, downloads) {
  if (!target || !downloads?.length) return;
  target.innerHTML = downloads.map((download) => `
    <a class="app-download-button" href="${escapeHtml(download.url)}" download title="${escapeHtml(platformTitle(download))}">
      ${platformIconClass(download.platform) ? `<span class="app-download-icon ${platformIconClass(download.platform)}" aria-hidden="true"></span>` : `<span>${iconSvg('download')}</span>`}
      <span>${escapeHtml(download.version || '')}</span>
    </a>
  `).join('');
  target.style.display = '';
}

function renderNativeAppVersion(target, platform, currentVersion) {
  if (!target || !platform || !currentVersion) return;
  target.innerHTML = `
    <span class="native-version-text"><strong>App Version:</strong> ${escapeHtml(platformLabel(platform))} v${escapeHtml(normalizeVersion(currentVersion) || currentVersion)}</span>
  `;
  target.style.display = '';
}

function renderNativeUpdate(target, download, currentVersion) {
  if (!target || !download) return;
  const latestVersion = download.version || '';
  target.innerHTML = `
    <div class="native-update-card">
      <div class="native-update-copy">
        <strong>Update für ${escapeHtml(platformLabel(download.platform))} verfügbar</strong>
        <span>Installiert: ${escapeHtml(currentVersion || 'unbekannt')} · Neu: ${escapeHtml(latestVersion)}</span>
      </div>
      <a class="app-download-button native-update-download" href="${escapeHtml(download.url)}" download title="${escapeHtml(platformTitle(download))}">
        ${platformIconClass(download.platform) ? `<span class="app-download-icon ${platformIconClass(download.platform)}" aria-hidden="true"></span>` : `<span>${iconSvg('download')}</span>`}
        <span>Download</span>
      </a>
    </div>
  `;
  target.style.display = '';
}

export function createAppDownloadsFeature() {
  async function loadDownloadManifest() {
    const response = await fetch('/downloads/app-downloads.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`download manifest unavailable: ${response.status}`);
    return response.json();
  }

  async function initAppDownloads() {
    const downloadTargets = Array.from(document.querySelectorAll('[data-app-downloads]'));
    const nativeVersionTargets = Array.from(document.querySelectorAll('[data-native-app-version]'));
    const nativeUpdateTargets = Array.from(document.querySelectorAll('[data-native-app-update]'));
    if (!downloadTargets.length && !nativeVersionTargets.length && !nativeUpdateTargets.length) return;

    const nativeBridge = createNativeBridge();
    const nativePlatform = platformFromNativeRuntime();
    const currentVersion = await getNativeAppVersion(nativeBridge);
    const hasNativeVersion = Boolean(nativePlatform && currentVersion);
    if (hasNativeVersion) {
      nativeVersionTargets.forEach((target) => renderNativeAppVersion(target, nativePlatform, currentVersion));
    } else {
      nativeVersionTargets.forEach((target) => { target.style.display = 'none'; });
    }

    try {
      const manifest = await loadDownloadManifest();
      const downloads = downloadsFromManifest(manifest);
      if (!downloads.length) throw new Error('app downloads missing');

      if (isBrowserDownloadEligible()) {
        downloadTargets.forEach((target) => renderDownloads(target, downloads));
      } else {
        downloadTargets.forEach((target) => { target.style.display = 'none'; });
      }

      const nativeDownload = downloads.find((download) => download.platform === nativePlatform);
      const updateAvailable = nativeDownload?.version && currentVersion && compareVersions(nativeDownload.version, currentVersion) > 0;
      if (updateAvailable) {
        nativeUpdateTargets.forEach((target) => renderNativeUpdate(target, nativeDownload, currentVersion));
      } else {
        nativeUpdateTargets.forEach((target) => { target.style.display = 'none'; });
      }
    } catch (error) {
      console.info('[Downloads] No app download available', error);
      downloadTargets.forEach((target) => { target.style.display = 'none'; });
      if (!hasNativeVersion) nativeVersionTargets.forEach((target) => { target.style.display = 'none'; });
      nativeUpdateTargets.forEach((target) => { target.style.display = 'none'; });
    }
  }

  return { initAppDownloads };
}
