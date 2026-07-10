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
const linuxDesktopTemplate = fs.readFileSync(path.join(repoRoot, 'src-tauri/linux/nia-todo-desktop.desktop'), 'utf8');

assert.match(
  desktopIntegration,
  /if \(isDesktopApp\(\)\) return true;/,
  'Desktop notifications must not request browser-style permission, which emits a Linux readiness notification',
);
assert.match(
  rustSource,
  /let is_minimized = window\.is_minimized\(\)\.unwrap_or\(false\);[\s\S]*if is_visible && !is_minimized \{[\s\S]*conceal_main_window\(&window\)/,
  'Desktop toggle hotkey must conceal any visible non-minimized main window, not only focused windows',
);
assert.match(
  rustSource,
  /Command::new\("notify-send"\)/,
  'Linux desktop notifications should use notify-send before falling back to the Tauri plugin',
);
assert.doesNotMatch(
  rustSource,
  /set_always_on_top\(true\)/,
  'Linux hotkey window presentation should not use an always-on-top pulse after it failed to stop readiness notifications',
);
assert.match(
  rustSource,
  /enum WindowPresentMode[\s\S]*ShowOnly[\s\S]*RestoreOnly[\s\S]*RestoreAndFocus/,
  'Desktop window presentation should expose modes for Linux readiness-notification debugging',
);
assert.match(
  rustSource,
  /show_main_window\(app: &AppHandle, source: &str, mode: WindowPresentMode\)[\s\S]*show_main_window source=\{source\} mode=\{mode:\?\}/,
  'Desktop window presentation paths should log their source and mode for readiness-notification debugging',
);
assert.match(
  rustSource,
  /show_main_window\(app, "toggle-hotkey", WindowPresentMode::RestoreOnly\)/,
  'Linux-prone toggle presentation should restore minimized windows without GTK show()',
);
assert.match(
  rustSource,
  /show_main_window\(app, action\.as_str\(\), WindowPresentMode::RestoreAndFocus\)/,
  'Action hotkeys that immediately interact with UI should still request focus',
);
assert.match(
  rustSource,
  /if started_minimized \{\s*conceal_main_window\(&window\);\s*\}/,
  'Normal cold start should rely on visible=true instead of programmatic GTK show()',
);
assert.match(
  tauriConfig,
  /"visible": true/,
  'Desktop window should be initially visible to avoid GTK show() readiness notifications on cold start',
);
assert.match(
  tauriConfig,
  /"recommends": \["libnotify-bin"\]/,
  'Linux Debian package should recommend libnotify-bin for notify-send notifications',
);
assert.match(
  linuxDesktopTemplate,
  /^StartupNotify=false$/m,
  'Linux desktop entry should disable GNOME startup readiness notifications',
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
