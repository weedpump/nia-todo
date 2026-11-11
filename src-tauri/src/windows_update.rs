use url::Url;

#[cfg(target_os = "windows")]
use serde::Serialize;
#[cfg(target_os = "windows")]
use std::{io::Read, time::Duration};
#[cfg(target_os = "windows")]
use tauri::{AppHandle, Emitter};
#[cfg(target_os = "windows")]
use tauri_plugin_updater::UpdaterExt;

const MAX_WINDOWS_UPDATE_BYTES: u64 = 512 * 1024 * 1024;

#[cfg(target_os = "windows")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowsUpdateProgress {
    phase: &'static str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

pub(crate) fn windows_updater_endpoint(server_url: &str) -> Result<Url, String> {
    let parsed = Url::parse(server_url.trim())
        .map_err(|_| "Configured server URL is invalid".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Configured server URL must use HTTP or HTTPS".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some() {
        return Err("Configured server URL must not contain credentials or fragments".to_string());
    }
    let origin = parsed.origin().ascii_serialization();
    Url::parse(&format!("{origin}/downloads/windows-updater.json"))
        .map_err(|_| "Windows updater endpoint is invalid".to_string())
}

fn windows_update_size(raw_json: &serde_json::Value) -> Result<u64, String> {
    let size = raw_json
        .get("size")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "Windows update size is unavailable".to_string())?;
    if size == 0 || size > MAX_WINDOWS_UPDATE_BYTES {
        return Err("Windows update size is outside the allowed range".to_string());
    }
    Ok(size)
}

#[cfg(target_os = "windows")]
fn download_windows_update(
    url: Url,
    expected_size: u64,
    app: AppHandle,
) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(10 * 60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = client.get(url).send().map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Windows update download failed with status {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length != expected_size)
    {
        return Err("Windows update download size does not match the manifest".to_string());
    }

    let mut bytes = Vec::with_capacity(expected_size as usize);
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let count = response
            .read(&mut chunk)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        if bytes.len().saturating_add(count) as u64 > expected_size {
            return Err("Windows update exceeded the announced size".to_string());
        }
        bytes.extend_from_slice(&chunk[..count]);
        let _ = app.emit(
            "native-update-progress",
            WindowsUpdateProgress {
                phase: "downloading",
                downloaded_bytes: bytes.len() as u64,
                total_bytes: Some(expected_size),
            },
        );
    }
    if bytes.len() as u64 != expected_size {
        return Err("Windows update download is incomplete".to_string());
    }
    Ok(bytes)
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) async fn desktop_install_update(app: AppHandle) -> Result<bool, String> {
    let server_url = super::load_settings(&app)
        .server_url
        .ok_or_else(|| "No Nia server is configured".to_string())?;
    let endpoint = windows_updater_endpoint(&server_url)?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else {
        return Ok(false);
    };

    let expected_size = windows_update_size(&update.raw_json)?;
    let download_url = update.download_url.clone();
    let download_app = app.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        download_windows_update(download_url, expected_size, download_app)
    })
    .await
    .map_err(|error| error.to_string())??;
    let _ = app.emit(
        "native-update-progress",
        WindowsUpdateProgress {
            phase: "installing",
            downloaded_bytes: expected_size,
            total_bytes: Some(expected_size),
        },
    );
    tauri::async_runtime::spawn_blocking(move || {
        update.restart_after_install(true).install(&bytes)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updater_endpoint_uses_configured_server_origin_and_allows_http() {
        assert_eq!(
            windows_updater_endpoint("http://todo.example.test/base")
                .unwrap()
                .as_str(),
            "http://todo.example.test/downloads/windows-updater.json"
        );
        assert_eq!(
            windows_updater_endpoint("https://todo.example.test/base")
                .unwrap()
                .as_str(),
            "https://todo.example.test/downloads/windows-updater.json"
        );
    }

    #[test]
    fn updater_endpoint_rejects_credentials_and_fragments() {
        assert!(windows_updater_endpoint("https://user:pass@todo.example.test").is_err());
        assert!(windows_updater_endpoint("https://todo.example.test/#fragment").is_err());
    }

    #[test]
    fn updater_size_requires_a_bounded_manifest_value() {
        assert_eq!(
            windows_update_size(&serde_json::json!({ "size": 42 })).unwrap(),
            42
        );
        assert!(windows_update_size(&serde_json::json!({ "size": 0 })).is_err());
        assert!(windows_update_size(&serde_json::json!({ "size": 600_000_000 })).is_err());
        assert!(windows_update_size(&serde_json::json!({})).is_err());
    }
}
