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
  await page.addInitScript(() => localStorage.setItem('nia-todo-language', 'de'));

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('.login-box .login-update-refresh').waitFor({ state: 'detached', timeout: 10000 });
    await page.getByText('Anmeldeproblem? App neu laden').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#login-overlay > .login-update-refresh').waitFor({ state: 'visible', timeout: 10000 });
    const updateModalZIndex = await page.locator('#web-update-modal').evaluate(el => getComputedStyle(el).zIndex);
    const loginOverlayZIndex = await page.locator('#login-overlay').evaluate(el => getComputedStyle(el).zIndex);
    if (Number(updateModalZIndex) <= Number(loginOverlayZIndex)) {
      throw new Error(`Web update modal must appear above login overlay: modal=${updateModalZIndex}, login=${loginOverlayZIndex}`);
    }
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
    await page.getByText('Bitte kontaktiere einen Admin für einen neuen Link.').waitFor({ state: 'visible', timeout: 10000 });
    const resendVisible = await page.locator('#resend-box').isVisible().catch(() => false);
    if (resendVisible) throw new Error('Public expired-link resend must stay hidden without SMTP');

    assertNoFrontendErrors();
    console.log('✅ Password reset hidden without SMTP + expired setup resend UI passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);
