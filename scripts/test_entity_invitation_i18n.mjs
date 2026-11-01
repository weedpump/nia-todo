#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const localesUrl = new URL('../web/static/i18n/', import.meta.url);
const required = [
  'nav.invitations',
  'invite.accept',
  'invite.acceptAria',
  'invite.decline',
  'invite.declineAria',
  'entity.invitation.error.onlineOnly',
  'entity.invitation.error.respondFailed',
];
const files = readdirSync(localesUrl).filter(name => name.endsWith('.json')).sort();
assert.equal(files.length, 12, 'all 12 shipped locales must be checked');
for (const file of files) {
  const messages = JSON.parse(readFileSync(new URL(file, localesUrl), 'utf8'));
  for (const key of required) {
    assert.equal(typeof messages[key], 'string', `${file} is missing ${key}`);
    assert.ok(messages[key].trim(), `${file} has an empty ${key}`);
  }
}
console.log('✅ Entity invitation copy exists in all shipped locales');
