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
          updateAvailable = true;
          showUpdateButton();
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
            updateAvailable = true;
            showUpdateButton();
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
      return;
    }
    console.log('SW: No waiting worker to activate');
  }

  return {
    initServiceWorker,
    triggerUpdate,
    isUpdateAvailable: () => updateAvailable,
  };
}
