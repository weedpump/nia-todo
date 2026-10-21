import assert from 'node:assert/strict';

const originalWindow = globalThis.window;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

try {
  const cleanedUrls = [];
  const location = {
    href: 'https://todo.example.test/?filter=today&hardReload=old-value#focus',
    origin: 'https://todo.example.test',
    search: '?filter=today&hardReload=old-value',
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
  createServiceWorkerUpdatesFeature();

  assert.equal(cleanedUrls.length, 1, 'startup must remove a stale hardReload marker from the visible URL');
  const cleanedUrl = new URL(location.href);
  assert.equal(cleanedUrl.searchParams.has('hardReload'), false, 'the cleanup must remove hardReload');
  assert.equal(cleanedUrl.searchParams.get('filter'), 'today', 'the cleanup must preserve unrelated query parameters');
  assert.equal(cleanedUrl.hash, '#focus', 'the cleanup must preserve the current URL fragment');

  console.log('Frontend reload URL cleanup regression test passed');
} finally {
  globalThis.window = originalWindow;
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
  else delete globalThis.location;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
}
