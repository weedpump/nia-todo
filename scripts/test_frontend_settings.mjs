#!/usr/bin/env node
import { withFreshDb, launchPage, USER_PASSWORD } from './frontend_test_lib.mjs';

async function run() {
  console.log('🌐 Running Playwright frontend settings test...');
  const { browser, page, visible, loginApp, assertNoFrontendErrors } = await launchPage();

  try {
    await loginApp();

    await page.click('button[title="Einstellungen"]');
    await visible('#settings-modal');
    await page.locator('#settings-user-name').waitFor({ state: 'visible' });

    await page.fill('#settings-old-password', USER_PASSWORD);
    await page.fill('#settings-new-password', 'FrontendChanged123!');
    await page.fill('#settings-confirm-password', 'FrontendChanged123!');
    await page.locator('#settings-modal button.btn-primary').filter({ hasText: 'Passwort ändern' }).click();
    await page.getByText('Passwort geändert! Du wirst abgemeldet...').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10000 });

    assertNoFrontendErrors();
    console.log('✅ Frontend settings test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);
