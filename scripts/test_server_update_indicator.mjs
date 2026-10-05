#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';
import { createServerUpdateIndicator } from '../web/static/js/features/server-update-indicator.js';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('web/index.html', root), 'utf8');
const appSource = await readFile(new URL('web/static/js/app.js', root), 'utf8');
const userButtonIndex = html.indexOf('id="user-menu-button"');
const indicatorIndex = html.indexOf('id="server-update-indicator"');
assert(userButtonIndex >= 0, 'sidebar must contain the user menu button');
assert(indicatorIndex > userButtonIndex, 'server update indicator must follow the user field');
assert.doesNotMatch(html, /id="version-info"|id="version-actions"/, 'obsolete sidebar version bar must stay removed');
assert.match(html, /data-i18n-key="update\.server\.available"/);
assert.doesNotMatch(html, /server-update-indicator[^>]*(button|href=)/);
assert.match(appSource, /openAboutModal:\s*options\s*=>\s*aboutFeature\.openAboutModal\(options\)/, 'production user-menu wiring must preserve the About focus target');
assert.match(appSource, /openAppDownloadsModal:\s*options\s*=>\s*appDownloadsFeature\.openAppDownloadsModal\(options\)/, 'production About wiring must preserve the Downloads focus target');

const shellStyles = await readFile(new URL('web/static/css/11-main-shell.css', root), 'utf8');
const aboutStyles = await readFile(new URL('web/static/css/54-about.css', root), 'utf8');
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const webRoot = join(repoRoot, 'web');
const harnessHtml = `<!doctype html>
<html><body>
  <button id="user-menu-button" aria-expanded="true">User</button>
  <div id="user-menu" class="active"><button id="open-about" data-user-menu-action="about">About</button></div>
  <div id="sidebar" class="open"></div><div id="sidebar-overlay" class="active"></div>
  <div id="about-modal" class="modal" aria-hidden="true">
    <button class="modal-close-x" data-close-modal="about-modal">Close about</button>
    <span id="about-server-url"></span><span id="about-server-copy"></span>
    <span id="about-server-version"></span><span id="about-latest-version"></span>
    <span id="about-server-version-status" hidden></span><span id="about-update-note" hidden></span>
    <span id="about-client-version-label"></span><span id="about-client-version"></span>
    <span id="about-client-version-status" hidden></span>
    <button id="about-reload-btn"></button>
    <button id="about-downloads-btn" data-about-action="downloads">Downloads</button>
  </div>
  <div id="app-downloads-modal" class="modal" aria-hidden="true">
    <button id="close-downloads" class="modal-close-x" data-close-modal="app-downloads-modal">Close downloads</button>
  </div>
  <script type="module">
    import { createAboutFeature } from '/static/js/features/about.js';
    import { createAppDownloadsFeature } from '/static/js/features/app-downloads.js';
    import { createUserMenuFeature } from '/static/js/features/user-menu.js';
    const downloads = createAppDownloadsFeature();
    downloads.bindAppDownloadLaunchers();
    const about = createAboutFeature({
      appVersion: '3.2.1',
      serverUpdatesApi: { status: async () => ({ current_version: '3.2.1', latest_version: '3.2.1', update_available: false, stale: false }) },
      openAppDownloadsModal: options => downloads.openAppDownloadsModal(options),
      getClientUpdateStatus: async () => ({ known: true, updateAvailable: false }),
    });
    about.bindAboutActions();
    createUserMenuFeature({ getCurrentUser: () => null, openAboutModal: options => about.openAboutModal(options) }).bindUserMenu();
    window.__aboutHarnessReady = true;
  </script>
</body></html>`;
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    if (pathname === '/harness') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(harnessHtml);
      return;
    }
    if (pathname === '/downloads/app-downloads.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"downloads":[]}');
      return;
    }
    const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    const filePath = join(webRoot, relative);
    if (!filePath.startsWith(webRoot)) throw new Error('Path traversal');
    const content = await readFile(filePath);
    const contentType = extname(filePath) === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': contentType });
    response.end(content);
  } catch (_error) {
    response.writeHead(404);
    response.end('Not found');
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const serverAddress = server.address();
assert(serverAddress && typeof serverAddress === 'object');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
  await page.setContent(`
    <style>${shellStyles}\n${aboutStyles}</style>
    <div class="sidebar-footer">
      <div class="user-menu-wrap sidebar-user-menu-wrap">
        <button class="user-menu-button" id="user-menu-button">User</button>
      </div>
      <div class="server-update-footer">
        <div class="server-update-indicator hidden" id="server-update-indicator" hidden>
          <span class="server-update-indicator-dot"></span>
          <span class="server-update-indicator-text">Server update available</span>
        </div>
      </div>
    </div>
  `);
  const hiddenLayout = await page.evaluate(() => ({
    indicatorDisplay: getComputedStyle(document.getElementById('server-update-indicator')).display,
    footerDisplay: getComputedStyle(document.querySelector('.server-update-footer')).display,
  }));
  assert.equal(hiddenLayout.indicatorDisplay, 'none', 'hidden indicator must not reserve space');
  assert.equal(hiddenLayout.footerDisplay, 'none', 'hidden indicator footer must not reserve space');

  await page.evaluate(() => {
    const indicator = document.getElementById('server-update-indicator');
    indicator.hidden = false;
    indicator.classList.remove('hidden');
  });
  const visibleLayout = await page.evaluate(() => {
    const user = document.getElementById('user-menu-button').getBoundingClientRect();
    const indicator = document.getElementById('server-update-indicator').getBoundingClientRect();
    return {
      indicatorDisplay: getComputedStyle(document.getElementById('server-update-indicator')).display,
      gap: indicator.top - user.bottom,
    };
  });
  assert.equal(visibleLayout.indicatorDisplay, 'flex');
  assert(visibleLayout.gap >= 0, `server update indicator must render below the user field, got ${visibleLayout.gap}px`);

  const lifecyclePage = await browser.newPage();
  await lifecyclePage.goto(`http://127.0.0.1:${serverAddress.port}/harness`);
  await lifecyclePage.waitForFunction(() => window.__aboutHarnessReady === true);
  await lifecyclePage.locator('#open-about').click();
  await lifecyclePage.waitForSelector('#about-modal.active');
  assert.equal(await lifecyclePage.evaluate(() => document.activeElement?.classList.contains('modal-close-x')), true, 'About must focus its close control');
  await lifecyclePage.keyboard.press('Escape');
  assert.equal(await lifecyclePage.locator('#about-modal').getAttribute('aria-hidden'), 'true');
  assert.equal(await lifecyclePage.evaluate(() => document.activeElement?.id), 'user-menu-button', 'closing About must restore focus to the user menu button');

  await lifecyclePage.locator('#open-about').click();
  await lifecyclePage.locator('#about-downloads-btn').click();
  assert.equal(await lifecyclePage.locator('#about-modal').getAttribute('aria-hidden'), 'true');
  assert.equal(await lifecyclePage.locator('#app-downloads-modal').getAttribute('aria-hidden'), null);
  assert.equal(await lifecyclePage.evaluate(() => document.activeElement?.id), 'close-downloads', 'Downloads must move focus out of the hidden About dialog');
  await lifecyclePage.locator('#close-downloads').click();
  assert.equal(await lifecyclePage.locator('#app-downloads-modal').getAttribute('aria-hidden'), 'true');
  assert.equal(await lifecyclePage.evaluate(() => document.activeElement?.id), 'user-menu-button', 'closing Downloads must restore the original focus target');

  await lifecyclePage.locator('#open-about').click();
  await lifecyclePage.locator('#about-downloads-btn').click();
  await lifecyclePage.keyboard.press('Escape');
  assert.equal(await lifecyclePage.locator('#app-downloads-modal').getAttribute('aria-hidden'), 'true');
  assert.equal(await lifecyclePage.evaluate(() => document.activeElement?.id), 'user-menu-button', 'escaping Downloads must restore the original focus target');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

const localeDir = new URL('web/static/i18n/', root);
for (const name of (await readdir(localeDir)).filter(name => name.endsWith('.json'))) {
  const messages = JSON.parse(await readFile(new URL(name, localeDir), 'utf8'));
  assert.equal(typeof messages['update.server.available'], 'string', `${name} must translate update.server.available`);
  assert(messages['update.server.available'].trim(), `${name} translation must not be empty`);
}

const classes = new Set(['hidden']);
const element = {
  hidden: true,
  classList: {
    toggle(name, enabled) {
      if (enabled) classes.add(name);
      else classes.delete(name);
    },
  },
};
const indicator = createServerUpdateIndicator({ getElement: () => element });
indicator.applyStatus({ update_available: true, stale: false });
assert.equal(element.hidden, false);
assert.equal(classes.has('hidden'), false);
indicator.applyStatus({ update_available: false, stale: false });
assert.equal(element.hidden, true);
assert.equal(classes.has('hidden'), true);

console.log('✅ Server update indicator tests passed');
