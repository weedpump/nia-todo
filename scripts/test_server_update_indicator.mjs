#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServerUpdateIndicator } from '../web/static/js/features/server-update-indicator.js';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('web/index.html', root), 'utf8');
const indicatorIndex = html.indexOf('id="server-update-indicator"');
const versionIndex = html.indexOf('id="version-info"');
const actionsIndex = html.indexOf('id="version-actions"');
assert(indicatorIndex >= 0, 'sidebar must contain the server update indicator');
assert(versionIndex < indicatorIndex, 'server update indicator must follow the app version');
assert(indicatorIndex < actionsIndex, 'server update indicator must precede the version actions');
assert.match(html, /data-i18n-key="update\.server\.available"/);
assert.doesNotMatch(html, /server-update-indicator[^>]*(button|href=)/);

const versionStyles = await readFile(new URL('web/static/css/53-version-bar.css', root), 'utf8');
const shellStyles = await readFile(new URL('web/static/css/11-main-shell.css', root), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
  await page.setContent(`
    <style>${versionStyles}\n${shellStyles}</style>
    <div class="native-app">
      <div class="version-bar">
        <div class="version-info"><span class="version-text">v3.2.0</span></div>
        <div class="server-update-indicator hidden" hidden></div>
        <div class="version-actions web-version-actions"></div>
        <div class="native-version-info" style="display:flex">
          <span class="native-version-text"><strong>App-Version:</strong> Android v3.2.0</span>
          <div class="version-actions native-version-actions">
            <a class="changelog-link version-action-btn">Changelog</a>
          </div>
        </div>
      </div>
    </div>
  `);
  const layout = await page.evaluate(() => {
    const indicator = document.querySelector('.server-update-indicator');
    const version = document.querySelector('.native-version-text').getBoundingClientRect();
    const actions = document.querySelector('.native-version-actions').getBoundingClientRect();
    return {
      indicatorDisplay: getComputedStyle(indicator).display,
      versionToActions: actions.top - version.bottom,
    };
  });
  assert.equal(layout.indicatorDisplay, 'none', 'hidden server update indicator must not reserve space');
  assert(layout.versionToActions >= 9, `native version actions must keep at least 9px spacing without the indicator, got ${layout.versionToActions}px`);
} finally {
  await browser.close();
}

const localeDir = new URL('web/static/i18n/', root);
for (const name of (await readdir(localeDir)).filter(name => name.endsWith('.json'))) {
  const messages = JSON.parse(await readFile(new URL(name, localeDir), 'utf8'));
  assert.equal(typeof messages['update.server.available'], 'string', `${name} must translate update.server.available`);
  assert(messages['update.server.available'].trim(), `${name} translation must not be empty`);
}

const classes = new Set(['hidden']);
const element = {
  hidden: true,
  classList: {
    toggle(name, enabled) {
      if (enabled) classes.add(name);
      else classes.delete(name);
    },
  },
};
const indicator = createServerUpdateIndicator({ getElement: () => element });
indicator.applyStatus({ update_available: true, stale: false });
assert.equal(element.hidden, false);
assert.equal(classes.has('hidden'), false);
indicator.applyStatus({ update_available: false, stale: false });
assert.equal(element.hidden, true);
assert.equal(classes.has('hidden'), true);

console.log('✅ Server update indicator tests passed');