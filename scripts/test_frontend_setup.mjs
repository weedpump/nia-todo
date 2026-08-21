#!/usr/bin/env node
import { backupDb, restoreDb, service, waitForService, launchPage, ADMIN_PASSWORD, BASE_URL } from './frontend_test_lib.mjs';

async function run() {
  console.log('🌐 Running Playwright frontend setup test...');
  backupDb();
  let browser;
  try {
    service('restart');
    await waitForService();

    const launched = await launchPage();
    browser = launched.browser;
    const { page, visible } = launched;
    await page.addInitScript(() => localStorage.setItem('nia-todo-language', 'de'));

    await page.setViewportSize({ width: 390, height: 640 });
    await page.goto(`${BASE_URL}/setup`, { waitUntil: 'networkidle' });
    await visible('#step-1');

    await page.fill('#admin-password', 'short');
    await page.fill('#admin-password-confirm', 'short');
    await page.click('button.setup-btn');
    await page.getByText('Passwort muss mindestens 12 Zeichen haben').waitFor({ state: 'visible' });

    await page.fill('#admin-password', ADMIN_PASSWORD);
    await page.fill('#admin-password-confirm', ADMIN_PASSWORD);
    await page.click('button.setup-btn');
    await visible('#step-2');
    const canScrollSetup = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight);
    if (!canScrollSetup) throw new Error('Mobile setup page should be scrollable when first-user form exceeds viewport');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.locator('text=Installation abschließen').waitFor({ state: 'visible' });

    await page.fill('#first-username', 'setupuser');
    await page.fill('#first-display-name', 'Setup User');
    await page.fill('#first-email', 'broken-email');
    await page.fill('#first-password', 'SetupUser123!');
    await page.click('text=Installation abschließen');
    await page.getByText('Bitte eine gültige E-Mail-Adresse eingeben').waitFor({ state: 'visible' });

    await page.fill('#first-email', 'setupuser@example.invalid');
    await page.fill('#first-password', 'SetupUser123!');
    await page.click('text=Installation abschließen');
    await visible('#step-success', 10000);

    console.log('✅ Frontend setup test passed');
  } finally {
    if (browser) await browser.close();
    restoreDb();
    await waitForService().catch(() => {});
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
