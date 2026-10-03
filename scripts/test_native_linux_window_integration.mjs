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
  /register_host_app\([\s\S]*GlobalShortcuts::new\(\)/,
  'Linux host apps must register their desktop application ID before the first portal call',
);
assert.match(
  rustSource,
  /receive_activated\(\)[\s\S]*activation_token_from_options\(event\.options\(\)\)[\s\S]*handle_portal_hotkey/,
  'Linux GlobalShortcuts events must retain the compositor activation token',
);
assert.doesNotMatch(
  rustSource,
  /portal\.version\(\) < 2/,
  'GlobalShortcuts version 1 must remain usable for action delivery even without activation tokens',
);
assert.doesNotMatch(
  rustSource,
  /event\.timestamp\(\)/,
  'The portal activation timestamp has an undefined base and must not be passed to GTK/GDK',
);
assert.match(
  rustSource,
  /present_main_window_with_activation[\s\S]*gdk_wayland_display_set_startup_notification_id[\s\S]*window\.show\(\)[\s\S]*window\.unminimize\(\)/,
  'Wayland shortcut presentation must apply the portal activation token to the GDK Wayland display before mapping the window',
);
assert.match(
  rustSource,
  /g_type_check_instance_is_a[\s\S]*gdk_wayland_display_get_type/,
  'Wayland display detection must use the GObject type hierarchy before the native pointer cast',
);
assert.match(
  rustSource,
  /is_focused\(\)\.unwrap_or\(false\)[\s\S]*if is_visible && !is_minimized && is_focused[\s\S]*conceal_main_window/,
  'The toggle shortcut must hide only the active window and present a visible background window',
);
assert.match(
  rustSource,
  /event\.session_handle\(\)\.as_str\(\) != handle_for_listener/,
  'Activated events must be limited to the currently bound portal session',
);
assert.match(
  rustSource,
  /static LINUX_PORTAL_STATE: Mutex<LinuxPortalLifecycleState>/,
  'Portal generation, active session, and recovery ownership must share one state lock',
);
assert.doesNotMatch(
  rustSource,
  /LINUX_PORTAL_(?:HOTKEY|RECOVERY)_GENERATION/,
  'Portal lifecycle ownership must not be split across independent generation atomics',
);
assert.match(
  rustSource,
  /fn schedule_recovery\([\s\S]*self\.generation != generation[\s\S]*self\.recovery_generation\.is_some\(\)/,
  'Stale listeners must be rejected before they can change recovery ownership',
);
assert.match(
  rustSource,
  /PortalApplyOutcome::Retry[\s\S]*rearm_recovery/,
  'Partial portal bindings must keep automatic recovery active',
);
assert.match(
  rustSource,
  /fn prepare_portal_closed_monitor[\s\S]*receive_closed\(\)\.await[\s\S]*subscribed_tx\.send[\s\S]*published_rx\.await/,
  'Session::Closed monitoring must confirm its subscription before publication is allowed',
);
assert.match(
  rustSource,
  /prepare_portal_closed_monitor\([\s\S]*\.await[\s\S]*active_session\.replace[\s\S]*closed_monitor_ready\.send\(\(\)\)/,
  'The candidate session must be published only after Closed subscription and then release its monitor',
);
assert.match(
  rustSource,
  /tauri::async_runtime::spawn\(async move \{[\s\S]*closed\.next\(\)\.await[\s\S]*portal_listener_ended/,
  'The pre-subscribed Session::Closed stream must trigger exact-session recovery',
);
assert.doesNotMatch(
  rustSource,
  /complete_portal_recovery_handoff|active_session_ready|mark_active_session_ready|ready:\s*bool/,
  'Wayland must not mix portal and legacy backends through a readiness handoff',
);
assert.match(
  rustSource,
  /gdk_wayland_display_get_type\(\)[\s\S]*gdk_x11_display_get_type\(\)[\s\S]*Unsupported GTK display backend/,
  'Linux display detection must positively identify both Wayland and X11 and reject unknown backends',
);
assert.match(
  rustSource,
  /match linux_display_backend\(\)\?[\s\S]*LinuxDisplayBackend::Wayland[\s\S]*try_apply_portal_hotkeys[\s\S]*LinuxDisplayBackend::X11[\s\S]*register_legacy_hotkeys/,
  'Wayland must use the portal exclusively while X11 uses the legacy backend',
);
assert.match(
  rustSource,
  /list_shortcuts\([\s\S]*ListShortcutsOptions::default\(\)[\s\S]*portal_listener_ended/,
  'An active portal session must be probed so portal restarts trigger recovery even without Closed or stream termination',
);
assert.match(
  rustSource,
  /fn spawn_portal_hotkey_recovery\([\s\S]*settings: DesktopSettings[\s\S]*try_apply_portal_hotkeys\(app\.clone\(\), settings\.clone\(\), generation\)/,
  'Portal recovery must reuse the captured settings snapshot',
);
assert.doesNotMatch(
  rustSource.match(/fn spawn_portal_hotkey_recovery[\s\S]*?\n\}/)?.[0] ?? '',
  /load_settings/,
  'Portal recovery must not reread desktop-settings.json while retrying',
);
assert.match(
  rustSource,
  /fn listener_ended\([\s\S]*Option<Arc<LinuxPortalShortcutSession>>[\s\S]*active_session\.take\(\)[\s\S]*schedule_recovery/,
  'A failed exact portal session must be removed from lifecycle state and returned for closure',
);
assert.match(
  rustSource,
  /fn portal_listener_ended[\s\S]*LINUX_PORTAL_OPERATION_LOCK\.lock\(\)[\s\S]*close_portal_hotkey_session\(session\)[\s\S]*spawn_portal_hotkey_recovery/,
  'The failed portal session must close under the operation lock before recovery can rebind',
);
assert.match(
  rustSource,
  /fn handle_portal_hotkey\([\s\S]*generation: u64[\s\S]*session_handle: &str[\s\S]*run_on_main_thread[\s\S]*is_active_session\(generation, &session_handle\)[\s\S]*if !remains_active[\s\S]*return/,
  'A queued portal action must revalidate its exact session on the GTK main thread before execution',
);

assert.match(
  rustSource,
  /handle_portal_hotkey\(&app_for_listener, &action, token\.as_deref\(\), generation, &handle_for_listener\)/,
  'The portal listener must carry generation and session identity into queued GTK work',
);

assert.match(
  rustSource,
  /fn close_portal_hotkey_session[\s\S]*block_on\(session\.close\(\)\)[\s\S]*begin_generation\(\)[\s\S]*close_portal_hotkey_session\(previous_session\)\?[\s\S]*try_apply_portal_hotkeys/,
  'The previous portal session must close synchronously before replacement registration',
);
assert.match(
  rustSource,
  /static DESKTOP_SETTINGS_TRANSACTION_LOCK: Mutex<\(\)>/,
  'All desktop-settings writers must share one transaction lock',
);
for (const command of ['desktop_set_setting', 'desktop_set_server_url', 'desktop_clear_server_url', 'desktop_set_hotkey']) {
  assert.match(
    rustSource,
    new RegExp(`fn ${command}\\([\\s\\S]*?DESKTOP_SETTINGS_TRANSACTION_LOCK[\\s\\S]*?\\.lock\\(\\)[\\s\\S]*?load_settings`),
    `${command} must lock before reading desktop-settings.json`,
  );
}
assert.match(
  rustSource,
  /apply_global_hotkeys_for_settings\(&app, &settings\)[\s\S]*save_settings\(&app, &previous\)[\s\S]*apply_global_hotkeys_for_settings\(&app, &previous\)[\s\S]*rollback_errors/,
  'Hotkey rollback must use the captured settings and report persistence or registration rollback failures',
);
assert.match(
  rustSource,
  /while let Some\(event\) = activated\.next\(\)\.await[\s\S]*portal_listener_ended/,
  'An ended portal event stream must transition the current session into recovery atomically',
);

console.log(`✅ Linux window integration regression passed (tao ${taoVersion})`);
