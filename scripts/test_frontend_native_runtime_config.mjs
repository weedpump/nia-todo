#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { withFreshDb, launchPage, BASE_URL, USERNAME, USER_PASSWORD, DB_PATH } from './frontend_test_lib.mjs';

async function installTauriStub(page, settings, options = {}) {
  if (options.userAgent) {
    await page.addInitScript((userAgent) => {
      Object.defineProperty(navigator, 'userAgent', { get: () => userAgent });
    }, options.userAgent);
  }
  await page.addInitScript((payload) => {
    const { tauriSettings, appVersion } = payload;
    const storedSettings = { ...tauriSettings };
    window.__TAURI__ = {
      core: {
        invoke: async (command, args = {}) => {
          window.__nativeInvokeCalls = window.__nativeInvokeCalls || [];
          window.__nativeInvokeCalls.push({ command, args });
          if (command === 'desktop_get_settings') return { ...storedSettings };
          if (command === 'desktop_set_setting') {
            storedSettings[args.key] = args.value;
            window.__nativeSettings = { ...storedSettings };
            localStorage.setItem('__nativeSettings', JSON.stringify(storedSettings));
            return { ...storedSettings };
          }
          if (command === 'desktop_set_server_url') {
            storedSettings.serverUrl = args.serverUrl;
            window.__nativeSavedServerUrl = args.serverUrl;
            localStorage.setItem('__nativeSavedServerUrl', args.serverUrl);
            return { ...storedSettings };
          }
          if (command === 'desktop_request_notification_permission') return 'granted';
          if (command === 'desktop_schedule_reminders') return 0;
          if (command === 'desktop_get_app_version') return appVersion || '9.9.9-test';
          if (command === 'desktop_open_url') {
            window.__nativeOpenedUrls = window.__nativeOpenedUrls || [];
            window.__nativeOpenedUrls.push(args.url);
            localStorage.setItem('__nativeOpenedUrls', JSON.stringify(window.__nativeOpenedUrls));
            return null;
          }
          return null;
        },
      },
    };
  }, { tauriSettings: settings, appVersion: options.appVersion });
}

async function testNativeSetupWithoutServerUrl() {
  const { browser, page, dumpErrors } = await launchPage();
  try {
    await installTauriStub(page, {});
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#native-server-form').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('#native-server-url').fill(BASE_URL);
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10_000 }),
      page.locator('#native-server-form button[type="submit"]').click(),
    ]);
    await page.waitForFunction(() => localStorage.getItem('__nativeSavedServerUrl'), null, { timeout: 10_000 });
    const saved = await page.evaluate(() => localStorage.getItem('__nativeSavedServerUrl'));
    if (saved !== BASE_URL) throw new Error(`Expected saved server URL ${BASE_URL}, got ${saved}`);
  } catch (error) {
    console.log('DEBUG frontend errors:', JSON.stringify(dumpErrors()));
    throw error;
  } finally {
    await browser.close();
  }
}

async function testNativeChangelogPillOpensOnlyOnce() {
  const { browser, page, dumpErrors } = await launchPage();
  try {
    await installTauriStub(page, { serverUrl: BASE_URL }, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10_000 });
    await page.fill('#login-username', USERNAME);
    await page.fill('#login-password', USER_PASSWORD);
    await page.click('button.login-btn');
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 15_000 });

    await page.locator('#changelog-link').evaluate((el) => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); });
    await page.waitForFunction(() => (window.__nativeOpenedUrls || []).length === 1, null, { timeout: 10_000 });
    const opened = await page.evaluate(() => window.__nativeOpenedUrls || []);
    if (opened.length !== 1) throw new Error(`Expected exactly one native openExternal call, got ${opened.length}`);
  } catch (error) {
    console.log('DEBUG frontend errors:', JSON.stringify(dumpErrors()));
    throw error;
  } finally {
    await browser.close();
  }
}

async function testNativeChangelogOpensExternally() {
  const { browser, page, dumpErrors } = await launchPage();
  try {
    await installTauriStub(page, { serverUrl: BASE_URL }, {
      appVersion: '9.9.9-test',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10_000 });

    await page.fill('#login-username', USERNAME);
    await page.fill('#login-password', USER_PASSWORD);
    await page.click('button.login-btn');
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 15_000 });

    await page.click('#user-menu-button');
    await page.click('#menu-settings-btn');
    await page.locator('#settings-modal.active').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('[data-native-app-version] a.changelog-link').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('[data-native-app-version] a.changelog-link').dispatchEvent('click');
    await page.waitForFunction(() => {
      const opened = JSON.parse(localStorage.getItem('__nativeOpenedUrls') || '[]');
      return opened.includes(`${location.origin}/changelog`);
    }, null, { timeout: 10_000 });
    const path = await page.evaluate(() => location.pathname);
    if (path !== '/') throw new Error(`Native changelog click must not navigate inside app, got ${path}`);
  } catch (error) {
    console.log('DEBUG frontend errors:', JSON.stringify(dumpErrors()));
    throw error;
  } finally {
    await browser.close();
  }
}

async function testNativeDesktopSettingsPersistViaTauriCommand() {
  const { browser, page, dumpErrors } = await launchPage();
  try {
    await installTauriStub(page, { serverUrl: BASE_URL, minimizeToTray: true, autostart: false, startMinimizedToTray: false, notifications: true });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10_000 });

    await page.fill('#login-username', USERNAME);
    await page.fill('#login-password', USER_PASSWORD);
    await page.click('button.login-btn');
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 15_000 });

    await page.click('#user-menu-button');
    await page.click('#menu-settings-btn');
    await page.locator('#settings-modal.active').waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator('#desktop-minimize-to-tray').setChecked(false);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('__nativeSettings') || '{}').minimizeToTray === false, null, { timeout: 10_000 });
    await page.locator('#desktop-notifications').setChecked(false);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('__nativeSettings') || '{}').notifications === false, null, { timeout: 10_000 });
    await page.locator('#desktop-autostart').setChecked(true);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('__nativeSettings') || '{}').autostart === true, null, { timeout: 10_000 });
    await page.locator('#desktop-start-minimized-to-tray').setChecked(true);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('__nativeSettings') || '{}').startMinimizedToTray === true, null, { timeout: 10_000 });

    const calls = await page.evaluate(() => window.__nativeInvokeCalls || []);
    for (const expected of [
      { key: 'minimizeToTray', value: false },
      { key: 'notifications', value: false },
      { key: 'autostart', value: true },
      { key: 'startMinimizedToTray', value: true },
    ]) {
      const found = calls.some(call => call.command === 'desktop_set_setting' && call.args?.key === expected.key && call.args?.value === expected.value);
      if (!found) throw new Error(`Missing desktop_set_setting call for ${expected.key}=${expected.value}`);
    }
  } catch (error) {
    console.log('DEBUG frontend errors:', JSON.stringify(dumpErrors()));
    throw error;
  } finally {
    await browser.close();
  }
}


async function testNativeLanguageSettingPersistsThroughInlineChangeBridge() {
  const { browser, page, dumpErrors } = await launchPage();
  try {
    await installTauriStub(page, { serverUrl: BASE_URL }, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10_000 });

    await page.fill('#login-username', USERNAME);
    await page.fill('#login-password', USER_PASSWORD);
    await page.click('button.login-btn');
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 15_000 });

    await page.click('#user-menu-button');
    await page.click('#menu-settings-btn');
    await page.locator('#settings-modal.active').waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator('#settings-language').selectOption('en');
    await page.getByText('Language saved.').waitFor({ state: 'visible', timeout: 10_000 });
    const preference = await page.evaluate(() => localStorage.getItem('nia-todo-language'));
    if (preference !== 'en') throw new Error(`Expected native language preference in localStorage to be en, got ${preference}`);

    await page.evaluate(() => window.closeModal?.('settings-modal'));
    await page.locator('#settings-modal').waitFor({ state: 'hidden', timeout: 10_000 });
    await page.click('#user-menu-button');
    await page.click('#menu-settings-btn');
    await page.locator('#settings-modal.active').waitFor({ state: 'visible', timeout: 10_000 });
    const selected = await page.locator('#settings-language').inputValue();
    if (selected !== 'en') throw new Error(`Expected reopened native settings language to stay en, got ${selected}`);
  } catch (error) {
    console.log('DEBUG frontend errors:', JSON.stringify(dumpErrors()));
    throw error;
  } finally {
    await browser.close();
  }
}

async function testNativeUpdateUsesModalWithDownloadButton() {
  const { browser, page, dumpErrors } = await launchPage();
  try {
    await installTauriStub(page, { serverUrl: BASE_URL }, {
      appVersion: '1.7.0',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    await page.route(new RegExp(`${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/instance$`), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          app: 'nia-todo',
          instance_id: 'test',
          display_name: 'nia-todo',
          public_base_url: BASE_URL,
          api_version: 1,
          server_version: '1.7.1',
          min_native_client_version: '1.7.0',
          capabilities: [],
        }),
      });
    });
    await page.route(new RegExp(`${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/downloads/app-downloads\\.json(?:\\?.*)?$`), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          version: 'v1.7.1',
          latest: { version: 'v1.7.1' },
          apps: [{
            platform: 'windows',
            arch: 'x64',
            label: 'Windows Setup',
            version: 'v1.7.1',
            filename: 'nia-todo-v1.7.1-windows-x64-setup.exe',
            url: '/downloads/nia-todo-v1.7.1-windows-x64-setup.exe',
            sha256: 'a'.repeat(64),
          }],
        }),
      });
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10_000 });
    await page.fill('#login-username', USERNAME);
    await page.fill('#login-password', USER_PASSWORD);
    await page.click('button.login-btn');
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 15_000 });

    await page.locator('#native-app-update-modal.active').waitFor({ state: 'visible', timeout: 10_000 });
    const href = await page.locator('#native-app-update-download-btn').getAttribute('href');
    if (href !== `${BASE_URL}/downloads/nia-todo-v1.7.1-windows-x64-setup.exe`) throw new Error(`Unexpected native update href: ${href}`);
    const laterVisible = await page.locator('#native-app-update-later-btn:visible').count();
    if (laterVisible !== 1) throw new Error('Optional native update must offer a later button');
    await page.locator('#native-app-update-later-btn').click();
    await page.locator('#native-app-update-modal.active').waitFor({ state: 'hidden', timeout: 5_000 });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(500);
    const reopened = await page.locator('#native-app-update-modal.active').count();
    if (reopened !== 0) throw new Error('Dismissed optional native update must not reopen on focus in the same app run');
    const webUpdateVisible = await page.locator('#web-update-modal.active').count();
    if (webUpdateVisible !== 0) throw new Error('Web app update modal must not be shown for native app updates');
  } catch (error) {
    console.log('DEBUG frontend errors:', JSON.stringify(dumpErrors()));
    throw error;
  } finally {
    await browser.close();
  }
}


async function testNativeRequiredUpdateCannotBeDismissed() {
  const { browser, page, dumpErrors } = await launchPage();
  try {
    await installTauriStub(page, { serverUrl: BASE_URL }, {
      appVersion: '1.7.0',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    await page.route(new RegExp(`${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/instance$`), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          app: 'nia-todo',
          instance_id: 'test',
          display_name: 'nia-todo',
          public_base_url: BASE_URL,
          api_version: 1,
          server_version: '1.7.1',
          min_native_client_version: '1.7.1',
          capabilities: [],
        }),
      });
    });
    await page.route(new RegExp(`${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/downloads/app-downloads\\.json(?:\\?.*)?$`), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          version: 'v1.7.1',
          latest: { version: 'v1.7.1' },
          apps: [{
            platform: 'windows',
            arch: 'x64',
            label: 'Windows Setup',
            version: 'v1.7.1',
            filename: 'nia-todo-v1.7.1-windows-x64-setup.exe',
            url: '/downloads/nia-todo-v1.7.1-windows-x64-setup.exe',
            sha256: 'a'.repeat(64),
          }],
        }),
      });
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10_000 });
    await page.fill('#login-username', USERNAME);
    await page.fill('#login-password', USER_PASSWORD);
    await page.click('button.login-btn');
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 15_000 });

    await page.locator('#native-app-update-modal.active.native-update-required').waitFor({ state: 'visible', timeout: 10_000 });
    const title = await page.locator('#native-app-update-title').textContent();
    if (!/erforderlich|required/i.test(title || '')) throw new Error(`Expected required update title, got ${title}`);
    const laterVisible = await page.locator('#native-app-update-later-btn:visible').count();
    if (laterVisible !== 0) throw new Error('Required native update must not offer a later button');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    const stillVisible = await page.locator('#native-app-update-modal.active').count();
    if (stillVisible !== 1) throw new Error('Required native update modal must remain visible');
  } catch (error) {
    console.log('DEBUG frontend errors:', JSON.stringify(dumpErrors()));
    throw error;
  } finally {
    await browser.close();
  }
}


async function testNativeRequiredUpdateRefreshesStaleBootInstance() {
  const { browser, page, dumpErrors } = await launchPage();
  try {
    await installTauriStub(page, { serverUrl: BASE_URL }, {
      appVersion: '1.7.0',
      userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36',
    });
    let instanceRequests = 0;
    await page.route(new RegExp(`${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/instance$`), async (route) => {
      instanceRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          app: 'nia-todo',
          instance_id: 'test',
          display_name: 'nia-todo',
          public_base_url: BASE_URL,
          api_version: 1,
          server_version: '1.7.1',
          min_native_client_version: instanceRequests === 1 ? '1.7.0' : '1.7.1',
          capabilities: [],
        }),
      });
    });
    await page.route(new RegExp(`${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/downloads/app-downloads\\.json(?:\\?.*)?$`), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          version: 'v1.7.1',
          latest: { version: 'v1.7.1' },
          apps: [{
            platform: 'android',
            arch: 'arm64',
            label: 'Android APK',
            version: 'v1.7.1',
            filename: 'nia-todo-v1.7.1-android-arm64.apk',
            url: '/downloads/nia-todo-v1.7.1-android-arm64.apk',
            sha256: 'a'.repeat(64),
          }],
        }),
      });
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10_000 });
    await page.fill('#login-username', USERNAME);
    await page.fill('#login-password', USER_PASSWORD);
    await page.click('button.login-btn');
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 15_000 });

    await page.locator('#native-app-update-modal.active.native-update-required').waitFor({ state: 'visible', timeout: 10_000 });
    const laterVisible = await page.locator('#native-app-update-later-btn:visible').count();
    if (laterVisible !== 0) throw new Error('Fresh native min version must force update even when boot-time instance was stale');
    if (instanceRequests < 2) throw new Error(`Expected app-download refresh to re-fetch /api/instance, got ${instanceRequests}`);
  } catch (error) {
    console.log('DEBUG frontend errors:', JSON.stringify(dumpErrors()));
    throw error;
  } finally {
    await browser.close();
  }
}

async function testNativeUpdateRejectsUnsafeManifestDownload() {
  const { browser, page, dumpErrors } = await launchPage();
  try {
    await installTauriStub(page, { serverUrl: BASE_URL }, {
      appVersion: '1.7.0',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    await page.route(new RegExp(`${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/downloads/app-downloads\\.json(?:\\?.*)?$`), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          version: 'v9.9.9',
          apps: [{
            platform: 'windows',
            arch: 'x64',
            label: 'Windows Setup',
            version: 'v9.9.9',
            filename: 'evil.exe',
            url: 'javascript:alert(1)',
            sha256: 'a'.repeat(64),
          }, {
            platform: 'windows',
            arch: 'x64',
            label: 'Windows Setup',
            version: 'v9.9.9',
            filename: 'nia-todo-v9.9.8-windows-x64-setup.exe',
            url: '/downloads/nia-todo-v9.9.8-windows-x64-setup.exe',
            sha256: 'c'.repeat(64),
          }, {
            platform: 'android',
            arch: 'arm64',
            label: 'Android APK',
            version: 'v9.9.9',
            filename: 'nia-todo-v9.9.9-android-arm64.apk',
            url: 'https://evil.example/nia-todo-v9.9.9-android-arm64.apk',
            sha256: 'b'.repeat(64),
          }],
        }),
      });
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10_000 });
    await page.fill('#login-username', USERNAME);
    await page.fill('#login-password', USER_PASSWORD);
    await page.click('button.login-btn');
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 15_000 });
    await page.waitForTimeout(500);

    const modalVisible = await page.locator('#native-app-update-modal.active').count();
    if (modalVisible !== 0) throw new Error('Unsafe native update manifest must not show update modal');
    const href = await page.locator('#native-app-update-download-btn').getAttribute('href');
    if (href && href !== '#') throw new Error(`Unsafe native update href must not be applied, got ${href}`);
  } catch (error) {
    console.log('DEBUG frontend errors:', JSON.stringify(dumpErrors()));
    throw error;
  } finally {
    await browser.close();
  }
}

async function testNativeRuntimeUsesConfiguredServerUrl() {
  execFileSync('python3', ['-c', `import sqlite3\ndb=sqlite3.connect(${JSON.stringify(DB_PATH)})\ndb.execute("UPDATE users SET avatar_url='/api/avatars/user-1.webp', avatar_updated_at='2026-05-24 15:45:00' WHERE username=?", (${JSON.stringify(USERNAME)},))\ndb.commit()\ndb.close()`]);
  const { browser, page, dumpErrors } = await launchPage();
  try {
    await installTauriStub(page, { serverUrl: BASE_URL });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10_000 });
    const runtime = await page.evaluate(() => window.NIA_TODO_RUNTIME);
    if (runtime?.mode !== 'native') throw new Error(`Expected native runtime, got ${JSON.stringify(runtime)}`);
    if (runtime?.apiBaseUrl !== BASE_URL) throw new Error(`Expected API base ${BASE_URL}, got ${runtime?.apiBaseUrl}`);
    if (runtime?.instance?.app !== 'nia-todo') throw new Error(`Expected verified instance metadata, got ${JSON.stringify(runtime?.instance)}`);

    await page.fill('#login-username', USERNAME);
    await page.fill('#login-password', USER_PASSWORD);
    await page.click('button.login-btn');
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 15_000 });
    await page.locator('#user-menu-button').waitFor({ state: 'visible', timeout: 10_000 });
    const avatarSrc = await page.locator('#user-menu-button img').getAttribute('src');
    if (!avatarSrc?.startsWith(`${BASE_URL}/api/avatars/user-1.webp`)) throw new Error(`Native avatar URL must use server base URL, got ${avatarSrc}`);
  } catch (error) {
    console.log('DEBUG frontend errors:', JSON.stringify(dumpErrors()));
    throw error;
  } finally {
    await browser.close();
  }
}

async function run() {
  console.log('🧭 Running native runtime config regression test...');
  await testNativeSetupWithoutServerUrl();
  await testNativeRuntimeUsesConfiguredServerUrl();
  await testNativeChangelogPillOpensOnlyOnce();
  await testNativeChangelogOpensExternally();
  await testNativeDesktopSettingsPersistViaTauriCommand();
  await testNativeLanguageSettingPersistsThroughInlineChangeBridge();
  await testNativeUpdateUsesModalWithDownloadButton();
  await testNativeRequiredUpdateCannotBeDismissed();
  await testNativeRequiredUpdateRefreshesStaleBootInstance();
  await testNativeUpdateRejectsUnsafeManifestDownload();
  console.log('✅ Native runtime config regression test passed');
}

await withFreshDb(run);
