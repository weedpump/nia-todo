#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const escape = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

globalThis.document = {
  createElement() {
    return {
      _text: '',
      set textContent(value) { this._text = String(value); },
      get innerHTML() { return escape(this._text); },
    };
  },
};

const { renderMarkdown } = await import('../web/static/js/core/utils.js');

const { sessionDeviceName, cleanSessionUserAgent } = await import('../web/static/js/core/device-labels.js');
const labelT = (key) => ({
  'settings.2fa.trustedDeviceUnknown': 'Unknown device',
  'settings.2fa.trustedDeviceBrowser': 'Browser',
  'settings.2fa.trustedDeviceDevice': 'Device',
}[key] || key);
assert.equal(sessionDeviceName({ user_agent: 'nia-todo-client(app=nia-todo;mode=native;platform=android;version=v2.3.2-dev) Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/125 Safari/537.36' }, labelT), 'Android App');
assert.equal(sessionDeviceName({ user_agent: 'nia-todo-client(app=nia-todo;mode=native;platform=windows;version=v2.3.2-dev) Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36' }, labelT), 'Windows App');
assert.equal(sessionDeviceName({ user_agent: 'nia-todo-client(app=nia-todo;mode=browser;platform=ipados;version=v2.10.4-dev) Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.14 Safari/605.1.15' }, labelT), 'Safari · iPadOS');
assert.equal(sessionDeviceName({ user_agent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/125 Mobile Safari/537.36 EdgA/125.0.0.0' }, labelT), 'Edge · Android');
assert.equal(sessionDeviceName({ user_agent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/125 Mobile Safari/537.36' }, labelT), 'Chrome · Android');
assert.equal(cleanSessionUserAgent('nia-todo-client(app=nia-todo;mode=native;platform=android;version=v2.3.2-dev) Mozilla/5.0'), 'Mozilla/5.0');

function assertNoExecutableHtml(name, html) {
  assert(!html.includes('<img'), `${name}: must not render img tags`);
  assert(!html.includes('<svg'), `${name}: must not render svg tags`);
  assert(!/<[^>]+\son\w+=/i.test(html), `${name}: must not render event handlers`);
  assert(!/<a\s[^>]*href=["']javascript:/i.test(html), `${name}: must not render javascript URLs`);
}

const payloads = {
  title: '<img src=x onerror=alert(1)>',
  codeBreakout: '`</code><img src=x onerror=alert(1)>`',
  boldPayload: '**<svg onload=alert(1)>**',
  linkText: '[<img src=x onerror=alert(1)>](https://example.com)',
  jsUrl: '[click](javascript:alert(1))',
};

for (const [name, payload] of Object.entries(payloads)) {
  const html = renderMarkdown(payload);
  assertNoExecutableHtml(name, html);
}

const safeLink = renderMarkdown('[docs](https://example.com/path?q=1)');
assert(safeLink.includes('<a href="https://example.com/path?q=1"'), 'safe HTTPS links should still render');
assert(safeLink.includes('rel="noopener noreferrer"'), 'external links must include noopener noreferrer');

const indexSource = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
assert(indexSource.includes('window.niaHardReloadApp = async function()'), 'boot retry must use an inline recovery function so it still works when app modules fail to load');
assert(indexSource.includes('navigator.onLine === false'), 'boot retry must not clear offline PWA caches while the browser reports offline');
assert(indexSource.includes('navigator.serviceWorker.getRegistrations') && indexSource.includes("scriptURL.endsWith('/sw.js')") && indexSource.includes('registration.unregister().catch'), 'boot retry must unregister nia-todo service workers before reloading and tolerate individual failures');
assert(indexSource.includes('caches.keys()') && indexSource.includes("name.indexOf('nia-todo') === 0") && indexSource.includes('caches.delete(name).catch'), 'boot retry must clear nia-todo CacheStorage before reloading and tolerate individual failures');
assert(indexSource.includes("url.searchParams.set('hardReload'"), 'boot retry must add a cache-busting hardReload query parameter');
assert(!indexSource.includes('id="boot-retry" style="display:none;" onclick="location.reload()"'), 'boot retry must not be a plain location.reload');

const cssSource = readFileSync(new URL('../web/static/style.css', import.meta.url), 'utf8');
assert(cssSource.includes('iOS WebKit zooms the page when focusing editable controls below 16px'), 'mobile iOS inputs must document why 16px focus font size is required');
assert(cssSource.includes('@supports (-webkit-touch-callout: none)') && cssSource.includes('font-size: 16px !important'), 'mobile iOS inputs/selects/textareas must stay at least 16px to prevent WebKit focus zoom');

const adminSource = readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8');
assert(adminSource.includes('hardReloadAfterServerUpdate'), 'admin server update reload must use explicit hard reload cleanup');
assert(adminSource.includes('navigator.serviceWorker.getRegistrations') && adminSource.includes("scriptURL?.endsWith('/sw.js')") && adminSource.includes('reg.unregister()'), 'admin server update reload must unregister stale nia-todo service workers');
assert(adminSource.includes('caches.keys()') && adminSource.includes("startsWith('nia-todo')") && adminSource.includes('caches.delete(name)'), 'admin server update reload must clear nia-todo CacheStorage');
assert(adminSource.includes('server-updated='), 'admin server update reload must navigate with a cache-busting query parameter');

const swSource = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
assert(!swSource.includes("caches.open(API_CACHE)"), 'service worker must not cache authenticated API responses');
assert(swSource.indexOf("url.pathname.startsWith('/api/avatars/')") < swSource.indexOf("url.pathname.startsWith('/api/')"), 'service worker must cache static avatars before the generic API network-only rule');
assert(swSource.includes("url.pathname.startsWith('/api/')") && swSource.includes('event.respondWith(fetch(event.request))'), 'API fetches must be network-only');

const authSessionSource = readFileSync(new URL('../web/static/js/features/auth-session.js', import.meta.url), 'utf8');
const userMenuSource = readFileSync(new URL('../web/static/js/features/user-menu.js', import.meta.url), 'utf8');
const userSettingsSource = readFileSync(new URL('../web/static/js/features/user-settings.js', import.meta.url), 'utf8');
const apiKeysSource = readFileSync(new URL('../web/static/js/features/api-keys.js', import.meta.url), 'utf8');
assert(!authSessionSource.includes('window.prompt') && !authSessionSource.includes('window.alert'), 'login/enrollment MFA must use inline or app UI, not browser prompt/alert dialogs');
assert(!authSessionSource.includes('window.confirm'), 'login remember-device choice must use inline checkbox, not browser confirm dialog');
assert(!userSettingsSource.includes('window.prompt') && !userSettingsSource.includes('window.confirm') && !userSettingsSource.includes('window.alert'), 'settings MFA/password confirmations must use in-app modal dialogs');
assert(!apiKeysSource.includes('prompt(') && !apiKeysSource.includes('confirm(') && !apiKeysSource.includes('alert('), 'API-key management must use in-app modal/status UI');
assert(authSessionSource.includes('login-remember-device'), 'login MFA must expose the 30-day trusted-device checkbox inline');
assert(authSessionSource.includes('login-mfa-switch-btn'), 'login MFA must expose a method switch when passkey and code methods are both available');
assert(authSessionSource.includes('if (RUNTIME_CAPABILITIES.native && codeMethod) return codeMethod'), 'native login MFA must prefer a code method over passkey when both are available');
assert(authSessionSource.includes("methods.includes('recovery_code') ? 'recovery_code'"), 'native/passkey-unavailable login MFA must prefer recovery_code before unusable passkey fallback');
assert(!userMenuSource.includes('Date.now()'), 'user menu avatar URLs must be stable so avatars can be cached offline');
assert(!userSettingsSource.includes('Date.now()'), 'settings avatar URLs must be stable so avatars can be cached offline');
assert(userSettingsSource.includes('hasExistingSecondFactor') && userSettingsSource.includes("&& hasExistingSecondFactor && !wasEnrollmentLocked) await ensureRecentMfa(t('settings.2fa.purpose.addPasskey'))"), 'passkey enrollment-only setup must not require an existing 2FA code');
assert(userSettingsSource.includes("promptSecurityPassword({ title: t('settings.2fa.addPasskey')"), 'passkey setup must explicitly ask for the account password before WebAuthn registration');

const nativeBridgeSource = readFileSync(new URL('../web/static/js/features/native-bridge.js', import.meta.url), 'utf8');
const desktopSource = readFileSync(new URL('../web/static/js/features/desktop-integration.js', import.meta.url), 'utf8');
const brainDumpSource = readFileSync(new URL('../web/static/js/features/braindump-live.js', import.meta.url), 'utf8');
assert(desktopSource.includes('if (event.repeat) return null'), 'hotkey capture must ignore repeated modifier keydown events');
assert(desktopSource.includes('if (isModifierKey(event)) return'), 'hotkey capture must not save a bare modifier as the main key');
assert(!desktopSource.includes('window.NiaAndroidNative'), 'desktop integration must use the native bridge adapter, not direct Android globals');
assert(!brainDumpSource.includes('window.NiaAndroidNative'), 'BrainDump must use the native bridge adapter, not direct Android globals');
assert(brainDumpSource.includes('aria-label="${escapeHtmlAttr(group.project)}"'), 'BrainDump project group labels must use attribute escaping, not HTML escaping');
assert(!desktopSource.includes('getTauriInvoke'), 'desktop integration must use the native bridge adapter, not direct Tauri invoke');
assert(desktopSource.includes('userId,'), 'native reminder schedules must carry the current user id for action isolation');

const downloadsSource = readFileSync(new URL('../web/static/js/features/app-downloads.js', import.meta.url), 'utf8');
assert(downloadsSource.includes('RUNTIME_CAPABILITIES.appDownloads && !isStandaloneDisplayMode()'), 'app downloads must only render when browser download capability is enabled, not native/PWA');
assert(!downloadsSource.includes('window.NiaAndroidNative'), 'app downloads must use the native bridge adapter for native app version lookup');
const themeSource = readFileSync(new URL('../web/static/js/features/theme.js', import.meta.url), 'utf8');
assert(!themeSource.includes('window.NiaAndroidNative') && !themeSource.includes('window.NiaAndroidSystemBars'), 'theme must use the native bridge adapter for Android system bars');
assert(nativeBridgeSource.includes('window.NiaAndroidNative'), 'native bridge is the only frontend feature module expected to access Android globals directly');
const appSource = readFileSync(new URL('../web/static/js/app.js', import.meta.url), 'utf8');
assert(!appSource.includes('window.NiaAndroidNative'), 'app core must consume notification actions through the native bridge, not Android globals');
assert(appSource.includes('actionUserId') && appSource.includes('currentUser.id'), 'native notification done actions must be checked against the current user');
const androidMainSource = readFileSync(new URL('../src-tauri/gen/android/app/src/main/java/de/tobiaskneidl/nia_todo/MainActivity.kt', import.meta.url), 'utf8');
assert(!androidMainSource.includes('indexedDB.open'), 'Android notification actions must not inject direct IndexedDB writes');
assert(androidMainSource.includes('consumePendingDoneAction'), 'Android notification actions must be handed to the web app through a pending action bridge');
assert(androidMainSource.includes('override fun onDestroy()') && androidMainSource.includes('cleanupNativeAudioRecording()'), 'Android native audio recorder must be released during Activity destruction');
assert(androidMainSource.includes('isTrustedLocalWebView()') && androidMainSource.includes('Native Aufnahme nur im lokalen App-Kontext verfügbar'), 'Android native audio recorder bridge must be limited to the trusted local WebView origin');
assert(androidMainSource.includes('Looper.myLooper() == Looper.getMainLooper()') && androidMainSource.includes('runOnUiThread') && androidMainSource.includes('latch.await(250, TimeUnit.MILLISECONDS)'), 'Android native audio origin gate must read WebView URL on the UI thread, not the JavaBridge thread');
assert(androidMainSource.includes('maxNativeAudioDurationMs') && androidMainSource.includes('maxNativeAudioBytes') && androidMainSource.includes('setMaxDuration(maxNativeAudioDurationMs)'), 'Android native audio recorder must enforce duration and size guards');
const androidReminderSource = readFileSync(new URL('../src-tauri/gen/android/app/src/main/java/de/tobiaskneidl/nia_todo/ReminderReceiver.kt', import.meta.url), 'utf8');
assert(androidReminderSource.includes('EXTRA_USER_ID') && androidReminderSource.includes('schedule.optString("userId"'), 'Android reminder actions must preserve the scheduled user id');
assert(swSource.includes('/static/js/features/app-downloads.js'), 'service worker must precache the app downloads module');
const serviceWorkerUpdatesSource = readFileSync(new URL('../web/static/js/features/service-worker-updates.js', import.meta.url), 'utf8');
assert(serviceWorkerUpdatesSource.includes('bundled app assets are loaded locally'), 'native apps must skip the web service worker because bundled app assets are local');
assert(serviceWorkerUpdatesSource.includes('scheduleUpdateCheck(\'startup\''), 'browser/PWA service worker update checks must run at startup, including before login');
assert(serviceWorkerUpdatesSource.includes("reloadWithCacheBuster('appUpdated')"), 'explicit web app updates must reload with a cache-busting appUpdated query parameter after controllerchange');
assert(serviceWorkerUpdatesSource.includes('updateReloadFallbackTimer') && serviceWorkerUpdatesSource.includes('controllerchange did not fire'), 'explicit web app updates must have a timeout fallback if controllerchange does not fire');
const forceReloadAppSource = serviceWorkerUpdatesSource.slice(serviceWorkerUpdatesSource.indexOf('async function forceReloadApp()'), serviceWorkerUpdatesSource.indexOf('  return {', serviceWorkerUpdatesSource.indexOf('async function forceReloadApp()')));
assert(forceReloadAppSource.includes('navigator.onLine === false') && forceReloadAppSource.indexOf('if (navigator.onLine === false)') < forceReloadAppSource.indexOf('try {'), 'login/sidebar force reload must return before cleanup/reload while the browser reports offline');
assert(serviceWorkerUpdatesSource.includes('navigator.serviceWorker.getRegistrations') && serviceWorkerUpdatesSource.includes('isNiaTodoServiceWorkerRegistration') && serviceWorkerUpdatesSource.includes('registration.unregister()'), 'login/sidebar force reload must unregister stale nia-todo service workers');
assert(serviceWorkerUpdatesSource.includes('caches.keys()') && serviceWorkerUpdatesSource.includes('isNiaTodoCacheName') && serviceWorkerUpdatesSource.includes('caches.delete(name)'), 'login/sidebar force reload must clear nia-todo CacheStorage');
assert(serviceWorkerUpdatesSource.includes("reloadWithCacheBuster('hardReload')"), 'login/sidebar force reload must add a cache-busting hardReload query parameter');
assert(downloadsSource.includes('showNativeUpdateModal'), 'native app updates must use the native update modal');
assert(downloadsSource.includes('deferUntilAfterLogin'), 'native app update prompts must be deferred until after login');
assert(downloadsSource.includes('validateDownloadEntry'), 'app download manifests must be validated before rendering');
assert(downloadsSource.includes("rawUrl.startsWith('/downloads/')"), 'app download URLs must be constrained to same-origin /downloads paths');
assert(downloadsSource.includes('DOWNLOAD_SHA_RE'), 'app download manifests must validate sha256 values');
assert(!downloadsSource.includes('target.innerHTML = downloads.map'), 'download buttons must not be rendered from manifest data via innerHTML');
assert(swSource.includes('/static/js/features/native-bridge.js'), 'service worker must precache the native bridge module');
assert(swSource.includes('isNeverCachePath') && swSource.includes("pathname.startsWith('/downloads/')"), 'service worker must classify downloads and their manifest as never-cache paths');
assert(swSource.includes('purgeNeverCacheEntries'), 'service worker must purge stale download manifest/artifacts from caches on activate/refresh');
assert(swSource.includes("cache: 'no-store'") && swSource.includes('isNeverCachePath(url.pathname)'), 'service worker must fetch downloads and app-downloads manifest with no-store');

const syncSource = readFileSync(new URL('../web/static/js/features/sync.js', import.meta.url), 'utf8');
assert(syncSource.includes('sanitizeQueueItem'), 'offline sync must sanitize queued actions');
assert(syncSource.includes('pickAllowed'), 'offline sync must whitelist payload fields');

const renderingSource = readFileSync(new URL('../web/static/js/features/app-rendering.js', import.meta.url), 'utf8');
assert(renderingSource.includes('editProject(${escapeHtmlAttr(JSON.stringify(project.id))})'), 'project edit onclick must quote string/temp IDs safely');
assert(renderingSource.includes('invite-action invite-accept') && renderingSource.includes('invite-action invite-decline'), 'invite actions should use compact dedicated buttons');

const toastSource = readFileSync(new URL('../web/static/js/features/toast-undo.js', import.meta.url), 'utf8');
assert(toastSource.includes("undoBtn.style.display = action ? '' : 'none'"), 'toast undo button must be hidden when there is no undo action');

console.log('✅ Frontend-Security-Regressionen bestanden');
