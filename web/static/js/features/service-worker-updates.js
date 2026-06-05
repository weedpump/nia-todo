import { APP_VERSION, RUNTIME_CAPABILITIES } from '../core/config.js';

export function createServiceWorkerUpdatesFeature() {
  let swRegistration = null;
  let updateAvailable = false;
  let allowReloadOnControllerChange = false;
  let hadControllerAtRegistration = false;
  let updateCheckInFlight = false;
  let lastUpdateCheckAt = 0;
  let serviceWorkerInitStarted = false;
  let updateReloadFallbackTimer = null;

  const STARTUP_SW_DELAY_MS = 5000;
  const UPDATE_CHECK_TIMEOUT_MS = 8000;
  const BROWSER_UPDATE_INTERVAL_MS = 30 * 60 * 1000;
  const NATIVE_UPDATE_INTERVAL_MS = 10 * 60 * 1000;
  const FOREGROUND_MIN_CHECK_INTERVAL_MS = 2 * 60 * 1000;
  const STARTUP_FOLLOW_UP_DELAYS_MS = [20 * 1000, 2 * 60 * 1000];
  const FALLBACK_HARD_RELOAD_ASSETS = ['/', '/index.html', '/manifest.json', '/static/style.css', '/static/js/main.js'];

  function isNativeApp() {
    return RUNTIME_CAPABILITIES.native;
  }

  function normalizeVersion(value) {
    return String(value || '').trim().replace(/^v/i, '');
  }

  async function fetchCurrentServiceWorkerVersion() {
    try {
      const response = await fetch(`/sw.js?update-check=${Date.now()}`, { cache: 'reload' });
      if (!response.ok) return '';
      const text = await response.text();
      return text.match(/SW_VERSION\s*=\s*['\"]([^'\"]+)['\"]/)?.[1] || '';
    } catch (err) {
      console.warn('SW: Could not read current service worker version', err);
      return '';
    }
  }

  async function shouldPromptForFirstInstallUpdate() {
    const swVersion = await fetchCurrentServiceWorkerVersion();
    return Boolean(swVersion && normalizeVersion(swVersion) !== normalizeVersion(APP_VERSION));
  }

  function withTimeout(promise, timeoutMs, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)),
    ]);
  }

  function reloadWithCacheBuster(paramName = 'appUpdated') {
    const url = new URL(window.location.href);
    url.searchParams.set(paramName, String(Date.now()));
    window.location.replace(url.toString());
  }

  function isNiaTodoServiceWorkerRegistration(registration) {
    const worker = registration?.active || registration?.waiting || registration?.installing;
    return Boolean(worker?.scriptURL && worker.scriptURL.endsWith('/sw.js'));
  }

  function isNiaTodoCacheName(name) {
    return String(name || '').startsWith('nia-todo');
  }

  async function refreshActiveServiceWorkerAppCache(registration) {
    const worker = registration?.active || navigator.serviceWorker?.controller;
    if (!worker || typeof worker.postMessage !== 'function') return false;
    const channel = new MessageChannel();
    const response = new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 10000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timeout);
        resolve(Boolean(event.data?.ok));
      };
    });
    worker.postMessage({ action: 'refreshAppCache' }, [channel.port2]);
    return response;
  }

  function parsePrecacheAssets(serviceWorkerSource) {
    const match = String(serviceWorkerSource || '').match(/const\s+PRECACHE_ASSETS\s*=\s*\[([\s\S]*?)\];/);
    if (!match) return [];
    return [...match[1].matchAll(/['"]([^'"]+)['"]/g)]
      .map(item => item[1])
      .filter(asset => asset === '/' || asset.startsWith('/static/') || asset === '/index.html' || asset === '/manifest.json');
  }


  function waitForWorkerState(worker, desiredStates, timeoutMs = 10000) {
    if (!worker) return Promise.resolve(false);
    if (desiredStates.includes(worker.state)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        worker.removeEventListener('statechange', onStateChange);
        resolve(false);
      }, timeoutMs);
      function onStateChange() {
        if (!desiredStates.includes(worker.state)) return;
        clearTimeout(timeout);
        worker.removeEventListener('statechange', onStateChange);
        resolve(true);
      }
      worker.addEventListener('statechange', onStateChange);
    });
  }

  function resolveWithTimeout(promise, timeoutMs, fallbackValue = false) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(fallbackValue), timeoutMs);
      Promise.resolve(promise).then((value) => {
        clearTimeout(timeout);
        resolve(value);
      }).catch(() => {
        clearTimeout(timeout);
        resolve(fallbackValue);
      });
    });
  }


  async function ensureOfflineServiceWorkerReadyAfterHardReload() {
    if (!('serviceWorker' in navigator) || typeof navigator.serviceWorker?.register !== 'function') return false;
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      swRegistration = registration;
      await registration.update().catch(() => null);

      if (registration.waiting) {
        registration.waiting.postMessage({ action: 'skipWaiting' });
        await waitForWorkerState(registration.waiting, ['activated'], 12000);
      }

      if (registration.installing) {
        await waitForWorkerState(registration.installing, ['installed', 'activated'], 12000);
        if (registration.waiting) {
          registration.waiting.postMessage({ action: 'skipWaiting' });
          await waitForWorkerState(registration.waiting, ['activated'], 12000);
        }
      }

      await resolveWithTimeout(navigator.serviceWorker.ready, 2500, null);
      return Boolean(registration.active || navigator.serviceWorker.controller);
    } catch (error) {
      console.warn('Forced app reload could not restore offline service worker before navigation', error);
      return false;
    }
  }

  async function fetchHardReloadAssets() {
    let assets = FALLBACK_HARD_RELOAD_ASSETS;
    try {
      const swResponse = await fetch(`/sw.js?hard-reload-assets=${Date.now()}`, { cache: 'reload' });
      if (swResponse.ok) {
        const parsed = parsePrecacheAssets(await swResponse.text());
        if (parsed.length) assets = parsed;
      }
    } catch (error) {
      console.warn('Forced app reload could not read service worker asset list; using fallback assets', error);
    }

    const uniqueAssets = [...new Set(assets)];
    await Promise.all(uniqueAssets.map(async (asset) => {
      try {
        const url = new URL(asset, window.location.origin);
        url.searchParams.set('hardReloadAsset', String(Date.now()));
        await fetch(url.toString(), { cache: 'reload', credentials: 'same-origin' });
      } catch (error) {
        console.warn('Forced app reload asset refresh failed:', asset, error);
      }
    }));
  }

  function hideUpdateModal() {
    const modal = document.getElementById('web-update-modal');
    if (!modal) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
  }

  async function initServiceWorker() {
    if (serviceWorkerInitStarted) return;
    serviceWorkerInitStarted = true;
    if (isNativeApp()) {
      hideUpdateModal();
      console.log('SW: skipped in native runtime; bundled app assets are loaded locally');
      return;
    }
    if (!('serviceWorker' in navigator) || typeof navigator.serviceWorker?.register !== 'function') return;

    console.log('SW: registration scheduled');
    setTimeout(async () => {
      if (!('serviceWorker' in navigator) || typeof navigator.serviceWorker?.register !== 'function') return;
      const startedAt = performance.now();
      try {
        console.log('SW: registering...');
        hadControllerAtRegistration = Boolean(navigator.serviceWorker.controller);
        const reg = await navigator.serviceWorker.register('/sw.js');
        swRegistration = reg;
        console.log('SW registered:', reg.scope, Math.round(performance.now() - startedAt) + 'ms');

        if (reg.waiting) {
          console.log('SW: Update waiting from previous session');
          markUpdateAvailable(reg.waiting);
        }

        scheduleUpdateCheck('startup', { immediate: true, minIntervalMs: 0 });
        for (const delay of STARTUP_FOLLOW_UP_DELAYS_MS) {
          setTimeout(() => scheduleUpdateCheck(`startup-follow-up-${delay}`, { minIntervalMs: 0 }), delay);
        }
        setInterval(
          () => scheduleUpdateCheck('periodic', { minIntervalMs: isNativeApp() ? NATIVE_UPDATE_INTERVAL_MS : BROWSER_UPDATE_INTERVAL_MS }),
          isNativeApp() ? NATIVE_UPDATE_INTERVAL_MS : BROWSER_UPDATE_INTERVAL_MS,
        );

        bindUpdateCheckEvents();

        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          console.log('SW: New version found, installing...');
          if (!newWorker) return;

          newWorker.addEventListener('statechange', () => {
            if (newWorker.state !== 'installed') return;
            if (!hadControllerAtRegistration) {
              shouldPromptForFirstInstallUpdate().then((shouldPrompt) => {
                if (shouldPrompt) {
                  console.log('SW: First installation is newer than loaded app — showing update prompt');
                  markUpdateAvailable(newWorker);
                } else {
                  console.log('SW: First installation completed — no update prompt');
                }
              });
              return;
            }
            if (!reg.waiting) {
              console.log('SW: Installed worker is not waiting — no update prompt');
              return;
            }
            console.log('SW: New version ready for update');
            markUpdateAvailable(reg.waiting);
          });
        });

        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!allowReloadOnControllerChange) {
            console.log('SW: controller changed on first registration — no reload');
            return;
          }
          if (updateReloadFallbackTimer) clearTimeout(updateReloadFallbackTimer);
          updateReloadFallbackTimer = null;
          console.log('SW: New controller active after explicit update, reloading with cache buster...');
          reloadWithCacheBuster('appUpdated');
        });
      } catch (err) {
        console.error('SW registration failed:', err);
      }
    }, STARTUP_SW_DELAY_MS);
  }

  function bindUpdateCheckEvents() {
    const foregroundCheck = (reason) => scheduleUpdateCheck(reason, { minIntervalMs: FOREGROUND_MIN_CHECK_INTERVAL_MS });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) foregroundCheck('visibilitychange');
    });
    window.addEventListener('focus', () => foregroundCheck('focus'));
    window.addEventListener('pageshow', () => foregroundCheck('pageshow'));
    window.addEventListener('online', () => scheduleUpdateCheck('online', { minIntervalMs: 0 }));
  }

  function scheduleUpdateCheck(reason, { immediate = false, minIntervalMs = FOREGROUND_MIN_CHECK_INTERVAL_MS } = {}) {
    if (!swRegistration) return;
    const now = Date.now();
    if (!immediate && now - lastUpdateCheckAt < minIntervalMs) return;
    if (updateCheckInFlight) return;
    updateCheckInFlight = true;
    lastUpdateCheckAt = now;
    setTimeout(() => {
      checkForUpdate(swRegistration, reason).finally(() => {
        updateCheckInFlight = false;
      });
    }, immediate ? 0 : 250);
  }

  async function checkForUpdate(reg, reason = 'manual') {
    if (!reg) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      console.log(`SW: Update check skipped (${reason}) — browser reports offline`);
      return;
    }
    try {
      await withTimeout(reg.update(), UPDATE_CHECK_TIMEOUT_MS, 'SW update check');
      console.log(`SW: Update check done (${reason})`);
      if (reg.waiting) markUpdateAvailable(reg.waiting);
    } catch (err) {
      console.warn(`SW: Update check failed (${reason})`, err);
    }
  }

  function updateVersionLabel() {
    const current = document.querySelector('.version-text')?.textContent?.trim() || '';
    const modalCurrent = document.getElementById('web-update-current-version');
    if (modalCurrent) modalCurrent.textContent = current || 'aktuelle Version';
  }

  function markUpdateAvailable() {
    updateAvailable = true;
    if (isNativeApp()) {
      console.log('SW: Web-app update prompt suppressed in native runtime');
      return;
    }
    showUpdateModal();
  }

  function showUpdateModal() {
    updateVersionLabel();
    const modal = document.getElementById('web-update-modal');
    const primary = document.getElementById('web-update-apply-btn');
    if (primary) primary.disabled = false;
    if (modal) {
      modal.classList.add('active');
      modal.removeAttribute('aria-hidden');
      console.log('SW: Update modal shown');
    }
  }

  async function triggerUpdate() {
    console.log('Triggering app update...');
    const primary = document.getElementById('web-update-apply-btn');
    if (primary) primary.disabled = true;
    if (swRegistration && swRegistration.waiting) {
      allowReloadOnControllerChange = true;
      if (updateReloadFallbackTimer) clearTimeout(updateReloadFallbackTimer);
      updateReloadFallbackTimer = setTimeout(() => {
        console.warn('SW: controllerchange did not fire after skipWaiting, reloading with cache buster fallback');
        reloadWithCacheBuster('appUpdated');
      }, 10000);
      swRegistration.waiting.postMessage({ action: 'skipWaiting' });
      return true;
    }
    console.log('SW: No waiting worker to activate — falling back to hard reload');
    await forceReloadApp();
    return true;
  }

  async function forceReloadApp() {
    const buttons = Array.from(document.querySelectorAll('#force-refresh-btn, [data-force-refresh-button]'));
    const previousTitles = new Map(buttons.map(button => [button, button.title]));

    if (navigator.onLine === false || buttons.some(button => button.disabled || button.getAttribute('aria-disabled') === 'true')) {
      console.warn('Forced app reload skipped because the app is offline');
      return;
    }

    for (const button of buttons) {
      button.disabled = true;
      button.title = 'Web-App wird neu geladen…';
    }

    try {
      // This is used by the login-page recovery button and the sidebar reload
      // action. It must be a real recovery reload, not just location.reload(): a
      // stale active service worker can otherwise serve the same broken app
      // shell again. Keep IndexedDB untouched. When a nia-todo service worker is
      // already active, keep it registered and refresh its app-shell cache in
      // place. iOS/iPadOS standalone PWAs can lose offline launch after a
      // hard-reload if the active worker is unregistered during the current
      // standalone page lifetime. Only use the destructive unregister/cache wipe
      // fallback when there is no active nia-todo worker to preserve.
      let hasActiveNiaTodoWorker = false;
      if ('serviceWorker' in navigator && typeof navigator.serviceWorker.getRegistrations === 'function') {
        const registrations = await navigator.serviceWorker.getRegistrations();
        const niaRegistrations = registrations.filter(isNiaTodoServiceWorkerRegistration);
        hasActiveNiaTodoWorker = niaRegistrations.some(registration => registration.active || navigator.serviceWorker.controller);
        if (hasActiveNiaTodoWorker) {
          await Promise.all(niaRegistrations.map(registration => refreshActiveServiceWorkerAppCache(registration).catch(() => false)));
        } else {
          await Promise.all(niaRegistrations.map(registration => registration.unregister().catch(() => false)));
        }
      }
      if (!hasActiveNiaTodoWorker && 'caches' in window && typeof caches.keys === 'function') {
        const names = await caches.keys();
        await Promise.all(names
          .filter(isNiaTodoCacheName)
          .map(name => caches.delete(name).catch(() => false)));
      }
      await fetchHardReloadAssets();
      await resolveWithTimeout(ensureOfflineServiceWorkerReadyAfterHardReload(), 7000, false);
    } catch (err) {
      console.error('Forced app reload cleanup failed:', err);
    }

    reloadWithCacheBuster('hardReload');
  }

  return {
    initServiceWorker,
    triggerUpdate,
    forceReloadApp,
    isUpdateAvailable: () => updateAvailable,
  };
}
