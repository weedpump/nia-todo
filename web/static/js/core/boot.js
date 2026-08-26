import { isTauri } from '../../vendor/tauri-api/core.js';
(function() {
    const params = new URLSearchParams(location.search);
    const nativeLaunch = params.get('nativeApp') === 'tauri';
    const android = /Android/i.test(navigator.userAgent || '');
    const tauri = isTauri();
    if (nativeLaunch) document.documentElement.classList.add('native-app');
    if (android && (nativeLaunch || tauri)) {
      document.documentElement.classList.add('native-android');
    }
    // Native shells rely on the service worker cache for offline cold starts.
    // Do not unregister it here: Android WebView can report navigator.onLine=true
    // while DNS is unavailable, which would break the next offline launch.
  })();

  // Keep the browser/PWA surface app-like on touch devices: no pinch-zoom or
  // two-finger page scaling, while leaving normal desktop browser zoom intact.
  (function() {
    function preventTouchZoom(event) {
      if (event.touches && event.touches.length > 1) event.preventDefault();
    }
    function preventGestureZoom(event) {
      event.preventDefault();
    }
    function preventTrackpadPinchZoom(event) {
      // Precision touchpad pinch gestures are exposed as ctrl/meta + wheel by browsers.
      // Keyboard/menu browser zoom stays available; ctrl/meta + wheel zoom is blocked too.
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    }
    document.addEventListener('touchmove', preventTouchZoom, { passive: false });
    document.addEventListener('wheel', preventTrackpadPinchZoom, { passive: false });
    document.addEventListener('gesturestart', preventGestureZoom, { passive: false });
    document.addEventListener('gesturechange', preventGestureZoom, { passive: false });
    document.addEventListener('gestureend', preventGestureZoom, { passive: false });
  })();

  // Prevent native form submit/reload if the user is faster than the JS module boot.
  window.__niaLoginReady = false;
  window.__niaPendingLoginSubmit = false;
  document.addEventListener('submit', function(event) {
    if (event.target && event.target.id === 'login-form' && !window.__niaLoginReady) {
      event.preventDefault();
      window.__niaPendingLoginSubmit = true;
    }
  }, true);

  // If module scripts are missing from an incomplete offline cache, app.js never
  // runs and the lifecycle watchdog cannot start. Keep this tiny inline fallback.
  // The retry action must work even when the app bundle or service worker code is
  // stale/broken, so it lives inline and refreshes browser-managed app caches.
  window.__niaAppModuleStarted = false;
  window.__niaMainModuleLoaded = false;
  window.niaHardReloadApp = async function() {
    var retry = document.getElementById('boot-retry');
    var subtitle = document.getElementById('boot-subtitle');
    var cssModuleAssets = [
      '/static/css/00-base.css',
      '/static/css/10-navigation-sidebar.css',
      '/static/css/11-main-shell.css',
      '/static/css/12-overview-dashboard.css',
      '/static/css/13-calendar-view.css',
      '/static/css/20-todos-list.css',
      '/static/css/30-buttons-empty.css',
      '/static/css/31-modals.css',
      '/static/css/32-dropdowns-selects.css',
      '/static/css/33-color-scrollbars.css',
      '/static/css/40-responsive-mobile.css',
      '/static/css/50-auth-login.css',
      '/static/css/51-auth-downloads-install.css',
      '/static/css/52-auth-mobile.css',
      '/static/css/53-version-bar.css',
      '/static/css/60-feedback-markdown.css',
      '/static/css/61-workspace-confirm-icons.css',
      '/static/css/62-touch-native.css',
      '/static/css/63-security-auth.css',
      '/static/css/64-focus-controls.css',
      '/static/css/70-braindump.css',
      '/static/css/71-settings.css',
      '/static/css/74-whats-new.css',
      '/static/css/80-form-todo-modal.css',
      '/static/css/80-todo-detail-workspace-base.css',
      '/static/css/81-todo-cards-refresh.css',
      '/static/css/82-entity-modals.css',
      '/static/css/83-focus-selects.css',
      '/static/css/89-ui-detail-modal.css',
      '/static/css/90-minimal-list.css',
      '/static/css/90-detail-extras.css',
      '/static/css/90-attachments-preview.css',
      '/static/css/91-todo-detail-layout.css',
      '/static/css/92-todo-detail-content.css',
      '/static/css/92-todo-detail-comments-actions.css',
      '/static/css/92-todo-detail-attachments.css',
      '/static/css/92-todo-detail-description.css',
      '/static/css/93-todo-detail-meta-drawer.css',
      '/static/css/94-todo-detail-header-actions.css',
      '/static/css/95-todo-detail-mobile-viewport.css'
    ];
    var fallbackAssets = ['/', '/index.html', '/manifest.json', '/static/style.css'].concat(cssModuleAssets, ['/static/js/main.js']);
    function parsePrecacheAssets(source) {
      var match = String(source || '').match(/const\s+PRECACHE_ASSETS\s*=\s*\[([\s\S]*?)\];/);
      if (!match) return [];
      return Array.from(match[1].matchAll(/['"]([^'"]+)['"]/g)).map(function(item) { return item[1]; }).filter(function(asset) {
        return asset === '/' || asset === '/index.html' || asset === '/manifest.json' || asset.indexOf('/static/') === 0;
      });
    }

    function waitForServiceWorkerState(worker, desiredStates, timeoutMs) {
      if (!worker) return Promise.resolve(false);
      if (desiredStates.indexOf(worker.state) !== -1) return Promise.resolve(true);
      return new Promise(function(resolve) {
        var timeout = setTimeout(function() {
          worker.removeEventListener('statechange', onStateChange);
          resolve(false);
        }, timeoutMs || 10000);
        function onStateChange() {
          if (desiredStates.indexOf(worker.state) === -1) return;
          clearTimeout(timeout);
          worker.removeEventListener('statechange', onStateChange);
          resolve(true);
        }
        worker.addEventListener('statechange', onStateChange);
      });
    }
    function withTimeout(promise, timeoutMs, fallbackValue) {
      return new Promise(function(resolve) {
        var timeout = setTimeout(function() { resolve(fallbackValue); }, timeoutMs);
        Promise.resolve(promise).then(function(value) {
          clearTimeout(timeout);
          resolve(value);
        }).catch(function() {
          clearTimeout(timeout);
          resolve(fallbackValue);
        });
      });
    }
    function isNiaTodoServiceWorkerRegistration(registration) {
      var worker = registration && (registration.active || registration.waiting || registration.installing);
      return Boolean(worker && worker.scriptURL && worker.scriptURL.endsWith('/sw.js'));
    }
    async function refreshActiveServiceWorkerAppCache(registration) {
      var worker = (registration && registration.active) || (navigator.serviceWorker && navigator.serviceWorker.controller);
      if (!worker || typeof worker.postMessage !== 'function' || typeof MessageChannel === 'undefined') return false;
      var channel = new MessageChannel();
      var response = new Promise(function(resolve) {
        var timeout = setTimeout(function() { resolve(false); }, 10000);
        channel.port1.onmessage = function(event) {
          clearTimeout(timeout);
          resolve(Boolean(event.data && event.data.ok));
        };
      });
      worker.postMessage({ action: 'refreshAppCache' }, [channel.port2]);
      return response;
    }
    async function restoreOfflineServiceWorker() {
      if (!navigator.serviceWorker || !navigator.serviceWorker.register) return false;
      try {
        var registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
        await registration.update().catch(function() { return null; });

        if (registration.waiting) {
          registration.waiting.postMessage({ action: 'skipWaiting' });
          await waitForServiceWorkerState(registration.waiting, ['activated'], 12000);
        }

        if (registration.installing) {
          await waitForServiceWorkerState(registration.installing, ['installed', 'activated'], 12000);
          if (registration.waiting) {
            registration.waiting.postMessage({ action: 'skipWaiting' });
            await waitForServiceWorkerState(registration.waiting, ['activated'], 12000);
          }
        }

        await withTimeout(navigator.serviceWorker.ready, 2500, null);
        return Boolean(registration.active || navigator.serviceWorker.controller);
      } catch (error) {
        console.warn('Boot recovery could not restore offline service worker before navigation', error);
        return false;
      }
    }
    async function refreshAssetsFromNetwork() {
      var assets = fallbackAssets;
      try {
        var swResponse = await fetch('/sw.js?hard-reload-assets=' + Date.now(), { cache: 'reload' });
        if (swResponse.ok) {
          var parsed = parsePrecacheAssets(await swResponse.text());
          if (parsed.length) assets = parsed;
        }
      } catch (error) {
        console.warn('Boot recovery could not read service worker asset list; using fallback assets', error);
      }
      await Promise.all(Array.from(new Set(assets)).map(function(asset) {
        try {
          var assetUrl = new URL(asset, window.location.origin);
          assetUrl.searchParams.set('hardReloadAsset', String(Date.now()));
          return fetch(assetUrl.toString(), { cache: 'reload', credentials: 'same-origin' }).catch(function() { return false; });
        } catch (_) {
          return false;
        }
      }));
    }
    if (navigator.onLine === false) {
      if (subtitle) subtitle.textContent = 'Offline – Neu laden ist erst online möglich.';
      return;
    }
    if (retry) retry.disabled = true;
    if (subtitle) subtitle.textContent = 'App cache is being refreshed…';
    try {
      var hasActiveNiaTodoWorker = false;
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        var registrations = await navigator.serviceWorker.getRegistrations();
        var niaRegistrations = registrations.filter(isNiaTodoServiceWorkerRegistration);
        hasActiveNiaTodoWorker = niaRegistrations.some(function(registration) {
          return Boolean(registration.active || (navigator.serviceWorker && navigator.serviceWorker.controller));
        });
        if (hasActiveNiaTodoWorker) {
          await Promise.all(niaRegistrations.map(function(registration) {
            return refreshActiveServiceWorkerAppCache(registration).catch(function() { return false; });
          }));
        } else {
          await Promise.all(niaRegistrations.map(function(registration) {
            return registration.unregister().catch(function() { return false; });
          }));
        }
      }
      if (!hasActiveNiaTodoWorker && window.caches && caches.keys) {
        var names = await caches.keys();
        await Promise.all(names.filter(function(name) { return name.indexOf('nia-todo') === 0; }).map(function(name) {
          return caches.delete(name).catch(function() { return false; });
        }));
      }
      await refreshAssetsFromNetwork();
      await withTimeout(restoreOfflineServiceWorker(), 7000, false);
    } catch (error) {
      console.warn('Boot recovery cache refresh failed:', error);
    }
    var url = new URL(window.location.href);
    url.searchParams.set('hardReload', String(Date.now()));
    window.location.replace(url.toString());
  };
  window.addEventListener('DOMContentLoaded', function() {
    setTimeout(function() {
      if (window.__niaAppModuleStarted) return;
      var subtitle = document.getElementById('boot-subtitle');
      var spinner = document.getElementById('boot-spinner');
      var retry = document.getElementById('boot-retry');
      if (window.__niaMainModuleLoaded) {
        if (subtitle) subtitle.textContent = 'App wird vorbereitet…';
        return;
      }
      if (subtitle) subtitle.textContent = 'App files are missing. Please reload online.';
      if (spinner) spinner.style.display = 'none';
      if (retry) retry.style.display = '';
    }, 15000);
  });
