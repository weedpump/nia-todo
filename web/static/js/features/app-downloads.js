function isTauriApp() {
  return Boolean(window.__TAURI__?.core?.invoke);
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

function platformIcon(platform) {
  if (platform === 'android') return '🤖';
  if (platform === 'windows') return '🪟';
  return '⬇️';
}

function platformTitle(download) {
  if (download.platform === 'android') return 'Android-App herunterladen';
  if (download.platform === 'windows') return 'Windows-App herunterladen';
  return `${download.label || 'App'} herunterladen`;
}

function renderDownloads(target, downloads) {
  if (!target || !downloads?.length) return;
  target.innerHTML = downloads.map((download) => `
    <a class="app-download-button" href="${download.url}" download title="${platformTitle(download)}">
      <span>${platformIcon(download.platform)}</span>
      <span>${download.version || ''}</span>
    </a>
  `).join('');
  target.style.display = '';
}

export function createAppDownloadsFeature() {
  async function initAppDownloads() {
    const targets = Array.from(document.querySelectorAll('[data-app-downloads]'));
    if (!targets.length) return;

    if (!isBrowserDownloadEligible()) {
      targets.forEach((target) => { target.style.display = 'none'; });
      return;
    }

    try {
      const response = await fetch('/downloads/app-downloads.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`download manifest unavailable: ${response.status}`);
      const manifest = await response.json();
      const downloads = downloadsFromManifest(manifest);
      if (!downloads.length) throw new Error('app downloads missing');
      targets.forEach((target) => renderDownloads(target, downloads));
    } catch (error) {
      console.info('[Downloads] No app download available', error);
      targets.forEach((target) => { target.style.display = 'none'; });
    }
  }

  return { initAppDownloads };
}
