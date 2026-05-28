"""Server update checks and Debian self-update orchestration."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from services.instance_config import _read_web_app_version

GITHUB_API_LATEST = "https://api.github.com/repos/weedpump/nia-todo/releases/latest"
GITHUB_RELEASES_URL = "https://github.com/weedpump/nia-todo/releases"
DEB_ASSET_RE = re.compile(r"^nia-todo-server-v(?P<version>[0-9]+\.[0-9]+\.[0-9]+)-full\.deb$")
HELPER = "/usr/local/bin/nia-todo-server-update"
UPDATE_DIR = Path(os.environ.get("NIA_TODO_UPDATE_DIR", "/var/lib/nia-todo/updates"))


@dataclass(frozen=True)
class ReleaseAsset:
    name: str
    browser_download_url: str
    size: int | None = None


def _http_json(url: str, *, timeout: int = 4) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "nia-todo-server-update-check",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _http_bytes(url: str, *, timeout: int = 60, max_bytes: int = 350 * 1024 * 1024) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "nia-todo-server-update"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        length = response.headers.get("Content-Length")
        if length and int(length) > max_bytes:
            raise ValueError("Download too large")
        data = response.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValueError("Download too large")
        return data


def normalize_version(value: str | None) -> str:
    value = (value or "").strip()
    if value.startswith("v"):
        value = value[1:]
    return value


def stable_version(value: str | None) -> str | None:
    value = normalize_version(value)
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)$", value)
    return value if match else None


def version_tuple(value: str | None) -> tuple[int, int, int] | None:
    stable = stable_version(value)
    if not stable:
        return None
    major, minor, patch = stable.split(".")
    return int(major), int(minor), int(patch)


def compare_versions(left: str | None, right: str | None) -> int | None:
    left_tuple = version_tuple(left)
    right_tuple = version_tuple(right)
    if left_tuple is None or right_tuple is None:
        return None
    return (left_tuple > right_tuple) - (left_tuple < right_tuple)


def detect_installation_type() -> str:
    if Path("/.dockerenv").exists() or _proc_cgroup_mentions_docker():
        return "docker"
    if _dpkg_package_installed("nia-todo"):
        return "deb"
    current = normalize_version(_read_web_app_version())
    if current.endswith("-dev") or Path("~/projects/nia-todo-dev").exists():
        return "dev"
    return "unknown"


def _proc_cgroup_mentions_docker() -> bool:
    try:
        text = Path("/proc/1/cgroup").read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False
    return any(marker in text for marker in ("docker", "kubepods", "containerd"))


def _dpkg_package_installed(package: str) -> bool:
    try:
        result = subprocess.run(
            ["dpkg-query", "-W", "-f=${Status}", package],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0 and "install ok installed" in result.stdout


def get_latest_release() -> dict[str, Any]:
    data = _http_json(GITHUB_API_LATEST)
    tag_name = str(data.get("tag_name") or "").strip()
    latest = stable_version(tag_name)
    assets = [
        ReleaseAsset(
            name=str(asset.get("name") or ""),
            browser_download_url=str(asset.get("browser_download_url") or ""),
            size=asset.get("size"),
        )
        for asset in data.get("assets", [])
        if isinstance(asset, dict)
    ]
    deb_asset = next((asset for asset in assets if DEB_ASSET_RE.match(asset.name)), None)
    sha_asset = next((asset for asset in assets if asset.name.endswith(".deb.sha256")), None)
    manifest_asset = next((asset for asset in assets if asset.name == "release-manifest.json"), None)
    return {
        "tag_name": tag_name,
        "version": latest,
        "html_url": data.get("html_url") or GITHUB_RELEASES_URL,
        "deb_asset": deb_asset.__dict__ if deb_asset else None,
        "sha256_asset": sha_asset.__dict__ if sha_asset else None,
        "manifest_asset": manifest_asset.__dict__ if manifest_asset else None,
    }


def get_update_status() -> dict[str, Any]:
    current = normalize_version(_read_web_app_version())
    install_type = detect_installation_type()
    status: dict[str, Any] = {
        "current_version": current,
        "installation_type": install_type,
        "github_releases_url": GITHUB_RELEASES_URL,
        "supported": install_type == "deb",
        "helper_available": Path(HELPER).exists(),
        "update_available": False,
        "can_install": False,
        "latest_release": None,
        "compare": None,
        "message": "",
        "docker_update_hint": "docker compose pull && docker compose up -d",
    }
    try:
        release = get_latest_release()
    except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
        status["message"] = f"Could not check GitHub release: {type(exc).__name__}"
        return status

    latest = release.get("version")
    cmp = compare_versions(latest, current)
    status["latest_release"] = release
    status["compare"] = cmp
    status["update_available"] = cmp == 1
    if cmp is None:
        status["message"] = "Version could not be compared safely."
    elif cmp == 0:
        status["message"] = "Server is up to date."
    elif cmp < 0:
        status["message"] = "Installed version is newer than the latest stable GitHub release."
    elif install_type == "deb":
        status["can_install"] = bool(release.get("deb_asset") and release.get("sha256_asset") and Path(HELPER).exists())
        status["message"] = "Update available for Debian installation."
        if not Path(HELPER).exists():
            status["message"] = "Update available, but the Debian update helper is not installed yet."
    elif install_type == "docker":
        status["message"] = "Update available. Pull the latest Docker image and restart the stack."
    else:
        status["message"] = "Update available, but this installation type is not self-updateable."
    return status


def install_latest_deb_update() -> dict[str, Any]:
    status = get_update_status()
    if status["installation_type"] != "deb":
        raise RuntimeError("Self-update is only supported for Debian installations.")
    if not status["update_available"]:
        raise RuntimeError("No newer stable release is available.")
    if not status["can_install"]:
        raise RuntimeError(status.get("message") or "Update cannot be installed automatically.")

    release = status["latest_release"] or {}
    deb_asset = release.get("deb_asset") or {}
    sha_asset = release.get("sha256_asset") or {}
    version = release.get("version")
    deb_name = deb_asset.get("name") or f"nia-todo-server-v{version}-full.deb"

    sha_text = _http_bytes(sha_asset["browser_download_url"], timeout=30, max_bytes=64 * 1024).decode("utf-8", errors="replace")
    expected_sha = sha_text.strip().split()[0].lower()
    if not re.fullmatch(r"[a-f0-9]{64}", expected_sha):
        raise RuntimeError("Release checksum is invalid.")

    UPDATE_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix="nia-todo-update-", suffix=".deb", dir=str(UPDATE_DIR), delete=False) as tmp:
        tmp_path = Path(tmp.name)
        tmp.write(_http_bytes(deb_asset["browser_download_url"]))
    actual_sha = hashlib.sha256(tmp_path.read_bytes()).hexdigest()
    if actual_sha != expected_sha:
        tmp_path.unlink(missing_ok=True)
        raise RuntimeError("Downloaded Debian package checksum mismatch.")

    final_path = UPDATE_DIR / deb_name
    tmp_path.replace(final_path)
    log_path = UPDATE_DIR / f"nia-todo-server-update-v{version}.log"
    log_file = log_path.open("ab")
    try:
        process = subprocess.Popen(
            ["sudo", "-n", HELPER, str(final_path)],
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )
    finally:
        log_file.close()
    return {
        "started": True,
        "pid": process.pid,
        "log_path": str(log_path),
        "deb_path": str(final_path),
        "target_version": version,
    }
