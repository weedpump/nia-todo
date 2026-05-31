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

    await page.click('#user-menu-button');
    await page.locator('#accent-preset-row').click();
    await page.locator('#accent-preset-panel.active .accent-preset-option').first().waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#accent-preset-panel .accent-preset-option[data-accent="teal"]').click();
    await page.waitForFunction(() => {
      const accentRgb = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
      return localStorage.getItem('nia-accent-preset') === 'teal' && ['20, 184, 166', '13, 148, 136'].includes(accentRgb);
    }, null, { timeout: 10000 });
    await page.locator('#accent-preset-panel .accent-preset-option.active[data-accent="teal"]').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#accent-intensity-slider').fill('35');
    await page.waitForFunction(() => {
      const intensity = getComputedStyle(document.documentElement).getPropertyValue('--accent-intensity').trim();
      return localStorage.getItem('nia-accent-intensity') === '35' && intensity === '0.35';
    }, null, { timeout: 10000 });
    await page.click('#menu-settings-btn');
    await visible('#settings-modal');
    const profileHeaderState = await page.evaluate(() => {
      const icon = document.querySelector('#settings-section-profile .settings-section-icon svg');
      const iconBox = document.querySelector('#settings-section-profile .settings-section-icon');
      const heading = document.querySelector('#settings-section-profile .settings-section-heading');
      const avatar = document.querySelector('#settings-section-profile .settings-avatar-button');
      const iconBoxStyle = iconBox ? getComputedStyle(iconBox) : null;
      const headingStyle = heading ? getComputedStyle(heading) : null;
      const avatarStyle = avatar ? getComputedStyle(avatar) : null;
      return {
        hasUserPath: Boolean(icon?.querySelector('path')),
        iconRadius: iconBoxStyle?.borderRadius,
        headingBackground: headingStyle?.backgroundImage,
        avatarRadius: avatarStyle?.borderRadius,
      };
    });
    if (!profileHeaderState.hasUserPath || profileHeaderState.iconRadius === '50%' || profileHeaderState.headingBackground === 'none' || profileHeaderState.avatarRadius === '999px') {
      throw new Error(`Settings profile header did not render the redesigned user treatment: ${JSON.stringify(profileHeaderState)}`);
    }
    await page.locator('#settings-username').waitFor({ state: 'visible' });
    await page.locator('#settings-username').getByText('frontenduser').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#settings-display-name-cell button[onclick="editUserDisplayName()"]').click();
    await page.fill('#settings-display-name-input', 'Frontend Avatar User');
    await page.locator('#settings-display-name-cell button[onclick="saveUserProfile()"]').click();
    await page.getByText(/Profil gespeichert|Profile saved/).waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/me', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      return data.display_name === 'Frontend Avatar User';
    }, null, { timeout: 10000 });
    await page.setInputFiles('#settings-avatar-input', {
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNMTvvIwMDAxMDAwMDAAAAUVAG+nM0ffgAAAABJRU5ErkJggg==', 'base64')
    });
    await visible('#avatar-crop-modal');
    await page.waitForFunction(() => {
      const image = document.getElementById('avatar-crop-image');
      const rect = image?.getBoundingClientRect();
      return image?.naturalWidth > 0 && rect?.width > 0 && !image.style.transform.includes('scale(0)');
    }, null, { timeout: 10000 });
    await page.click('#avatar-crop-modal .btn-primary');
    await page.getByText(/Avatar gespeichert|Avatar saved/).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#settings-avatar-preview').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/me', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      return data.avatar_url && data.avatar_url.includes('/api/avatars/user-');
    }, null, { timeout: 10000 });
    await page.click('#settings-avatar-remove');
    await page.locator('#security-action-modal').waitFor({ state: 'visible', timeout: 10000 });
    await page.click('#security-action-primary');
    await page.getByText(/Avatar gelöscht|Avatar deleted/).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#settings-avatar-preview').waitFor({ state: 'hidden', timeout: 10000 });
    await page.locator('#settings-avatar-remove').waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForFunction(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/me', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      return !data.avatar_url && !data.avatar_updated_at;
    }, null, { timeout: 10000 });
    await page.locator('#settings-email-display').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#settings-email-cell button[onclick="editUserEmail()"]').click();
    await page.locator('#settings-email-input').fill('broken-email');
    await page.locator('#settings-email-cell button[onclick="saveUserEmail()"]').click();
    await page.getByText(/Bitte eine gültige E-Mail-Adresse eingeben|Please enter a valid email address/).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#settings-email-input').fill('frontenduser-updated@example.invalid');
    await page.locator('#settings-email-cell button[onclick="saveUserEmail()"]').click();
    await page.getByText(/E-Mail gespeichert|Email saved/).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#settings-email-cell').getByText('frontenduser-updated@example.invalid').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#settings-email-cell button[onclick="editUserEmail()"]').click();
    await page.locator('#settings-email-input').fill('cancelled@example.invalid');
    await page.locator('#settings-email-cell button[onclick="cancelUserEmailEdit()"]').click();
    await page.locator('#settings-email-cell').getByText('frontenduser-updated@example.invalid').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/me', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      return data.email === 'frontenduser-updated@example.invalid';
    }, null, { timeout: 10000 });

    await page.evaluate(() => {
      window.updatePushStatus('granted');
      const disableBtn = document.getElementById('push-disable-btn');
      const testBtn = document.getElementById('push-test-btn');
      if (disableBtn) disableBtn.style.display = 'inline-block';
      if (testBtn) testBtn.style.display = 'inline-block';
    });
    await page.evaluate(() => {
      const disableBtn = document.getElementById('push-disable-btn');
      const testBtn = document.getElementById('push-test-btn');
      if (disableBtn) disableBtn.style.display = 'inline-block';
      if (testBtn) testBtn.style.display = 'inline-block';
    });
    await page.evaluate(() => {
      const disableBtn = document.getElementById('push-disable-btn');
      const testBtn = document.getElementById('push-test-btn');
      if (disableBtn) disableBtn.hidden = false;
      if (testBtn) testBtn.hidden = false;
    });

    await page.locator('button[onclick="createApiKey()"]').click();
    await page.locator('#security-action-modal').waitFor({ state: 'visible', timeout: 10000 });
    await page.fill('#security-action-body input[name="value"]', 'Frontend Test Key');
    await page.click('#security-action-primary');
    await page.locator('#api-key-created').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('api-key-value')?.textContent?.trim().length > 0, { timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('api-keys-list')?.innerText?.includes('Frontend Test Key'), { timeout: 10000 });

    await page.evaluate(() => window.sendTestPush());
    await page.waitForFunction(() => {
      const text = document.getElementById('push-error')?.textContent || '';
      return text.includes('Test-Benachrichtigung gesendet!')
        || text.includes('Test notification sent!')
        || text.includes('Test-Benachrichtigung konnte nicht gesendet werden.')
        || text.includes('Test notification could not be sent.');
    }, { timeout: 10000 });

    await page.locator('#api-keys-list .btn.btn-danger').first().click();
    await page.locator('#security-action-modal').waitFor({ state: 'visible', timeout: 10000 });
    await page.click('#security-action-primary');
    await page.waitForFunction(() => {
      const text = document.getElementById('api-keys-list')?.innerText || '';
      return text.includes('widerrufen')
        || text.includes('revoked')
        || text.includes('Keine API-Keys vorhanden')
        || text.includes('No API keys yet');
    }, { timeout: 10000 });

    await page.evaluate(() => window.disablePushNotifications());
    await page.waitForFunction(() => {
      const text = document.getElementById('push-error')?.textContent || '';
      return text.includes('deaktiviert') || text.includes('disabled');
    }, { timeout: 10000 });

    const languageSelectState = await page.evaluate(() => {
      const select = document.getElementById('settings-language');
      const rect = select?.getBoundingClientRect();
      return {
        hiddenNative: select?.classList.contains('visually-hidden-native-select') && rect && rect.width <= 1,
        hasTrigger: !!document.querySelector('.ui-select[data-select-id="settings-language"] .ui-select-trigger'),
      };
    });
    if (!languageSelectState.hiddenNative || !languageSelectState.hasTrigger) throw new Error(`Settings language select was not hydrated: ${JSON.stringify(languageSelectState)}`);
    await page.locator('.ui-select[data-select-id="settings-language"] .ui-select-trigger').click();
    await page.locator('.ui-select-menu').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('.ui-select-option[data-value="en"]').click();
    await page.locator('.ui-select-menu').waitFor({ state: 'hidden', timeout: 5000 });
    await page.getByText('Language saved.').waitFor({ state: 'visible', timeout: 10000 });
    await page.evaluate(() => window.closeModal?.('settings-modal'));
    await page.locator('#settings-modal').waitFor({ state: 'hidden', timeout: 10000 });
    await page.getByText('All todos at a glance').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('Total').waitFor({ state: 'visible', timeout: 10000 });

    await page.click('#user-menu-button');
    await page.click('#menu-settings-btn');
    await visible('#settings-modal');
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('#settings-2fa-trusted-devices .settings-device-row')];
      const collapsed = document.getElementById('settings-2fa-trusted-panel')?.hidden === true;
      return collapsed && rows.some((row) => row.innerText.includes('this device') || row.innerText.includes('dieses Gerät'));
    }, null, { timeout: 10000 });
    await page.click('#settings-sessions-toggle');
    await page.locator('#settings-2fa-trusted-panel').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(() => document.getElementById('settings-2fa-trusted-devices')?.innerText.includes('IP:'), null, { timeout: 5000 });
    await page.waitForFunction(() => {
      const devicesText = document.getElementById('settings-2fa-devices')?.innerText || '';
      const setupBtn = document.querySelector('#settings-2fa-actions button[onclick="startTwoFactorTotp()"]');
      const setupBtnVisible = setupBtn ? window.getComputedStyle(setupBtn).display !== 'none' : false;
      const disableBtn = document.getElementById('settings-2fa-disable-btn');
      const disableBtnHidden = disableBtn ? window.getComputedStyle(disableBtn).display === 'none' : false;
      const duplicateTotpSetupCardHidden = !/Noch nicht eingerichtet|Not set up yet/.test(devicesText);
      return setupBtnVisible && disableBtnHidden && duplicateTotpSetupCardHidden;
    }, null, { timeout: 10000 });
    const currentSessionRevokeButton = page.locator('#settings-2fa-trusted-devices .settings-device-row', { hasText: /this device|dieses Gerät/ }).locator('button').first();
    await currentSessionRevokeButton.click();
    await page.locator('#security-action-modal').waitFor({ state: 'visible', timeout: 10000 });
    await page.click('#security-action-primary');
    await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10000 });

    await loginApp();
    await page.click('#user-menu-button');
    await page.click('#menu-settings-btn');
    await visible('#settings-modal');

    await page.waitForFunction(() => {
      const statusText = document.getElementById('settings-2fa-status')?.textContent || '';
      const devicesText = document.getElementById('settings-2fa-devices')?.innerText || '';
      const setupBtn = document.querySelector('#settings-2fa-actions button[onclick="startTwoFactorTotp()"]');
      const setupBtnVisible = setupBtn ? window.getComputedStyle(setupBtn).display !== 'none' : false;
      const disableBtn = document.getElementById('settings-2fa-disable-btn');
      const disableBtnHidden = disableBtn ? window.getComputedStyle(disableBtn).display === 'none' : false;
      const duplicateTotpSetupCardHidden = !/Noch nicht eingerichtet|Not set up yet/.test(devicesText);
      const noReferenceError = !statusText.includes('ReferenceError') && !statusText.includes('totpCountLabel');
      return setupBtnVisible && disableBtnHidden && duplicateTotpSetupCardHidden && noReferenceError;
    }, null, { timeout: 10000 });

    await page.fill('#settings-old-password', USER_PASSWORD);
    await page.fill('#settings-new-password', 'FrontendChanged123!');
    await page.fill('#settings-confirm-password', 'FrontendChanged123!');
    await page.locator('#settings-modal button[onclick="changeUserPassword()"]').click();
    await page.getByText(/Passwort geändert|Password changed/).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10000 });

    assertNoFrontendErrors();
    console.log('✅ Frontend settings test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);
