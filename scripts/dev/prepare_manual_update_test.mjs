#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const VERSION = process.argv[2] || process.env.NIA_TODO_MANUAL_UPDATE_VERSION || '2.5.5';
const PORT = process.env.NIA_TODO_MANUAL_UPDATE_PORT || '8765';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const RELEASE_DIR = `${ROOT}/.local/manual-update-release`;
const PID_FILE = `${ROOT}/.local/manual-update-release/http-server.pid`;
const HELPER_SRC = `${ROOT}/packaging/scripts/nia-todo-server-update.sh`;
const HELPER_DST = '/usr/local/bin/nia-todo-server-update';
const SOURCE_CONFIG = '/etc/nia-todo/update-source.env';
const STATUS_FILE = '/var/cache/nia-todo/updates/status.json';
const SERVICE = process.env.NIA_TODO_SERVICE || 'nia-todo-dev';
const DROPIN_DIR = `/etc/systemd/system/${SERVICE}.service.d`;
const DROPIN_FILE = `${DROPIN_DIR}/server-update-manual-test.conf`;

function sh(cmd, args = [], options = {}) {
  return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...options });
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

if (process.getuid && process.getuid() !== 0) {
  throw new Error('Run as root. This prepares systemd/drop-in/helper state for manual update testing.');
}

console.log('🧹 Resetting previous manual test package state...');
try { sh('dpkg', ['--purge', 'nia-todo']); } catch {}
try { sh('git', ['restore', 'web/static/js/core/config.js'], { cwd: ROOT }); } catch {}

console.log(`📦 Creating real manual test package v${VERSION}...`);
sh('python3', ['scripts/dev/make-update-test-release.py', VERSION, '--output', RELEASE_DIR, '--base-url', BASE_URL, '--dev-app-root', ROOT], { cwd: ROOT });

if (existsSync(PID_FILE)) {
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
}
console.log(`🌐 Starting local release server on ${BASE_URL}...`);
const server = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1'], {
  cwd: RELEASE_DIR,
  stdio: ['ignore', 'ignore', 'ignore'],
  detached: true,
});
server.unref();
writeFileSync(PID_FILE, `${server.pid}\n`, 'utf8');
await waitForHttp(`${BASE_URL}/latest.json`);

console.log('🔧 Installing helper and dev-service test overrides...');
rmSync(STATUS_FILE, { force: true });
sh('install', ['-m', '755', '-o', 'root', '-g', 'root', HELPER_SRC, HELPER_DST]);
mkdirSync(dirname(SOURCE_CONFIG), { recursive: true });
writeFileSync(SOURCE_CONFIG, `RELEASE_API_LATEST=${BASE_URL}/latest.json\nSERVICE_NAME=${SERVICE}\n`, 'utf8');
mkdirSync(DROPIN_DIR, { recursive: true });
writeFileSync(DROPIN_FILE, `[Service]\nEnvironment=NIA_TODO_SERVICE_NAME=${SERVICE}\nEnvironment=NIA_TODO_UPDATE_CURRENT_VERSION=2.5.4\nEnvironment=NIA_TODO_UPDATE_RELEASE_API_URL=${BASE_URL}/latest.json\n`, 'utf8');
sh('systemctl', ['daemon-reload']);
sh('systemctl', ['restart', SERVICE]);

console.log('\n✅ Manual server-update test is ready.');
console.log(`Admin panel: http://localhost:8754/admin`);
console.log(`Release API: ${BASE_URL}/latest.json`);
console.log(`Target version: v${VERSION}`);
console.log('\nNow open the admin panel, sign in, and click “Install update”.');
console.log('Expected result: progress updates, service restart, hard reload prompt, then server version v' + VERSION + '.');
console.log('\nCleanup afterwards: node scripts/dev/cleanup_manual_update_test.mjs');
