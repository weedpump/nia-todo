#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB_ROOT = join(ROOT, 'web');
const MAIN_ACTIVITY = join(ROOT, 'src-tauri/gen/android/app/src/main/java/de/tobiaskneidl/nia_todo/MainActivity.kt');
const activitySource = readFileSync(MAIN_ACTIVITY, 'utf8');
const onWebViewCreate = activitySource.match(/override fun onWebViewCreate\(webView: WebView\) \{([\s\S]*?)\n  \}\n/)?.[1];
assert.ok(onWebViewCreate, 'MainActivity.onWebViewCreate must be present');

assert.match(
  onWebViewCreate,
  /webView\.isVerticalScrollBarEnabled\s*=\s*false/,
  'Android WebView must disable its native vertical scrollbar because the web layer renders the single dashboard scroll indicator',
);
assert.match(
  onWebViewCreate,
  /webView\.isHorizontalScrollBarEnabled\s*=\s*false/,
  'Android WebView must disable its native horizontal scrollbar so overflow indicators stay owned by the web layer',
);

// Playwright verifies the real CSS/DOM scroll-root contract. The Kotlin source
// assertions above cover the native WebView layer that headless Chromium cannot emulate.
const fixture = `<!doctype html>
<html class="native-app native-android" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <link rel="stylesheet" href="/static/style.css">
</head>
<body>
  <div id="app">
    <main class="main">
      <div class="topbar"><button class="hamburger">Menu</button><div class="search-box"><input aria-label="Search"></div></div>
      <div class="stats-bar">
        <section class="overview-dashboard">
          <header class="overview-dashboard-header"><div class="overview-greeting"><div class="overview-avatar">N</div><div><div class="overview-kicker">Dashboard</div><h2>Overview</h2></div></div></header>
          <div class="overview-stat-grid">
            <div class="overview-stat-card total"><strong class="overview-stat-num">40</strong><div><div class="overview-stat-label">Open</div></div></div>
            <div class="overview-stat-card pending"><strong class="overview-stat-num">4</strong><div><div class="overview-stat-label">Due</div></div></div>
            <div class="overview-stat-card progress"><strong class="overview-stat-num">2</strong><div><div class="overview-stat-label">In progress</div></div></div>
            <div class="overview-stat-card due"><strong class="overview-stat-num">0</strong><div><div class="overview-stat-label">Overdue</div></div></div>
          </div>
          <div class="overview-detail-grid"><div class="overview-panel"><div class="overview-panel-title">Focus</div></div><div class="overview-panel"><div class="overview-panel-title">Projects</div></div></div>
        </section>
      </div>
      <div class="todo-list">
        <div class="todo-group"><div class="todo-group-title">Open</div><div id="fixture-todos"></div></div>
      </div>
    </main>
  </div>
  <script type="module">
    import { initAutoScrollbars } from '/static/js/features/auto-scrollbars.js';
    const list = document.getElementById('fixture-todos');
    for (let index = 1; index <= 40; index += 1) {
      const item = document.createElement('article');
      item.className = 'todo-item';
      item.innerHTML = '<button class="todo-check"></button><div class="todo-body"><div class="todo-title">Android dashboard overflow regression ' + index + '</div></div>';
      list.appendChild(item);
    }
    initAutoScrollbars();
    document.documentElement.dataset.fixtureReady = 'true';
  </script>
</body>
</html>`;

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
]);

const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(fixture);
    return;
  }
  const relative = normalize(pathname).replace(/^[/\\]+/, '');
  const path = join(WEB_ROOT, relative);
  if (!path.startsWith(WEB_ROOT)) {
    response.writeHead(403).end();
    return;
  }
  try {
    response.writeHead(200, { 'Content-Type': contentTypes.get(extname(path)) || 'application/octet-stream' });
    response.end(readFileSync(path));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const fixtureUrl = `http://127.0.0.1:${address.port}/`;

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8 Pro Build/AP4A.250205.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2.75,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(fixtureUrl, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === 'true');

  const viewports = [
    { width: 360, height: 640 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
    { width: 768, height: 1024 },
    { width: 1280, height: 720 },
  ];
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      const layout = await page.evaluate(() => {
        const main = document.querySelector('.main');
        const todoList = document.querySelector('.todo-list');
        const viewportScroller = document.scrollingElement;
        const activeScrollRoots = [...document.querySelectorAll('*')].filter(element => {
          const style = getComputedStyle(element);
          return ['auto', 'scroll', 'overlay'].includes(style.overflowY)
            && element.scrollHeight - element.clientHeight > 1
            && element.getBoundingClientRect().right > 0;
        });
        return {
          bodyOverflowY: getComputedStyle(document.body).overflowY,
          viewportOverflow: viewportScroller.scrollHeight - innerHeight,
          mainOverflowY: getComputedStyle(main).overflowY,
          mainOverflow: main.scrollHeight - main.clientHeight,
          todoOverflowY: getComputedStyle(todoList).overflowY,
          activeScrollRoots: activeScrollRoots.map(element => element.className || element.tagName),
        };
      });
      assert.equal(layout.bodyOverflowY, 'hidden', `${theme} ${viewport.width}x${viewport.height}: body must not become a competing scroll root`);
      assert.ok(layout.viewportOverflow <= 1, `${theme} ${viewport.width}x${viewport.height}: viewport unexpectedly scrolls by ${layout.viewportOverflow}px`);
      assert.equal(layout.mainOverflowY, 'auto', `${theme} ${viewport.width}x${viewport.height}: dashboard main must own vertical scrolling`);
      assert.ok(layout.mainOverflow > 1, `${theme} ${viewport.width}x${viewport.height}: fixture must overflow the dashboard main`);
      assert.equal(layout.todoOverflowY, 'visible', `${theme} ${viewport.width}x${viewport.height}: todo list must flow inside the main scroll root`);
      assert.deepEqual(layout.activeScrollRoots, ['main'], `${theme} ${viewport.width}x${viewport.height}: expected exactly one DOM scroll root`);
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    const main = document.querySelector('.main');
    main.scrollTop = 200;
    main.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(50);
  const visibleWebIndicators = await page.locator('.scrollbar-overlay-indicator.visible').count();
  assert.equal(visibleWebIndicators, 1, 'The web layer should render exactly one dashboard scroll indicator after Android native scrollbars are disabled');

  await context.close();
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log('✅ Android dashboard scrollbar regression test passed');
