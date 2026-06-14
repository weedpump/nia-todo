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
assert.match(manifest, /android:name="\.OidcCallbackActivity"/, 'Android manifest must route OIDC callbacks through a trampoline activity');
assert.match(manifest, /android:scheme="nia-todo"/, 'Android manifest must register nia-todo custom URL scheme');
assert.match(manifest, /android:host="oidc"/, 'Android manifest must route OIDC callbacks to the app');
const mainActivityBlock = manifest.slice(manifest.indexOf('android:name=".MainActivity"'), manifest.indexOf('android:name=".OidcCallbackActivity"'));
assert.doesNotMatch(mainActivityBlock, /android:scheme="nia-todo"/, 'MainActivity must not directly own the OIDC VIEW intent filter');
const callbackActivitySource = fs.readFileSync(path.join(repoRoot, 'src-tauri/gen/android/app/src/main/java/de/tobiaskneidl/nia_todo/OidcCallbackActivity.kt'), 'utf8');
assert.match(callbackActivitySource, /putString\(pendingOidcCallbackKey, uri\.toString\(\)\)/, 'OIDC trampoline activity must persist callback URL for MainActivity');
assert.match(callbackActivitySource, /Intent\(this, MainActivity::class\.java\)/, 'OIDC trampoline activity must launch MainActivity after storing callback');
assert.match(source, /handleOidcIntent\(intent\)/, 'Android activity must still tolerate direct cold-start OIDC callback intents');
assert.match(source, /override fun onNewIntent/, 'Android activity must still tolerate warm OIDC callback intents');
assert.match(source, /storeOidcCallbackForWebLayer\(uri\.toString\(\)\)/, 'Android activity must store native OIDC callbacks for web-layer consumption');
assert.match(source, /consumePendingOidcCallback\(\)/, 'Android bridge must expose explicit pending OIDC callback consumption');
assert.match(source, /configuredPasskeyOrigin = canonical/, 'Android passkey bridge must rebind when the configured server URL changes without requiring an app restart');
assert.doesNotMatch(source, /if \(configuredPasskeyOrigin == null\) configuredPasskeyOrigin = canonical/, 'Android passkey bridge must not permanently pin the first configured server URL for the process');
assert.match(source, /pendingOidcCallbackUrl = url/, 'Android must keep OIDC callbacks pending when WebView/JS is not ready');
assert.match(source, /pendingOidcCallbackKey/, 'Android bridge must read persisted trampoline OIDC callbacks');
assert.doesNotMatch(source, /evaluateJavascript[\s\S]{0,240}__niaNativeOidcCallback/, 'Android must not push OIDC callbacks via evaluateJavascript during deep-link startup');
assert.doesNotMatch(source, /fun openExternal\([\s\S]*?FLAG_ACTIVITY_NEW_TASK[\s\S]*?startActivity/, 'Android external browser launch should stay in the current task stack');

const nativeBridge = fs.readFileSync(path.join(repoRoot, 'web/static/js/features/native-bridge.js'), 'utf8');
assert.match(nativeBridge, /consumePendingOidcCallback/, 'Native bridge must consume pending Android OIDC callbacks after JS listener setup');
assert.match(nativeBridge, /lastDelivered/, 'Native bridge must deduplicate native OIDC callback delivery');

console.log('✅ Native Android WebView cache migration regression passed');
