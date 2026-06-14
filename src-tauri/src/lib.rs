use serde::{Deserialize, Serialize};
use std::{
  fs,
  path::PathBuf,
  sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
  },
  thread,
  time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
#[cfg(desktop)]
use tauri::{Emitter, WindowEvent};
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(desktop)]
use tauri_plugin_notification::NotificationExt;
#[cfg(not(target_os = "android"))]
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct DesktopHotkeys {
  toggle_app: Option<String>,
  new_todo: Option<String>,
  search: Option<String>,
}

impl Default for DesktopHotkeys {
  fn default() -> Self {
    Self {
      toggle_app: None,
      new_todo: None,
      search: None,
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct DesktopSettings {
  minimize_to_tray: bool,
  autostart: bool,
  start_minimized_to_tray: bool,
  notifications: bool,
  server_url: Option<String>,
  hotkeys: DesktopHotkeys,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopReminderSchedule {
  id: String,
  title: String,
  body: String,
  due_at_ms: u64,
}

#[derive(Default)]
struct DesktopReminderScheduler {
  generation: Arc<AtomicU64>,
}

#[derive(Default)]
struct PendingNativeOidcCallback(Mutex<Option<String>>);

impl Default for DesktopSettings {
  fn default() -> Self {
    Self {
      minimize_to_tray: true,
      autostart: false,
      start_minimized_to_tray: false,
      notifications: true,
      server_url: None,
      hotkeys: DesktopHotkeys::default(),
    }
  }
}

#[cfg(desktop)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopHotkeyEvent {
  action: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
  app
    .path()
    .app_config_dir()
    .map(|dir| dir.join("desktop-settings.json"))
    .map_err(|err| err.to_string())
}

fn load_settings(app: &AppHandle) -> DesktopSettings {
  let Ok(path) = settings_path(app) else { return DesktopSettings::default(); };
  let Ok(raw) = fs::read_to_string(path) else { return DesktopSettings::default(); };
  serde_json::from_str(&raw).unwrap_or_default()
}

fn repair_autostart_registration(settings: &DesktopSettings) {
  if settings.autostart {
    // Windows installers/updates can remove or stale the HKCU Run entry while
    // the app-local setting still says autostart is enabled. Re-register on
    // app start/settings read so the checkbox and Windows startup state heal.
    if let Err(err) = set_autostart(true, settings.start_minimized_to_tray) {
      eprintln!("Failed to repair autostart registration: {err}");
    }
  }
}

fn save_settings(app: &AppHandle, settings: &DesktopSettings) -> Result<(), String> {
  let path = settings_path(app)?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
  }
  let raw = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
  fs::write(path, raw).map_err(|err| err.to_string())
}

#[cfg(any(desktop, target_os = "windows"))]
const START_MINIMIZED_ARG: &str = "--nia-start-minimized-to-tray";

#[cfg(target_os = "windows")]
fn set_autostart(enabled: bool, start_minimized_to_tray: bool) -> Result<(), String> {
  use winreg::enums::HKEY_CURRENT_USER;
  use winreg::RegKey;

  let hkcu = RegKey::predef(HKEY_CURRENT_USER);
  let (run_key, _) = hkcu
    .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
    .map_err(|err| err.to_string())?;
  let value_name = "nia-todo";
  if enabled {
    let exe = std::env::current_exe().map_err(|err| err.to_string())?;
    let mut command = format!("\"{}\"", exe.display());
    if start_minimized_to_tray {
      command.push(' ');
      command.push_str(START_MINIMIZED_ARG);
    }
    run_key.set_value(value_name, &command).map_err(|err| err.to_string())?;
  } else {
    let _ = run_key.delete_value(value_name);
  }
  Ok(())
}

#[cfg(not(target_os = "windows"))]
fn set_autostart(_enabled: bool, _start_minimized_to_tray: bool) -> Result<(), String> {
  Ok(())
}

fn normalize_server_url(server_url: &str) -> Result<String, String> {
  let trimmed = server_url.trim().trim_end_matches('/');
  if trimmed.is_empty() {
    return Err("Server-URL darf nicht leer sein.".into());
  }

  let raw = if trimmed.contains("://") {
    trimmed.to_string()
  } else {
    format!("https://{trimmed}")
  };
  let mut parsed = url::Url::parse(&raw).map_err(|_| "Bitte eine gültige URL eingeben.".to_string())?;
  let host = parsed.host_str().ok_or_else(|| "Bitte eine gültige Server-URL eingeben.".to_string())?;
  let is_local_http = parsed.scheme() == "http" && matches!(host, "localhost" | "127.0.0.1" | "::1");
  if parsed.scheme() != "https" && !is_local_http {
    return Err("Bitte eine HTTPS-Adresse verwenden.".into());
  }
  if !parsed.username().is_empty() || parsed.password().is_some() {
    return Err("Server-URL darf keine Zugangsdaten enthalten.".into());
  }
  if host.contains(' ') {
    return Err("Bitte eine gültige Server-URL eingeben.".into());
  }

  parsed.set_query(None);
  parsed.set_fragment(None);
  let origin = parsed.origin().ascii_serialization();
  let path = parsed.path().trim_end_matches('/');
  Ok(format!("{origin}{path}"))
}

#[cfg(desktop)]
fn show_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.set_focus();
  }
}

#[cfg(desktop)]
fn toggle_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let is_visible = window.is_visible().unwrap_or(false);
    let is_focused = window.is_focused().unwrap_or(false);
    if is_visible && is_focused {
      let _ = window.hide();
    } else {
      let _ = window.show();
      let _ = window.set_focus();
    }
  }
}

#[cfg(desktop)]
fn native_oidc_callback_from_args(args: &[String]) -> Option<String> {
  args.iter()
    .find(|arg| arg.starts_with("nia-todo://oidc/callback?"))
    .cloned()
}

#[cfg(desktop)]
fn emit_native_oidc_callback(app: &AppHandle, url: String) {
  if let Ok(mut pending) = app.state::<PendingNativeOidcCallback>().0.lock() {
    *pending = Some(url.clone());
  }
  show_main_window(app);
  let _ = app.emit("native-oidc-callback", serde_json::json!({ "url": url }));
}

fn clean_hotkey(value: String) -> Option<String> {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    None
  } else {
    Some(trimmed.to_string())
  }
}

fn ensure_unique_hotkeys(hotkeys: &DesktopHotkeys) -> Result<(), String> {
  let entries = [
    ("App anzeigen/verstecken", &hotkeys.toggle_app),
    ("Neues Todo", &hotkeys.new_todo),
    ("Suche", &hotkeys.search),
  ];
  let mut seen: Vec<(String, &str)> = Vec::new();
  for (label, value) in entries {
    let Some(shortcut) = value else { continue; };
    let key = shortcut.to_lowercase().replace(' ', "");
    if let Some((_, existing_label)) = seen.iter().find(|(existing, _)| existing == &key) {
      return Err(format!("Hotkey doppelt vergeben: {label} und {existing_label}"));
    }
    seen.push((key, label));
  }
  Ok(())
}

#[cfg(desktop)]
fn emit_desktop_hotkey(app: &AppHandle, action: &str) {
  let _ = app.emit("desktop-hotkey", DesktopHotkeyEvent { action: action.to_string() });
}

#[cfg(desktop)]
fn apply_global_hotkeys(app: &AppHandle) -> Result<(), String> {
  use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

  let settings = load_settings(app);
  ensure_unique_hotkeys(&settings.hotkeys)?;
  app.global_shortcut().unregister_all().map_err(|err| err.to_string())?;

  let entries = [
    ("toggleApp", settings.hotkeys.toggle_app),
    ("newTodo", settings.hotkeys.new_todo),
    ("search", settings.hotkeys.search),
  ];

  for (action, shortcut) in entries {
    let Some(shortcut) = shortcut else { continue; };
    let action = action.to_string();
    let shortcut_for_error = shortcut.clone();
    app
      .global_shortcut()
      .on_shortcut(shortcut.as_str(), move |app, _shortcut, event| {
        if event.state != ShortcutState::Pressed {
          return;
        }
        match action.as_str() {
          "toggleApp" => toggle_main_window(app),
          "newTodo" | "search" => {
            show_main_window(app);
            emit_desktop_hotkey(app, &action);
          }
          _ => {}
        }
      })
      .map_err(|err| format!("Hotkey '{shortcut_for_error}' konnte nicht registriert werden: {err}"))?;
  }

  Ok(())
}

#[cfg(not(desktop))]
fn apply_global_hotkeys(_app: &AppHandle) -> Result<(), String> {
  Ok(())
}


#[tauri::command]
fn desktop_open_url(url: String) -> Result<(), String> {
  let lower = url.to_ascii_lowercase();
  let is_http = lower.starts_with("http://") || lower.starts_with("https://");
  let has_control_chars = url.chars().any(|ch| ch.is_control());
  if !is_http || has_control_chars {
    return Err("Nur gültige http(s)-URLs dürfen geöffnet werden.".into());
  }

  #[cfg(target_os = "windows")]
  let status = Command::new("rundll32").args(["url.dll,FileProtocolHandler", url.as_str()]).status();
  #[cfg(target_os = "macos")]
  let status = Command::new("open").arg(url.as_str()).status();
  #[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
  let status = Command::new("xdg-open").arg(url.as_str()).status();
  #[cfg(target_os = "android")]
  let status: Result<std::process::ExitStatus, std::io::Error> = Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "Android opens URLs via native bridge"));

  status
    .map_err(|err| err.to_string())
    .and_then(|status| if status.success() { Ok(()) } else { Err(format!("URL öffnen fehlgeschlagen: {status}")) })
}

#[tauri::command]
fn desktop_get_app_version() -> String {
  env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn desktop_consume_pending_oidc_callback(state: State<PendingNativeOidcCallback>) -> Option<String> {
  state.0.lock().ok().and_then(|mut pending| pending.take())
}

#[tauri::command]
fn desktop_get_settings(app: AppHandle) -> DesktopSettings {
  let settings = load_settings(&app);
  repair_autostart_registration(&settings);
  settings
}

#[tauri::command]
fn desktop_set_setting(app: AppHandle, key: String, value: bool) -> Result<DesktopSettings, String> {
  let mut settings = load_settings(&app);
  match key.as_str() {
    "minimizeToTray" => settings.minimize_to_tray = value,
    "autostart" => {
      set_autostart(value, settings.start_minimized_to_tray)?;
      settings.autostart = value;
    }
    "startMinimizedToTray" => {
      settings.start_minimized_to_tray = value;
      if settings.autostart {
        set_autostart(true, value)?;
      }
    }
    "notifications" => settings.notifications = value,
    _ => return Err(format!("Unknown desktop setting: {key}")),
  }
  save_settings(&app, &settings)?;
  Ok(settings)
}

#[tauri::command]
fn desktop_set_server_url(app: AppHandle, server_url: String) -> Result<DesktopSettings, String> {
  let mut settings = load_settings(&app);
  settings.server_url = Some(normalize_server_url(&server_url)?);
  save_settings(&app, &settings)?;
  Ok(settings)
}

#[tauri::command]
fn desktop_clear_server_url(app: AppHandle) -> Result<DesktopSettings, String> {
  let mut settings = load_settings(&app);
  settings.server_url = None;
  save_settings(&app, &settings)?;
  Ok(settings)
}

#[tauri::command]
fn desktop_set_hotkey(app: AppHandle, action: String, shortcut: String) -> Result<DesktopSettings, String> {
  let previous = load_settings(&app);
  let mut settings = previous.clone();
  let value = clean_hotkey(shortcut);
  match action.as_str() {
    "toggleApp" => settings.hotkeys.toggle_app = value,
    "newTodo" => settings.hotkeys.new_todo = value,
    "search" => settings.hotkeys.search = value,
    _ => return Err(format!("Unknown desktop hotkey action: {action}")),
  }
  ensure_unique_hotkeys(&settings.hotkeys)?;
  save_settings(&app, &settings)?;
  if let Err(err) = apply_global_hotkeys(&app) {
    let _ = save_settings(&app, &previous);
    let _ = apply_global_hotkeys(&app);
    return Err(err);
  }
  Ok(settings)
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_request_notification_permission(app: AppHandle) -> Result<String, String> {
  app
    .notification()
    .request_permission()
    .map(|state| state.to_string())
    .map_err(|err| err.to_string())
}

#[cfg(not(desktop))]
#[tauri::command]
fn desktop_request_notification_permission(_app: AppHandle) -> Result<String, String> {
  Ok("unsupported".into())
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
  let settings = load_settings(&app);
  if !settings.notifications {
    return Ok(());
  }
  app
    .notification()
    .builder()
    .title(title)
    .body(body)
    .show()
    .map_err(|err| err.to_string())
}

#[cfg(not(desktop))]
#[tauri::command]
fn desktop_notify(_app: AppHandle, _title: String, _body: String) -> Result<(), String> {
  Ok(())
}

fn unix_now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis()
    .try_into()
    .unwrap_or(u64::MAX)
}

#[cfg(desktop)]
fn show_scheduled_reminder(app: &AppHandle, title: String, body: String) {
  if !load_settings(app).notifications {
    return;
  }
  let _ = app
    .notification()
    .builder()
    .title(title)
    .body(body)
    .show();
}

#[cfg(not(desktop))]
fn show_scheduled_reminder(_app: &AppHandle, _title: String, _body: String) {}

#[tauri::command]
fn desktop_schedule_reminders(
  app: AppHandle,
  scheduler: State<'_, DesktopReminderScheduler>,
  reminders: Vec<DesktopReminderSchedule>,
) -> Result<usize, String> {
  let generation = scheduler.generation.fetch_add(1, Ordering::SeqCst) + 1;
  if !load_settings(&app).notifications {
    return Ok(0);
  }

  let now = unix_now_ms();
  let mut scheduled = 0usize;
  for reminder in reminders.into_iter().filter(|reminder| reminder.due_at_ms > now) {
    scheduled += 1;
    let app = app.clone();
    let _reminder_id = reminder.id;
    let title = reminder.title;
    let body = reminder.body;
    let due_at_ms = reminder.due_at_ms;
    let scheduler = scheduler.inner().generation.clone();

    thread::spawn(move || {
      let delay_ms = due_at_ms.saturating_sub(unix_now_ms());
      thread::sleep(Duration::from_millis(delay_ms));
      if scheduler.load(Ordering::SeqCst) != generation {
        return;
      }
      show_scheduled_reminder(&app, title, body);
    });
  }

  Ok(scheduled)
}

#[cfg(desktop)]
fn build_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
  let show = MenuItem::with_id(app, "show", "Öffnen", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&show, &quit])?;
  let icon = app.default_window_icon().cloned().ok_or("missing default window icon")?;

  TrayIconBuilder::new()
    .tooltip("nia-todo")
    .icon(icon)
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id.as_ref() {
      "show" => show_main_window(app),
      "quit" => app.exit(0),
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        show_main_window(tray.app_handle());
      }
    })
    .build(app)?;

  Ok(())
}

#[cfg(windows)]
fn passkey_allowed_origin(app: &AppHandle) -> Result<(url::Url, String), String> {
  let server_url = load_settings(app)
    .server_url
    .ok_or_else(|| "Keine Server-URL für native Passkeys konfiguriert.".to_string())?;
  let normalized = normalize_server_url(&server_url)?;
  let parsed = url::Url::parse(&normalized).map_err(|err| format!("Ungültige konfigurierte Server-URL: {err}"))?;
  let host = parsed
    .host_str()
    .ok_or_else(|| "Konfigurierte Server-URL hat keinen Host.".to_string())?
    .trim_end_matches('.')
    .to_lowercase();
  Ok((parsed, host))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn validate_passkey_origin(origin: &str, allowed: &url::Url) -> Result<String, String> {
  let parsed = url::Url::parse(origin).map_err(|err| format!("Ungültige Passkey-Origin: {err}"))?;
  let host = parsed
    .host_str()
    .ok_or_else(|| "Passkey-Origin hat keinen Host.".to_string())?;
  let is_local_http = parsed.scheme() == "http" && matches!(host, "localhost" | "127.0.0.1" | "::1");
  if parsed.scheme() != "https" && !is_local_http {
    return Err("Passkey-Origin muss HTTPS verwenden.".into());
  }
  if !parsed.username().is_empty() || parsed.password().is_some() || parsed.query().is_some() || parsed.fragment().is_some() {
    return Err("Passkey-Origin darf keine Zugangsdaten, Query oder Fragment enthalten.".into());
  }
  let canonical_origin = parsed.origin().ascii_serialization();
  if origin != canonical_origin {
    return Err("Passkey-Origin muss exakt der kanonischen Origin entsprechen.".into());
  }
  if canonical_origin != allowed.origin().ascii_serialization() {
    return Err("Passkey-Origin passt nicht zur konfigurierten Server-URL.".into());
  }
  Ok(canonical_origin)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn validate_passkey_rp_id(rp_id: Option<&str>, allowed_host: &str) -> Result<(), String> {
  let rp_id = rp_id
    .ok_or_else(|| "Passkey-Optionen enthalten keine RP-ID.".to_string())?
    .trim()
    .trim_end_matches('.')
    .to_lowercase();
  if rp_id != allowed_host {
    return Err("Passkey-RP-ID passt nicht zur konfigurierten Server-URL.".into());
  }
  Ok(())
}


#[cfg(windows)]
fn b64url_decode(value: &str) -> Result<Vec<u8>, String> {
  use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
  URL_SAFE_NO_PAD.decode(value).map_err(|err| format!("Ungültige Base64URL-Daten: {err}"))
}

#[cfg(windows)]
fn b64url_encode(bytes: &[u8]) -> String {
  use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
  URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(windows)]
unsafe fn copy_webauthn_buffer(ptr: *const u8, len: u32, label: &str) -> Result<Vec<u8>, String> {
  if len == 0 {
    return Ok(Vec::new());
  }
  if ptr.is_null() {
    return Err(format!("Windows WebAuthn lieferte keinen {label}-Puffer."));
  }
  Ok(unsafe { std::slice::from_raw_parts(ptr, len as usize) }.to_vec())
}

#[cfg(windows)]
fn json_string<'a>(value: &'a serde_json::Value, path: &str) -> Result<&'a str, String> {
  value.pointer(path).and_then(|v| v.as_str()).ok_or_else(|| format!("Passkey-Option fehlt: {path}"))
}

#[cfg(windows)]
fn json_bool(value: &serde_json::Value, path: &str) -> bool {
  value.pointer(path).and_then(|v| v.as_bool()).unwrap_or(false)
}

#[cfg(windows)]
fn client_data_json(kind: &str, origin: &str, challenge: &str) -> Result<String, String> {
  serde_json::to_string(&serde_json::json!({
    "type": kind,
    "challenge": challenge,
    "origin": origin,
  })).map_err(|err| err.to_string())
}

#[cfg(windows)]
fn transport_names(flags: u32) -> Vec<&'static str> {
  use windows::Win32::Networking::WindowsWebServices::*;
  let mut out = Vec::new();
  if flags & WEBAUTHN_CTAP_TRANSPORT_USB != 0 { out.push("usb"); }
  if flags & WEBAUTHN_CTAP_TRANSPORT_NFC != 0 { out.push("nfc"); }
  if flags & WEBAUTHN_CTAP_TRANSPORT_BLE != 0 { out.push("ble"); }
  if flags & WEBAUTHN_CTAP_TRANSPORT_INTERNAL != 0 { out.push("internal"); }
  out
}

#[cfg(windows)]
fn user_verification_requirement(value: Option<&str>) -> u32 {
  use windows::Win32::Networking::WindowsWebServices::*;
  match value {
    Some("required") => WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
    Some("preferred") => WEBAUTHN_USER_VERIFICATION_REQUIREMENT_PREFERRED,
    Some("discouraged") => WEBAUTHN_USER_VERIFICATION_REQUIREMENT_DISCOURAGED,
    _ => WEBAUTHN_USER_VERIFICATION_REQUIREMENT_ANY,
  }
}

#[cfg(windows)]
fn authenticator_attachment(value: Option<&str>) -> u32 {
  use windows::Win32::Networking::WindowsWebServices::*;
  match value {
    Some("platform") => WEBAUTHN_AUTHENTICATOR_ATTACHMENT_PLATFORM,
    Some("cross-platform") => WEBAUTHN_AUTHENTICATOR_ATTACHMENT_CROSS_PLATFORM,
    _ => WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY,
  }
}

#[cfg(windows)]
#[allow(dead_code)]
struct WinCredentialList {
  ids: Vec<Vec<u8>>,
  types: Vec<windows::core::HSTRING>,
  credentials: Vec<windows::Win32::Networking::WindowsWebServices::WEBAUTHN_CREDENTIAL_EX>,
  ptrs: Vec<*mut windows::Win32::Networking::WindowsWebServices::WEBAUTHN_CREDENTIAL_EX>,
  native: windows::Win32::Networking::WindowsWebServices::WEBAUTHN_CREDENTIAL_LIST,
}

#[cfg(windows)]
impl WinCredentialList {
  fn from_json(items: Option<&Vec<serde_json::Value>>) -> Result<Self, String> {
    use windows::Win32::Networking::WindowsWebServices::*;
    let mut ids = Vec::new();
    let mut types = Vec::new();
    for item in items.into_iter().flatten() {
      ids.push(b64url_decode(json_string(item, "/id")?)?);
      types.push(windows::core::HSTRING::from(item.get("type").and_then(|v| v.as_str()).unwrap_or("public-key")));
    }
    let mut credentials: Vec<WEBAUTHN_CREDENTIAL_EX> = ids.iter_mut().zip(types.iter()).map(|(id, type_)| WEBAUTHN_CREDENTIAL_EX {
      dwVersion: WEBAUTHN_CREDENTIAL_EX_CURRENT_VERSION,
      cbId: id.len() as u32,
      pbId: id.as_mut_ptr(),
      pwszCredentialType: windows::core::PCWSTR::from_raw(type_.as_ptr()),
      dwTransports: 0,
    }).collect();
    let mut ptrs: Vec<*mut WEBAUTHN_CREDENTIAL_EX> = credentials.iter_mut().map(|credential| credential as *mut _).collect();
    let native = WEBAUTHN_CREDENTIAL_LIST {
      cCredentials: ptrs.len() as u32,
      ppCredentials: if ptrs.is_empty() { std::ptr::null_mut() } else { ptrs.as_mut_ptr() },
    };
    Ok(Self { ids, types, credentials, ptrs, native })
  }
}

#[cfg(windows)]
fn windows_webauthn_register(hwnd: windows::Win32::Foundation::HWND, origin: &str, options: serde_json::Value) -> Result<serde_json::Value, String> {
  use windows::{core::{HSTRING, PCWSTR}, Win32::Networking::WindowsWebServices::*};

  let rp_id = json_string(&options, "/rp/id")?;
  let rp_name = options.pointer("/rp/name").and_then(|v| v.as_str()).unwrap_or("nia-todo");
  let user_id = b64url_decode(json_string(&options, "/user/id")?)?;
  let user_name = json_string(&options, "/user/name")?;
  let user_display_name = options.pointer("/user/displayName").and_then(|v| v.as_str()).unwrap_or(user_name);
  let challenge = json_string(&options, "/challenge")?;
  let client_data_json = client_data_json("webauthn.create", origin, challenge)?;

  let rp_id_h = HSTRING::from(rp_id);
  let rp_name_h = HSTRING::from(rp_name);
  let user_name_h = HSTRING::from(user_name);
  let user_display_h = HSTRING::from(user_display_name);
  let public_key_h = HSTRING::from("public-key");
  let sha256_h = HSTRING::from("SHA-256");

  let rp = WEBAUTHN_RP_ENTITY_INFORMATION {
    dwVersion: WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION,
    pwszId: PCWSTR::from_raw(rp_id_h.as_ptr()),
    pwszName: PCWSTR::from_raw(rp_name_h.as_ptr()),
    pwszIcon: PCWSTR::null(),
  };
  let mut user_id = user_id;
  let user = WEBAUTHN_USER_ENTITY_INFORMATION {
    dwVersion: WEBAUTHN_USER_ENTITY_INFORMATION_CURRENT_VERSION,
    cbId: user_id.len() as u32,
    pbId: user_id.as_mut_ptr(),
    pwszName: PCWSTR::from_raw(user_name_h.as_ptr()),
    pwszIcon: PCWSTR::null(),
    pwszDisplayName: PCWSTR::from_raw(user_display_h.as_ptr()),
  };

  let params_json = options.pointer("/pubKeyCredParams").and_then(|v| v.as_array()).ok_or_else(|| "Passkey-Option fehlt: /pubKeyCredParams".to_string())?;
  let mut cose_params: Vec<WEBAUTHN_COSE_CREDENTIAL_PARAMETER> = params_json.iter().filter_map(|item| {
    let alg = item.get("alg")?.as_i64()? as i32;
    Some(WEBAUTHN_COSE_CREDENTIAL_PARAMETER {
      dwVersion: WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION,
      pwszCredentialType: PCWSTR::from_raw(public_key_h.as_ptr()),
      lAlg: alg,
    })
  }).collect();
  if cose_params.is_empty() {
    cose_params.push(WEBAUTHN_COSE_CREDENTIAL_PARAMETER {
      dwVersion: WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION,
      pwszCredentialType: PCWSTR::from_raw(public_key_h.as_ptr()),
      lAlg: WEBAUTHN_COSE_ALGORITHM_ECDSA_P256_WITH_SHA256,
    });
  }
  let cose = WEBAUTHN_COSE_CREDENTIAL_PARAMETERS {
    cCredentialParameters: cose_params.len() as u32,
    pCredentialParameters: cose_params.as_mut_ptr(),
  };

  let mut client_data_bytes = client_data_json.as_bytes().to_vec();
  let client_data = WEBAUTHN_CLIENT_DATA {
    dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
    cbClientDataJSON: client_data_bytes.len() as u32,
    pbClientDataJSON: client_data_bytes.as_mut_ptr(),
    pwszHashAlgId: PCWSTR::from_raw(sha256_h.as_ptr()),
  };

  let exclude_items = options.pointer("/excludeCredentials").and_then(|v| v.as_array());
  let mut exclude = WinCredentialList::from_json(exclude_items)?;
  let selection = options.pointer("/authenticatorSelection");
  let require_resident = selection.map(|s| json_bool(s, "/requireResidentKey")).unwrap_or(false);
  let prefer_resident = selection.and_then(|s| s.get("residentKey")).and_then(|v| v.as_str()).map(|v| v == "preferred" || v == "required").unwrap_or(false);
  let uv = selection.and_then(|s| s.get("userVerification")).and_then(|v| v.as_str());
  let attachment = selection.and_then(|s| s.get("authenticatorAttachment")).and_then(|v| v.as_str());

  let make_options = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS {
    dwVersion: WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS_CURRENT_VERSION,
    dwTimeoutMilliseconds: options.get("timeout").and_then(|v| v.as_u64()).unwrap_or(60_000) as u32,
    CredentialList: WEBAUTHN_CREDENTIALS::default(),
    Extensions: WEBAUTHN_EXTENSIONS::default(),
    dwAuthenticatorAttachment: authenticator_attachment(attachment),
    bRequireResidentKey: require_resident.into(),
    dwUserVerificationRequirement: user_verification_requirement(uv),
    dwAttestationConveyancePreference: WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE,
    dwFlags: 0,
    pCancellationId: std::ptr::null_mut(),
    pExcludeCredentialList: &mut exclude.native,
    dwEnterpriseAttestation: WEBAUTHN_ENTERPRISE_ATTESTATION_NONE,
    dwLargeBlobSupport: 0,
    bPreferResidentKey: prefer_resident.into(),
    ..Default::default()
  };

  let attestation = unsafe {
    WebAuthNAuthenticatorMakeCredential(hwnd, &rp, &user, &cose, &client_data, Some(&make_options))
      .map_err(|err| format!("Windows WebAuthn Registrierung fehlgeschlagen: {err:?}"))?
  };
  let credential_id = unsafe { copy_webauthn_buffer((*attestation).pbCredentialId, (*attestation).cbCredentialId, "Credential-ID") };
  let attestation_object = unsafe { copy_webauthn_buffer((*attestation).pbAttestationObject, (*attestation).cbAttestationObject, "Attestation-Object") };
  let used_transport = unsafe { (*attestation).dwUsedTransport };
  unsafe { WebAuthNFreeCredentialAttestation(Some(attestation)); }
  let credential_id = credential_id?;
  let attestation_object = attestation_object?;

  Ok(serde_json::json!({
    "id": b64url_encode(&credential_id),
    "rawId": b64url_encode(&credential_id),
    "type": "public-key",
    "response": {
      "clientDataJSON": b64url_encode(client_data_json.as_bytes()),
      "attestationObject": b64url_encode(&attestation_object)
    },
    "transports": transport_names(used_transport)
  }))
}

#[cfg(windows)]
fn windows_webauthn_authenticate(hwnd: windows::Win32::Foundation::HWND, origin: &str, options: serde_json::Value) -> Result<serde_json::Value, String> {
  use windows::{core::{BOOL, HSTRING, PCWSTR}, Win32::Networking::WindowsWebServices::*};

  let rp_id = json_string(&options, "/rpId")?;
  let challenge = json_string(&options, "/challenge")?;
  let client_data_json = client_data_json("webauthn.get", origin, challenge)?;
  let rp_id_h = HSTRING::from(rp_id);
  let sha256_h = HSTRING::from("SHA-256");

  let mut client_data_bytes = client_data_json.as_bytes().to_vec();
  let client_data = WEBAUTHN_CLIENT_DATA {
    dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
    cbClientDataJSON: client_data_bytes.len() as u32,
    pbClientDataJSON: client_data_bytes.as_mut_ptr(),
    pwszHashAlgId: PCWSTR::from_raw(sha256_h.as_ptr()),
  };

  let allow_items = options.pointer("/allowCredentials").and_then(|v| v.as_array());
  let mut allow = WinCredentialList::from_json(allow_items)?;
  let mut app_id_used = BOOL(0);
  let get_options = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS {
    dwVersion: WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_CURRENT_VERSION,
    dwTimeoutMilliseconds: options.get("timeout").and_then(|v| v.as_u64()).unwrap_or(60_000) as u32,
    CredentialList: WEBAUTHN_CREDENTIALS::default(),
    Extensions: WEBAUTHN_EXTENSIONS::default(),
    dwAuthenticatorAttachment: WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY,
    dwUserVerificationRequirement: user_verification_requirement(options.get("userVerification").and_then(|v| v.as_str())),
    dwFlags: 0,
    pwszU2fAppId: PCWSTR::null(),
    pbU2fAppId: &mut app_id_used,
    pCancellationId: std::ptr::null_mut(),
    pAllowCredentialList: &mut allow.native,
    dwCredLargeBlobOperation: WEBAUTHN_CRED_LARGE_BLOB_OPERATION_NONE,
    cbCredLargeBlob: 0,
    pbCredLargeBlob: std::ptr::null_mut(),
    ..Default::default()
  };

  let assertion = unsafe {
    WebAuthNAuthenticatorGetAssertion(hwnd, PCWSTR::from_raw(rp_id_h.as_ptr()), &client_data, Some(&get_options))
      .map_err(|err| format!("Windows WebAuthn Anmeldung fehlgeschlagen: {err:?}"))?
  };
  let credential_id = unsafe { copy_webauthn_buffer((*assertion).Credential.pbId, (*assertion).Credential.cbId, "Credential-ID") };
  let authenticator_data = unsafe { copy_webauthn_buffer((*assertion).pbAuthenticatorData, (*assertion).cbAuthenticatorData, "Authenticator-Data") };
  let signature = unsafe { copy_webauthn_buffer((*assertion).pbSignature, (*assertion).cbSignature, "Signatur") };
  let user_handle = unsafe { copy_webauthn_buffer((*assertion).pbUserId, (*assertion).cbUserId, "User-Handle") };
  unsafe { WebAuthNFreeAssertion(assertion); }
  let credential_id = credential_id?;
  let authenticator_data = authenticator_data?;
  let signature = signature?;
  let user_handle = match user_handle? {
    bytes if bytes.is_empty() => None,
    bytes => Some(b64url_encode(&bytes)),
  };

  let mut response = serde_json::json!({
    "clientDataJSON": b64url_encode(client_data_json.as_bytes()),
    "authenticatorData": b64url_encode(&authenticator_data),
    "signature": b64url_encode(&signature)
  });
  if let Some(user_handle) = user_handle {
    response["userHandle"] = serde_json::Value::String(user_handle);
  }

  Ok(serde_json::json!({
    "id": b64url_encode(&credential_id),
    "rawId": b64url_encode(&credential_id),
    "type": "public-key",
    "response": response
  }))
}

#[cfg(windows)]
#[tauri::command]
fn desktop_passkey_register(app: AppHandle, window: tauri::WebviewWindow, origin: String, options: serde_json::Value) -> Result<serde_json::Value, String> {
  let hwnd = window.hwnd().map_err(|err| format!("Windows-Fensterhandle konnte nicht gelesen werden: {err}"))?;
  let (allowed_origin, allowed_host) = passkey_allowed_origin(&app)?;
  let canonical_origin = validate_passkey_origin(&origin, &allowed_origin)?;
  validate_passkey_rp_id(options.pointer("/rp/id").and_then(|value| value.as_str()), &allowed_host)?;
  windows_webauthn_register(hwnd, &canonical_origin, options)
}

#[cfg(not(windows))]
#[tauri::command]
fn desktop_passkey_register(_app: AppHandle, _origin: String, _options: serde_json::Value) -> Result<serde_json::Value, String> {
  Err("Windows Passkeys werden auf dieser Plattform nicht unterstützt.".into())
}

#[cfg(windows)]
#[tauri::command]
fn desktop_passkey_authenticate(app: AppHandle, window: tauri::WebviewWindow, origin: String, options: serde_json::Value) -> Result<serde_json::Value, String> {
  let hwnd = window.hwnd().map_err(|err| format!("Windows-Fensterhandle konnte nicht gelesen werden: {err}"))?;
  let (allowed_origin, allowed_host) = passkey_allowed_origin(&app)?;
  let canonical_origin = validate_passkey_origin(&origin, &allowed_origin)?;
  validate_passkey_rp_id(options.get("rpId").and_then(|value| value.as_str()), &allowed_host)?;
  windows_webauthn_authenticate(hwnd, &canonical_origin, options)
}

#[cfg(not(windows))]
#[tauri::command]
fn desktop_passkey_authenticate(_app: AppHandle, _origin: String, _options: serde_json::Value) -> Result<serde_json::Value, String> {
  Err("Windows Passkeys werden auf dieser Plattform nicht unterstützt.".into())
}

#[cfg(test)]
mod passkey_validation_tests {
  use super::{validate_passkey_origin, validate_passkey_rp_id};

  #[test]
  fn passkey_origin_must_match_allowed_origin_exactly() {
    let allowed = url::Url::parse("https://todo.example.test/app").unwrap();
    assert_eq!(
      validate_passkey_origin("https://todo.example.test", &allowed).unwrap(),
      "https://todo.example.test"
    );
    assert!(validate_passkey_origin("https://todo.example.test/path", &allowed).is_err());
    assert!(validate_passkey_origin("https://evil.example.test", &allowed).is_err());
  }

  #[test]
  fn passkey_origin_allows_only_https_or_local_http() {
    let local = url::Url::parse("http://localhost:8753").unwrap();
    assert_eq!(
      validate_passkey_origin("http://localhost:8753", &local).unwrap(),
      "http://localhost:8753"
    );

    let remote_http = url::Url::parse("http://todo.example.test").unwrap();
    assert!(validate_passkey_origin("http://todo.example.test", &remote_http).is_err());
  }

  #[test]
  fn passkey_rp_id_must_match_allowed_host_exactly() {
    assert!(validate_passkey_rp_id(Some("todo.example.test"), "todo.example.test").is_ok());
    assert!(validate_passkey_rp_id(Some("TODO.EXAMPLE.TEST."), "todo.example.test").is_ok());
    assert!(validate_passkey_rp_id(Some("sub.todo.example.test"), "todo.example.test").is_err());
    assert!(validate_passkey_rp_id(None, "todo.example.test").is_err());
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default();
  #[cfg(desktop)]
  let builder = builder
    .plugin(tauri_plugin_notification::init())
    .plugin(
      tauri_plugin_window_state::Builder::new()
        .with_state_flags(
          tauri_plugin_window_state::StateFlags::SIZE
            | tauri_plugin_window_state::StateFlags::POSITION
            | tauri_plugin_window_state::StateFlags::MAXIMIZED,
        )
        .build(),
    )
    .plugin(tauri_plugin_global_shortcut::Builder::new().build())
    .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
      if let Some(url) = native_oidc_callback_from_args(&argv) {
        emit_native_oidc_callback(app, url);
      }
    }));

  builder
    .manage(DesktopReminderScheduler::default())
    .manage(PendingNativeOidcCallback::default())
    .invoke_handler(tauri::generate_handler![
      desktop_get_app_version,
      desktop_get_settings,
      desktop_consume_pending_oidc_callback,
      desktop_set_setting,
      desktop_set_server_url,
      desktop_clear_server_url,
      desktop_open_url,
      desktop_set_hotkey,
      desktop_request_notification_permission,
      desktop_notify,
      desktop_schedule_reminders,
      desktop_passkey_register,
      desktop_passkey_authenticate,
    ])
    .setup(|_app| {
      #[cfg(desktop)]
      {
        apply_global_hotkeys(_app.handle())?;
        repair_autostart_registration(&load_settings(_app.handle()));
        build_tray(_app)?;
        if let Some(window) = _app.get_webview_window("main") {
          let app_handle = _app.handle().clone();
          let started_minimized = std::env::args().any(|arg| arg == START_MINIMIZED_ARG)
            && load_settings(_app.handle()).start_minimized_to_tray;
          if !started_minimized {
            let _ = window.show();
            let _ = window.set_focus();
          }
          if let Some(url) = native_oidc_callback_from_args(&std::env::args().collect::<Vec<_>>()) {
            let app_handle_for_oidc = app_handle.clone();
            tauri::async_runtime::spawn(async move {
              emit_native_oidc_callback(&app_handle_for_oidc, url);
            });
          }
          let window_for_close = window.clone();
          window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
              if load_settings(&app_handle).minimize_to_tray {
                api.prevent_close();
                let _ = window_for_close.hide();
              }
            }
          });
        }
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running nia-todo desktop wrapper");
}
