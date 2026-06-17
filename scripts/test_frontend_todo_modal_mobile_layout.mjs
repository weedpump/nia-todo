#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function modalMetrics(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('#todo-modal');
    const content = document.querySelector('#todo-modal .todo-modal-content');
    const header = document.querySelector('#todo-modal .todo-modal-header');
    const close = document.querySelector('#todo-modal .modal-close-x');
    const body = document.querySelector('#todo-modal .todo-modal-body');
    const metaSummary = document.querySelector('#todo-meta-summary');
    const metaToggle = document.querySelector('#todo-meta-edit-toggle');
    const drawer = document.querySelector('#todo-meta-drawer');
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const viewportWidth = window.visualViewport?.width || window.innerWidth;
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
    };
    return {
      viewportHeight,
      viewportWidth,
      bodyScrollWidth: document.body.scrollWidth,
      active: modal?.classList.contains('active') || false,
      detailView: modal?.classList.contains('todo-detail-view') || false,
      metaEditing: modal?.classList.contains('todo-meta-editing') || false,
      content: rect(content),
      header: rect(header),
      close: rect(close),
      body: rect(body),
      metaSummary: rect(metaSummary),
      metaToggle: rect(metaToggle),
      drawer: rect(drawer),
      closeVisible: Boolean(close && getComputedStyle(close).display !== 'none' && close.getBoundingClientRect().height > 0),
      metaToggleVisible: Boolean(metaToggle && getComputedStyle(metaToggle).display !== 'none' && metaToggle.getBoundingClientRect().height > 0),
      drawerVisible: Boolean(drawer && getComputedStyle(drawer).display !== 'none' && drawer.getBoundingClientRect().height > 0),
      organizeVisible: Boolean(document.querySelector('#todo-organize-panel')?.getBoundingClientRect().height),
      pinVisible: Boolean(document.querySelector('.todo-pin-row')?.getBoundingClientRect().height),
    };
  });
}

function assertMobileDetailShell(metrics, label) {
  if (!metrics.active) throw new Error(`${label}: todo modal is not active`);
  if (!metrics.detailView) throw new Error(`${label}: todo modal is not using unified detail view`);
  if (!metrics.closeVisible) throw new Error(`${label}: close icon is not visible`);
  if (!metrics.metaToggleVisible) throw new Error(`${label}: details edit action is not visible`);
  if (metrics.bodyScrollWidth > metrics.viewportWidth + 1) {
    throw new Error(`${label}: horizontal body overflow: scrollWidth=${metrics.bodyScrollWidth}, viewportWidth=${metrics.viewportWidth}`);
  }
  if (Math.abs(metrics.content.width - metrics.viewportWidth) > 1) {
    throw new Error(`${label}: mobile modal is not fullscreen width: ${JSON.stringify(metrics.content)}`);
  }
  if (Math.abs(metrics.content.height - metrics.viewportHeight) > 2) {
    throw new Error(`${label}: mobile modal is not dynamic-viewport height: content=${JSON.stringify(metrics.content)}, viewportHeight=${metrics.viewportHeight}`);
  }
  if (metrics.close.top < -1 || metrics.close.right > metrics.viewportWidth + 1) {
    throw new Error(`${label}: close icon moved out of viewport: ${JSON.stringify(metrics.close)}`);
  }
}

function assertMobileMetaDrawer(metrics, label) {
  if (!metrics.metaEditing || !metrics.drawerVisible) throw new Error(`${label}: details drawer did not open`);
  if (!metrics.organizeVisible || !metrics.pinVisible) throw new Error(`${label}: organize/pin controls are not visible in details drawer`);
  if (Math.abs(metrics.drawer.width - metrics.viewportWidth) > 1) {
    throw new Error(`${label}: details drawer is not fullscreen width: ${JSON.stringify(metrics.drawer)}`);
  }
  if (Math.abs(metrics.drawer.height - metrics.viewportHeight) > 2) {
    throw new Error(`${label}: details drawer is not dynamic-viewport height: drawer=${JSON.stringify(metrics.drawer)}, viewportHeight=${metrics.viewportHeight}`);
  }
}

async function run() {
  console.log('📱 Running todo modal mobile layout test...');
  const { browser, page, openTodoModal, loginApp, waitForText, assertNoFrontendErrors } = await launchPage();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginApp();
    await openTodoModal();

    const createShell = await modalMetrics(page);
    assertMobileDetailShell(createShell, 'new todo shell');

    await page.locator('#todo-meta-edit-toggle').click();
    await page.locator('#todo-meta-drawer').waitFor({ state: 'visible', timeout: 5000 });
    const drawerBefore = await modalMetrics(page);
    assertMobileMetaDrawer(drawerBefore, 'new todo details drawer before pin toggle');

    await page.locator('.pin-checkbox-label').click();
    await page.waitForTimeout(120);
    const drawerAfter = await modalMetrics(page);
    assertMobileMetaDrawer(drawerAfter, 'new todo details drawer after pin toggle');

    await page.locator('.todo-meta-drawer-close').click();
    await page.locator('#todo-meta-drawer').waitFor({ state: 'hidden', timeout: 5000 });
    await page.fill('#todo-title', 'Mobile unified todo modal');
    await page.selectOption('#todo-priority', '1', { force: true });
    await page.fill('#todo-due', '2099-03-04T05:06', { force: true });
    await page.click('#todo-modal button[type="submit"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 10000 });

    await waitForText('Mobile unified todo modal');
    await page.locator('.todo-item').filter({ hasText: 'Mobile unified todo modal' }).first().click();
    await page.locator('#todo-modal').waitFor({ state: 'visible', timeout: 5000 });
    const existingShell = await modalMetrics(page);
    assertMobileDetailShell(existingShell, 'existing todo shell');

    assertNoFrontendErrors();
    console.log('✅ Todo modal mobile layout test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);
