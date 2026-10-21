import assert from 'node:assert/strict';

const originalWindow = globalThis.window;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

try {
  const cleanedUrls = [];
  const location = {
    href: 'https://todo.example.test/?filter=today&hardReload=old-value&appUpdated=old-version#focus',
    origin: 'https://todo.example.test',
    search: '?filter=today&hardReload=old-value&appUpdated=old-version',
  };
  globalThis.window = {
    location,
    history: {
      state: { view: 'today' },
      replaceState(state, title, url) {
        cleanedUrls.push({ state, title, url });
        location.href = new URL(url, location.href).toString();
      },
    },
  };
  globalThis.location = location;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Mozilla/5.0', platform: 'Linux', maxTouchPoints: 0 },
  });

  const { createServiceWorkerUpdatesFeature } = await import('../web/static/js/features/service-worker-updates.js');
  const feature = createServiceWorkerUpdatesFeature();

  assert.equal(cleanedUrls.length, 0, 'creating the feature must not remove reload markers before app bootstrap succeeds');
  feature.removeReloadMarkersFromVisibleUrl();

  assert.equal(cleanedUrls.length, 1, 'successful startup must remove reload markers from the visible URL');
  const cleanedUrl = new URL(location.href);
  assert.equal(cleanedUrl.searchParams.has('hardReload'), false, 'the cleanup must remove hardReload');
  assert.equal(cleanedUrl.searchParams.has('appUpdated'), false, 'the cleanup must remove appUpdated');
  assert.equal(cleanedUrl.searchParams.get('filter'), 'today', 'the cleanup must preserve unrelated query parameters');
  assert.equal(cleanedUrl.hash, '#focus', 'the cleanup must preserve the current URL fragment');

  const appSource = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../web/static/js/app.js', import.meta.url), 'utf8'));
  assert.match(appSource, /bindLoginForm\(\);\s*serviceWorkerUpdates\.removeReloadMarkersFromVisibleUrl\(\);\s*\}/, 'app startup must clean reload markers only after bootstrap bindings complete');

  console.log('Frontend reload URL cleanup regression test passed');
} finally {
  globalThis.window = originalWindow;
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
  else delete globalThis.location;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
}
