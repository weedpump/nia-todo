#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { withFreshDb, launchPage, USERNAME, USER_PASSWORD, DB_PATH, BASE_URL } from './frontend_test_lib.mjs';

const SECRET = 'JBSWY3DPEHPK3PXP';

function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of value.replace(/=+$/g, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret) {
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

async function run() {
  execFileSync('python3', ['-c', `import sqlite3\ndb=sqlite3.connect(${JSON.stringify(DB_PATH)})\ndb.execute("UPDATE users SET two_factor_enabled=1, two_factor_totp_secret=? WHERE username=?", (${JSON.stringify(SECRET)}, ${JSON.stringify(USERNAME)}))\ndb.commit()\ndb.close()`]);
  const { browser, page, visible, dumpErrors } = await launchPage();
  let dialogs = 0;
  page.on('dialog', dialog => { dialogs += 1; dialog.dismiss().catch(() => {}); });
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await visible('#login-overlay', 10000);
    await page.fill('#login-username', USERNAME);
    await page.fill('#login-password', USER_PASSWORD);
    await page.click('button.login-btn');
    await visible('#login-mfa-panel', 10000);
    if (dialogs) throw new Error(`Unexpected login dialog count: ${dialogs}`);
    await page.fill('#login-mfa-code', totp(SECRET));
    await page.check('#login-remember-device');
    await page.click('button.login-btn');
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 15000 });

    await page.evaluate(() => {
      window.Notification = { permission: 'default', requestPermission: async () => 'default' };
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve({ pushManager: { getSubscription: async () => null } }) } });
      Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
    });

    await page.click('#user-menu-button');
    await page.click('#menu-settings-btn');
    await visible('#settings-modal', 10000);
    await page.waitForFunction(() => (document.getElementById('settings-2fa-status')?.textContent || '').includes('Status: aktiv'), null, { timeout: 10000 });
    await page.waitForFunction(() => {
      const text = document.body.innerText;
      return !text.includes('2FA-Status fehlgeschlagen') && !text.includes('API-Key-Liste fehlgeschlagen');
    }, null, { timeout: 10000 });

    await page.evaluate((reauthCode) => {
      const answers = ['MFA Login Test Key', reauthCode];
      window.prompt = () => answers.shift() || '';
    }, totp(SECRET));
    await page.click('text=Neuen API-Key erstellen');
    await page.locator('#api-key-created').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('api-key-value')?.textContent?.trim().length > 0, null, { timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('api-keys-list')?.innerText?.includes('MFA Login Test Key'), null, { timeout: 10000 });

    const errors = dumpErrors();
    const consoleErrors = errors.consoleErrors.filter(msg => !msg.includes('the server responded with a status of 403'));
    if (errors.pageErrors.length || consoleErrors.length) {
      throw new Error(`Frontend emitted errors: ${JSON.stringify({ pageErrors: errors.pageErrors, consoleErrors })}`);
    }
    console.log('✅ MFA login/settings smoke passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);
