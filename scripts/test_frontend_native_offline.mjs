#!/usr/bin/env node
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFreshDb, launchPage, BASE_URL, USERNAME, USER_PASSWORD } from './frontend_test_lib.mjs';

const DEV_DIR = process.env.NIA_TODO_DEV_DIR || dirname(dirname(fileURLToPath(import.meta.url)));

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const LOCAL_PORT = Number(process.env.NIA_TODO_NATIVE_TEST_PORT || await getFreePort());
const LOCAL_URL = `http://tauri.localhost:${LOCAL_PORT}`;
const BASE_ORIGIN = new URL(BASE_URL).origin;

const EXPECTED_NATIVE_STATIC_404_PATHS = [
  '/api/oidc/status',
  '/api/password-setup/features',
  '/api/setup/status',
];

function shouldSuppressNativeStaticServerLogLine(line) {
  if (line.includes('code 404, message File not found')) return true;
  return EXPECTED_NATIVE_STATIC_404_PATHS.some(path => line.includes(`GET ${path} `) && line.includes(' 404 '));
}

function startStaticServer() {
  const server = spawn('python3', ['-m', 'http.server', String(LOCAL_PORT), '--bind', '127.0.0.1', '--directory', 'web'], {
    cwd: DEV_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.setEncoding('utf8');
  let stderrBuffer = '';
  server.stderr.on('data', chunk => {
    stderrBuffer += chunk;
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!shouldSuppressNativeStaticServerLogLine(line)) {
        process.stderr.write(`[native-static-server] ${line}\n`);
      }
    }
  });
  server.stderr.on('end', () => {
    if (stderrBuffer && !shouldSuppressNativeStaticServerLogLine(stderrBuffer)) {
      process.stderr.write(`[native-static-server] ${stderrBuffer}\n`);
    }
  });
  return server;
}

async function fetchLocalIndexStatus() {
  return await new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: LOCAL_PORT, path: '/index.html' }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.setTimeout(1_000, () => request.destroy(new Error('Native local asset server probe timed out')));
  });
}

async function waitForStaticServer(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await fetchLocalIndexStatus();
      if (status >= 200 && status < 300) return;
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

async function assertNoNativeServiceWorker(page) {
  const state = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false, registrations: 0, controlled: false };
    const registrations = await navigator.serviceWorker.getRegistrations();
    return { supported: true, registrations: registrations.length, controlled: Boolean(navigator.serviceWorker.controller) };
  });
  if (state.registrations !== 0 || state.controlled) {
    throw new Error(`Native runtime must not depend on web Service Worker: ${JSON.stringify(state)}`);
  }
}

async function loginNativeApp(page) {
  await page.goto(LOCAL_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 15_000 });
  await page.fill('#login-username', USERNAME);
  await page.fill('#login-password', USER_PASSWORD);
  await page.click('button.login-btn');
  await waitForAppReady(page);
}

async function blockBackendRequests(context) {
  await context.route(`${BASE_ORIGIN}/**`, route => route.abort('internetdisconnected'));
}

async function run() {
  console.log('🧊 Running native offline cold-start regression test...');
  const staticServer = startStaticServer();
  const { browser, page, dumpErrors } = await launchPage();

  try {
    await waitForStaticServer();
    await installTauriStub(page.context(), BASE_URL);

    // Seed native auth/session and IndexedDB from bundled local assets while backend is online.
    await loginNativeApp(page);
    await assertNoNativeServiceWorker(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await assertNoNativeServiceWorker(page);

    // Native bundles the web app locally. Simulate backend/API outage only; local tauri assets stay available.
    await blockBackendRequests(page.context());

    const firstOffline = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await firstOffline.goto(LOCAL_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await waitForAppReady(firstOffline);
    await assertNoNativeServiceWorker(firstOffline);
    await firstOffline.close();

    const secondOffline = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await secondOffline.goto(LOCAL_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await waitForAppReady(secondOffline);
    await assertNoNativeServiceWorker(secondOffline);
    await secondOffline.close();

    console.log('✅ Native offline cold-start regression test passed');
  } catch (error) {
    console.log('DEBUG frontend errors:', JSON.stringify(dumpErrors()));
    throw error;
  } finally {
    await browser.close();
    staticServer.kill('SIGTERM');
  }
}

await withFreshDb(run);
