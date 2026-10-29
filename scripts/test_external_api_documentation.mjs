#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const docsUrl = 'https://nia-todo.homelabdiary.dev/docs/';
const apiDocsUrl = 'https://nia-todo.homelabdiary.dev/docs/api/';
const githubUrl = 'https://github.com/weedpump/nia-todo';
const issueUrl = 'https://github.com/weedpump/nia-todo/issues/new';

const indexSource = read('web/index.html');
assert(indexSource.includes('class="about-resources ui-detail-section ui-section-divider"'), 'the About resources must use the shared divided detail-section structure');
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
assert(serviceWorkerSource.includes("const CACHE_REVISION = 'nia-v4-module-platform-preview-202';"), 'the app-shell cache revision must deliver the current V4 shopping-list deletion flow');
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
assert(indexSource.includes('class="about-actions ui-detail-action-row ui-section-divider"'), 'the About actions must use the global section divider');
assert(!/\.about-actions\s*\{[^}]*border-top:/.test(aboutCss), 'the About actions must not retain a competing local divider');

const githubMarkSource = read('web/static/icons/brands/github-mark.svg');
assert(githubMarkSource.includes('viewBox="0 0 16 16"'), 'the GitHub mark must retain the official 16px viewBox');
assert(githubMarkSource.includes('<path'), 'the GitHub mark must contain its official vector path');

const detailModalCss = read('web/static/css/89-ui-detail-modal.css');
const todoCommentsActionsCss = read('web/static/css/92-todo-detail-comments-actions.css');
assert(detailModalCss.includes('.ui-detail-section-heading.is-title-only'), 'the shared detail-modal CSS must define title-only heading alignment');
assert(detailModalCss.includes('align-items: center;'), 'title-only detail headings must center their contents structurally');
assert(
  /\.ui-detail-modal\.ui-detail-view \.ui-detail-modal-header,[\s\S]*?border-bottom: 1px solid color-mix/.test(detailModalCss),
  'the shared detail-modal header must own its inset divider',
);

const sectionPrimitivesCss = read('web/static/css/99-ui-primitives.css');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`<style>:root { --border: #333; --text-muted: #777; } ${detailModalCss}\n${todoCommentsActionsCss}\n${sectionPrimitivesCss}</style><div class="ui-detail-shell"><div class="about-overview"></div><section class="about-resources ui-section-divider"></section></div><div class="ui-detail-modal ui-detail-view"><section class="ui-detail-section ui-section-divider"><div class="ui-detail-section-heading"><h4>Details</h4></div></section></div><div id="todo-modal" class="ui-detail-modal todo-detail-view"><details class="ui-detail-section ui-section-divider todo-subtasks-card"><summary><h4>Subtasks</h4></summary></details></div>`);
  const divider = await page.locator('.about-resources').evaluate(element => {
    const style = getComputedStyle(element);
    return {
      marginTop: style.marginTop,
      paddingTop: style.paddingTop,
      borderTopWidth: style.borderTopWidth,
    };
  });
  assert.deepEqual(divider, { marginTop: '22px', paddingTop: '22px', borderTopWidth: '2px' }, 'About resources must retain the global divider after preceding overview content');

  const interactiveDivider = page.locator('.ui-detail-modal.ui-detail-view .ui-section-divider');
  const baselineDividerColor = await interactiveDivider.evaluate(element => getComputedStyle(element).borderTopColor);
  await interactiveDivider.locator('h4').hover();
  const hoveredDividerColor = await interactiveDivider.evaluate(element => getComputedStyle(element).borderTopColor);
  assert.equal(hoveredDividerColor, baselineDividerColor, 'holding or hovering a section heading must not mute its shared divider');

  const todoDivider = page.locator('#todo-modal .todo-subtasks-card');
  const baselineTodoDividerColor = await todoDivider.evaluate(element => getComputedStyle(element).borderTopColor);
  await todoDivider.locator('h4').hover();
  const hoveredTodoDividerColor = await todoDivider.evaluate(element => getComputedStyle(element).borderTopColor);
  assert.equal(hoveredTodoDividerColor, baselineTodoDividerColor, 'holding a Todo section heading must not mute its shared divider');
} finally {
  await browser.close();
}

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
