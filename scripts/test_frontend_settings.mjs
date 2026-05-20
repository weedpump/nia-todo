#!/usr/bin/env node
import { withFreshDb, launchPage, USER_PASSWORD } from './frontend_test_lib.mjs';

async function run() {
  console.log('🌐 Running Playwright frontend settings test...');
  const { browser, page, visible, loginApp, assertNoFrontendErrors } = await launchPage();

  try {
    await loginApp();

    await page.evaluate(() => {
      window.Notification = {
        permission: 'granted',
        requestPermission: async () => 'granted',
      };

      const fakeSubscription = {
        endpoint: 'https://push.example.test/sub/123',
        getKey(kind) {
          const value = kind === 'p256dh' ? 'p256dh-key' : 'auth-key';
          return new TextEncoder().encode(value);
        },
        unsubscribe: async () => true,
      };

      const fakePushManager = {
        current: fakeSubscription,
        async getSubscription() {
          return this.current;
        },
        async subscribe() {
          this.current = fakeSubscription;
          return fakeSubscription;
        },
      };

      const fakeRegistration = { pushManager: fakePushManager };
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: { ready: Promise.resolve(fakeRegistration) },
      });
      Object.defineProperty(window, 'PushManager', {
        configurable: true,
        value: function PushManager() {},
      });
    });

    await page.click('button[title="Einstellungen"]');
    await visible('#settings-modal');
    await page.locator('#settings-user-name').waitFor({ state: 'visible' });

    await page.evaluate(() => {
      window.updatePushStatus('granted');
      document.getElementById('push-disable-btn').style.display = 'inline-block';
      document.getElementById('push-test-btn').style.display = 'inline-block';
    });
    await page.locator('#push-disable-btn').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#push-test-btn').waitFor({ state: 'visible', timeout: 10000 });

    await page.evaluate(() => {
      window.prompt = () => 'Frontend Test Key';
    });
    await page.click('text=Neuen API-Key erstellen');
    await page.locator('#api-key-created').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('api-key-value')?.textContent?.trim().length > 0, { timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('api-keys-list')?.innerText?.includes('Frontend Test Key'), { timeout: 10000 });

    await page.click('#push-test-btn');
    await page.waitForFunction(() => document.getElementById('push-error')?.textContent?.includes('Test-Benachrichtigung gesendet!'), { timeout: 10000 });

    await page.evaluate(() => {
      window.confirm = () => true;
    });
    await page.locator('#api-keys-list .btn.btn-danger').first().click();
    await page.waitForFunction(() => document.getElementById('api-keys-list')?.innerText?.includes('widerrufen') || document.getElementById('api-keys-list')?.innerText?.includes('Keine API-Keys vorhanden'), { timeout: 10000 });

    await page.click('#push-disable-btn');
    await page.waitForFunction(() => document.getElementById('push-error')?.textContent?.includes('deaktiviert'), { timeout: 10000 });

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
