#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { withFreshDb, launchPage, BASE_URL, DB_PATH, ADMIN_PASSWORD } from './frontend_test_lib.mjs';

function expireSetupTokenForUser(username) {
  execFileSync('python3', ['-c', `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)})
conn.execute("""
UPDATE password_setup_tokens
SET expires_at = datetime('now', '-1 hour')
WHERE user_id = (SELECT id FROM users WHERE username = ?)
  AND status = 'active'
  AND used_at IS NULL
""", (${JSON.stringify(username)},))
conn.commit()
conn.close()
`], { stdio: 'pipe' });
}

async function run() {
  console.log('🔐 Running Playwright password reset/expired link test...');
  const { browser, page, assertNoFrontendErrors } = await launchPage();

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#login-forgot-btn').waitFor({ state: 'hidden', timeout: 10000 });
    await page.locator('#login-reset-panel').waitFor({ state: 'hidden', timeout: 5000 });

    const adminLogin = await page.evaluate(async (password) => {
      const r = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        credentials: 'include'
      });
      return await r.json();
    }, ADMIN_PASSWORD);
    if (!adminLogin.access_token) throw new Error('Admin login failed for expired link test');

    const createdUser = await page.evaluate(async ({ jwt, csrf }) => {
      const r = await fetch('/api/admin/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
          'X-CSRF-Token': csrf
        },
        body: JSON.stringify({ username: 'expiredfrontend', display_name: 'Expired Frontend', email: 'expiredfrontend@example.invalid' }),
        credentials: 'include'
      });
      return await r.json();
    }, { jwt: adminLogin.access_token, csrf: adminLogin.csrf_token });
    if (!createdUser.password_setup_url) throw new Error('Expected manual password setup URL without SMTP');

    expireSetupTokenForUser('expiredfrontend');
    await page.goto(createdUser.password_setup_url, { waitUntil: 'domcontentloaded' });
    await page.getByText('dieser Link ist abgelaufen').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByRole('button', { name: 'Neuen Link anfordern' }).click();
    await page.getByText('Neuer Link wurde erstellt.').waitFor({ state: 'visible', timeout: 10000 });
    const replacementLink = await page.locator('#resend-link-input').inputValue();
    if (!replacementLink.includes('/set-password?token=')) throw new Error('Replacement setup link missing');

    await page.goto(replacementLink, { waitUntil: 'domcontentloaded' });
    await page.getByText('bitte lege dein Passwort fest').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#password-form').waitFor({ state: 'visible', timeout: 10000 });

    assertNoFrontendErrors();
    console.log('✅ Password reset hidden without SMTP + expired setup resend UI passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);
