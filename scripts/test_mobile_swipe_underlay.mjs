#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const webRoot = join(repoRoot, 'web');
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function harnessHtml() {
  return `<!doctype html>
<html class="native-app mobile-swipe-ui">
<head>
  <link rel="stylesheet" href="/static/style.css">
  <style>
    body { margin: 20px; }
    #fixture { width: 320px; }
  </style>
</head>
<body>
  <div id="fixture"></div>
  <script type="module">
    import { renderTodoItem } from '/static/js/features/todo-rendering.js';
    import { createTodosFeature } from '/static/js/features/todos.js';

    const todos = [
      { id: 36, title: 'Native swipe underlay', status: 'pending', priority: 3 },
      { id: 37, title: 'Completed native card', status: 'done', priority: 2 },
      { id: 38, title: 'In-progress native card', status: 'in_progress', priority: 1 },
      { id: 39, title: 'Pinned mobile card', status: 'pending', priority: 3, is_pinned: true },
      { id: 40, title: 'Mobile card with details', status: 'pending', priority: 3, description: 'Responsive radius fixture' },
    ];
    document.getElementById('fixture').innerHTML = todos.map(renderTodoItem).join('');
    window.__renderTodoItem = renderTodoItem;
    window.__underlayTodo = todos[0];
    const noop = () => undefined;
    createTodosFeature({
      getTodos: () => todos,
      setTodos: noop,
      getProjects: () => [],
      getCurrentProjectId: () => null,
      getCurrentWorkspaceId: () => null,
      getCurrentUser: () => null,
      setCurrentUser: noop,
      getAppInitialized: () => false,
      getDb: () => null,
      dbPut: async () => undefined,
      dbGetAll: async () => [],
      deleteFromDB: async () => undefined,
      addToSyncQueue: async () => undefined,
      isOnlineForSync: () => false,
      syncWithServer: async () => undefined,
      todosApi: {},
      sectionsApi: {},
      placesApi: null,
      renderProjects: noop,
      renderStats: noop,
      renderTodos: noop,
      closeModal: noop,
      confirmDanger: async () => false,
      showToast: noop,
      setupDescPreview: noop,
      renderMarkdown: value => String(value || ''),
    });
    window.__underlayReady = true;
  </script>
</body>
</html>`;
}

function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/harness') {
        response.writeHead(200, { 'Content-Type': mimeTypes['.html'] });
        response.end(harnessHtml());
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
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

console.log('🤖 Running mobile touch semantic swipe underlay test...');
const server = await startServer();
const address = server.address();
assert.ok(address && typeof address === 'object');

try {
  const availableBrowsers = { chromium, webkit };
  const requestedBrowsers = (process.env.MOBILE_SWIPE_BROWSERS || 'chromium,webkit')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  for (const browserName of requestedBrowsers) {
    const browserType = availableBrowsers[browserName];
    assert.ok(browserType, `Unknown browser requested: ${browserName}`);
    const browser = await browserType.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`http://127.0.0.1:${address.port}/harness`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__underlayReady === true);

  const shells = page.locator('.todo-swipe-shell');
  const shell = page.locator('.todo-swipe-shell[data-todo-swipe-id="36"]');
  const item = page.locator('.todo-item[data-id="36"]');
  assert.equal(await shells.count(), 5, 'every mobile touch todo must render a swipe shell');
  assert.equal(await shell.locator('.todo-swipe-action-in-progress').count(), 1, 'right swipe action must be persistent');
  assert.equal(await shell.locator('.todo-swipe-action-done').count(), 1, 'left swipe action must be persistent');
  assert.equal(await shell.locator('svg.todo-swipe-action-icon[data-swipe-icon="in-progress"]').count(), 1, 'in-progress action must use the Lucide flame icon');
  assert.equal(await shell.locator('svg.todo-swipe-action-icon[data-swipe-icon="done"]').count(), 1, 'done action must use the Lucide check icon');
  assert.ok((await shell.locator('.todo-swipe-action-in-progress').textContent()).trim(), 'in-progress action needs a label');
  assert.ok((await shell.locator('.todo-swipe-action-done').textContent()).trim(), 'done action needs a label');

  const idleStyles = await page.evaluate(() => {
    const read = id => {
      const item = document.querySelector(`.todo-item[data-id="${id}"]`);
      const shell = item.closest('.todo-swipe-shell');
      const itemStyle = getComputedStyle(item);
      const shellStyle = getComputedStyle(shell);
      return {
        itemClass: item.className,
        itemOpacity: itemStyle.opacity,
        itemBackground: itemStyle.background,
        itemBoxShadow: itemStyle.boxShadow,
        shellMarginBottom: shellStyle.marginBottom,
        shellRadius: shellStyle.borderRadius,
        shellOverflow: shellStyle.overflow,
        underlayOpacity: getComputedStyle(shell.querySelector('.todo-swipe-underlay')).opacity,
        underlayVisibility: getComputedStyle(shell.querySelector('.todo-swipe-underlay')).visibility,
      };
    };
    return { pending: read(36), done: read(37), progress: read(38), pinned: read(39), details: read(40) };
  });
  for (const state of Object.values(idleStyles)) {
    assert.equal(state.shellMarginBottom, '8px', 'native swipe shells must preserve card spacing outside grid lists');
    assert.equal(state.shellRadius, '24px', 'phone swipe shell radius must match the native card radius');
    assert.equal(state.shellOverflow, 'hidden', 'swipe clipping must be established before the first gesture');
    assert.equal(state.underlayOpacity, '0', 'semantic underlay must not bleed through idle cards');
    assert.equal(state.underlayVisibility, 'hidden', 'idle semantic underlay must be excluded from painting');
  }
  assert.equal(idleStyles.done.itemOpacity, '0.54', 'done card opacity must remain unchanged while idle');
  assert.match(idleStyles.progress.itemClass, /in-progress/);
  assert.match(idleStyles.pinned.itemClass, /pinned/);
  assert.notEqual(idleStyles.progress.itemBoxShadow, 'none', 'in-progress card treatment must remain intact while idle');
  assert.notEqual(idleStyles.pinned.itemBoxShadow, 'none', 'pinned card treatment must remain intact while idle');

  await page.setViewportSize({ width: 900, height: 900 });
  const wideRadii = await page.evaluate(() => ({
    simple: getComputedStyle(document.querySelector('.todo-swipe-shell[data-todo-swipe-id="36"]')).borderRadius,
    details: getComputedStyle(document.querySelector('.todo-swipe-shell[data-todo-swipe-id="40"]')).borderRadius,
  }));
  assert.equal(wideRadii.simple, '999px', 'wide compact cards must retain pill clipping');
  assert.equal(wideRadii.details, '26px', 'wide cards with details must match their 26px card radius');
  await page.setViewportSize({ width: 390, height: 844 });

  const revealButton = item.locator('.todo-actions-reveal-btn');
  await revealButton.click();
  assert.equal(await item.evaluate(element => element.classList.contains('actions-expanded')), true, 'quick-action reveal must still expand the wrapped card');
  assert.equal(await shell.evaluate(element => getComputedStyle(element).overflow), 'visible', 'expanded quick actions must escape shell clipping');
  await revealButton.click();
  assert.equal(await item.evaluate(element => element.classList.contains('actions-expanded')), false, 'quick-action reveal must still collapse the wrapped card');

  for (const selector of ['.todo-status-menu-left', '.todo-snooze-menu']) {
    const menuState = await page.evaluate((menuSelector) => {
      const shell = document.querySelector('.todo-swipe-shell[data-todo-swipe-id="36"]');
      const item = shell.querySelector('.todo-item');
      if (menuSelector === '.todo-snooze-menu') item.classList.add('actions-expanded');
      const menu = shell.querySelector(menuSelector);
      menu.open = true;
      menu.classList.add('placement-ready');
      const panel = menu.querySelector('.todo-action-menu');
      const rect = panel.getBoundingClientRect();
      const x = Math.max(1, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(1, Math.min(window.innerHeight - 1, rect.top + Math.min(rect.height / 2, 24)));
      const hit = document.elementFromPoint(x, y);
      const result = {
        overflow: getComputedStyle(shell).overflow,
        zIndex: getComputedStyle(shell).zIndex,
        panelVisible: getComputedStyle(panel).visibility,
        panelHeight: rect.height,
        hitShellId: hit?.closest?.('.todo-swipe-shell')?.dataset?.todoSwipeId || null,
      };
      menu.open = false;
      menu.classList.remove('placement-ready');
      item.classList.remove('actions-expanded');
      return result;
    }, selector);
    assert.equal(menuState.overflow, 'visible', `${selector} must escape the swipe clipping shell`);
    assert.equal(menuState.zIndex, '1001', `${selector} must elevate its shell above later cards`);
    assert.equal(menuState.panelVisible, 'visible', `${selector} panel must be visible`);
    assert.ok(menuState.panelHeight > 0, `${selector} panel must have layout`);
    assert.equal(menuState.hitShellId, '36', `${selector} panel must remain hit-testable above adjacent cards`);
  }

  const box = await item.boundingBox();
  assert.ok(box);

  await page.evaluate(() => {
    const shell = document.querySelector('.todo-swipe-shell[data-todo-swipe-id="36"]');
    const item = shell.querySelector('.todo-item');
    const menu = item.querySelector('.todo-status-menu-left');
    item.classList.add('actions-expanded', 'has-open-menu');
    menu.open = true;
    menu.classList.add('placement-ready');
  });
  await item.dispatchEvent('pointerdown', {
    pointerId: 35,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: box.x + box.width * 0.7,
    clientY: box.y + box.height / 2,
  });
  await item.dispatchEvent('pointermove', {
    pointerId: 35,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: box.x + box.width * 0.45,
    clientY: box.y + box.height / 2,
  });
  await page.waitForFunction(() => document.querySelector('.todo-swipe-shell[data-todo-swipe-id="36"]')?.classList.contains('is-swiping'));
  const openStateSwipe = await page.evaluate(() => {
    const shell = document.querySelector('.todo-swipe-shell[data-todo-swipe-id="36"]');
    const item = shell.querySelector('.todo-item');
    return {
      overflow: getComputedStyle(shell).overflow,
      actionsExpanded: item.classList.contains('actions-expanded'),
      hasOpenMenu: item.classList.contains('has-open-menu'),
      menuOpen: item.querySelector('.todo-status-menu-left').open,
    };
  });
  assert.deepEqual(openStateSwipe, {
    overflow: 'hidden',
    actionsExpanded: false,
    hasOpenMenu: false,
    menuOpen: false,
  }, 'horizontal swipe must close open card actions and restore clipping');
  await item.dispatchEvent('pointercancel', {
    pointerId: 35,
    pointerType: 'touch',
    isPrimary: true,
  });

  await item.dispatchEvent('pointerdown', {
    pointerId: 36,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: box.x + box.width * 0.7,
    clientY: box.y + box.height / 2,
  });
  await item.dispatchEvent('pointermove', {
    pointerId: 36,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: box.x + box.width * 0.45,
    clientY: box.y + box.height / 2,
  });
  await page.waitForFunction(() => {
    const shell = document.querySelector('.todo-swipe-shell[data-todo-swipe-id="36"]');
    const item = shell?.querySelector('.todo-item[data-id="36"]');
    return shell?.classList.contains('is-swiping') && item?.style.getPropertyValue('--swipe-x');
  });

  assert.equal(await shell.evaluate(element => element.classList.contains('is-swiping')), true, 'swipe shell must clip and reveal its semantic underlay');
  const styles = await item.evaluate(element => {
    const current = getComputedStyle(element);
    return {
      backgroundImage: current.backgroundImage,
      boxShadow: current.boxShadow,
      beforeDisplay: getComputedStyle(element, '::before').display,
      afterDisplay: getComputedStyle(element, '::after').display,
      transform: current.transform,
    };
  });
  assert.equal(styles.backgroundImage, 'none', 'moving native card must keep a static background');
  assert.equal(styles.boxShadow, 'none', 'moving native card must not compile dynamic swipe shadows');
  assert.equal(styles.beforeDisplay, 'none', 'legacy swipe pseudo-elements must be disabled natively');
  assert.equal(styles.afterDisplay, 'none', 'legacy swipe pseudo-elements must be disabled natively');
  assert.notEqual(styles.transform, 'none', 'foreground card must still follow the finger');

  const leftGeometry = await page.evaluate(() => {
    const shell = document.querySelector('.todo-swipe-shell[data-todo-swipe-id="36"]');
    const item = shell.querySelector('.todo-item');
    const progress = shell.querySelector('.todo-swipe-action-in-progress');
    const done = shell.querySelector('.todo-swipe-action-done');
    const shellRect = shell.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const progressRect = progress.getBoundingClientRect();
    const doneRect = done.getBoundingClientRect();
    return {
      shellRect,
      itemRect,
      progressRect,
      doneRect,
      progressOpacity: getComputedStyle(progress).opacity,
      doneOpacity: getComputedStyle(done).opacity,
      underlayVisibility: getComputedStyle(shell.querySelector('.todo-swipe-underlay')).visibility,
    };
  });
  assert.ok(leftGeometry.itemRect.right < leftGeometry.shellRect.right, 'left swipe must expose the shell right edge');
  assert.ok(Math.abs(leftGeometry.doneRect.left - leftGeometry.shellRect.left) < 1 && Math.abs(leftGeometry.doneRect.right - leftGeometry.shellRect.right) < 1, 'done action must fill the complete underlay');
  assert.equal(leftGeometry.doneOpacity, '1', 'left swipe must show only the done action');
  assert.equal(leftGeometry.progressOpacity, '0', 'left swipe must hide the in-progress action');
  assert.equal(leftGeometry.underlayVisibility, 'visible', 'active direction must reveal the underlay');

  const doneAction = await shell.locator('.todo-swipe-action-done').evaluate(element => {
    const current = getComputedStyle(element);
    return { backgroundImage: current.backgroundImage, color: current.color };
  });
  assert.notEqual(doneAction.backgroundImage, 'none', 'done action must retain its green semantic surface');
  assert.notEqual(doneAction.color, 'rgba(0, 0, 0, 0)', 'done action label must remain visible');
  if (process.env.NIA_SWIPE_SCREENSHOT) {
    await page.screenshot({ path: process.env.NIA_SWIPE_SCREENSHOT, fullPage: true });
  }

  await item.dispatchEvent('pointercancel', {
    pointerId: 36,
    pointerType: 'touch',
    isPrimary: true,
  });
  assert.equal(await shell.evaluate(element => element.classList.contains('is-swiping')), false, 'cancel must clean up the swipe shell');
  const cleanupState = await shell.evaluate(element => ({
    underlayVisibility: getComputedStyle(element.querySelector('.todo-swipe-underlay')).visibility,
    underlayOpacity: getComputedStyle(element.querySelector('.todo-swipe-underlay')).opacity,
    doneOpacity: getComputedStyle(element.querySelector('.todo-swipe-action-done')).opacity,
    progressOpacity: getComputedStyle(element.querySelector('.todo-swipe-action-in-progress')).opacity,
    itemSwiping: element.querySelector('.todo-item').classList.contains('swiping'),
  }));
  assert.deepEqual(cleanupState, {
    underlayVisibility: 'hidden',
    underlayOpacity: '0',
    doneOpacity: '0',
    progressOpacity: '0',
    itemSwiping: false,
  }, 'cleanup must hide the semantic underlay before restoring the idle card');

  await item.dispatchEvent('pointerdown', {
    pointerId: 37,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: box.x + box.width * 0.35,
    clientY: box.y + box.height / 2,
  });
  await item.dispatchEvent('pointermove', {
    pointerId: 37,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: box.x + box.width * 0.6,
    clientY: box.y + box.height / 2,
  });
  await page.waitForFunction(() => document.querySelector('.todo-swipe-shell[data-todo-swipe-id="36"]')?.classList.contains('swipe-right'));
  assert.equal(await shell.evaluate(element => element.classList.contains('swipe-right')), true, 'right swipe must reveal the in-progress action');
  const rightGeometry = await page.evaluate(() => {
    const shell = document.querySelector('.todo-swipe-shell[data-todo-swipe-id="36"]');
    const item = shell.querySelector('.todo-item');
    const shellRect = shell.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    return { shellRect, itemRect };
  });
  assert.ok(rightGeometry.itemRect.left > rightGeometry.shellRect.left, 'right swipe must expose the shell left edge');
  const progressAction = await shell.locator('.todo-swipe-action-in-progress').evaluate(element => ({
    backgroundImage: getComputedStyle(element).backgroundImage,
    opacity: getComputedStyle(element).opacity,
    doneOpacity: getComputedStyle(element.parentElement.querySelector('.todo-swipe-action-done')).opacity,
  }));
  assert.notEqual(progressAction.backgroundImage, 'none', 'in-progress action must retain its orange semantic surface');
  assert.equal(progressAction.opacity, '1', 'right swipe must show only the in-progress action');
  assert.equal(progressAction.doneOpacity, '0', 'right swipe must hide the done action');
  await item.dispatchEvent('pointercancel', {
    pointerId: 37,
    pointerType: 'touch',
    isPrimary: true,
  });

  await page.evaluate(() => {
    document.documentElement.classList.remove('mobile-swipe-ui', 'native-app');
    document.getElementById('fixture').innerHTML = window.__renderTodoItem(window.__underlayTodo);
  });
  assert.equal(await page.locator('.todo-swipe-shell').count(), 0, 'web clients must retain the existing todo markup');
  assert.equal(await page.locator('#fixture > .todo-item[data-id="36"]').count(), 1, 'web todo card must remain a direct rendered item');

      console.log(`✅ Mobile touch semantic swipe underlay test passed (${browserName})`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}
