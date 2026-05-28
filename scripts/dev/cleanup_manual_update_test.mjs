#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const SERVICE = process.env.NIA_TODO_SERVICE || 'nia-todo-dev';
const PID_FILE = `${ROOT}/.local/manual-update-release/http-server.pid`;
const RELEASE_DIR = `${ROOT}/.local/manual-update-release`;
const SOURCE_CONFIG = '/etc/nia-todo/update-source.env';
const DROPIN_FILE = `/etc/systemd/system/${SERVICE}.service.d/server-update-manual-test.conf`;

function sh(cmd, args = [], options = {}) {
  return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...options });
}

if (process.getuid && process.getuid() !== 0) {
  throw new Error('Run as root.');
}

if (existsSync(PID_FILE)) {
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
}
rmSync(RELEASE_DIR, { recursive: true, force: true });
if (existsSync(SOURCE_CONFIG)) unlinkSync(SOURCE_CONFIG);
if (existsSync(DROPIN_FILE)) unlinkSync(DROPIN_FILE);
try { sh('dpkg', ['--purge', 'nia-todo']); } catch {}
try { sh('git', ['restore', 'web/static/js/core/config.js'], { cwd: ROOT }); } catch {}
sh('systemctl', ['daemon-reload']);
sh('systemctl', ['restart', SERVICE]);
console.log('✅ Manual server-update test cleanup complete.');
