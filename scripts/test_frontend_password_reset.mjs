#!/usr/bin/env node
import { withFreshDb, launchPage, BASE_URL } from './frontend_test_lib.mjs';

async function run() {
  console.log('🔐 Running Playwright password reset visibility test...');
  const { browser, page, assertNoFrontendErrors } = await launchPage();

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#login-forgot-btn').waitFor({ state: 'hidden', timeout: 10000 });
    await page.locator('#login-reset-panel').waitFor({ state: 'hidden', timeout: 5000 });
    assertNoFrontendErrors();
    console.log('✅ Password reset hidden without SMTP config');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);
