use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use rand::random;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use url::Url;

const MAX_DEBIAN_UPDATE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_SIGNATURE_BYTES: usize = 16 * 1024;
const UPDATER_PATH: &str = "/usr/lib/nia-todo-desktop/nia-todo-desktop-updater";
const PUBLIC_KEY: &str = "RWSJt15V25pErHT7xEbWod9OSpwZvp97V84wmvjOkV13O2epbmElzWl8";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DebianUpdateRequest {
    url: String,
    filename: String,
    version: String,
    sha256: String,
    size_bytes: u64,
    signature: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DebianUpdateProgress {
    phase: &'static str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

fn stable_version(version: &str) -> bool {
    let mut parts = version.split('.');
    parts.clone().count() == 3
        && parts.all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn validate_request(server_url: &str, request: &DebianUpdateRequest) -> Result<Url, String> {
    if !stable_version(&request.version) {
        return Err("Debian update version is invalid".to_string());
    }
    let expected_filename = format!("nia-todo-desktop-v{}-debian-amd64.deb", request.version);
    if request.filename != expected_filename {
        return Err("Debian update filename does not match its version".to_string());
    }
    if request.size_bytes == 0 || request.size_bytes > MAX_DEBIAN_UPDATE_BYTES {
        return Err("Debian update size is outside the allowed range".to_string());
    }
    if request.sha256.len() != 64
        || !request
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("Debian update checksum is invalid".to_string());
    }
    if request.signature.is_empty() || request.signature.len() > MAX_SIGNATURE_BYTES {
        return Err("Debian update signature is invalid".to_string());
    }

    let server = Url::parse(server_url.trim())
        .map_err(|_| "Configured server URL is invalid".to_string())?;
    let download =
        Url::parse(&request.url).map_err(|_| "Debian update URL is invalid".to_string())?;
    for parsed in [&server, &download] {
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err("Debian update URL must use HTTP or HTTPS".to_string());
        }
        if !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.fragment().is_some()
        {
            return Err("Debian update URL must not contain credentials or fragments".to_string());
        }
    }
    if server.origin() != download.origin()
        || download.path() != format!("/downloads/{}", request.filename)
        || download.query().is_some()
    {
        return Err("Debian update URL is outside the configured server download path".to_string());
    }
    Ok(download)
}

fn trusted_comment_version(comment: &str) -> Result<&str, String> {
    let mut versions = comment
        .split('\t')
        .filter_map(|field| field.strip_prefix("version:"));
    let version = versions
        .next()
        .filter(|value| stable_version(value))
        .ok_or_else(|| "Debian update signature version is invalid".to_string())?;
    if versions.next().is_some() {
        return Err("Debian update signature contains multiple versions".to_string());
    }
    Ok(version)
}

fn decode_and_verify_signature(
    package: &[u8],
    encoded_signature: &str,
    expected_version: &str,
) -> Result<(), String> {
    let signature_document = STANDARD
        .decode(encoded_signature.trim())
        .map_err(|_| "Debian update signature encoding is invalid".to_string())?;
    let signature_document = String::from_utf8(signature_document)
        .map_err(|_| "Debian update signature encoding is invalid".to_string())?;
    let public_key = PublicKey::from_base64(PUBLIC_KEY)
        .map_err(|_| "Debian update public key is invalid".to_string())?;
    let signature = Signature::decode(&signature_document)
        .map_err(|_| "Debian update signature is invalid".to_string())?;
    public_key
        .verify(package, &signature, false)
        .map_err(|_| "Debian update signature verification failed".to_string())?;
    if trusted_comment_version(signature.trusted_comment())? != expected_version {
        return Err("Debian update signature version does not match".to_string());
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn create_stage_dir(uid: u32, token: &str) -> Result<PathBuf, String> {
    let base = PathBuf::from(format!("/run/user/{uid}/nia-todo-desktop-updates"));
    if !base.exists() {
        fs::create_dir(&base).map_err(|error| error.to_string())?;
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    let metadata = fs::symlink_metadata(&base).map_err(|error| error.to_string())?;
    use std::os::unix::fs::MetadataExt;
    if !metadata.file_type().is_dir() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
        return Err("Debian update staging directory is unsafe".to_string());
    }
    let stage = base.join(token);
    fs::create_dir(&stage).map_err(|error| error.to_string())?;
    fs::set_permissions(&stage, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    Ok(stage)
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

fn download_and_stage(
    url: Url,
    request: &DebianUpdateRequest,
    app: AppHandle,
) -> Result<(String, PathBuf), String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(10 * 60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = client.get(url).send().map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Debian update download failed with status {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length != request.size_bytes)
    {
        return Err("Debian update download size does not match the manifest".to_string());
    }

    let mut package = Vec::with_capacity(request.size_bytes as usize);
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let count = response
            .read(&mut chunk)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        if package.len().saturating_add(count) as u64 > request.size_bytes {
            return Err("Debian update exceeded the announced size".to_string());
        }
        package.extend_from_slice(&chunk[..count]);
        let _ = app.emit(
            "native-update-progress",
            DebianUpdateProgress {
                phase: "downloading",
                downloaded_bytes: package.len() as u64,
                total_bytes: Some(request.size_bytes),
            },
        );
    }
    if package.len() as u64 != request.size_bytes {
        return Err("Debian update download is incomplete".to_string());
    }
    let actual_sha = sha256_hex(&package);
    if actual_sha != request.sha256 {
        return Err("Debian update checksum does not match the manifest".to_string());
    }
    decode_and_verify_signature(&package, &request.signature, &request.version)?;

    let uid = unsafe { libc::geteuid() };
    if uid == 0 {
        return Err("Debian update download must not run as root".to_string());
    }
    let token = format!("{:032x}", random::<u128>());
    let stage = create_stage_dir(uid, &token)?;
    if let Err(error) = (|| {
        write_private_file(&stage.join("package.deb"), &package)?;
        write_private_file(&stage.join("package.deb.sig"), request.signature.as_bytes())
    })() {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }
    Ok((token, stage))
}

#[tauri::command]
pub(crate) async fn desktop_install_debian_update(
    app: AppHandle,
    update: DebianUpdateRequest,
) -> Result<bool, String> {
    let server_url = super::load_settings(&app)
        .server_url
        .ok_or_else(|| "No Nia server is configured".to_string())?;
    let url = validate_request(&server_url, &update)?;
    let download_app = app.clone();
    let (token, stage) = tauri::async_runtime::spawn_blocking(move || {
        download_and_stage(url, &update, download_app)
    })
    .await
    .map_err(|error| error.to_string())??;

    let _ = app.emit(
        "native-update-progress",
        DebianUpdateProgress {
            phase: "installing",
            downloaded_bytes: 0,
            total_bytes: None,
        },
    );
    let token_for_launcher = token.clone();
    let launcher_status = tauri::async_runtime::spawn_blocking(move || {
        Command::new(UPDATER_PATH)
            .arg("launch")
            .arg(token_for_launcher)
            .arg(std::process::id().to_string())
            .status()
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| format!("Debian update launcher could not start: {error}"))?;
    if !launcher_status.success() {
        let _ = fs::remove_dir_all(stage);
        return Err("Debian update authorization or installation failed".to_string());
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_sha256_as_lowercase_hex() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    fn request(url: &str) -> DebianUpdateRequest {
        DebianUpdateRequest {
            url: url.to_string(),
            filename: "nia-todo-desktop-v3.4.0-debian-amd64.deb".to_string(),
            version: "3.4.0".to_string(),
            sha256: "a".repeat(64),
            size_bytes: 42,
            signature: "YQ==".to_string(),
        }
    }

    #[test]
    fn request_accepts_http_on_the_configured_origin() {
        assert!(validate_request(
            "http://todo.example.test/base",
            &request("http://todo.example.test/downloads/nia-todo-desktop-v3.4.0-debian-amd64.deb")
        )
        .is_ok());
    }

    #[test]
    fn request_rejects_foreign_origins_and_unbounded_sizes() {
        assert!(validate_request(
            "https://todo.example.test",
            &request(
                "https://evil.example.test/downloads/nia-todo-desktop-v3.4.0-debian-amd64.deb"
            )
        )
        .is_err());
        let mut oversized =
            request("https://todo.example.test/downloads/nia-todo-desktop-v3.4.0-debian-amd64.deb");
        oversized.size_bytes = MAX_DEBIAN_UPDATE_BYTES + 1;
        assert!(validate_request("https://todo.example.test", &oversized).is_err());
    }

    #[test]
    fn trusted_comment_requires_one_exact_version_field() {
        assert_eq!(
            trusted_comment_version("timestamp:1\tfile:update.deb\tversion:3.4.0").unwrap(),
            "3.4.0"
        );
        assert!(trusted_comment_version("version:3.4.0\tversion:3.4.1").is_err());
        assert!(trusted_comment_version("timestamp:1\tfile:update.deb").is_err());
    }
}
