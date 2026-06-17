#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

function assertCloseEnough(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label} changed too much: before=${expected}, after=${actual}, tolerance=${tolerance}`);
  }
}

async function modalMetrics(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('#todo-modal');
    const content = document.querySelector('#todo-modal .todo-modal-content');
    const header = document.querySelector('#todo-modal .todo-modal-header');
    const close = document.querySelector('#todo-modal .modal-close-x');
    const body = document.querySelector('#todo-modal .todo-modal-body');
    const footer = document.querySelector('#todo-modal .todo-modal-actions');
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const viewportWidth = window.visualViewport?.width || window.innerWidth;
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
    };
    const sectionSelect = document.querySelector('.ui-select[data-select-id="todo-section"] .ui-select-trigger') || document.querySelector('#todo-section');
    const pinRow = document.querySelector('.todo-pin-row');
    return {
      viewportHeight,
      viewportWidth,
      bodyScrollWidth: document.body.scrollWidth,
      active: modal?.classList.contains('active') || false,
      content: rect(content),
      header: rect(header),
      close: rect(close),
      body: rect(body),
      footer: rect(footer),
      sectionSelect: rect(sectionSelect),
      pinRow: rect(pinRow),
      closeVisible: Boolean(close && getComputedStyle(close).display !== 'none' && close.getBoundingClientRect().height > 0),
    };
  });
}

function assertMobileTodoModalLayout(metrics, label) {
  if (!metrics.active) throw new Error(`${label}: todo modal is not active`);
  if (!metrics.closeVisible) throw new Error(`${label}: close icon is not visible`);
  if (metrics.close.top < -1 || metrics.close.right > metrics.viewportWidth + 1) {
    throw new Error(`${label}: close icon moved out of viewport: ${JSON.stringify(metrics.close)}`);
  }
  if (metrics.footer.bottom < metrics.viewportHeight - 2 || metrics.footer.bottom > metrics.viewportHeight + 2) {
    throw new Error(`${label}: footer is not anchored to bottom: footer=${JSON.stringify(metrics.footer)}, viewportHeight=${metrics.viewportHeight}`);
  }
  if (metrics.body.height < 120) {
    throw new Error(`${label}: modal body collapsed: ${JSON.stringify(metrics.body)}`);
  }
  if (metrics.bodyScrollWidth > metrics.viewportWidth + 1) {
    throw new Error(`${label}: horizontal body overflow: scrollWidth=${metrics.bodyScrollWidth}, viewportWidth=${metrics.viewportWidth}`);
  }
  const pinGap = metrics.pinRow.top - metrics.sectionSelect.bottom;
  if (pinGap < 8 || pinGap > 20) {
    throw new Error(`${label}: pin section spacing is inconsistent: gap=${pinGap}`);
  }
}

async function run() {
  console.log('📱 Running todo modal mobile pin layout test...');
  const { browser, page, openTodoModal, loginApp, waitForText, assertNoFrontendErrors } = await launchPage();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginApp();
    await openTodoModal();
    await page.click('#todo-organize-panel > summary');

    const before = await modalMetrics(page);
    assertMobileTodoModalLayout(before, 'before pin toggle');

    await page.locator('.pin-checkbox-label').click();
    await page.waitForTimeout(120);

    const after = await modalMetrics(page);
    assertMobileTodoModalLayout(after, 'after pin toggle');
    assertCloseEnough(after.header.top, before.header.top, 1, 'header top');
    assertCloseEnough(after.footer.bottom, before.footer.bottom, 1, 'footer bottom');
    assertCloseEnough(after.content.height, before.content.height, 1, 'modal content height');

    await page.fill('#todo-title', 'Mobile collapsed metadata panels');
    await page.selectOption('#todo-priority', '1', { force: true });
    await page.click('#todo-schedule-panel > summary');
    await page.fill('#todo-due', '2099-03-04T05:06', { force: true });
    await page.click('#todo-modal button[type="submit"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 10000 });
    await waitForText('Mobile collapsed metadata panels');
    await page.locator('.todo-item').filter({ hasText: 'Mobile collapsed metadata panels' }).first().click();
    await page.locator('#todo-modal').waitFor({ state: 'visible', timeout: 5000 });
    const mobileMetadataPanels = await page.evaluate(() => ({
      organize: document.querySelector('#todo-organize-panel')?.open,
      schedule: document.querySelector('#todo-schedule-panel')?.open,
    }));
    if (mobileMetadataPanels.organize || mobileMetadataPanels.schedule) {
      throw new Error(`Expected metadata panels to stay collapsed on mobile even with values: ${JSON.stringify(mobileMetadataPanels)}`);
    }

    assertNoFrontendErrors();
    console.log('✅ Todo modal mobile pin layout test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);
