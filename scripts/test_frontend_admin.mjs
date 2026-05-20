#!/usr/bin/env node
import { withFreshDb, launchPage, ADMIN_PASSWORD } from './frontend_test_lib.mjs';

async function run() {
  console.log('🌐 Running Playwright frontend admin test...');
  const { browser, page } = await launchPage();

  try {
    await page.goto('http://localhost:8754/admin', { waitUntil: 'networkidle' });
    await page.locator('#admin-login-card').waitFor({ state: 'visible', timeout: 5000 });

    await page.fill('#admin-login-password', 'wrong');
    await page.click('text=Anmelden');
    await page.getByText('Falsches Admin-Passwort').waitFor({ state: 'visible' });

    await page.fill('#admin-login-password', ADMIN_PASSWORD);
    await page.click('text=Anmelden');
    await page.locator('#admin-content').waitFor({ state: 'visible', timeout: 10000 });

    await page.fill('#new-username', 'admincreated');
    await page.fill('#new-display-name', 'Admin Created');
    await page.fill('#new-password', 'AdminCreated123!');
    await page.locator('#create-user-card button.btn-primary').click();
    await page.getByText("Benutzer 'admincreated' erstellt!").waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#user-list').getByText('admincreated').waitFor({ state: 'visible', timeout: 10000 });

    await page.fill('#admin-old-password', ADMIN_PASSWORD);
    await page.fill('#admin-new-password', 'NewFrontendAdmin123!');
    await page.fill('#admin-confirm-password', 'NewFrontendAdmin123!');
    await page.locator('#admin-password-card button.btn-primary').click();
    await page.getByText('Admin-Passwort geändert! Melde dich erneut an.').waitFor({ state: 'visible', timeout: 10000 });

    console.log('✅ Frontend admin test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);
