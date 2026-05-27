#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');

const index = read('web/index.html');
const downloads = read('web/static/js/features/app-downloads.js');
const css = read('web/static/style.css');
const sw = read('web/sw.js');
const de = JSON.parse(read('web/static/i18n/de.json'));
const en = JSON.parse(read('web/static/i18n/en.json'));

assert(index.includes('login-download-panel'), 'login page must show a titled app download panel');
assert(index.includes('sidebar-download-panel'), 'logged-in browser UI must expose app downloads in the sidebar');
assert(index.includes('settings-download-panel'), 'settings must keep a titled app download panel');
assert.equal((index.match(/data-app-download-panel/g) || []).length, 3, 'expected exactly three app download panels');
assert(downloads.includes('setDownloadTargetVisible'), 'download renderer must hide/show wrapper panels with targets');
assert(downloads.includes('app-download-platform'), 'download buttons must render visible platform labels');
assert(downloads.includes('platformLabel(download.platform)'), 'download buttons must use platform labels, not just icons/version');
assert(css.includes('.app-download-heading'), 'download panels need visible headings');
assert(css.includes('.app-download-text'), 'download buttons need structured label/version text');
assert(sw.includes('/static/icons/platform/android.svg'), 'service worker must precache Android platform icon');
assert(sw.includes('/static/icons/platform/windows.svg'), 'service worker must precache Windows platform icon');
for (const dictionary of [de, en]) {
  assert(dictionary['appDownloads.title'], 'app download title translation missing');
  assert(dictionary['appDownloads.subtitle'], 'app download subtitle translation missing');
  assert(dictionary['appDownloads.sidebarSubtitle'], 'app download sidebar subtitle translation missing');
}

console.log('✅ Frontend app downloads visibility test passed');
