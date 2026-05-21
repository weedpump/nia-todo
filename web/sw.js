// nia-todo Service Worker - Bulletproof Offline-First + Update-System + Push Notifications
const SW_VERSION = 'v1.5.2';
const CACHE_NAME = 'nia-todo-' + SW_VERSION;

// ALLE Assets die wir brauchen
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/static/style.css',
  '/static/js/main.js',
  '/static/js/app.js',
  '/static/js/api/http.js',
  '/static/js/api/sections.js',
  '/static/js/api/auth.js',
  '/static/js/api/index.js',
  '/static/js/api/projects.js',
  '/static/js/api/push.js',
  '/static/js/api/todos.js',
  '/static/js/core/config.js',
  '/static/js/core/utils.js',
  '/static/js/core/state.js',
  '/static/js/storage/app-storage.js',
  '/static/js/storage/indexed-db.js',
  '/static/js/sync/queue.js',
  '/static/js/features/api-keys.js',
  '/static/js/features/app-downloads.js',
  '/static/js/features/app-rendering.js',
  '/static/js/features/app-lifecycle.js',
  '/static/js/features/auth-session.js',
  '/static/js/features/connection-status.js',
  '/static/js/features/drag-drop.js',
  '/static/js/features/legacy-globals.js',
  '/static/js/features/push-notifications.js',
  '/static/js/features/theme.js',
  '/static/js/features/ui-shell.js',
  '/static/js/features/user-settings.js',
  '/static/js/features/projects.js',
  '/static/js/features/navigation.js',
  '/static/js/features/todos.js',
  '/static/js/features/sync.js',
  '/static/js/features/todo-rendering.js',
  '/static/js/features/toast-undo.js',
  '/static/js/features/view-preferences.js',
  '/static/js/features/websocket-client.js',
  '/static/js/features/service-worker-updates.js',
  '/static/js/features/section-actions.js',
  '/static/js/features/sections.js',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/favicon.ico'
];

// Inline Offline-Fallback
const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>nia-todo - Offline</title>
<style>
body { background:#0f172a; color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; text-align:center; padding:20px; }
.offline-state { max-width:400px; }
.emoji { font-size:64px; margin-bottom:20px; }
h1 { margin:0 0 10px 0; font-size:24px; }
p { color:#94a3b8; margin:0 0 20px 0; }
.btn { background:#6366f1; color:white; border:none; padding:12px 24px; border-radius:8px; font-size:16px; cursor:pointer; }
</style>
</head>
<body>
<div class="offline-state">
<div class="emoji">📴</div>
<h1>Offline</h1>
<p>Keine Internetverbindung. Die App wird gleich geladen...</p>
<button class="btn" onclick="location.reload()">Neu laden</button>
</div>
<script>setTimeout(()=>location.reload(),2000);</script>
</body>
</html>`;

// ─── Install ─────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('SW: Installing version', SW_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('SW: Pre-caching', PRECACHE_ASSETS.length, 'assets');
        return cache.addAll(PRECACHE_ASSETS);
      })
      .then(() => {
        console.log('SW: Pre-cache complete for', SW_VERSION);
        // NICHT skipWaiting - warten auf Nutzer-Approval
        // self.skipWaiting();
      })
      .catch((err) => {
        console.error('SW: Pre-cache failed:', err);
      })
  );
});

// ─── Activate ────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('SW: Activating version', SW_VERSION);
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.filter((n) => n !== CACHE_NAME)
            .map((n) => {
              console.log('SW: Deleting old cache:', n);
              return caches.delete(n);
            })
      );
    }).then(() => self.clients.claim())
  );
});

// ─── Message Event (für skipWaiting vom Client) ───────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data && event.data.action === 'skipWaiting') {
    console.log('SW: skipWaiting received, activating new version');
    self.skipWaiting();
  }
  if (event.data && event.data.action === 'clearAuthCaches') {
    event.waitUntil(
      caches.keys().then((names) => Promise.all(
        names.filter((n) => n.startsWith('nia-todo-api-')).map((n) => caches.delete(n))
      ))
    );
  }
});

// ─── Push Event ──────────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    data = { title: '⏰ Erinnerung', body: 'Neue Benachrichtigung', tag: 'default' };
  }

  // Ignore silent health check pushes from server
  if (data._silent || data._health_check) {
    return;
  }

  const title = data.title || 'nia-todo';
  const body = data.body || '';
  const tag = data.tag || ('push-' + Date.now());
  const url = data.url || '/';
  const todoId = data.todoId;

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: '/static/icons/icon-192.png',
      badge: '/static/icons/icon-badge.png',
      tag: tag,
      data: { url: url, todoId: todoId },
      actions: [
        { action: 'open', title: 'Öffnen' },
        { action: 'done', title: '✅ Erledigt' }
      ],
      requireInteraction: false,
    })
  );
});

// ─── Notification Click ──────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const action = event.action;
  const data = event.notification.data || {};
  const todoId = data.todoId;
  const url = data.url || '/';

  if (action === 'open' || !action) {
    // Open app
    event.waitUntil(clients.openWindow(url));
  } else if (action === 'done' && todoId) {
    // Focus existing app window or open it, then post message to mark todo done
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
        if (windowClients.length > 0) {
          // Focus existing window and send message
          const client = windowClients[0];
          client.focus();
          client.postMessage({ type: 'MARK_TODO_DONE', todoId: todoId });
        } else {
          // Open new window
          clients.openWindow('/').then(client => {
            // Wait a bit for app to init, then send message
            setTimeout(() => {
              client.postMessage({ type: 'MARK_TODO_DONE', todoId: todoId });
            }, 2000);
          });
        }
      })
    );
  } else {
    event.waitUntil(clients.openWindow(url));
  }
});

// ─── Notification Close (optional cleanup) ───────────────────────────────────
self.addEventListener('notificationclose', (event) => {
  // Nothing special needed, but good to log for debugging
  console.log('SW: Notification closed', event.notification.tag);
});

// ─── Fetch ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  if (event.request.method !== 'GET') return;
  
  // User avatars are static, versioned by avatar_updated_at and should stay visible offline.
  if (url.pathname.startsWith('/api/avatars/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const network = fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
        return cached || network;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // API requests are auth-bound and must never be cached in the service worker.
  // Offline data lives in the per-user IndexedDB cache, which is cleared on user switch/logout.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }
  
  // Alle anderen Requests
  event.respondWith(
    caches.match(event.request)
      .then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        });
      })
      .catch(() => {
        if (event.request.mode === 'navigate' || event.request.destination === 'document') {
          return caches.match('/index.html').then((cached) => {
            return cached || new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html' } });
          });
        }
        return new Response('', { status: 404 });
      })
  );
});
