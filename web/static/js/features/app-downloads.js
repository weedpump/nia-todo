function getTauri() {
  return window.__TAURI__ || null;
}

function getInvoke() {
  return getTauri()?.core?.invoke || null;
}

function hasNativeLaunchParam() {
  return new URLSearchParams(location.search).get('nativeApp') === 'tauri';
}

function isTauriApp() {
  return Boolean(getInvoke()) || hasNativeLaunchParam();
}

function isStandaloneDisplayMode() {
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)')?.matches
    || window.matchMedia?.('(display-mode: fullscreen)')?.matches
    || window.navigator?.standalone
  );
}

function isBrowserDownloadEligible() {
  return !isTauriApp() && !isStandaloneDisplayMode();
}

function platformFromNativeRuntime() {
  if (!isTauriApp()) return '';
  if (/Android/i.test(navigator.userAgent || '')) return 'android';
  return 'windows';
}

async function getNativeAppVersion(platform) {
  if (platform === 'android') {
    try {
      const version = window.NiaAndroidNative?.appVersion?.();
      return version ? String(version) : '';
    } catch (error) {
      console.warn('[Downloads] Android app version unavailable', error);
      return '';
    }
  }

  try {
    const version = await getTauri()?.app?.getVersion?.();
    if (version) return String(version);
  } catch (error) {
    console.warn('[Downloads] Tauri app version unavailable', error);
  }

  const invoke = getInvoke();
  if (!invoke) return '';
  try {
    const version = await invoke('desktop_get_app_version');
    return version ? String(version) : '';
  } catch (error) {
    console.warn('[Downloads] Desktop app version unavailable', error);
    return '';
  }
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
  if (platform === 'android') return 'Android-App';
  if (platform === 'windows') return 'Windows-App';
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
  return String(value || '').trim().replace(/^v/i, '').split('-')[0];
}

function compareVersions(a, b) {
  const left = normalizeVersion(a).split('.').map((part) => Number.parseInt(part, 10));
  const right = normalizeVersion(b).split('.').map((part) => Number.parseInt(part, 10));
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = Number.isFinite(left[index]) ? left[index] : 0;
    const r = Number.isFinite(right[index]) ? right[index] : 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
}

function renderDownloads(target, downloads) {
  if (!target || !downloads?.length) return;
  target.innerHTML = downloads.map((download) => `
    <a class="app-download-button" href="${escapeHtml(download.url)}" download title="${escapeHtml(platformTitle(download))}">
      ${platformIconClass(download.platform) ? `<span class="app-download-icon ${platformIconClass(download.platform)}" aria-hidden="true"></span>` : '<span>⬇️</span>'}
      <span>${escapeHtml(download.version || '')}</span>
    </a>
  `).join('');
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
        ${platformIconClass(download.platform) ? `<span class="app-download-icon ${platformIconClass(download.platform)}" aria-hidden="true"></span>` : '<span>⬇️</span>'}
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
    const nativeUpdateTargets = Array.from(document.querySelectorAll('[data-native-app-update]'));
    if (!downloadTargets.length && !nativeUpdateTargets.length) return;

    try {
      const manifest = await loadDownloadManifest();
      const downloads = downloadsFromManifest(manifest);
      if (!downloads.length) throw new Error('app downloads missing');

      if (isBrowserDownloadEligible()) {
        downloadTargets.forEach((target) => renderDownloads(target, downloads));
      } else {
        downloadTargets.forEach((target) => { target.style.display = 'none'; });
      }

      const nativePlatform = platformFromNativeRuntime();
      const currentVersion = await getNativeAppVersion(nativePlatform);
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
      nativeUpdateTargets.forEach((target) => { target.style.display = 'none'; });
    }
  }

  return { initAppDownloads };
}
