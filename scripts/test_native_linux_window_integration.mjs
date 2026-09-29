#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const cargoLock = fs.readFileSync(path.join(repoRoot, 'src-tauri/Cargo.lock'), 'utf8');
const rustSource = fs.readFileSync(path.join(repoRoot, 'src-tauri/src/lib.rs'), 'utf8');

function lockedCrateVersion(name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = cargoLock.match(new RegExp(`\\[\\[package\\]\\]\\nname = "${escapedName}"\\nversion = "([^"]+)"`));
  assert.ok(match, `${name} must be present in src-tauri/Cargo.lock`);
  return match[1];
}

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const taoVersion = lockedCrateVersion('tao');
assert.ok(
  compareVersions(taoVersion, '0.36.0') >= 0,
  `Linux desktop builds need tao >= 0.36.0 for the Wayland title-bar input fix; Cargo.lock resolves ${taoVersion}`,
);

assert.match(
  rustSource,
  /receive_activated\(\)[\s\S]*activation_token_from_options\(event\.options\(\)\)[\s\S]*event\.timestamp\(\)[\s\S]*handle_portal_hotkey/,
  'Linux GlobalShortcuts events must retain the compositor activation token and timestamp',
);
assert.match(
  rustSource,
  /handle_portal_hotkey[\s\S]*run_on_main_thread[\s\S]*present_main_window_with_activation/,
  'Linux shortcut window presentation must be marshalled to the GTK main thread',
);
assert.match(
  rustSource,
  /present_main_window_with_activation[\s\S]*set_startup_id\(token\)[\s\S]*present_with_time\(timestamp_ms\)[\s\S]*window\.show\(\)[\s\S]*window\.unminimize\(\)[\s\S]*window\.set_focus\(\)/,
  'Linux shortcut presentation must use portal activation data before the Tauri show/unminimize/focus fallback',
);

console.log(`✅ Linux window integration regression passed (tao ${taoVersion})`);
