#!/usr/bin/env node
import { withFreshDb, launchPage, ADMIN_PASSWORD, BASE_URL } from './frontend_test_lib.mjs';

async function run() {
  console.log('🌐 Running Playwright frontend admin test...');
  const { browser, page } = await launchPage();

  async function expandSection(cardSelector) {
    const card = page.locator(cardSelector);
    await card.waitFor({ state: 'visible', timeout: 10000 });
    const collapsed = await card.evaluate((el) => el.classList.contains('collapsed'));
    if (collapsed) await card.locator('.admin-section-header').click();
  }

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
    const nestedHeaderInputs = await page.locator('.admin-section-header input, .admin-section-header button, .admin-section-header select, .admin-section-header textarea').count();
    if (nestedHeaderInputs !== 0) throw new Error('Admin section header button contains nested interactive controls');
    await expandSection('#email-config-card');
    await expandSection('#braindump-config-card');
    await expandSection('#create-user-card');
    const adminSelectState = await page.evaluate(() => {
      const ids = ['email-smtp-security', 'braindump-llm-provider', 'braindump-system-prompt-mode', 'braindump-stt-provider', 'new-language'];
      return ids.map((id) => {
        const select = document.getElementById(id);
        const rect = select?.getBoundingClientRect();
        return {
          id,
          hiddenNative: select?.classList.contains('visually-hidden-native-select') && rect && rect.width <= 1,
          hasTrigger: !!document.querySelector(`.ui-select[data-select-id="${id}"] .ui-select-trigger`),
        };
      });
    });
    const unhydratedAdminSelects = adminSelectState.filter((item) => !item.hiddenNative || !item.hasTrigger);
    if (unhydratedAdminSelects.length) throw new Error(`Admin selects are not fully hydrated: ${JSON.stringify(adminSelectState)}`);
    async function assertAdminSelectLayout(context) {
      const adminSelectLayout = await page.evaluate(() => {
        const ids = ['email-smtp-security', 'braindump-llm-provider', 'braindump-system-prompt-mode', 'braindump-stt-provider', 'new-language'];
        return ids.map((id) => {
          const wrapper = document.querySelector(`.ui-select[data-select-id="${id}"]`);
          const trigger = wrapper?.querySelector('.ui-select-trigger');
          const chevron = wrapper?.querySelector('.ui-select-chevron');
          const wrapperRect = wrapper?.getBoundingClientRect();
          const triggerRect = trigger?.getBoundingClientRect();
          const chevronRect = chevron?.getBoundingClientRect();
          return {
            id,
            wrapperHeight: wrapperRect?.height || 0,
            triggerHeight: triggerRect?.height || 0,
            chevronHeight: chevronRect?.height || 0,
            chevronTopDelta: chevronRect && triggerRect ? Math.abs(chevronRect.top - triggerRect.top) : 999,
          };
        });
      });
      const brokenAdminSelectLayout = adminSelectLayout.filter((item) => (
        Math.abs(item.wrapperHeight - item.triggerHeight) > 2
        || Math.abs(item.chevronHeight - item.triggerHeight) > 2
        || item.chevronTopDelta > 2
      ));
      if (brokenAdminSelectLayout.length) throw new Error(`Admin custom select layout is broken (${context}): ${JSON.stringify(adminSelectLayout)}`);
    }
    await assertAdminSelectLayout('desktop');
    const createUserLanguageVisualStyle = await page.evaluate(() => {
      const email = document.getElementById('new-email');
      const trigger = document.querySelector('.ui-select[data-select-id="new-language"] .ui-select-trigger');
      const emailStyle = email ? getComputedStyle(email) : null;
      const triggerStyle = trigger ? getComputedStyle(trigger) : null;
      return {
        emailHeight: email?.getBoundingClientRect().height || 0,
        triggerHeight: trigger?.getBoundingClientRect().height || 0,
        emailRadius: emailStyle?.borderRadius,
        triggerRadius: triggerStyle?.borderRadius,
        emailBackground: emailStyle?.backgroundColor,
        triggerBackground: triggerStyle?.backgroundColor,
        triggerBoxShadow: triggerStyle?.boxShadow,
      };
    });
    if (
      Math.abs(createUserLanguageVisualStyle.emailHeight - createUserLanguageVisualStyle.triggerHeight) > 1
      || createUserLanguageVisualStyle.emailRadius !== createUserLanguageVisualStyle.triggerRadius
      || createUserLanguageVisualStyle.emailBackground !== createUserLanguageVisualStyle.triggerBackground
      || createUserLanguageVisualStyle.triggerBoxShadow !== 'none'
    ) {
      throw new Error(`Create-user language dropdown visual style differs from sibling input: ${JSON.stringify(createUserLanguageVisualStyle)}`);
    }
    const adminDesktopViewport = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await assertAdminSelectLayout('mobile');
    await page.setViewportSize(adminDesktopViewport || { width: 1280, height: 720 });

    await expandSection('#security-card');
    await page.getByText('Globale 2FA-Pflicht ist deaktiviert').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#twofa-policy-toggle').click();
    await page.getByText('Globale 2FA-Pflicht aktiviert.').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('Globale 2FA-Pflicht ist aktiv').waitFor({ state: 'visible', timeout: 10000 });
    await expandSection('#user-list-card');
    await page.locator('#user-list').getByText('Pflicht').first().waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#twofa-policy-toggle').click();
    await page.getByRole('heading', { name: 'Globale 2FA-Pflicht deaktivieren?' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByRole('button', { name: 'Abbrechen' }).click();
    await page.getByText('Globale 2FA-Pflicht ist aktiv').waitFor({ state: 'visible', timeout: 10000 });
    if (!(await page.locator('#twofa-policy-toggle').isChecked())) throw new Error('2FA policy toggle did not roll back after cancelled disable confirmation');
    await page.locator('#twofa-policy-toggle').click();
    await page.getByRole('heading', { name: 'Globale 2FA-Pflicht deaktivieren?' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#admin-dialog-confirm').click();
    await page.getByText('Globale 2FA-Pflicht deaktiviert.').waitFor({ state: 'visible', timeout: 10000 });

    await expandSection('#instance-config-card');
    await page.fill('#instance-public-url', BASE_URL);
    await page.fill('#instance-allowed-origins', `${BASE_URL}\nhttps://example.invalid`);
    await page.fill('#instance-trusted-proxies', '127.0.0.1\n10.0.10.0/24');
    await page.getByRole('button', { name: 'Instanz-Konfiguration speichern' }).click();
    await page.getByText('Instanz-Konfiguration gespeichert.').waitFor({ state: 'visible', timeout: 10000 });

    await expandSection('#user-list-card');
    await page.locator('#user-list button[title="E-Mail bearbeiten"]').first().click();
    await page.locator('#user-list input[type="email"]').first().waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#user-list button[title="Abbrechen"]').first().click();
    await page.locator('#user-list input[type="email"]').waitFor({ state: 'detached', timeout: 5000 });

    const originalViewport = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await expandSection('#user-list-card');
    const mobileUserColumns = await page.locator('#user-list').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length);
    if (mobileUserColumns !== 1) throw new Error(`Expected mobile user cards to be one column, got ${mobileUserColumns}`);
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    if (mobileOverflow) throw new Error('Mobile admin layout overflows horizontally');
    await page.setViewportSize(originalViewport || { width: 1280, height: 720 });

    await page.evaluate(() => {
      document.getElementById('braindump-llm-base-url').value = 'http://llm.example.invalid/v1';
      document.getElementById('braindump-llm-model').value = 'test-model';
      document.getElementById('braindump-stt-url').value = 'http://stt.example.invalid/inference';
      document.getElementById('braindump-stt-language').value = 'de';
    });
    if (!(await page.locator('#braindump-enabled').isChecked())) {
      await page.locator('#braindump-enabled').click();
      await page.waitForFunction(() => document.getElementById('new-braindump-field')?.style.display !== 'none', null, { timeout: 10000 });
    }
    await expandSection('#create-user-card');
    await page.locator('#new-braindump-field').waitFor({ state: 'visible', timeout: 10000 });
    if (await page.locator('#new-braindump-enabled').isChecked()) throw new Error('Create-user BrainDump toggle should default off');
    await page.fill('#new-username', 'admincreated');
    await page.fill('#new-display-name', 'Admin Created');
    await page.fill('#new-email', 'broken-email');
    await page.getByRole('button', { name: 'Erstellen & Link erzeugen' }).click();
    await page.getByText('Bitte eine gültige E-Mail-Adresse eingeben').waitFor({ state: 'visible', timeout: 10000 });
    await page.fill('#new-email', 'admincreated@example.invalid');
    await page.locator('.ui-select[data-select-id="new-language"] .ui-select-trigger').click();
    await page.locator('.ui-select-menu').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('.ui-select-option[data-value="en"]').click();
    await page.locator('.ui-select-menu').waitFor({ state: 'hidden', timeout: 5000 });
    await page.getByRole('button', { name: 'Erstellen & Link erzeugen' }).click();
    await page.getByText(/Benutzer .*admincreated.* erstellt.*Link kopieren und senden/).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#create-link-input').waitFor({ state: 'visible', timeout: 10000 });
    const setupUrl = await page.locator('#create-link-input').inputValue();
    if (!setupUrl.startsWith(`${BASE_URL}/set-password?token=`)) throw new Error('Create user did not use configured public base URL');
    await page.locator('#user-list').getByText('admincreated', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });
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
    const createdBrainDumpEnabled = await page.evaluate(async () => {
      const response = await fetch('/api/admin/users', {
        headers: { Authorization: `Bearer ${localStorage.getItem('admin_jwt_token')}` },
        credentials: 'include'
      });
      const data = await response.json();
      return data.users.find((user) => user.username === 'admincreated')?.braindump_enabled;
    });
    if (Boolean(createdBrainDumpEnabled) !== false) throw new Error(`Expected created user BrainDump default false, got ${createdBrainDumpEnabled}`);
    const selectedLanguageAfterCreate = await page.locator('#new-language').inputValue();
    if (selectedLanguageAfterCreate !== 'en') throw new Error(`Expected create-user language selection to remain en, got ${selectedLanguageAfterCreate}`);
    await page.locator('#user-list button[title="E-Mail bearbeiten"]').last().click();
    await page.locator('#user-list input[type="email"]').last().fill('broken-email');
    await page.locator('#user-list button[title="Speichern"]').last().click();
    await page.getByText('Bitte eine gültige E-Mail-Adresse eingeben').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#user-list input[type="email"]').last().fill('admincreated-updated@example.invalid');
    await page.locator('#user-list button[title="Speichern"]').last().click();
    await page.locator('#user-list').getByText('admincreated-updated@example.invalid').waitFor({ state: 'visible', timeout: 10000 });

    await page.locator('#user-list button[title="Benutzernamen bearbeiten"]').last().click();
    await page.locator('#user-list input[type="text"]').last().fill("admino'neil");
    await page.locator('#user-list button[title="Speichern"]').last().click();
    await page.getByRole('heading', { name: 'Benutzernamen ändern?' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText(/Bestehende Passkeys bleiben gültig/).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#admin-dialog-confirm').click();
    await page.locator('#user-list').getByText("admino'neil", { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });

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
        body: JSON.stringify({ username: "admino'neil", password: 'AdminCreated123!' }),
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
    await expandSection('#user-list-card');
    await page.locator('#user-list').getByText("admino'neil", { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#user-list').getByText('admincreated-updated@example.invalid').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#user-list').getByText('Aktiv', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });

    await page.getByRole('button', { name: 'Passwort ändern' }).click();
    await page.locator('#admin-password-dialog').waitFor({ state: 'visible', timeout: 10000 });
    await page.fill('#admin-old-password', ADMIN_PASSWORD);
    await page.fill('#admin-new-password', 'NewFrontendAdmin123!');
    await page.fill('#admin-confirm-password', 'NewFrontendAdmin123!');
    await page.locator('#admin-password-dialog button.btn-primary').click();
    await page.getByText('Admin-Passwort geändert! Melde dich erneut an.').waitFor({ state: 'visible', timeout: 10000 });

    console.log('✅ Frontend admin test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);
