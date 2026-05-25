#!/usr/bin/env node
import { withFreshDb, launchPage, ADMIN_PASSWORD, BASE_URL } from './frontend_test_lib.mjs';

async function run() {
  console.log('🌐 Running Playwright frontend admin test...');
  const { browser, page } = await launchPage();

  try {
    await page.addInitScript(() => localStorage.setItem('nia-todo-language', 'de'));
    await page.goto('http://localhost:8754/admin', { waitUntil: 'networkidle' });
    await page.locator('#admin-login-card').waitFor({ state: 'visible', timeout: 5000 });

    await page.fill('#admin-login-password', 'wrong');
    await page.click('text=Anmelden');
    await page.getByText('Falsches Admin-Passwort').waitFor({ state: 'visible' });

    await page.fill('#admin-login-password', ADMIN_PASSWORD);
    await page.click('text=Anmelden');
    await page.locator('#admin-content').waitFor({ state: 'visible', timeout: 10000 });

    await page.locator('#security-card').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('Globale 2FA-Pflicht ist deaktiviert').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#twofa-policy-toggle').click();
    await page.locator('#admin-action-dialog').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#admin-dialog-confirm').click();
    await page.getByText('Globale 2FA-Pflicht aktiviert.').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('Globale 2FA-Pflicht ist aktiv').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#user-list').getByText('Pflicht').first().waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#twofa-policy-toggle').click();
    await page.locator('#admin-action-dialog').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#admin-dialog-confirm').click();
    await page.getByText('Globale 2FA-Pflicht deaktiviert.').waitFor({ state: 'visible', timeout: 10000 });

    await page.locator('#instance-config-card').waitFor({ state: 'visible', timeout: 10000 });
    await page.fill('#instance-public-url', BASE_URL);
    await page.fill('#instance-allowed-origins', `${BASE_URL}\nhttps://example.invalid`);
    await page.fill('#instance-trusted-proxies', '127.0.0.1\n10.0.10.0/24');
    await page.getByRole('button', { name: 'Instanz-Konfiguration speichern' }).click();
    await page.getByText('Instanz-Konfiguration gespeichert.').waitFor({ state: 'visible', timeout: 10000 });

    await page.locator('#user-list button[title="E-Mail bearbeiten"]').first().click();
    await page.locator('#user-list input[type="email"]').first().waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#user-list button[title="Abbrechen"]').first().click();
    await page.locator('#user-list input[type="email"]').waitFor({ state: 'detached', timeout: 5000 });

    await page.fill('#new-username', 'admincreated');
    await page.fill('#new-display-name', 'Admin Created');
    await page.fill('#new-email', 'broken-email');
    await page.getByRole('button', { name: 'Erstellen & Link erzeugen' }).click();
    await page.getByText('Bitte eine gültige E-Mail-Adresse eingeben').waitFor({ state: 'visible', timeout: 10000 });
    await page.fill('#new-email', 'admincreated@example.invalid');
    await page.selectOption('#new-language', 'en');
    await page.getByRole('button', { name: 'Erstellen & Link erzeugen' }).click();
    await page.getByText(/Benutzer .*admincreated.* erstellt.*Link kopieren und senden/).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#create-link-input').waitFor({ state: 'visible', timeout: 10000 });
    const setupUrl = await page.locator('#create-link-input').inputValue();
    if (!setupUrl.startsWith(`${BASE_URL}/set-password?token=`)) throw new Error('Create user did not use configured public base URL');
    await page.locator('#user-list').getByRole('cell', { name: 'admincreated', exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#user-list').getByText('admincreated@example.invalid').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#user-list').getByText('Bestätigt').first().waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#user-list').getByText('Aktiv').first().waitFor({ state: 'visible', timeout: 10000 });
    const createdLanguage = await page.evaluate(async () => {
      const response = await fetch('/api/admin/users', {
        headers: { Authorization: `Bearer ${localStorage.getItem('admin_jwt_token')}` },
        credentials: 'include'
      });
      const data = await response.json();
      return data.users.find((user) => user.username === 'admincreated')?.language;
    });
    if (createdLanguage !== 'en') throw new Error(`Expected created user language en, got ${createdLanguage}`);
    await page.locator('#user-list button[title="E-Mail bearbeiten"]').last().click();
    await page.locator('#user-list input[type="email"]').last().fill('broken-email');
    await page.locator('#user-list button[title="Speichern"]').last().click();
    await page.getByText('Bitte eine gültige E-Mail-Adresse eingeben').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#user-list input[type="email"]').last().fill('admincreated-updated@example.invalid');
    await page.locator('#user-list button[title="Speichern"]').last().click();
    await page.locator('#user-list').getByText('admincreated-updated@example.invalid').waitFor({ state: 'visible', timeout: 10000 });

    await page.goto(setupUrl, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: /Passwort setzen/ }).waitFor({ state: 'visible', timeout: 10000 });
    await page.fill('#password', 'AdminCreated123!');
    await page.fill('#confirm-password', 'AdminCreated123!');
    await page.click('#submit-btn');
    await page.getByText('Du kannst dich jetzt anmelden.').waitFor({ state: 'visible', timeout: 10000 });
    const loginStatus = await page.evaluate(async () => {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admincreated', password: 'AdminCreated123!' }),
        credentials: 'include'
      });
      return response.status;
    });
    if (loginStatus !== 200) throw new Error(`New user could not log in after password setup: ${loginStatus}`);

    await page.evaluate(() => {
      localStorage.removeItem('admin_jwt_token');
      localStorage.removeItem('csrf_token');
    });
    await page.goto('http://localhost:8754/admin', { waitUntil: 'networkidle' });
    await page.locator('#admin-login-card').waitFor({ state: 'visible', timeout: 5000 });
    await page.fill('#admin-login-password', ADMIN_PASSWORD);
    await page.click('text=Anmelden');
    await page.locator('#admin-content').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#user-list').getByRole('row', { name: /admincreated/ }).getByText('Aktiv').waitFor({ state: 'visible', timeout: 10000 });

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
