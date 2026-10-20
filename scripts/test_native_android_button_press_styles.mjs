#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'web/static/css/62-touch-native.css'), 'utf8');

function matchingRules(fragment) {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => ({ selectors: match[1].trim(), body: match[2] }));
  return rules.filter((rule) => rule.selectors.includes(fragment));
}

assert(
  css.includes('-webkit-tap-highlight-color: transparent;'),
  'Android WebView tap highlight must remain disabled',
);

for (const selector of ['button:active', 'button.touch-feedback', 'a:active', 'a.touch-feedback', '[role="button"]:active', '[role="button"].touch-feedback']) {
  const rules = matchingRules(selector);
  assert(
    rules.length === 0,
    `Android native CSS must not globally override the pressed state for ${selector}`,
  );
}

console.log('Android native press styling preserves component fills and disables the tap highlight.');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}
