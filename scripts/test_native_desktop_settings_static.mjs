#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

const desktopIntegration = fs.readFileSync(path.join(repoRoot, 'web/static/js/features/desktop-integration.js'), 'utf8');
const desktopHotkeyDescriptions = fs.readFileSync(path.join(repoRoot, 'web/static/js/features/desktop-hotkey-descriptions.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(repoRoot, 'web/static/js/main.js'), 'utf8');
const packageJsonSource = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
const releaseGateSource = fs.readFileSync(path.join(repoRoot, 'scripts/test_all.sh'), 'utf8');
const i18nSource = fs.readFileSync(path.join(repoRoot, 'web/static/js/i18n/index.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'web/index.html'), 'utf8');
const rustSource = fs.readFileSync(path.join(repoRoot, 'src-tauri/src/lib.rs'), 'utf8');
const tauriConfig = fs.readFileSync(path.join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8');
const deI18n = fs.readFileSync(path.join(repoRoot, 'web/static/i18n/de.json'), 'utf8');
const enI18n = fs.readFileSync(path.join(repoRoot, 'web/static/i18n/en.json'), 'utf8');
const linuxDesktopTemplate = fs.readFileSync(path.join(repoRoot, 'src-tauri/linux/nia-todo-desktop.desktop'), 'utf8');

const i18nDir = path.join(repoRoot, 'web/static/i18n');
const supportedLanguages = ['de', 'en', 'cs', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'es', 'zh-CN'];

for (const language of supportedLanguages) {
  const dictionary = JSON.parse(fs.readFileSync(path.join(i18nDir, `${language}.json`), 'utf8'));
  for (const key of [
    'settings.desktop.hotkeys.toggleApp',
    'settings.desktop.hotkeys.newTodo',
    'settings.desktop.hotkeys.search',
  ]) {
    assert.equal(typeof dictionary[key], 'string', `${language} must translate ${key}`);
    assert(dictionary[key].trim(), `${language} must provide a non-empty ${key}`);
  }
}

for (const testScript of [
  'scripts/test_i18n_language_lifecycle.mjs',
  'scripts/test_desktop_hotkey_description_sync.mjs',
]) {
  assert(packageJsonSource.includes(`node ${testScript}`), `${testScript} must run through npm run test:native`);
  assert(releaseGateSource.includes(`node ${testScript}`), `${testScript} must run through the release gate`);
}

assert.match(
  i18nSource,
  /let i18nLoadGeneration = 0[\s\S]*const generation = \+\+i18nLoadGeneration[\s\S]*if \(generation !== i18nLoadGeneration\)[\s\S]*applied: false[\s\S]*activeLanguage = loaded\.language[\s\S]*activeDictionary = loaded\.dictionary/,
  'Older asynchronous dictionary loads must neither overwrite state nor report a committed language',
);
assert.match(
  i18nSource,
  /return \{ language, dictionary: dictionaries\.get\(language\) \}[\s\S]*return \{ language, dictionary \}[\s\S]*return \{ language: DEFAULT_LANGUAGE, dictionary \}/,
  'Dictionary loading must preserve the effective language across cache hits and fallback',
);
const setLanguageSource = i18nSource.match(/export async function setLanguagePreference[\s\S]*?\n\}/)?.[0] ?? '';
assert(
  setLanguageSource.indexOf('if (result.applied) dispatchLanguageChange()') >= 0
    && setLanguageSource.indexOf('syncLanguagePreference') >= 0
    && setLanguageSource.indexOf('dispatchLanguageChange()') < setLanguageSource.indexOf('syncLanguagePreference'),
  'Only committed local language changes may notify integrations, before optional server persistence',
);
assert.match(
  i18nSource,
  /async function adoptServerLanguagePreference[\s\S]*const result = await initI18n\(\)[\s\S]*if \(result\.applied\) dispatchLanguageChange\(\)/,
  'Adopting a server language must notify native integrations only after that dictionary commits',
);
assert.match(
  desktopHotkeyDescriptions,
  /pendingHotkeyDescriptions[\s\S]*hotkeyDescriptionSyncPromise[\s\S]*while \(pendingHotkeyDescriptions\)[\s\S]*nativeBridge\.syncHotkeyDescriptions/,
  'Localized description updates must drain through one ordered synchronization queue',
);
assert.match(
  desktopHotkeyDescriptions,
  /HOTKEY_DESCRIPTION_RETRY_MAX_MS[\s\S]*scheduleHotkeyDescriptionRetry[\s\S]*Math\.min\([\s\S]*setTimeout/,
  'A failed startup description synchronization must retry with bounded backoff',
);
assert.match(
  desktopHotkeyDescriptions,
  /function localizedHotkeyDescriptions\(\)[\s\S]*t\('settings\.desktop\.hotkeys\.toggleApp'\)[\s\S]*t\('settings\.desktop\.hotkeys\.newTodo'\)[\s\S]*t\('settings\.desktop\.hotkeys\.search'\)[\s\S]*nativeBridge\.syncHotkeyDescriptions/,
  'Portal shortcut descriptions must come from the active nia-todo i18n dictionary',
);
const desktopInitSource = desktopIntegration.match(/async function init\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
assert(
  desktopInitSource.indexOf('bindDesktopHotkeyDescriptionSync()') >= 0
    && desktopInitSource.indexOf('await loadSettings()') >= 0
    && desktopInitSource.indexOf('bindDesktopHotkeyDescriptionSync()') < desktopInitSource.indexOf('await loadSettings()'),
  'The language-change listener must be bound before desktop startup awaits can miss an event',
);
assert.match(
  desktopIntegration,
  /await syncDesktopHotkeyDescriptions\(\)/,
  'Normal desktop startup must synchronize localized shortcut descriptions',
);
const setupGuardIndex = mainSource.indexOf('!runtime.apiBaseUrl');
assert(
  mainSource.indexOf('bindDesktopHotkeyDescriptionSync()') >= 0
    && mainSource.indexOf('await hotkeyDescriptions.syncDesktopHotkeyDescriptions()') >= 0
    && mainSource.indexOf('await hotkeyDescriptions.syncDesktopHotkeyDescriptions()') < setupGuardIndex,
  'Native startup must synchronize and retry descriptions before the server-setup early return',
);
assert.match(
  desktopHotkeyDescriptions,
  /addEventListener\('nia-language-change'[\s\S]*syncDesktopHotkeyDescriptions\(\)/,
  'Desktop language changes must synchronize localized shortcut descriptions',
);
assert.match(
  rustSource,
  /struct DesktopHotkeyDescriptions[\s\S]*hotkey_descriptions: Option<DesktopHotkeyDescriptions>/,
  'Localized shortcut descriptions must be retained in the desktop settings snapshot for recovery',
);
assert.match(
  rustSource,
  /fn desktop_sync_hotkey_descriptions[\s\S]*DESKTOP_SETTINGS_TRANSACTION_LOCK[\s\S]*apply_portal_description_update/,
  'Localized descriptions must be saved and applied through the serialized settings transaction',
);
assert.doesNotMatch(
  rustSource,
  /\("toggleApp", "nia-todo anzeigen\/verstecken"|\("newTodo", "Neues nia-todo Todo"|\("search", "nia-todo Suche"/,
  'Portal shortcut descriptions must not be hard-coded in Rust',
);

assert.match(
  desktopIntegration,
  /if \(isDesktopApp\(\)\) return true;/,
  'Desktop notifications must not request browser-style permission, which emits a Linux readiness notification',
);
const concealStart = rustSource.indexOf('fn conceal_main_window');
const concealEnd = rustSource.indexOf('fn present_main_window_with_activation', concealStart);
const concealSource = rustSource.slice(concealStart, concealEnd);
assert(concealStart >= 0 && concealEnd > concealStart, 'Wayland concealment function must exist');
assert.match(concealSource, /match linux_display_backend_for_window\(window\)/);
assert.match(concealSource, /LinuxDisplayBackend::Wayland[\s\S]*window\.minimize\(\)[\s\S]*set_skip_taskbar\(true\)/);
assert.match(concealSource, /LinuxDisplayBackend::X11[\s\S]*window\.hide\(\)/);
assert.match(concealSource, /Err\(err\)[\s\S]*window\.minimize\(\)/);
assert(
  concealSource.indexOf('window.minimize()') < concealSource.indexOf('set_skip_taskbar(true)'),
  'Wayland concealment must minimize successfully before removing the window from the taskbar',
);
assert.match(
  rustSource,
  /fn apply_portal_description_update[\s\S]*LinuxDisplayBackend::Wayland[\s\S]*apply_global_hotkeys_for_settings[\s\S]*LinuxDisplayBackend::X11 => Ok\(\(\)\)[\s\S]*cfg\(not\(all\(unix/,
  'Localized portal descriptions must not re-register legacy hotkeys on X11 or non-Linux platforms',
);
assert.match(
  rustSource,
  /fn present_main_window_with_activation[\s\S]*set_skip_taskbar\(false\)[\s\S]*window\.unminimize\(\)/,
  'Wayland presentation must restore the minimized window to the taskbar before unminimizing it',
);
assert.doesNotMatch(
  rustSource,
  /set_position\(|set_outer_position\(/,
  'Wayland monitor restoration must not rely on unsupported absolute positioning',
);
assert.match(
  rustSource,
  /let is_focused = window\.is_focused\(\)\.unwrap_or\(false\);[\s\S]*if is_visible && !is_minimized && is_focused \{[\s\S]*conceal_main_window\(&window\)/,
  'Desktop toggle hotkey must conceal an active window and present a visible background window',
);
assert.match(
  rustSource,
  /Command::new\("notify-send"\)/,
  'Debian desktop notifications should use notify-send before falling back to the Tauri plugin',
);
assert.doesNotMatch(
  rustSource,
  /set_always_on_top\(true\)/,
  'Linux hotkey window presentation should not use an always-on-top pulse after it failed to stop readiness notifications',
);
assert.doesNotMatch(
  rustSource,
  /Command::new\("xdotool"\)|Command::new\("wmctrl"\)|WindowPresentMode/,
  'Desktop window presentation should use the clean Tauri path, not failed X11 helper experiments',
);
assert.match(
  rustSource,
  /fn show_main_window\(app: &AppHandle\)[\s\S]*window\.show\(\)[\s\S]*window\.unminimize\(\)[\s\S]*window\.set_focus\(\)/,
  'Desktop window presentation should use the clean Tauri show/unminimize/focus path',
);
assert.match(
  rustSource,
  /if !started_minimized \{\s*show_main_window\(_app\.handle\(\)\);\s*\}/,
  'Normal cold start should present the initially hidden Tauri window via the shared show path',
);
assert.match(
  tauriConfig,
  /"visible": false/,
  'Desktop window should start hidden so start-minimized-to-tray remains reliable',
);
assert.match(
  tauriConfig,
  /"recommends": \["libnotify-bin"\]/,
  'Debian package should recommend libnotify-bin for notify-send notifications',
);
assert.match(
  linuxDesktopTemplate,
  /^StartupNotify=false$/m,
  'Debian desktop entry should disable GNOME startup readiness notifications',
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
