#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const docsUrl = 'https://nia-todo.homelabdiary.dev/docs/';
const apiDocsUrl = 'https://nia-todo.homelabdiary.dev/docs/api/';
const githubUrl = 'https://github.com/weedpump/nia-todo';
const issueUrl = 'https://github.com/weedpump/nia-todo/issues/new';

const indexSource = read('web/index.html');
assert(indexSource.includes('class="about-resources ui-detail-section"'), 'the About dialog must use the shared detail-section structure for resources');
assert(indexSource.includes('class="ui-section-heading ui-detail-section-heading is-title-only"'), 'the title-only resources heading must use the shared centering modifier');
assert(indexSource.includes('class="about-resource-actions"'), 'the About resource actions must use the responsive action container');
assert.equal((indexSource.match(/class="btn btn-secondary about-resource-link"/g) || []).length, 4, 'the About resources must expose exactly four shared secondary buttons');
assert(!indexSource.includes('about-resource-grid'), 'the About resources must not use a custom card grid');
assert(!indexSource.includes('data-icon="code"'), 'GitHub must not use the generic code icon');
assert(!indexSource.includes('data-icon="git-branch"'), 'GitHub must not use a substitute Lucide icon');
assert(indexSource.includes('class="about-resource-github-mark"'), 'GitHub must use the locally vendored official mark');
for (const [label, url] of [
  ['documentation', docsUrl],
  ['API documentation', apiDocsUrl],
  ['GitHub repository', githubUrl],
  ['issue form', issueUrl],
]) {
  const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const linkTag = indexSource.match(new RegExp(`<a\\b[^>]*href="${escapedUrl}"[^>]*>`))?.[0];
  assert(linkTag, `the About resources must link to the ${label}`);
  assert(linkTag.includes('class="btn btn-secondary about-resource-link"'), `${label} must use the shared resource button`);
  assert(linkTag.includes('target="_blank"'), `${label} must open in a separate browser context`);
  assert(linkTag.includes('rel="noopener noreferrer"'), `${label} must isolate the external browser context`);
  assert(linkTag.includes('data-external-resource'), `${label} must use the native external-resource bridge`);
}
assert(!indexSource.includes('href="/api"'), 'the app must not link to the removed instance-local API documentation');

for (const locale of ['cs', 'de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'zh-CN']) {
  const dictionary = JSON.parse(read(`web/static/i18n/${locale}.json`));
  for (const key of ['resource.section', 'resource.documentation', 'resource.apiDocs', 'resource.github', 'resource.reportIssue']) {
    assert.equal(typeof dictionary[key], 'string', `${locale} must contain ${key}`);
    assert(dictionary[key].trim(), `${locale} ${key} must not be empty`);
  }
}

const appDownloadsSource = read('web/static/js/features/app-downloads.js');
assert(appDownloadsSource.includes('installNativeExternalResourceLinks'), 'native apps must install the external-resource link handler');
assert(appDownloadsSource.includes("link.matches?.('[data-external-resource]')"), 'the native external-resource handler must recognize the API documentation link');
assert(appDownloadsSource.includes('nativeBridge.openExternal'), 'native apps must open external documentation with the native browser bridge');

const serviceWorkerSource = read('web/sw.js');
assert(serviceWorkerSource.includes("const CACHE_REVISION = 'todo-meta-badge-actions-98';"), 'the app-shell cache revision must include interactive Todo metadata badge updates');
assert(serviceWorkerSource.includes("'/static/icons/brands/github-mark.svg'"), 'the official GitHub mark must be available offline');

const aboutCss = read('web/static/css/54-about.css');
assert(
  /#about-modal\.ui-detail-modal\.ui-detail-view \.ui-detail-modal-content\s*\{[\s\S]*?padding: 0;[\s\S]*?overflow-y: auto;/.test(aboutCss),
  'the About modal shell must remove generic modal padding while preserving its scroll owner',
);
assert(aboutCss.includes('grid-template-columns: repeat(2, minmax(0, 1fr));'), 'desktop About resources must use a balanced two-column grid');
assert(
  /@media \(max-width: 768px\)[\s\S]*?\.about-resource-actions\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/.test(aboutCss),
  'mobile About resources must collapse to one column',
);
assert(!aboutCss.includes('#about-modal .ui-detail-modal-header {'), 'the About dialog must not override the shared detail-modal header geometry');
assert(!aboutCss.includes('#about-modal .ui-detail-header-actions {'), 'the About dialog must not override the shared detail-modal header actions');
assert(
  /\.about-actions\s*\{[\s\S]*?padding-top: 18px;[\s\S]*?border-top: 1px solid/.test(aboutCss),
  'the About actions must render as a separated footer',
);

const githubMarkSource = read('web/static/icons/brands/github-mark.svg');
assert(githubMarkSource.includes('viewBox="0 0 16 16"'), 'the GitHub mark must retain the official 16px viewBox');
assert(githubMarkSource.includes('<path'), 'the GitHub mark must contain its official vector path');

const detailModalCss = read('web/static/css/89-ui-detail-modal.css');
assert(detailModalCss.includes('.ui-detail-section-heading.is-title-only'), 'the shared detail-modal CSS must define title-only heading alignment');
assert(detailModalCss.includes('align-items: center;'), 'title-only detail headings must center their contents structurally');
assert(
  /\.ui-detail-modal\.ui-detail-view \.ui-detail-modal-header,[\s\S]*?border-bottom: 1px solid color-mix/.test(detailModalCss),
  'the shared detail-modal header must own its inset divider',
);

const mainSource = read('api/main.py');
assert(!mainSource.includes('def _api_docs_html'), 'the server must not generate API documentation HTML');
assert(!mainSource.includes('def public_api_docs'), 'the server must not expose an instance-local API documentation handler');
assert(!mainSource.includes('@app.get("/api", response_class=HTMLResponse)'), 'the instance-local /api documentation route must be removed');
assert(!mainSource.includes('DOCS_DIR'), 'the server must not depend on a local API documentation source file');

assert(!existsSync(new URL('docs/api.md', root)), 'the duplicated API documentation source must be removed from the application repository');

const packageStageSource = read('scripts/release/stage-package-source.sh');
assert(!packageStageSource.includes('docs/api.md'), 'server packages must not stage the removed API documentation source');

const readmeSource = read('README.md');
assert(readmeSource.includes(`[API documentation](${apiDocsUrl})`), 'the repository README must point to the public API documentation');
assert(!readmeSource.includes('[API documentation](docs/api.md)'), 'the repository README must not point to a duplicate local API document');

console.log('✅ External API documentation contract checks passed');
