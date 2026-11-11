#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../web/static/js/features/user-settings.js', import.meta.url), 'utf8');
const closeNavigation = source.match(/function closeSettingsNavigation\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
const openSettings = source.match(/async function openSettingsModal\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

assert.match(closeNavigation, /\.settings-nav-shell['"]\)\?\.classList\.remove\('is-open'\)/, 'closing settings navigation must remove its open state');
assert.match(closeNavigation, /\.settings-mobile-nav-toggle['"]\)\?\.setAttribute\('aria-expanded', 'false'\)/, 'closing settings navigation must reset its expanded state');
assert(
  openSettings.indexOf('closeSettingsNavigation();') >= 0
    && openSettings.indexOf("showSettingsPage('general');") >= 0
    && openSettings.indexOf('closeSettingsNavigation();') < openSettings.indexOf("showSettingsPage('general');"),
  'opening settings must close mobile navigation before restoring the General page',
);

console.log('✅ Settings navigation lifecycle regression passed');