#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function run() {
  console.log('📐 Running frontend user-menu alignment test...');
  const { browser, page, loginApp, visible, assertNoFrontendErrors } = await launchPage();

  try {
    await loginApp();
    await visible('#sidebar');
    await page.click('#user-menu-button');
    await page.locator('#user-menu.active').waitFor({ state: 'visible', timeout: 5000 });

    const metrics = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#user-menu .user-menu-item')).map((item) => {
        const icon = item.querySelector('span:first-child');
        const label = item.querySelector('span:nth-child(2)');
        const iconRect = icon.getBoundingClientRect();
        const labelRect = label.getBoundingClientRect();
        return {
          text: item.textContent.trim(),
          iconLeft: Math.round(iconRect.left),
          iconCenter: Math.round(iconRect.left + iconRect.width / 2),
          iconWidth: Math.round(iconRect.width),
          labelLeft: Math.round(labelRect.left),
        };
      });
    });

    if (metrics.length < 4) throw new Error(`Expected menu items, got ${JSON.stringify(metrics)}`);
    const first = metrics[0];
    const misaligned = metrics.filter(row =>
      Math.abs(row.iconLeft - first.iconLeft) > 1 ||
      Math.abs(row.iconCenter - first.iconCenter) > 1 ||
      Math.abs(row.labelLeft - first.labelLeft) > 1 ||
      row.iconWidth !== 24
    );
    if (misaligned.length) {
      throw new Error(`User menu rows are misaligned:\n${JSON.stringify(metrics, null, 2)}`);
    }

    assertNoFrontendErrors();
    console.log('✅ Frontend user-menu alignment test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);
