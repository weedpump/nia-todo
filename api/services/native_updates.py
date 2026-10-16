from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

_VERSION_RE = re.compile(r"^v?(\d+\.\d+\.\d+)$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_WINDOWS_FILENAME_RE = re.compile(r"^nia-todo-v(\d+\.\d+\.\d+)-windows-x64-setup\.exe$")
_MAX_SIGNATURE_BYTES = 16 * 1024
_MAX_WINDOWS_UPDATE_BYTES = 512 * 1024 * 1024


def _normalized_version(value: object) -> str:
    match = _VERSION_RE.fullmatch(str(value or ""))
    if not match:
        raise ValueError("Windows update version is invalid")
    return match.group(1)


def _absolute_download_url(base_url: str, path: str) -> str:
    parsed = urlsplit(base_url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Updater base URL is invalid")
    if parsed.username or parsed.password or parsed.fragment:
        raise ValueError("Updater base URL must not contain credentials or fragments")
    if not path.startswith("/downloads/") or path.startswith("//"):
        raise ValueError("Windows update download path is invalid")
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def build_windows_updater_response(manifest: dict, downloads_dir: Path, base_url: str) -> dict[str, object]:
    for app in manifest.get("apps") or []:
        if app.get("platform") != "windows" or app.get("arch") != "x64":
            continue
        version = _normalized_version(app.get("version"))

        filename = str(app.get("filename") or "")
        filename_match = _WINDOWS_FILENAME_RE.fullmatch(filename)
        if not filename_match or filename_match.group(1) != version:
            raise ValueError("Windows update filename is invalid")
        expected_path = f"/downloads/{filename}"
        if app.get("url") != expected_path:
            raise ValueError("Windows update download path is invalid")
        if not _SHA256_RE.fullmatch(str(app.get("sha256") or "")):
            raise ValueError("Windows update checksum is invalid")
        if not isinstance(app.get("size_bytes"), int) or not 0 < app["size_bytes"] <= _MAX_WINDOWS_UPDATE_BYTES:
            raise ValueError("Windows update size is invalid")
        if app.get("tauri_updater") is False:
            raise LookupError("Windows native update artifact is unavailable")

        signature_path = downloads_dir / f"{filename}.sig"
        try:
            if signature_path.stat().st_size > _MAX_SIGNATURE_BYTES:
                raise ValueError("Windows update signature is too large")
            signature = signature_path.read_text(encoding="utf-8").strip()
        except OSError as error:
            raise ValueError("Windows update signature is unavailable") from error
        if not signature:
            raise ValueError("Windows update signature is empty")

        return {
            "version": version,
            "url": _absolute_download_url(base_url, expected_path),
            "signature": signature,
            "size": app["size_bytes"],
        }
    raise LookupError("Windows update artifact is unavailable")
