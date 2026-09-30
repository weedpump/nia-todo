#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packageRoot = path.join(root, 'node_modules', '@tauri-apps', 'api');
const vendorRoot = path.join(root, 'web', 'static', 'vendor', 'tauri-api');
const installed = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const vendorNote = readFileSync(path.join(vendorRoot, 'VENDOR.md'), 'utf8');
assert(vendorNote.includes(`Upstream version: ${installed.version}`), 'VENDOR.md must record the installed @tauri-apps/api version');
const normalize = value => value.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
const vendoredFiles = [
  ['core.js', 'core.js'],
  ['event.js', 'event.js'],
  ['app.js', 'app.js'],
  ['image.js', 'image.js'],
  ['external/tslib/tslib.es6.js', 'external/tslib/tslib.es6.js'],
  ['LICENSE_APACHE-2.0', 'LICENSE-APACHE-2.0'],
  ['LICENSE_MIT', 'LICENSE-MIT'],
];
for (const [vendoredRelative, packageRelative] of vendoredFiles) {
  assert.equal(
    normalize(readFileSync(path.join(vendorRoot, vendoredRelative), 'utf8')),
    normalize(readFileSync(path.join(packageRoot, packageRelative), 'utf8')),
    `vendored ${vendoredRelative} must match @tauri-apps/api ${installed.version}`,
  );
}
console.log(`✅ Vendored Tauri API matches @tauri-apps/api ${installed.version}`);
