import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const mainActivityPath = path.join(repoRoot, 'src-tauri/gen/android/app/src/main/java/de/tobiaskneidl/nia_todo/MainActivity.kt');
const source = fs.readFileSync(mainActivityPath, 'utf8');

assert.match(source, /clearStaleWebViewCachesOnVersionChange\(\)/, 'Android must run WebView cache migration before WebView startup');
assert.match(source, /BuildConfig\.VERSION_NAME/, 'Android cache migration must be version-gated');
assert.match(source, /lastUpdateTime/, 'Android cache migration must also account for same-version APK reinstalls');
assert.match(source, /File\(dataDir, "app_webview\/Default"\)/, 'Android cache migration must target the default WebView profile');

for (const volatileDir of ['Service Worker', 'Cache', 'Code Cache', 'GPUCache']) {
  assert.ok(source.includes(`"${volatileDir}"`), `Android cache migration must clear ${volatileDir}`);
}

assert.ok(!/File\(dataDir, "app_webview"\)\.deleteRecursively\(\)/.test(source), 'Android cache migration must not delete the full WebView profile');
assert.ok(!/File\(dataDir, "app_webview\/Default"\)\.deleteRecursively\(\)/.test(source), 'Android cache migration must not delete the full Default profile');

const onCreateIndex = source.indexOf('override fun onCreate');
const migrationCallIndex = source.indexOf('clearStaleWebViewCachesOnVersionChange()', onCreateIndex);
const superOnCreateIndex = source.indexOf('super.onCreate(savedInstanceState)', onCreateIndex);
assert.ok(migrationCallIndex > onCreateIndex && migrationCallIndex < superOnCreateIndex, 'Android cache migration must run before Tauri creates the WebView');

const manifest = fs.readFileSync(path.join(repoRoot, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'), 'utf8');
assert.match(manifest, /android:scheme="nia-todo"/, 'Android manifest must register nia-todo custom URL scheme');
assert.match(manifest, /android:host="oidc"/, 'Android manifest must route OIDC callbacks to the app');
assert.match(source, /handleOidcIntent\(intent\)/, 'Android activity must process cold-start OIDC callback intents');
assert.match(source, /override fun onNewIntent/, 'Android activity must process warm OIDC callback intents');
assert.match(source, /__niaNativeOidcCallback/, 'Android activity must dispatch native OIDC callbacks into the WebView bridge');

console.log('✅ Native Android WebView cache migration regression passed');
