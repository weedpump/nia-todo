#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const apiDocsUrl = 'https://nia-todo.homelabdiary.dev/docs/api/';

const indexSource = read('web/index.html');
assert(indexSource.includes(`href="${apiDocsUrl}"`), 'the shared web/native app UI must link to the public latest API documentation');
assert(indexSource.includes('data-external-resource'), 'the API documentation link must use the native external-resource bridge');
assert(!indexSource.includes('href="/api"'), 'the app must not link to the removed instance-local API documentation');

const appDownloadsSource = read('web/static/js/features/app-downloads.js');
assert(appDownloadsSource.includes('installNativeExternalResourceLinks'), 'native apps must install the external-resource link handler');
assert(appDownloadsSource.includes("link.matches?.('[data-external-resource]')"), 'the native external-resource handler must recognize the API documentation link');
assert(appDownloadsSource.includes('nativeBridge.openExternal'), 'native apps must open external documentation with the native browser bridge');

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
