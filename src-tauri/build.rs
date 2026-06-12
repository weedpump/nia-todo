fn main() {
  tauri_build::try_build(
    tauri_build::Attributes::new().app_manifest(
      tauri_build::AppManifest::new().commands(&[
        "desktop_get_app_version",
        "desktop_get_settings",
        "desktop_consume_pending_oidc_callback",
        "desktop_set_setting",
        "desktop_set_server_url",
        "desktop_clear_server_url",
        "desktop_set_hotkey",
        "desktop_request_notification_permission",
        "desktop_notify",
        "desktop_schedule_reminders",
        "desktop_passkey_register",
        "desktop_passkey_authenticate",
      ]),
    ),
  )
  .expect("failed to run tauri-build");
}
