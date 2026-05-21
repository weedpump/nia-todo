#!/usr/bin/env node
import { withFreshDb, launchPage, BASE_URL } from './frontend_test_lib.mjs';

async function waitForAppReady(page, timeout = 20_000) {
  await page.locator('#boot-overlay').waitFor({ state: 'hidden', timeout });
  await page.locator('#user-menu-button').waitFor({ state: 'visible', timeout: 5_000 });
}

async function waitForServiceWorker(page) {
  await page.waitForFunction(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready;
    return Boolean(reg?.active);
  }, null, { timeout: 15_000 });
}

async function run() {
  console.log('🧊 Running native offline cold-start regression test...');
  const { browser, page, loginApp, dumpErrors } = await launchPage();

  try {
    await loginApp();

    // First native launch seeds the app shell in the Service Worker cache.
    await page.goto(`${BASE_URL}/?nativeApp=tauri`, { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await waitForServiceWorker(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);

    await page.context().setOffline(true);

    // First offline cold start: must load from cache.
    const firstOffline = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await firstOffline.goto(`${BASE_URL}/?nativeApp=tauri`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await waitForAppReady(firstOffline);
    await firstOffline.close();

    // Second offline cold start reproduces the Android WebView failure when the
    // first offline launch removed the SW: navigation becomes ERR_NAME_NOT_RESOLVED.
    const secondOffline = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await secondOffline.goto(`${BASE_URL}/?nativeApp=tauri`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
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
  }
}

await withFreshDb(run);
