use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};
#[cfg(desktop)]
use tauri::WindowEvent;
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_notification::NotificationExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
  minimize_to_tray: bool,
  autostart: bool,
  notifications: bool,
  server_url: Option<String>,
}

impl Default for DesktopSettings {
  fn default() -> Self {
    Self {
      minimize_to_tray: true,
      autostart: false,
      notifications: true,
      server_url: None,
    }
  }
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
  tauri::Builder::default()
    .plugin(tauri_plugin_notification::init())
    .invoke_handler(tauri::generate_handler![
      desktop_get_settings,
      desktop_set_setting,
      desktop_set_server_url,
      desktop_clear_server_url,
      desktop_notify,
    ])
    .setup(|_app| {
      #[cfg(desktop)]
      {
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
