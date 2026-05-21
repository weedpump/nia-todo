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

const userMenuSource = readFileSync(new URL('../web/static/js/features/user-menu.js', import.meta.url), 'utf8');
const userSettingsSource = readFileSync(new URL('../web/static/js/features/user-settings.js', import.meta.url), 'utf8');
assert(!userMenuSource.includes('Date.now()'), 'user menu avatar URLs must be stable so avatars can be cached offline');
assert(!userSettingsSource.includes('Date.now()'), 'settings avatar URLs must be stable so avatars can be cached offline');

const desktopSource = readFileSync(new URL('../web/static/js/features/desktop-integration.js', import.meta.url), 'utf8');
assert(desktopSource.includes('if (event.repeat) return null'), 'hotkey capture must ignore repeated modifier keydown events');
assert(desktopSource.includes('if (isModifierKey(event)) return'), 'hotkey capture must not save a bare modifier as the main key');

const downloadsSource = readFileSync(new URL('../web/static/js/features/app-downloads.js', import.meta.url), 'utf8');
assert(downloadsSource.includes('!isTauriApp() && !isStandaloneDisplayMode()'), 'app downloads must only render in the normal browser, not desktop/PWA');
assert(swSource.includes('/static/js/features/app-downloads.js'), 'service worker must precache the app downloads module');

const syncSource = readFileSync(new URL('../web/static/js/features/sync.js', import.meta.url), 'utf8');
assert(syncSource.includes('sanitizeQueueItem'), 'offline sync must sanitize queued actions');
assert(syncSource.includes('pickAllowed'), 'offline sync must whitelist payload fields');

const renderingSource = readFileSync(new URL('../web/static/js/features/app-rendering.js', import.meta.url), 'utf8');
assert(renderingSource.includes('editProject(${escapeHtmlAttr(JSON.stringify(project.id))})'), 'project edit onclick must quote string/temp IDs safely');
assert(renderingSource.includes('invite-action invite-accept') && renderingSource.includes('invite-action invite-decline'), 'invite actions should use compact dedicated buttons');

const toastSource = readFileSync(new URL('../web/static/js/features/toast-undo.js', import.meta.url), 'utf8');
assert(toastSource.includes("undoBtn.style.display = action ? '' : 'none'"), 'toast undo button must be hidden when there is no undo action');

console.log('✅ Frontend-Security-Regressionen bestanden');
