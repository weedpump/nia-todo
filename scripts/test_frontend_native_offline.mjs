#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { withFreshDb, launchPage, BASE_URL, USERNAME, USER_PASSWORD } from './frontend_test_lib.mjs';

const LOCAL_PORT = Number(process.env.NIA_TODO_NATIVE_TEST_PORT || 8765);
const LOCAL_URL = `http://tauri.localhost:${LOCAL_PORT}`;

function startStaticServer() {
  const child = spawn('python3', ['-m', 'http.server', String(LOCAL_PORT), '--bind', '127.0.0.1', '--directory', 'web'], {
    cwd: '~/projects/nia-todo-dev',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

async function waitForStaticServer(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${LOCAL_PORT}/index.html`, { cache: 'no-store' });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Native local asset server not ready: ${LOCAL_URL}`);
}

async function installTauriStub(context, serverUrl) {
  await context.addInitScript((configuredServerUrl) => {
    window.__TAURI__ = {
      core: {
        invoke: async (command, args = {}) => {
          window.__nativeInvokeCalls = window.__nativeInvokeCalls || [];
          window.__nativeInvokeCalls.push({ command, args });
          if (command === 'desktop_get_settings') return { serverUrl: configuredServerUrl };
          if (command === 'desktop_set_server_url') return { serverUrl: args.serverUrl };
          if (command === 'desktop_request_notification_permission') return 'granted';
          if (command === 'desktop_schedule_reminders') return 0;
          if (command === 'desktop_get_app_version') return '2.0.0-test';
          return null;
        },
      },
    };
  }, serverUrl);
}

async function waitForAppReady(page, timeout = 20_000) {
  await page.locator('#boot-overlay').waitFor({ state: 'hidden', timeout });
  await page.locator('#user-menu-button').waitFor({ state: 'visible', timeout: 5_000 });
}

async function waitForServiceWorker(page) {
  await page.waitForFunction(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready;
    if (reg && !navigator.serviceWorker.controller) {
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, 5000);
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
    }
    return Boolean(reg?.active && navigator.serviceWorker.controller);
  }, null, { timeout: 20_000 });
}

async function loginNativeApp(page) {
  await page.goto(LOCAL_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 15_000 });
  await page.fill('#login-username', USERNAME);
  await page.fill('#login-password', USER_PASSWORD);
  await page.click('button.login-btn');
  await waitForAppReady(page);
}

async function run() {
  console.log('🧊 Running native offline cold-start regression test...');
  const staticServer = startStaticServer();
  const { browser, page, dumpErrors } = await launchPage();

  try {
    await waitForStaticServer();
    await installTauriStub(page.context(), BASE_URL);

    // Seed auth, IndexedDB data and the Service Worker cache from the local bundled app origin.
    await loginNativeApp(page);
    await waitForServiceWorker(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);

    await page.context().setOffline(true);

    // First offline cold start: must load the bundled app shell from the local SW cache.
    const firstOffline = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await firstOffline.goto(LOCAL_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await waitForAppReady(firstOffline);
    await firstOffline.close();

    // Second offline cold start protects against regressions where the first offline launch
    // unregisters or invalidates the native local app shell cache.
    const secondOffline = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await secondOffline.goto(LOCAL_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await waitForAppReady(secondOffline);
    await secondOffline.close();

    await page.context().setOffline(false);
    console.log('✅ Native offline cold-start regression test passed');
  } catch (error) {
    console.log('DEBUG frontend errors:', JSON.stringify(dumpErrors()));
    throw error;
  } finally {
    await page.context().setOffline(false).catch(() => {});
    await browser.close();
    staticServer.kill('SIGTERM');
  }
}

await withFreshDb(run);
