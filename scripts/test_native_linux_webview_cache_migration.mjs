import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tauriSourcePath = path.join(repoRoot, 'src-tauri/src/lib.rs');
const source = fs.readFileSync(tauriSourcePath, 'utf8');

assert.match(source, /clear_linux_webview_caches_on_version_change\(_app\.handle\(\)\)/, 'Linux must run WebView cache migration during desktop setup');
assert.match(source, /linux-webview-cache-version/, 'Linux cache migration must be version-gated');
assert.match(source, /env!\("CARGO_PKG_VERSION"\)/, 'Linux cache migration must use the packaged app version');
assert.match(source, /std::env::current_exe\(\)/, 'Linux cache migration must include the installed executable timestamp');
assert.match(source, /metadata\.modified\(\)/, 'Linux cache migration must catch same-version package reinstalls');
assert.match(source, /app\.path\(\)\.app_cache_dir\(\)/, 'Linux cache migration must target the per-user app cache directory');
assert.match(source, /app\.path\(\)\.app_config_dir\(\)/, 'Linux cache migration marker must live in persistent app config');

for (const volatileDir of ['WebKitCache', 'Service Worker', 'Cache', 'Code Cache', 'GPUCache']) {
  assert.ok(source.includes(`"${volatileDir}"`), `Linux cache migration must clear ${volatileDir}`);
}

assert.doesNotMatch(source, /app_data_dir\(\)[\s\S]{0,400}remove_dir_all/, 'Linux cache migration must not delete app data or settings');
assert.doesNotMatch(source, /app_config_dir\(\)[\s\S]{0,400}remove_dir_all/, 'Linux cache migration must not delete app config or desktop settings');
assert.doesNotMatch(source, /Local Storage["']?\)/, 'Linux cache migration must not target local storage');
assert.doesNotMatch(source, /IndexedDB["']?\)/, 'Linux cache migration must not target IndexedDB');

const setupIndex = source.indexOf('.setup(|_app|');
const migrationCallIndex = source.indexOf('clear_linux_webview_caches_on_version_change(_app.handle())', setupIndex);
const buildTrayIndex = source.indexOf('build_tray(_app)?', setupIndex);
assert.ok(migrationCallIndex > setupIndex && migrationCallIndex < buildTrayIndex, 'Linux cache migration must run before normal desktop UI setup continues');

console.log('✅ Native Debian WebView cache migration regression passed');
