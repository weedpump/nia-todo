fn main() {
  tauri_build::try_build(
    tauri_build::Attributes::new().app_manifest(
      tauri_build::AppManifest::new().commands(&[
        "desktop_get_settings",
        "desktop_set_setting",
        "desktop_set_server_url",
        "desktop_clear_server_url",
        "desktop_notify",
      ]),
    ),
  )
  .expect("failed to run tauri-build");
}
