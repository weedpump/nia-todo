#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function waitForTodo(page, title) {
  await page.waitForFunction((value) => document.body.innerText.includes(value), title, { timeout: 10000 });
}

async function run() {
  console.log('📱 Running todo action menu viewport flip test...');
  const { browser, page, openTodoModal, loginApp, assertNoFrontendErrors } = await launchPage();
  const title = 'Single Todo Menu Flip';

  try {
    await page.setViewportSize({ width: 390, height: 360 });
    await loginApp();

    await openTodoModal();
    await page.fill('#todo-title', title);
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await waitForTodo(page, title);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const item = page.locator('.todo-item').filter({ hasText: title }).last();
    await item.waitFor({ state: 'visible', timeout: 5000 });
    await item.locator('.todo-snooze-menu summary').click();
    await item.locator('.todo-snooze-menu[open]').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('.todo-snooze-menu[open] .todo-action-menu')?.getBoundingClientRect().height > 0, null, { timeout: 5000 });
    await page.waitForTimeout(80);

    const placement = await item.locator('.todo-snooze-menu').evaluate((menu) => {
      const summary = menu.querySelector('summary');
      const panel = menu.querySelector('.todo-action-menu');
      const summaryRect = summary.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      return {
        opensUp: menu.classList.contains('opens-up'),
        wouldOverflowDown: summaryRect.bottom + panelRect.height + 8 > viewportHeight,
        panelTop: panelRect.top,
        panelBottom: panelRect.bottom,
        viewportHeight,
      };
    });

    if (placement.wouldOverflowDown && !placement.opensUp) {
      throw new Error(`Snooze menu should flip upward near viewport bottom: ${JSON.stringify(placement)}`);
    }
    if (placement.opensUp && placement.panelTop < 0) {
      throw new Error(`Flipped snooze menu must stay visible above the trigger: ${JSON.stringify(placement)}`);
    }
    if (placement.panelBottom > placement.viewportHeight - 1) {
      throw new Error(`Snooze menu should not be clipped by viewport bottom: ${JSON.stringify(placement)}`);
    }

    assertNoFrontendErrors();
    console.log('✅ Todo action menu viewport flip test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);
