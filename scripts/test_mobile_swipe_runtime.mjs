#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const webRoot = join(repoRoot, 'web');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const harness = `<!doctype html><html><body><script type="module">
  await import('/static/js/core/boot.js');
  document.documentElement.dataset.bootReady = 'true';
</script></body></html>`;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/harness') {
      response.writeHead(200, { 'Content-Type': mimeTypes['.html'] });
      response.end(harness);
      return;
    }
    const relativePath = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    const filePath = join(webRoot, relativePath);
    if (!filePath.startsWith(webRoot)) throw new Error('Path traversal rejected');
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file');
    response.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream' });
    createReadStream(filePath).pipe(response);
  } catch (_error) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}/harness`;
const browser = await chromium.launch({ headless: true });

async function runtimeClasses(options = {}) {
  const context = await browser.newContext({
    viewport: options.viewport || { width: 1280, height: 800 },
    userAgent: options.userAgent,
    isMobile: options.isMobile,
    hasTouch: options.hasTouch,
  });
  if (options.navigatorStandalone) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    });
  }
  const page = await context.newPage();
  await page.goto(`${baseUrl}${options.query || ''}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.bootReady === 'true');
  const classes = await page.evaluate(() => Array.from(document.documentElement.classList));
  await context.close();
  return classes;
}

console.log('🤖 Running mobile swipe runtime classification test...');
try {
  const androidNative = await runtimeClasses({
    query: '?nativeApp=tauri',
    userAgent: 'Mozilla/5.0 (Linux; Android 16; wv) AppleWebKit/537.36 Chrome/153 Mobile Safari/537.36',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  assert.ok(androidNative.includes('native-android'));
  assert.ok(androidNative.includes('mobile-swipe-ui'), 'native Android must use the shared mobile swipe UI');

  const androidBrowser = await runtimeClasses({
    userAgent: 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/153 Mobile Safari/537.36',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  assert.ok(androidBrowser.includes('mobile-swipe-ui'), 'mobile Android browser must use the shared mobile swipe UI');
  assert.ok(!androidBrowser.includes('native-android'));

  const iosWebKit = await runtimeClasses({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  assert.ok(iosWebKit.includes('mobile-swipe-ui'), 'iOS WebKit must use the shared mobile swipe UI');

  const standalonePwa = await runtimeClasses({ navigatorStandalone: true });
  assert.ok(standalonePwa.includes('mobile-swipe-ui'), 'standalone PWA must use the shared mobile swipe UI');

  const desktop = await runtimeClasses();
  assert.ok(!desktop.includes('mobile-swipe-ui'), 'normal desktop browser must retain existing todo markup');

  console.log('✅ Mobile swipe runtime classification test passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
