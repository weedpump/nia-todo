export function createServiceWorkerUpdatesFeature({ onMarkTodoDone }) {
  let swRegistration = null;
  let updateAvailable = false;
  let allowReloadOnControllerChange = false;
  let hadControllerAtRegistration = false;

  function isNativeApp() {
    return Boolean(window.__TAURI__?.core?.invoke) || new URLSearchParams(location.search).get('nativeApp') === 'tauri';
  }

  async function initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

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
          if (isNativeApp()) {
            console.log('SW: Native app detected → activating waiting update automatically');
            setTimeout(() => triggerUpdate(), 0);
          } else {
            updateAvailable = true;
            showUpdateButton();
          }
        }

        checkForUpdate(reg);
        setInterval(() => checkForUpdate(reg), 30 * 60 * 1000);

        document.addEventListener('visibilitychange', () => {
          if (!document.hidden && swRegistration) {
            console.log('SW: Visibility changed → checking for update');
            checkForUpdate(swRegistration);
          }
        });

        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          console.log('SW: New version found, installing...');
          if (!newWorker) return;

          newWorker.addEventListener('statechange', () => {
            if (newWorker.state !== 'installed') return;
            if (!hadControllerAtRegistration) {
              console.log('SW: First installation completed — no update prompt');
              return;
            }
            if (!reg.waiting) {
              console.log('SW: Installed worker is not waiting — no update prompt');
              return;
            }
            console.log('SW: New version ready for update');
            if (isNativeApp()) {
              console.log('SW: Native app detected → activating new update automatically');
              triggerUpdate();
            } else {
              updateAvailable = true;
              showUpdateButton();
            }
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
          if (event.data.type === 'MARK_TODO_DONE' && event.data.todoId) {
            onMarkTodoDone(event.data.todoId);
          }
        });
      } catch (err) {
        console.error('SW registration failed:', err);
      }
    }, 5000);
  }

  async function checkForUpdate(reg) {
    try {
      await reg.update();
      console.log('SW: Update check done');
    } catch (err) {
      console.error('SW: Update check failed', err);
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

  function showUpdateButton() {
    const el = document.getElementById('update-btn');
    if (el) {
      el.style.display = 'flex';
      console.log('Update button shown');
    }
  }

  async function triggerUpdate() {
    console.log('Triggering app update...');
    if (swRegistration && swRegistration.waiting) {
      allowReloadOnControllerChange = true;
      swRegistration.waiting.postMessage({ action: 'skipWaiting' });
      return true;
    }
    console.log('SW: No waiting worker to activate');
    return false;
  }

  async function forceReloadApp() {
    const button = document.getElementById('force-refresh-btn');
    const previousTitle = button?.title;
    if (button) {
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
        await reg.update();
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
      if (button) {
        button.disabled = false;
        button.title = previousTitle || 'Web-App neu herunterladen und Cache aktualisieren';
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
