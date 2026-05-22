import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tauriConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
const hookPath = tauriConfig.bundle?.windows?.nsis?.installerHooks;

assert.equal(hookPath, 'windows/nsis-hooks.nsh', 'NSIS installer hook must be configured for native cache migration');

const hookSource = fs.readFileSync(path.join(repoRoot, 'src-tauri', hookPath), 'utf8');

assert.match(hookSource, /NSIS_HOOK_PREINSTALL/, 'cache migration must run before install/update');
for (const volatileDir of ['Service Worker', 'Cache', 'Code Cache', 'GPUCache']) {
  assert.ok(hookSource.includes(`$LOCALAPPDATA\\${'${BUNDLEID}'}\\${volatileDir}`), `installer hook must clear ${volatileDir}`);
}

assert.ok(!hookSource.includes('$APPDATA\\${BUNDLEID}'), 'installer hook must not delete roaming app config/settings');
assert.ok(!/IndexedDB/i.test(hookSource), 'installer hook must not delete IndexedDB/offline data');
assert.ok(!/desktop-settings\.json/i.test(hookSource), 'installer hook must not delete desktop settings');

console.log('✅ Native Windows installer cache hook regression passed');
