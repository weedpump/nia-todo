#!/usr/bin/env node
import { withFreshDb, launchPage, BASE_URL, USERNAME, USER_PASSWORD } from './frontend_test_lib.mjs';

async function installTauriStub(page, settings) {
  await page.addInitScript((tauriSettings) => {
    window.__TAURI__ = {
      core: {
        invoke: async (command, args = {}) => {
          window.__nativeInvokeCalls = window.__nativeInvokeCalls || [];
          window.__nativeInvokeCalls.push({ command, args });
          if (command === 'desktop_get_settings') return tauriSettings;
          if (command === 'desktop_set_server_url') {
            window.__nativeSavedServerUrl = args.serverUrl;
            localStorage.setItem('__nativeSavedServerUrl', args.serverUrl);
            return { ...tauriSettings, serverUrl: args.serverUrl };
          }
          if (command === 'desktop_request_notification_permission') return 'granted';
          if (command === 'desktop_schedule_reminders') return 0;
          if (command === 'desktop_get_app_version') return '2.0.0-test';
          return null;
        },
      },
    };
  }, settings);
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

async function testNativeRuntimeUsesConfiguredServerUrl() {
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
  console.log('✅ Native runtime config regression test passed');
}

await withFreshDb(run);
