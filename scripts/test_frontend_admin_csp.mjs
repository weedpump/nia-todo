#!/usr/bin/env node
import { withFreshDb, launchPage, BASE_URL, ADMIN_PASSWORD } from './frontend_test_lib.mjs';

await withFreshDb(async () => {
  const { browser, page, dumpErrors } = await launchPage();
  try {
    await page.goto(`${BASE_URL}/admin`, { waitUntil: 'networkidle' });
    await page.fill('#admin-login-password', ADMIN_PASSWORD);
    await page.locator('#admin-login-form button[type="submit"]').click();
    await page.locator('#admin-content').waitFor({ state: 'visible', timeout: 15_000 });

    await page.locator('[data-admin-action="openAdminPasswordDialog"]').click();
    await page.locator('#admin-password-dialog.active').waitFor({ state: 'visible' });
    await page.locator('#admin-password-dialog-cancel').click();

    await page.locator('[data-admin-action="setStatsPeriod"][data-admin-value="7"]').click();
    await page.evaluate(() => {
      const search = document.getElementById('user-search');
      search.value = 'frontend';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector('[data-admin-action="editUserUsername"]'));
    await page.locator('[data-admin-action="editUserUsername"]').first().evaluate(el => el.click());
    await page.locator('[data-admin-enter-action="saveUserUsername"]').first().waitFor({ state: 'attached' });

    const errors = dumpErrors();
    if (errors.pageErrors.length || errors.consoleErrors.length) {
      throw new Error(`Admin page errors: ${JSON.stringify(errors)}`);
    }
    console.log('✅ Admin CSP delegated-action regression passed');
  } finally {
    await browser.close();
  }
});
