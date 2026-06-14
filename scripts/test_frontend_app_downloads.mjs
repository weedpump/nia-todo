#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');

const index = read('web/index.html');
const downloads = read('web/static/js/features/app-downloads.js');
const authSession = read('web/static/js/features/auth-session.js');
const css = read('web/static/style.css');
const sw = read('web/sw.js');
const de = JSON.parse(read('web/static/i18n/de.json'));
const en = JSON.parse(read('web/static/i18n/en.json'));

assert(index.includes('login-download-launcher'), 'login page must show the compact app download launcher');
assert(index.includes('data-app-download-launcher'), 'logged-in browser UI must expose a compact app download launcher');
assert(index.includes('app-downloads-modal'), 'app download launcher must open a modal');
assert(index.includes('data-app-download-server-host'), 'download modal must show the server host users should enter in native apps');
assert(!index.includes('settings-download-panel'), 'settings must not include app downloads; sidebar modal is the authenticated entry point');
assert.equal((index.match(/data-app-download-panel/g) || []).length, 1, 'expected only the modal app download panel; login/sidebar use compact launchers');
assert(downloads.includes('setDownloadTargetVisible'), 'download renderer must hide/show wrapper panels with targets');
assert(downloads.includes('setDownloadLaunchersVisible'), 'download renderer must hide/show compact launchers with availability');
assert(downloads.includes('openAppDownloadsModal'), 'download feature must expose modal opener');
assert(downloads.includes('app-download-platform'), 'download buttons must render visible platform labels');
assert(downloads.includes('platformLabel(download.platform)'), 'download buttons must use platform labels, not just icons/version');
assert(downloads.includes('verifyInstance(location.origin)'), 'download modal must prefer configured public_base_url from /api/instance');
assert(downloads.includes('serverAddressFromUrl'), 'download modal must strip protocol from server address hint');
assert(css.includes('.app-download-launcher'), 'sidebar downloads should be a subtle bottom action');
assert(css.includes('.app-download-launcher span:not(.ui-icon)') && css.includes('text-overflow: ellipsis'), 'compact app download launcher text must stay centered and truncate safely');
assert(css.includes('.login-box > .login-download-launcher') && css.includes('max-width: 380px') && css.includes('margin-left: auto') && css.includes('margin-right: auto'), 'login app download launcher must align to the same centered max width as the login form on mobile');
assert(css.includes('.login-auth-alternatives .login-passkey-btn') && css.includes('flex: 1 0 max-content') && css.includes('min-width: min(100%, 148px)') && css.includes('max-width: 100%') && css.includes('justify-content: center') && css.includes('text-overflow: ellipsis'), 'login auth alternative buttons must use intrinsic CSS flex wrapping, center text, and truncate only when stacked labels still overflow');
assert(!css.includes('.login-auth-alternatives.stacked') && !authSession.includes("classList.toggle('stacked'"), 'login auth alternative layout must not rely on stale JS stacked state');
assert(css.includes('#app-downloads-modal.active'), 'download modal must layer above the login overlay');
assert(css.includes('.app-downloads-modal-content'), 'download modal needs dedicated layout styles');
assert(css.includes('.app-download-text'), 'download buttons need structured label/version text');
assert(css.includes('.app-download-server-box'), 'download modal needs server host hint styles');
assert(sw.includes('/static/icons/platform/android.svg'), 'service worker must precache Android platform icon');
assert(sw.includes('/static/icons/platform/windows.svg'), 'service worker must precache Windows platform icon');
for (const dictionary of [de, en]) {
  assert(dictionary['appDownloads.title'], 'app download title translation missing');
  assert(dictionary['appDownloads.subtitle'], 'app download subtitle translation missing');
  assert(dictionary['appDownloads.sidebarSubtitle'], 'app download sidebar subtitle translation missing');
  assert(dictionary['appDownloads.modalSubtitle'], 'app download modal subtitle translation missing');
  assert(dictionary['appDownloads.serverHostLabel'], 'app download server host label translation missing');
}

console.log('✅ Frontend app downloads visibility test passed');
