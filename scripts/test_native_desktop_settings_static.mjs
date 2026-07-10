#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

const desktopIntegration = fs.readFileSync(path.join(repoRoot, 'web/static/js/features/desktop-integration.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'web/index.html'), 'utf8');
const rustSource = fs.readFileSync(path.join(repoRoot, 'src-tauri/src/lib.rs'), 'utf8');
const tauriConfig = fs.readFileSync(path.join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8');
const deI18n = fs.readFileSync(path.join(repoRoot, 'web/static/i18n/de.json'), 'utf8');
const enI18n = fs.readFileSync(path.join(repoRoot, 'web/static/i18n/en.json'), 'utf8');

assert.match(
  desktopIntegration,
  /if \(isDesktopApp\(\)\) return true;/,
  'Desktop notifications must not request browser-style permission, which emits a Linux readiness notification',
);
assert.match(
  rustSource,
  /let is_minimized = window\.is_minimized\(\)\.unwrap_or\(false\);[\s\S]*if is_visible && !is_minimized \{[\s\S]*window\.hide\(\)/,
  'Desktop toggle hotkey must hide any visible non-minimized main window, not only focused windows',
);
assert.match(
  rustSource,
  /Command::new\("notify-send"\)/,
  'Linux desktop notifications should use notify-send before falling back to the Tauri plugin',
);
assert.match(
  rustSource,
  /set_always_on_top\(true\)[\s\S]*set_focus\(\)[\s\S]*set_always_on_top\(false\)/,
  'Linux hotkey window presentation should avoid compositor readiness notifications when possible',
);
assert.match(
  tauriConfig,
  /"recommends": \["libnotify-bin"\]/,
  'Linux Debian package should recommend libnotify-bin for notify-send notifications',
);
for (const id of ['desktop-minimize-to-tray', 'desktop-autostart', 'desktop-start-minimized-to-tray', 'desktop-notifications']) {
  assert.match(
    indexHtml,
    new RegExp(`<input class="settings-switch" type="checkbox" id="${id}"`),
    `${id} must use the shared settings switch design`,
  );
}
assert.match(deI18n, /"settings\.desktop\.autostart": "Autostart mit System"/, 'German desktop autostart label must not mention Windows');
assert.match(enI18n, /"settings\.desktop\.autostart": "Start with system"/, 'English desktop autostart label must not mention Windows');

console.log('✅ Native desktop settings static regression passed');
