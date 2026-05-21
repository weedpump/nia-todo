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

function windowsDownloadFromManifest(manifest) {
  const windows = manifest?.latest?.windows || manifest?.apps?.find?.((app) => app.platform === 'windows');
  if (!windows?.url) return null;
  return {
    ...windows,
    version: windows.version || manifest.version || manifest.latest?.version || '',
  };
}

function renderDownload(target, download) {
  if (!target || !download) return;
  const version = download.version || '';
  target.innerHTML = `
    <a class="app-download-button" href="${download.url}" download title="Windows-App herunterladen">
      <span>🪟</span>
      <span>${version}</span>
    </a>
  `;
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
      const download = windowsDownloadFromManifest(manifest);
      if (!download) throw new Error('windows download missing');
      targets.forEach((target) => renderDownload(target, download));
    } catch (error) {
      console.info('[Downloads] No app download available', error);
      targets.forEach((target) => { target.style.display = 'none'; });
    }
  }

  return { initAppDownloads };
}
