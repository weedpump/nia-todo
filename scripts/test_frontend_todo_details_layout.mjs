#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)), 'web');
const MIME = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
]);

const fixture = `<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <link rel="stylesheet" href="/static/style.css">
  <style>
    body { margin: 0; }
    .modal { display: flex !important; }
    .todo-desc-rich-wrap { display: block !important; margin-top: 720px !important; }
    .todo-editor-main { min-height: 1200px; }
  </style>
</head>
<body>
  <div class="modal ui-detail-modal todo-detail-view todo-desc-editing todo-meta-editing active" id="todo-modal">
    <div class="modal-overlay"></div>
    <div class="modal-content todo-modal-content ui-detail-modal-content">
      <div class="todo-modal-header ui-detail-modal-header">
        <div><h3>Edit todo</h3></div>
        <div class="todo-detail-header-actions ui-detail-header-actions"><button class="modal-close-x" data-close-modal="todo-modal">Todo close</button></div>
      </div>
      <div class="modal-body todo-modal-body ui-detail-modal-body">
        <form class="todo-modal-form todo-editor-shell ui-detail-shell">
          <section class="ui-section-card ui-detail-section ui-detail-title-section todo-section-card todo-editor-section todo-editor-main todo-main-section">
            <div class="todo-desc-rich-wrap todo-rich-keyboard-wrap" id="todo-desc-rich-wrap">
              <div class="todo-desc-rich-toolbar">
                <button>B</button><button><i>I</i></button><button><u>U</u></button><button>H1</button>
                <button>H2</button><button>Quote</button><button>Code</button><button>• List</button>
              </div>
              <div class="todo-desc-rich-editor" contenteditable="true">Description content</div>
            </div>
          </section>
          <aside class="todo-meta-edit-drawer">
            <div class="todo-meta-drawer-header"><h4>Edit details</h4><button type="button" class="todo-meta-drawer-close">Details close</button></div>
            <div class="todo-meta-drawer-body">
              <section class="ui-section-card ui-detail-section todo-section-card todo-editor-section todo-editor-meta-panel" id="todo-organize-panel">
                <div style="height: 650px">Organize</div>
                <label class="pin-checkbox-label"><input type="checkbox"><span class="pin-checkbox-box"></span><span>Pinned at top</span></label>
              </section>
              <section class="ui-section-card ui-detail-section todo-section-card todo-editor-section todo-editor-meta-panel" id="todo-schedule-panel">
                <div class="ui-section-heading ui-detail-section-heading"><div><h4>Planning</h4><p>Deadline and reminder.</p></div></div>
                <div class="ui-field-grid two-columns"><div class="form-group"><label>Deadline</label><input class="ui-field" id="todo-due"></div></div>
              </section>
            </div>
          </aside>
        </form>
      </div>
    </div>
  </div>
</body>
</html>`;

function startServer() {
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/fixture') {
        response.writeHead(200, { 'Content-Type': MIME.get('.html') });
        response.end(fixture);
        return;
      }
      const pathname = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname);
      const relativePath = normalize(pathname).replace(/^([/\\])+/, '');
      const filePath = join(ROOT, relativePath);
      if (filePath !== ROOT && !filePath.startsWith(`${ROOT}/`)) throw new Error('Invalid fixture path');
      const content = await readFile(filePath);
      response.writeHead(200, { 'Content-Type': MIME.get(extname(filePath)) || 'application/octet-stream' });
      response.end(content);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const server = await startServer();
const address = server.address();
let browser;
const viewports = [
  { width: 360, height: 780, label: 'narrow Android' },
  { width: 390, height: 844, label: 'common Android' },
  { width: 720, height: 900, label: 'mobile grid boundary' },
  { width: 721, height: 900, label: 'above mobile grid boundary' },
  { width: 1024, height: 1366, label: 'iPad portrait' },
  { width: 1180, height: 900, label: 'fullscreen drawer boundary' },
  { width: 1181, height: 900, label: 'desktop drawer boundary' },
];

try {
  browser = await chromium.launch({ headless: true });
  for (const viewport of viewports) {
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 2,
      isMobile: viewport.width <= 720,
      hasTouch: viewport.width <= 720,
    });
    await page.goto(`http://127.0.0.1:${address.port}/fixture`, { waitUntil: 'networkidle' });
    await page.locator('.ui-detail-modal-body').evaluate(element => { element.scrollTop = 150; });
    await page.locator('.todo-meta-drawer-body').evaluate(element => { element.scrollTop = element.scrollHeight; });

    const result = await page.evaluate(() => {
      const stackingResult = () => {
        const toolbar = document.querySelector('.todo-desc-rich-toolbar');
        const drawer = document.querySelector('.todo-meta-edit-drawer');
        const toolbarRect = toolbar.getBoundingClientRect();
        const drawerRect = drawer.getBoundingClientRect();
        const overlapLeft = Math.max(toolbarRect.left, drawerRect.left);
        const overlapRight = Math.min(toolbarRect.right, drawerRect.right);
        const overlapTop = Math.max(toolbarRect.top, drawerRect.top);
        const overlapBottom = Math.min(toolbarRect.bottom, drawerRect.bottom);
        const point = {
          x: overlapLeft + Math.max(1, (overlapRight - overlapLeft) / 2),
          y: overlapTop + Math.max(1, (overlapBottom - overlapTop) / 2),
        };
        const topElement = document.elementFromPoint(point.x, point.y);
        return {
          intersects: overlapRight > overlapLeft && overlapBottom > overlapTop,
          drawerOwnsOverlap: Boolean(topElement?.closest('.todo-meta-edit-drawer')),
          topElement: topElement?.className || topElement?.tagName || null,
        };
      };
      const modalContent = document.querySelector('.todo-modal-content');
      const modalBody = document.querySelector('.todo-modal-body');
      const drawer = document.querySelector('.todo-meta-edit-drawer');
      const detailsClose = document.querySelector('.todo-meta-drawer-close');
      const pinControl = document.querySelector('.pin-checkbox-label');
      const contentRect = modalContent.getBoundingClientRect();
      const drawerRect = drawer.getBoundingClientRect();
      const closeRect = detailsClose.getBoundingClientRect();
      const closeTarget = document.elementFromPoint(closeRect.left + closeRect.width / 2, closeRect.top + closeRect.height / 2);
      return {
        stacking: stackingResult(),
        fullscreenDrawer: {
          drawerPosition: getComputedStyle(drawer).position,
          bodyOverflowY: getComputedStyle(modalBody).overflowY,
          fillsModal: Math.abs(drawerRect.top - contentRect.top) <= 1
            && Math.abs(drawerRect.bottom - contentRect.bottom) <= 1,
          detailsCloseOwnsHit: Boolean(closeTarget?.closest('.todo-meta-drawer-close')),
        },
        pinControlRadius: getComputedStyle(pinControl).borderRadius,
        pinControlBorderWidth: getComputedStyle(pinControl).borderTopWidth,
      };
    });

    const keyboardFixedResult = await page.evaluate(() => {
      const toolbar = document.querySelector('.todo-desc-rich-toolbar');
      toolbar.classList.add('is-keyboard-fixed');
      toolbar.style.setProperty('--todo-rich-toolbar-left', '0px');
      toolbar.style.setProperty('--todo-rich-toolbar-width', `${window.innerWidth}px`);
      toolbar.style.setProperty('--todo-rich-toolbar-top', '150px');
      document.body.appendChild(toolbar);
      const drawer = document.querySelector('.todo-meta-edit-drawer');
      const toolbarRect = toolbar.getBoundingClientRect();
      const drawerRect = drawer.getBoundingClientRect();
      const overlapLeft = Math.max(toolbarRect.left, drawerRect.left);
      const overlapRight = Math.min(toolbarRect.right, drawerRect.right);
      const overlapTop = Math.max(toolbarRect.top, drawerRect.top);
      const overlapBottom = Math.min(toolbarRect.bottom, drawerRect.bottom);
      const point = {
        x: overlapLeft + Math.max(1, (overlapRight - overlapLeft) / 2),
        y: overlapTop + Math.max(1, (overlapBottom - overlapTop) / 2),
      };
      const topElement = document.elementFromPoint(point.x, point.y);
      return {
        intersects: overlapRight > overlapLeft && overlapBottom > overlapTop,
        drawerOwnsOverlap: Boolean(topElement?.closest('.todo-meta-edit-drawer')),
        topElement: topElement?.className || topElement?.tagName || null,
      };
    });

    await page.close();
    if (!result.stacking.intersects) {
      console.log(`✓ Toolbar and details drawer do not collide at ${viewport.width}×${viewport.height}`);
    } else if (!result.stacking.drawerOwnsOverlap) {
      throw new Error(`Rich text toolbar overlaps the details drawer at ${viewport.label} width (top element: ${result.stacking.topElement})`);
    } else {
      console.log(`✓ Details drawer covers the rich text toolbar at ${viewport.width}×${viewport.height}`);
    }
    if (viewport.width <= 1180) {
      if (result.fullscreenDrawer.drawerPosition !== 'absolute') throw new Error(`Fullscreen details drawer is not anchored to the modal shell at ${viewport.label}`);
      if (result.fullscreenDrawer.bodyOverflowY !== 'visible') throw new Error(`Todo body still clips the fullscreen details drawer at ${viewport.label}`);
      if (!result.fullscreenDrawer.fillsModal) throw new Error(`Fullscreen details drawer does not fill the modal shell at ${viewport.label}`);
      if (!result.fullscreenDrawer.detailsCloseOwnsHit) throw new Error(`Todo close control wins the details close hit target at ${viewport.label}`);
      console.log(`✓ Fullscreen details header owns its close target at ${viewport.width}×${viewport.height}`);
    }
    if (result.pinControlRadius !== '999px') throw new Error(`Pinned-at-top control is not pill-shaped at ${viewport.label}: ${result.pinControlRadius}`);
    if (result.pinControlBorderWidth !== '0px') throw new Error(`Pinned-at-top control still has an outer border at ${viewport.label}: ${result.pinControlBorderWidth}`);
    if (!keyboardFixedResult.intersects) throw new Error(`Fixture error at ${viewport.label}: fixed keyboard toolbar and details drawer do not intersect`);
    if (!keyboardFixedResult.drawerOwnsOverlap) {
      throw new Error(`Fixed keyboard toolbar overlaps the details drawer at ${viewport.label} width (top element: ${keyboardFixedResult.topElement})`);
    }
    console.log(`✓ Details drawer covers the fixed keyboard toolbar at ${viewport.width}×${viewport.height}`);
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
