#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { withFreshDb, launchPage, ADMIN_PASSWORD, BASE_URL, SERVICE, waitForService } from '../frontend_test_lib.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const VERSION = process.env.NIA_TODO_UPDATE_TEST_VERSION || '2.5.5';
const RELEASE_DIR = `${ROOT}/.local/update-test-release-real`;
const RELEASE_PORT = process.env.NIA_TODO_UPDATE_TEST_PORT || '8765';
const RELEASE_URL = `http://127.0.0.1:${RELEASE_PORT}`;
const LATEST_URL = `${RELEASE_URL}/latest.json`;
const HELPER_SRC = `${ROOT}/packaging/scripts/nia-todo-server-update.sh`;
const HELPER_DST = '/usr/local/bin/nia-todo-server-update';
const SOURCE_CONFIG = '/etc/nia-todo/update-source.env';
const DROPIN_DIR = `/etc/systemd/system/${SERVICE}.service.d`;
const DROPIN_FILE = `${DROPIN_DIR}/server-update-test.conf`;

function sh(cmd, args = [], options = {}) {
  return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...options });
}

function maybeRead(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function restoreFile(path, content) {
  if (content == null) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

async function waitForHttp(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`HTTP server not ready: ${url}`);
}

async function main() {
  if (process.getuid && process.getuid() !== 0) {
    throw new Error('This integration test must run as root because it installs a real test .deb and manages systemd drop-ins.');
  }

  const oldHelper = maybeRead(HELPER_DST);
  const oldSourceConfig = maybeRead(SOURCE_CONFIG);
  const oldDropin = maybeRead(DROPIN_FILE);
  let server;

  try {
    console.log('🧪 Creating local fake release assets...');
    sh('python3', ['scripts/dev/make-update-test-release.py', VERSION, '--output', RELEASE_DIR, '--base-url', RELEASE_URL], { cwd: ROOT });

    console.log('🌐 Serving fake release locally...');
    server = spawn('python3', ['-m', 'http.server', RELEASE_PORT, '--bind', '127.0.0.1'], { cwd: RELEASE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    await waitForHttp(LATEST_URL);

    console.log('🔧 Installing test helper + temporary dev service overrides...');
    copyFileSync(HELPER_SRC, HELPER_DST);
    sh('chmod', ['755', HELPER_DST]);
    sh('chown', ['root:root', HELPER_DST]);
    mkdirSync(dirname(SOURCE_CONFIG), { recursive: true });
    writeFileSync(SOURCE_CONFIG, `RELEASE_API_LATEST=${LATEST_URL}\nSERVICE_NAME=${SERVICE}\n`, 'utf8');
    mkdirSync(DROPIN_DIR, { recursive: true });
    writeFileSync(DROPIN_FILE, `[Service]\nEnvironment=NIA_TODO_SERVICE_NAME=${SERVICE}\nEnvironment=NIA_TODO_UPDATE_CURRENT_VERSION=2.5.4\nEnvironment=NIA_TODO_UPDATE_RELEASE_API_URL=${LATEST_URL}\n`, 'utf8');
    sh('systemctl', ['daemon-reload']);

    await withFreshDb(async () => {
      const { browser, page, waitForText, visible, consoleErrors, pageErrors } = await launchPage();
      try {
        console.log('🖱️  Opening admin panel and starting real update...');
        await page.goto(`${BASE_URL}/admin`, { waitUntil: 'domcontentloaded' });
        await visible('#admin-login-password');
        await page.fill('#admin-login-password', ADMIN_PASSWORD);
        await page.click('button:has-text("Sign in"), button:has-text("Anmelden")');
        await visible('#server-update-card', 15_000);
        await waitForText(`Update available`, 20_000);
        await page.locator('#server-update-install').waitFor({ state: 'visible', timeout: 10_000 });
        await page.locator('#server-update-install').click();
        await page.locator('#admin-dialog-confirm').click();
        await waitForText('Update to v', 10_000);
        await waitForText('Hard reload required', 60_000);
        await waitForText('Server update complete', 20_000);
        await page.locator('#admin-dialog-confirm').click();
        await page.waitForURL(/server-updated=/, { timeout: 30_000 });
        const filteredConsoleErrors = consoleErrors.filter(message => {
          if (message.includes('Failed to load resource: the server responded with a status of 404')) return false;
          // Expected during this integration test: the update helper intentionally
          // restarts the dev service while the browser is still polling/reloading.
          if (message.includes('Failed to load resource: net::ERR_CONNECTION_REFUSED')) return false;
          return true;
        });
        if (pageErrors.length || filteredConsoleErrors.length) {
          throw new Error(`Frontend emitted errors:\npageErrors=${JSON.stringify(pageErrors)}\nconsoleErrors=${JSON.stringify(filteredConsoleErrors)}`);
        }
      } finally {
        await browser.close();
      }
    });

    console.log('🧹 Removing fake nia-todo Debian package from dpkg database...');
    try { sh('dpkg', ['--purge', 'nia-todo']); } catch {}
    await waitForService();
    console.log('✅ Real server update integration test passed');
  } finally {
    if (server) server.kill('SIGTERM');
    restoreFile(HELPER_DST, oldHelper);
    if (oldHelper == null && existsSync(HELPER_DST)) unlinkSync(HELPER_DST);
    restoreFile(SOURCE_CONFIG, oldSourceConfig);
    restoreFile(DROPIN_FILE, oldDropin);
    sh('systemctl', ['daemon-reload']);
    try { sh('systemctl', ['restart', SERVICE]); await waitForService(); } catch {}
    try { sh('dpkg', ['--purge', 'nia-todo']); } catch {}
    rmSync(RELEASE_DIR, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
