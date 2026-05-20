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
assert(swSource.includes("url.pathname.startsWith('/api/')") && swSource.includes('event.respondWith(fetch(event.request))'), 'API fetches must be network-only');

const syncSource = readFileSync(new URL('../web/static/js/features/sync.js', import.meta.url), 'utf8');
assert(syncSource.includes('sanitizeQueueItem'), 'offline sync must sanitize queued actions');
assert(syncSource.includes('pickAllowed'), 'offline sync must whitelist payload fields');

console.log('✅ Frontend-Security-Regressionen bestanden');
