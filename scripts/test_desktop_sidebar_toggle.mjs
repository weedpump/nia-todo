import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const indexHtml = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const uiShellSource = readFileSync(new URL('../web/static/js/features/ui-shell.js', import.meta.url), 'utf8');
const uiHistorySource = readFileSync(new URL('../web/static/js/features/ui-history.js', import.meta.url), 'utf8');
const baseCss = readFileSync(new URL('../web/static/css/00-base.css', import.meta.url), 'utf8');
const sidebarCss = readFileSync(new URL('../web/static/css/10-navigation-sidebar.css', import.meta.url), 'utf8');
const shellCss = readFileSync(new URL('../web/static/css/11-main-shell.css', import.meta.url), 'utf8');
const buttonCss = readFileSync(new URL('../web/static/css/30-buttons-empty.css', import.meta.url), 'utf8');
const responsiveCss = readFileSync(new URL('../web/static/css/40-responsive-mobile.css', import.meta.url), 'utf8');

assert.match(
  indexHtml,
  /id="sidebar-toggle-btn"[\s\S]*data-icon="sidebar"/,
  'the shared sidebar control must use the Lucide sidebar icon',
);
assert.match(
  indexHtml,
  /id="user-menu-button"[^>]*aria-label="User menu"[^>]*data-i18n-aria-label-key="menu\.userMenu"/,
  'the rail user-menu button must keep its localized accessible name',
);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route('http://sidebar.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/static/js/features/ui-shell.js') {
      await route.fulfill({ contentType: 'text/javascript', body: uiShellSource });
      return;
    }
    if (path === '/static/js/features/ui-history.js') {
      await route.fulfill({ contentType: 'text/javascript', body: uiHistorySource });
      return;
    }
    if (path === '/static/js/features/auto-scrollbars.js') {
      await route.fulfill({ contentType: 'text/javascript', body: 'export function hideAutoScrollbars() {}' });
      return;
    }
    if (path === '/static/js/i18n/index.js') {
      await route.fulfill({ contentType: 'text/javascript', body: 'export function t(key) { return key; }' });
      return;
    }
    if (path !== '/sidebar-test') {
      await route.fulfill({ status: 404, body: 'Not found' });
      return;
    }
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html>
        <html>
          <head><style>${baseCss}\n${sidebarCss}\n${shellCss}\n${buttonCss}\n${responsiveCss}</style></head>
          <body>
            <div id="app">
              <div class="sidebar-overlay" id="sidebar-overlay" data-sidebar-toggle></div>
              <aside class="sidebar" id="sidebar">
                <div class="logo"><span class="logo-text">nia-todo</span></div>
                <div class="sidebar-scroll-region">
                  <nav class="nav-section">
                    <button class="nav-btn ui-nav-pill"><span class="nav-label">Dashboard</span><span class="badge">4</span></button>
                  </nav>
                </div>
                <div class="sidebar-footer">
                  <div class="user-menu-wrap sidebar-user-menu-wrap">
                    <button class="user-menu-button" id="user-menu-button" aria-expanded="false" aria-label="User menu"><span class="user-menu-button-avatar">T</span><span class="sidebar-user-meta">Tobi</span></button>
                    <div class="ui-menu user-menu" id="user-menu"></div>
                  </div>
                </div>
              </aside>
              <main class="main">
                <div class="topbar"><button type="button" class="hamburger" id="sidebar-toggle-btn" data-sidebar-toggle aria-expanded="false"><svg><rect></rect><path></path></svg></button></div>
              </main>
            </div>
            <script type="module">
              import { createUiShell } from '/static/js/features/ui-shell.js';
              const shell = createUiShell({ renderMarkdown: value => value, showTodoModal: async () => {} });
              shell.bindSidebarControls();
              window.sidebarReady = true;
            </script>
          </body>
        </html>`,
    });
  });

  await page.goto('http://sidebar.test/sidebar-test');
  await page.waitForFunction(() => window.sidebarReady === true);

  const snapshot = () => page.evaluate(() => {
    const app = document.getElementById('app');
    const sidebar = document.getElementById('sidebar');
    const toggle = document.getElementById('sidebar-toggle-btn');
    return {
      mode: app.dataset.desktopSidebarMode,
      width: Math.round(sidebar.getBoundingClientRect().width),
      visibility: getComputedStyle(sidebar).visibility,
      expanded: toggle.getAttribute('aria-expanded'),
      labelDisplay: getComputedStyle(document.querySelector('.nav-label')).display,
      badgeDisplay: getComputedStyle(document.querySelector('.badge')).display,
    };
  });

  assert.deepEqual(await snapshot(), {
    mode: 'expanded',
    width: 260,
    visibility: 'visible',
    expanded: 'true',
    labelDisplay: 'block',
    badgeDisplay: 'flex',
  });
  assert.equal(await page.evaluate(() => localStorage.getItem('nia-desktop-sidebar-mode')), null);

  await page.locator('#sidebar-toggle-btn').click();
  await page.waitForTimeout(250);
  assert.deepEqual(await snapshot(), {
    mode: 'rail',
    width: 76,
    visibility: 'visible',
    expanded: 'true',
    labelDisplay: 'none',
    badgeDisplay: 'none',
  });
  assert.equal(await page.evaluate(() => localStorage.getItem('nia-desktop-sidebar-mode')), 'rail');
  await page.reload();
  await page.waitForFunction(() => window.sidebarReady === true);
  await page.waitForTimeout(250);
  assert.deepEqual(await snapshot(), {
    mode: 'rail',
    width: 76,
    visibility: 'visible',
    expanded: 'true',
    labelDisplay: 'none',
    badgeDisplay: 'none',
  });
  const railUserMenuButton = page.getByRole('button', { name: 'User menu' });
  await assert.doesNotReject(() => railUserMenuButton.click());
  assert.equal(await railUserMenuButton.isVisible(), true);

  await page.locator('#sidebar-toggle-btn').click();
  await page.waitForTimeout(250);
  assert.deepEqual(await snapshot(), {
    mode: 'hidden',
    width: 0,
    visibility: 'hidden',
    expanded: 'false',
    labelDisplay: 'block',
    badgeDisplay: 'flex',
  });
  assert.equal(await page.evaluate(() => localStorage.getItem('nia-desktop-sidebar-mode')), 'hidden');
  await page.reload();
  await page.waitForFunction(() => window.sidebarReady === true);
  await page.waitForTimeout(250);
  assert.deepEqual(await snapshot(), {
    mode: 'hidden',
    width: 0,
    visibility: 'hidden',
    expanded: 'false',
    labelDisplay: 'block',
    badgeDisplay: 'flex',
  });

  await page.locator('#sidebar-toggle-btn').click();
  await page.waitForTimeout(250);
  assert.equal((await snapshot()).mode, 'expanded');
  assert.equal((await snapshot()).width, 260);
  assert.equal(await page.evaluate(() => localStorage.getItem('nia-desktop-sidebar-mode')), 'expanded');

  await page.evaluate(() => localStorage.setItem('nia-desktop-sidebar-mode', 'invalid'));
  await page.reload();
  await page.waitForFunction(() => window.sidebarReady === true);
  assert.equal((await snapshot()).mode, 'expanded');
  assert.equal(await page.evaluate(() => localStorage.getItem('nia-desktop-sidebar-mode')), 'invalid');

  await page.setViewportSize({ width: 390, height: 800 });
  await page.locator('#sidebar-toggle-btn').click();
  assert.equal(await page.locator('#sidebar').evaluate(element => element.classList.contains('open')), true);
  assert.equal(await page.locator('#sidebar-overlay').evaluate(element => element.classList.contains('active')), true);
  assert.equal(await page.locator('#sidebar-toggle-btn').getAttribute('aria-expanded'), 'true');

  await page.locator('#sidebar-overlay').click({ position: { x: 380, y: 400 } });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#sidebar').evaluate(element => element.classList.contains('open')), false);
  assert.equal(await page.locator('#sidebar-overlay').evaluate(element => element.classList.contains('active')), false);
  assert.equal(await page.locator('#sidebar-toggle-btn').getAttribute('aria-expanded'), 'false');
} finally {
  await browser.close();
}

console.log('Desktop sidebar toggle tests passed');
