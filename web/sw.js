// nia-todo Service Worker - Bulletproof Offline-First + Update-System
const SW_VERSION = 'v0.2.1';
const CACHE_NAME = 'nia-todo-' + SW_VERSION;
const API_CACHE = 'nia-todo-api-' + SW_VERSION;

// ALLE Assets die wir brauchen
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/static/style.css',
  '/static/app.js',
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
        names.filter((n) => n !== CACHE_NAME && n !== API_CACHE)
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
});

// ─── Fetch ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  if (event.request.method !== 'GET') return;
  
  // API Requests
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(API_CACHE).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
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
