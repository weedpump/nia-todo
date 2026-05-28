import { APP_VERSION, RUNTIME_CAPABILITIES } from '../core/config.js';

export function createServiceWorkerUpdatesFeature({ onMarkTodoDone }) {
  let swRegistration = null;
  let updateAvailable = false;
  let allowReloadOnControllerChange = false;
  let hadControllerAtRegistration = false;
  let updateCheckInFlight = false;
  let lastUpdateCheckAt = 0;
  let serviceWorkerInitStarted = false;

  const STARTUP_SW_DELAY_MS = 5000;
  const UPDATE_CHECK_TIMEOUT_MS = 8000;
  const BROWSER_UPDATE_INTERVAL_MS = 30 * 60 * 1000;
  const NATIVE_UPDATE_INTERVAL_MS = 10 * 60 * 1000;
  const FOREGROUND_MIN_CHECK_INTERVAL_MS = 2 * 60 * 1000;
  const STARTUP_FOLLOW_UP_DELAYS_MS = [20 * 1000, 2 * 60 * 1000];

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
      console.log('SW: web update prompts suppressed in native runtime');
    }
    if (!('serviceWorker' in navigator) || typeof navigator.serviceWorker?.register !== 'function') return;

    console.log('SW: registration scheduled');
    setTimeout(async () => {
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
          console.log('SW: New controller active after explicit update, reloading...');
          window.location.reload();
        });

        navigator.serviceWorker.addEventListener('message', (event) => {
          console.log('SW message received:', event.data);
          if (event.data?.type === 'MARK_TODO_DONE' && event.data.todoId) {
            onMarkTodoDone(event.data.todoId);
          }
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

  function waitForWorkerState(worker, state, timeoutMs = 8000) {
    if (!worker) return Promise.resolve(false);
    if (worker.state === state) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        worker.removeEventListener('statechange', onStateChange);
        resolve(false);
      }, timeoutMs);
      function onStateChange() {
        if (worker.state !== state) return;
        clearTimeout(timeout);
        worker.removeEventListener('statechange', onStateChange);
        resolve(true);
      }
      worker.addEventListener('statechange', onStateChange);
    });
  }

  function postMessageWithReply(worker, message, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!worker) {
        reject(new Error('No service worker controller'));
        return;
      }
      const channel = new MessageChannel();
      const timeout = setTimeout(() => {
        channel.port1.onmessage = null;
        reject(new Error('Service worker reply timeout'));
      }, timeoutMs);
      channel.port1.onmessage = (event) => {
        clearTimeout(timeout);
        if (event.data?.ok) resolve(event.data);
        else reject(new Error(event.data?.error || 'Service worker request failed'));
      };
      worker.postMessage(message, [channel.port2]);
    });
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
    for (const button of buttons) {
      button.disabled = true;
      button.title = 'Web-App wird neu geladen…';
    }

    try {
      if (!('serviceWorker' in navigator)) {
        window.location.reload();
        return;
      }

      const reg = swRegistration || await navigator.serviceWorker.getRegistration('/') || await navigator.serviceWorker.register('/sw.js');
      swRegistration = reg;

      try {
        await withTimeout(reg.update(), UPDATE_CHECK_TIMEOUT_MS, 'SW forced update check');
      } catch (err) {
        console.warn('SW: Forced update check failed, refreshing current cache anyway', err);
      }

      if (reg.waiting) {
        await triggerUpdate();
        return;
      }

      if (reg.installing) {
        await waitForWorkerState(reg.installing, 'installed');
        if (reg.waiting) {
          await triggerUpdate();
          return;
        }
      }

      const controller = navigator.serviceWorker.controller || reg.active;
      if (controller) {
        await postMessageWithReply(controller, { action: 'refreshAppCache' });
      }

      window.location.reload();
    } catch (err) {
      console.error('Forced app reload failed:', err);
      window.location.reload();
    } finally {
      for (const button of buttons) {
        button.disabled = false;
        button.title = previousTitles.get(button) || 'Web-App neu herunterladen und Cache aktualisieren';
      }
    }
  }

  return {
    initServiceWorker,
    triggerUpdate,
    forceReloadApp,
    isUpdateAvailable: () => updateAvailable,
  };
}
