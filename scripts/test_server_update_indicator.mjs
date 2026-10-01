#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createServerUpdateIndicator } from '../web/static/js/features/server-update-indicator.js';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('web/index.html', root), 'utf8');
const indicatorIndex = html.indexOf('id="server-update-indicator"');
const userIndex = html.indexOf('id="user-menu-button"');
assert(indicatorIndex >= 0, 'sidebar must contain the server update indicator');
assert(indicatorIndex < userIndex, 'server update indicator must be above the user profile');
assert.match(html, /data-i18n-key="update\.server\.available"/);
assert.doesNotMatch(html, /server-update-indicator[^>]*(button|href=)/);

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