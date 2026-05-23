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
assert(authSessionSource.includes("methods.includes('recovery_code') ? 'recovery_code'"), 'native/passkey-unavailable login MFA must prefer recovery_code before unusable passkey fallback');
assert(!userMenuSource.includes('Date.now()'), 'user menu avatar URLs must be stable so avatars can be cached offline');
assert(!userSettingsSource.includes('Date.now()'), 'settings avatar URLs must be stable so avatars can be cached offline');

const nativeBridgeSource = readFileSync(new URL('../web/static/js/features/native-bridge.js', import.meta.url), 'utf8');
const desktopSource = readFileSync(new URL('../web/static/js/features/desktop-integration.js', import.meta.url), 'utf8');
assert(desktopSource.includes('if (event.repeat) return null'), 'hotkey capture must ignore repeated modifier keydown events');
assert(desktopSource.includes('if (isModifierKey(event)) return'), 'hotkey capture must not save a bare modifier as the main key');
assert(!desktopSource.includes('window.NiaAndroidNative'), 'desktop integration must use the native bridge adapter, not direct Android globals');
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
const androidReminderSource = readFileSync(new URL('../src-tauri/gen/android/app/src/main/java/de/tobiaskneidl/nia_todo/ReminderReceiver.kt', import.meta.url), 'utf8');
assert(androidReminderSource.includes('EXTRA_USER_ID') && androidReminderSource.includes('schedule.optString("userId"'), 'Android reminder actions must preserve the scheduled user id');
assert(swSource.includes('/static/js/features/app-downloads.js'), 'service worker must precache the app downloads module');
const serviceWorkerUpdatesSource = readFileSync(new URL('../web/static/js/features/service-worker-updates.js', import.meta.url), 'utf8');
assert(serviceWorkerUpdatesSource.includes('Web-app update prompt suppressed in native runtime'), 'native apps must not show the web app reload update modal');
assert(downloadsSource.includes('showNativeUpdateModal'), 'native app updates must use the native update modal');
assert(downloadsSource.includes('validateDownloadEntry'), 'app download manifests must be validated before rendering');
assert(downloadsSource.includes("rawUrl.startsWith('/downloads/')"), 'app download URLs must be constrained to same-origin /downloads paths');
assert(downloadsSource.includes('DOWNLOAD_SHA_RE'), 'app download manifests must validate sha256 values');
assert(!downloadsSource.includes('target.innerHTML = downloads.map'), 'download buttons must not be rendered from manifest data via innerHTML');
assert(swSource.includes('/static/js/features/native-bridge.js'), 'service worker must precache the native bridge module');

const syncSource = readFileSync(new URL('../web/static/js/features/sync.js', import.meta.url), 'utf8');
assert(syncSource.includes('sanitizeQueueItem'), 'offline sync must sanitize queued actions');
assert(syncSource.includes('pickAllowed'), 'offline sync must whitelist payload fields');

const renderingSource = readFileSync(new URL('../web/static/js/features/app-rendering.js', import.meta.url), 'utf8');
assert(renderingSource.includes('editProject(${escapeHtmlAttr(JSON.stringify(project.id))})'), 'project edit onclick must quote string/temp IDs safely');
assert(renderingSource.includes('invite-action invite-accept') && renderingSource.includes('invite-action invite-decline'), 'invite actions should use compact dedicated buttons');

const toastSource = readFileSync(new URL('../web/static/js/features/toast-undo.js', import.meta.url), 'utf8');
assert(toastSource.includes("undoBtn.style.display = action ? '' : 'none'"), 'toast undo button must be hidden when there is no undo action');

console.log('✅ Frontend-Security-Regressionen bestanden');
