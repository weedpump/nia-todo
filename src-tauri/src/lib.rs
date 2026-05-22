use serde::{Deserialize, Serialize};
use std::{
  fs,
  path::PathBuf,
  sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
  minimize_to_tray: bool,
  autostart: bool,
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

impl Default for DesktopSettings {
  fn default() -> Self {
    Self {
      minimize_to_tray: true,
      autostart: false,
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

fn save_settings(app: &AppHandle, settings: &DesktopSettings) -> Result<(), String> {
  let path = settings_path(app)?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
  }
  let raw = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
  fs::write(path, raw).map_err(|err| err.to_string())
}

#[cfg(target_os = "windows")]
fn set_autostart(enabled: bool) -> Result<(), String> {
  use winreg::enums::HKEY_CURRENT_USER;
  use winreg::RegKey;

  let hkcu = RegKey::predef(HKEY_CURRENT_USER);
  let (run_key, _) = hkcu
    .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
    .map_err(|err| err.to_string())?;
  let value_name = "nia-todo";
  if enabled {
    let exe = std::env::current_exe().map_err(|err| err.to_string())?;
    let command = format!("\"{}\"", exe.display());
    run_key.set_value(value_name, &command).map_err(|err| err.to_string())?;
  } else {
    let _ = run_key.delete_value(value_name);
  }
  Ok(())
}

#[cfg(not(target_os = "windows"))]
fn set_autostart(_enabled: bool) -> Result<(), String> {
  Ok(())
}

fn normalize_server_url(server_url: &str) -> Result<String, String> {
  let trimmed = server_url.trim().trim_end_matches('/');
  if trimmed.is_empty() {
    return Err("Server-URL darf nicht leer sein.".into());
  }
  let parsed = url::Url::parse(trimmed).map_err(|_| "Bitte eine gültige URL eingeben.".to_string())?;
  match parsed.scheme() {
    "http" | "https" => Ok(trimmed.to_string()),
    _ => Err("Bitte eine http(s)-URL eingeben.".into()),
  }
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
fn desktop_get_app_version() -> String {
  env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn desktop_get_settings(app: AppHandle) -> DesktopSettings {
  load_settings(&app)
}

#[tauri::command]
fn desktop_set_setting(app: AppHandle, key: String, value: bool) -> Result<DesktopSettings, String> {
  let mut settings = load_settings(&app);
  match key.as_str() {
    "minimizeToTray" => settings.minimize_to_tray = value,
    "autostart" => {
      set_autostart(value)?;
      settings.autostart = value;
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
    .plugin(tauri_plugin_global_shortcut::Builder::new().build());

  builder
    .manage(DesktopReminderScheduler::default())
    .invoke_handler(tauri::generate_handler![
      desktop_get_app_version,
      desktop_get_settings,
      desktop_set_setting,
      desktop_set_server_url,
      desktop_clear_server_url,
      desktop_set_hotkey,
      desktop_request_notification_permission,
      desktop_notify,
      desktop_schedule_reminders,
    ])
    .setup(|_app| {
      #[cfg(desktop)]
      {
        apply_global_hotkeys(_app.handle())?;
        build_tray(_app)?;
        if let Some(window) = _app.get_webview_window("main") {
          let app_handle = _app.handle().clone();
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
