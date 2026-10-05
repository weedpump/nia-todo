"""Server update checks and Debian self-update orchestration."""

from __future__ import annotations

import asyncio
import json
import os
import random
import re
import subprocess
import urllib.request
from urllib.parse import urlsplit
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from db import get_db, now_iso
from services.instance_config import _read_web_app_version, get_update_analytics_enabled

DEFAULT_PRIMARY_URL = "https://nia-todo.homelabdiary.dev/update/stable.json"
DEFAULT_RELEASE_API_LATEST = "https://api.github.com/repos/weedpump/nia-todo/releases/latest"
DEFAULT_RELEASES_URL = "https://github.com/weedpump/nia-todo/releases"
DEFAULT_UMAMI_URL = "https://umami.homelabdiary.dev"
DEFAULT_UPDATE_UMAMI_WEBSITE_ID = "e5caf353-0f3a-44a9-a104-0a879eebdcc4"
SEMVER_COMPONENT_MAX = 2_147_483_647
STABLE_VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
DEB_ASSET_RE = re.compile(r"^nia-todo-server-v(?P<version>[0-9]+\.[0-9]+\.[0-9]+)-full\.deb$")
HELPER = "/usr/local/bin/nia-todo-server-update"
SERVICE_NAME = os.environ.get("NIA_TODO_SERVICE_NAME", "nia-todo").strip() or "nia-todo"
UPDATE_LOG_PATH = "/var/log/nia-todo/nia-todo-server-update.log"
UPDATE_LOG_FILE = Path(UPDATE_LOG_PATH)
UPDATE_STATUS_FILE = Path(os.environ.get("NIA_TODO_UPDATE_STATUS_FILE", "/var/cache/nia-todo/updates/status.json"))
UPDATE_PRIMARY_URL = os.environ.get("NIA_TODO_UPDATE_PRIMARY_URL", DEFAULT_PRIMARY_URL).strip() or DEFAULT_PRIMARY_URL
UPDATE_RELEASE_API_URL = os.environ.get("NIA_TODO_UPDATE_RELEASE_API_URL", DEFAULT_RELEASE_API_LATEST).strip() or DEFAULT_RELEASE_API_LATEST
UPDATE_RELEASES_URL = os.environ.get("NIA_TODO_UPDATE_RELEASES_URL", DEFAULT_RELEASES_URL).strip() or DEFAULT_RELEASES_URL
UPDATE_UMAMI_URL = os.environ.get("NIA_TODO_UPDATE_UMAMI_URL", DEFAULT_UMAMI_URL).strip() or DEFAULT_UMAMI_URL
UPDATE_UMAMI_WEBSITE_ID = os.environ.get("NIA_TODO_UPDATE_UMAMI_WEBSITE_ID", DEFAULT_UPDATE_UMAMI_WEBSITE_ID).strip()
UMAMI_TIMEOUT_SECONDS = 1.0
INSTALLATION_TYPE_OVERRIDE = os.environ.get("NIA_TODO_INSTALLATION_TYPE", "").strip().lower()
CURRENT_VERSION_OVERRIDE = os.environ.get("NIA_TODO_UPDATE_CURRENT_VERSION", "").strip()
_UPDATE_CHECK_LOCK = asyncio.Lock()


class ReleaseCheckError(RuntimeError):
    """Both release sources failed or returned an invalid stable release."""


@dataclass(frozen=True)
class ReleaseAsset:
    name: str
    browser_download_url: str
    size: int | None = None


def _http_json(url: str, *, timeout: int = 4) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "nia-todo-update-check",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = json.loads(response.read().decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("release response must be a JSON object")
    return data


def normalize_version(value: str | None) -> str:
    value = (value or "").strip()
    if value.startswith("v"):
        value = value[1:]
    return value


def stable_version(value: str | None) -> str | None:
    value = normalize_version(value)
    match = STABLE_VERSION_RE.fullmatch(value)
    if not match:
        return None
    components = tuple(int(match.group(index)) for index in (1, 2, 3))
    return value if all(component <= SEMVER_COMPONENT_MAX for component in components) else None


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


def update_severity(latest: str | None, current: str | None) -> str:
    latest_tuple = version_tuple(latest)
    current_tuple = version_tuple(current)
    if latest_tuple is None or current_tuple is None:
        return "unknown"
    if latest_tuple <= current_tuple:
        return "none"
    if latest_tuple[0] > current_tuple[0]:
        return "major"
    return "minor_patch"


def _asset_from_payload(value: Any) -> ReleaseAsset | None:
    if not isinstance(value, dict):
        return None
    name = str(value.get("name") or "").strip()
    url = str(value.get("browser_download_url") or value.get("url") or value.get("download_url") or "").strip()
    if not name or not url:
        return None
    size = value.get("size")
    return ReleaseAsset(name=name, browser_download_url=url, size=size if isinstance(size, int) else None)


def _assets_from_payload(data: dict[str, Any], version: str) -> list[ReleaseAsset]:
    values = data.get("assets")
    if isinstance(values, dict):
        named_values = []
        semantic_names = {
            "server_deb": f"nia-todo-server-v{version}-full.deb",
            "deb": f"nia-todo-server-v{version}-full.deb",
            "server_deb_sha256": f"nia-todo-server-v{version}-full.deb.sha256",
            "sha256": f"nia-todo-server-v{version}-full.deb.sha256",
            "checksum": f"nia-todo-server-v{version}-full.deb.sha256",
            "manifest": "release-manifest.json",
            "release_manifest": "release-manifest.json",
        }
        for key, value in values.items():
            name = semantic_names.get(str(key), str(key))
            if isinstance(value, str):
                named_values.append({"name": name, "url": value})
            elif isinstance(value, dict):
                named_values.append({"name": value.get("name") or name, **value})
        values = named_values
    assets = [_asset_from_payload(value) for value in values or []]
    for key in ("deb_asset", "sha256_asset", "manifest_asset"):
        asset = _asset_from_payload(data.get(key))
        if asset:
            assets.append(asset)
    return [asset for asset in assets if asset is not None]


def _trusted_github_asset_url(url: str, *, version: str, filename: str) -> bool:
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return False
    expected_path = f"/weedpump/nia-todo/releases/download/v{version}/{filename}"
    return (
        parsed.scheme == "https"
        and parsed.hostname == "github.com"
        and parsed.username is None
        and parsed.password is None
        and port is None
        and parsed.path == expected_path
        and not parsed.query
        and not parsed.fragment
    )


def _manifest_assets_from_payload(data: dict[str, Any], assets: list[ReleaseAsset]) -> list[ReleaseAsset]:
    declared: list[ReleaseAsset] = []
    if "manifest_asset" in data and data["manifest_asset"] is not None:
        asset = _asset_from_payload(data["manifest_asset"])
        if not asset or asset.name != "release-manifest.json":
            raise ValueError("release manifest asset must be named 'release-manifest.json'")
        declared.append(asset)

    values = data.get("assets")
    if isinstance(values, dict):
        for key in ("manifest", "release_manifest"):
            if key not in values or values[key] is None:
                continue
            value = values[key]
            if isinstance(value, str):
                value = {"name": "release-manifest.json", "url": value}
            elif isinstance(value, dict):
                value = {"name": value.get("name") or "release-manifest.json", **value}
            asset = _asset_from_payload(value)
            if not asset or asset.name != "release-manifest.json":
                raise ValueError("release manifest asset must be named 'release-manifest.json'")
            declared.append(asset)
    elif isinstance(values, list):
        for value in values:
            if not isinstance(value, dict) or str(value.get("name") or "").strip() != "release-manifest.json":
                continue
            asset = _asset_from_payload(value)
            if not asset:
                raise ValueError("release manifest asset must include a download URL")
            declared.append(asset)

    declared.extend(asset for asset in assets if asset.name == "release-manifest.json")
    return declared


def _normalized_release(data: dict[str, Any], *, version_value: str, html_url: str | None) -> dict[str, Any]:
    version = stable_version(version_value)
    if not version:
        raise ValueError("release version is not stable semantic version")
    assets = _assets_from_payload(data, version)
    deb_asset = None
    for asset in assets:
        match = DEB_ASSET_RE.fullmatch(asset.name)
        if match and match.group("version") == version:
            deb_asset = asset
            break
    sha_asset = next((asset for asset in assets if deb_asset and asset.name == f"{deb_asset.name}.sha256"), None)
    manifest_assets = _manifest_assets_from_payload(data, assets)
    manifest_asset = manifest_assets[0] if manifest_assets else None
    for asset in (deb_asset, sha_asset, *manifest_assets):
        if asset and not _trusted_github_asset_url(
            asset.browser_download_url,
            version=version,
            filename=asset.name,
        ):
            raise ValueError(f"release asset {asset.name!r} is not a trusted GitHub HTTPS URL")
    return {
        "tag_name": f"v{version}",
        "version": version,
        "html_url": html_url or UPDATE_RELEASES_URL,
        "deb_asset": asdict(deb_asset) if deb_asset else None,
        "sha256_asset": asdict(sha_asset) if sha_asset else None,
        "manifest_asset": asdict(manifest_asset) if manifest_asset else None,
    }


def _normalize_primary_release(data: dict[str, Any]) -> dict[str, Any]:
    for key in ("latest", "release"):
        if key in data and data[key] is not None and not isinstance(data[key], dict):
            raise ValueError(f"primary manifest {key} must be an object")
    nested = data.get("latest") or data.get("release")
    payload = {**data, **nested} if isinstance(nested, dict) else data
    for level in (data, data.get("latest"), data.get("release"), payload):
        if not isinstance(level, dict):
            continue
        channel = str(level.get("channel") or "stable").strip().lower()
        if channel != "stable":
            raise ValueError("primary manifest is not the stable channel")
    version_value = str(payload.get("version") or payload.get("tag_name") or "")
    return _normalized_release(
        payload,
        version_value=version_value,
        html_url=str(payload.get("release_url") or payload.get("html_url") or "").strip() or None,
    )


def _normalize_github_release(data: dict[str, Any]) -> dict[str, Any]:
    if data.get("draft") or data.get("prerelease"):
        raise ValueError("GitHub release is not stable")
    return _normalized_release(
        data,
        version_value=str(data.get("tag_name") or ""),
        html_url=str(data.get("html_url") or "").strip() or None,
    )


def get_latest_release() -> dict[str, Any]:
    errors: list[str] = []
    try:
        release = _normalize_primary_release(_http_json(UPDATE_PRIMARY_URL))
        return {**release, "source": "primary"}
    except Exception as exc:
        errors.append(f"primary: {type(exc).__name__}")
    try:
        release = _normalize_github_release(_http_json(UPDATE_RELEASE_API_URL))
        return {**release, "source": "github"}
    except Exception as exc:
        errors.append(f"github: {type(exc).__name__}")
    raise ReleaseCheckError("; ".join(errors))


def _ensure_update_state_row(db) -> None:
    db.execute(
        """INSERT OR IGNORE INTO server_update_check_state
           (id, stale, updated_at) VALUES (1, 1, datetime('now'))"""
    )


def record_successful_check(release: dict[str, Any], *, source: str) -> None:
    timestamp = now_iso()
    stored_release = {key: value for key, value in release.items() if key != "source"}
    with get_db() as db:
        _ensure_update_state_row(db)
        db.execute(
            """UPDATE server_update_check_state
               SET release_json = ?, source = ?, last_success_at = ?, last_check_at = ?,
                   stale = 0, check_error = NULL, updated_at = ?
               WHERE id = 1""",
            (json.dumps(stored_release, separators=(",", ":")), source, timestamp, timestamp, timestamp),
        )


def record_failed_check(error: str) -> None:
    timestamp = now_iso()
    with get_db() as db:
        _ensure_update_state_row(db)
        db.execute(
            """UPDATE server_update_check_state
               SET last_check_at = ?, stale = 1, check_error = ?, updated_at = ?
               WHERE id = 1""",
            (timestamp, str(error)[:1000], timestamp),
        )


def get_persisted_check_state() -> dict[str, Any]:
    with get_db() as db:
        row = db.execute(
            """SELECT release_json, source, last_success_at, last_check_at, stale, check_error
               FROM server_update_check_state WHERE id = 1"""
        ).fetchone()
    if not row:
        return {"release": None, "source": None, "last_success_at": None, "last_check_at": None, "stale": True, "check_error": None}
    release = None
    try:
        parsed = json.loads(row["release_json"]) if row["release_json"] else None
        release = parsed if isinstance(parsed, dict) else None
    except (TypeError, json.JSONDecodeError):
        release = None
    return {
        "release": release,
        "source": row["source"],
        "last_success_at": row["last_success_at"],
        "last_check_at": row["last_check_at"],
        "stale": bool(row["stale"]),
        "check_error": row["check_error"],
    }


def get_public_update_status() -> dict[str, bool | str | None]:
    state = get_persisted_check_state()
    current = normalize_version(CURRENT_VERSION_OVERRIDE or _read_web_app_version())
    latest = normalize_version((state.get("release") or {}).get("version")) or None
    return {
        "current_version": current or None,
        "latest_version": latest,
        "update_available": compare_versions(latest, current) == 1,
        "stale": bool(state.get("stale")),
    }


def send_update_check_event() -> None:
    if not UPDATE_UMAMI_WEBSITE_ID or not get_update_analytics_enabled():
        return
    body = json.dumps(
        {
            "type": "event",
            "payload": {
                "website": UPDATE_UMAMI_WEBSITE_ID,
                "hostname": "nia-todo.homelabdiary.dev",
                "url": "/update/stable.json",
                "name": "server-update-check",
            },
        },
        separators=(",", ":"),
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{UPDATE_UMAMI_URL.rstrip('/')}/api/send",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) nia-todo",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=UMAMI_TIMEOUT_SECONDS):
            pass
    except Exception:
        pass


async def perform_update_check(trigger: str, *, broadcast: bool = True) -> dict[str, bool | str | None]:
    del trigger  # Tracking is deliberately identical and data-free for every trigger.
    async with _UPDATE_CHECK_LOCK:
        before = await asyncio.to_thread(get_public_update_status)
        try:
            release = await asyncio.to_thread(get_latest_release)
            await asyncio.to_thread(record_successful_check, release, source=str(release.get("source") or "unknown"))
        except Exception as exc:
            await asyncio.to_thread(record_failed_check, str(exc))
        await asyncio.to_thread(send_update_check_event)
        after = await asyncio.to_thread(get_public_update_status)
        if broadcast and after != before:
            from services.websocket import manager

            await manager.broadcast({"type": "server_update_status", "payload": after})
        return after


def seconds_until_scheduled_minute(now: datetime, minute: int) -> float:
    minute = max(0, min(59, int(minute)))
    candidate = now.replace(minute=minute, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(hours=1)
    return (candidate - now).total_seconds()


async def _perform_background_update_check(trigger: str) -> None:
    try:
        await perform_update_check(trigger)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        print(f"[UPDATE] Background {trigger} check failed: {type(exc).__name__}", flush=True)


async def update_check_background_task() -> None:
    scheduled_minute = random.SystemRandom().randrange(60)
    await _perform_background_update_check("startup")
    while True:
        now = datetime.now(timezone.utc)
        await asyncio.sleep(seconds_until_scheduled_minute(now, scheduled_minute))
        await _perform_background_update_check("scheduled")


def detect_installation_type() -> str:
    if _dpkg_package_installed("nia-todo"):
        return "deb"
    if _looks_like_debian_systemd_install():
        return "deb"
    if Path("/.dockerenv").exists() or _proc_cgroup_mentions_docker():
        return "docker"
    current = normalize_version(_read_web_app_version())
    if current.endswith("-dev"):
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


def _looks_like_debian_systemd_install() -> bool:
    helper = Path(HELPER)
    service_names = tuple(dict.fromkeys((SERVICE_NAME, "nia-todo")))
    service_files = tuple(
        Path(directory) / f"{name}.service"
        for name in service_names
        for directory in ("/etc/systemd/system", "/lib/systemd/system", "/usr/lib/systemd/system")
    )
    return _root_owned_not_group_world_writable(helper) and any(
        _root_owned_not_group_world_writable(path) for path in service_files
    )


def _root_owned_not_group_world_writable(path: Path) -> bool:
    try:
        st = path.stat()
    except OSError:
        return False
    return st.st_uid == 0 and (st.st_mode & 0o022) == 0


def _reconcile_progress_with_current_version(progress: dict[str, Any], current: str | None) -> dict[str, Any]:
    state = str(progress.get("state") or "")
    if state in {"success", "failed", "idle"}:
        return progress
    target = progress.get("target_version")
    if compare_versions(current, str(target) if target else None) in {0, 1}:
        return {**progress, "state": "success", "message": "Server update installed. Reload the app to finish."}
    return progress


def get_update_progress() -> dict[str, Any]:
    if not UPDATE_STATUS_FILE.exists():
        return {"state": "idle", "message": "No update is running."}
    try:
        data = json.loads(UPDATE_STATUS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"state": "unknown", "message": "Update status could not be read."}
    if not isinstance(data, dict):
        return {"state": "unknown", "message": "Update status is invalid."}
    current = normalize_version(CURRENT_VERSION_OVERRIDE or _read_web_app_version())
    return _reconcile_progress_with_current_version(data, current)


def get_update_status() -> dict[str, Any]:
    current = normalize_version(CURRENT_VERSION_OVERRIDE or _read_web_app_version())
    install_type = INSTALLATION_TYPE_OVERRIDE if INSTALLATION_TYPE_OVERRIDE in {"deb", "docker", "dev", "unknown"} else detect_installation_type()
    state = get_persisted_check_state()
    release = state.get("release")
    latest = (release or {}).get("version")
    cmp = compare_versions(latest, current)
    status: dict[str, Any] = {
        "current_version": current,
        "installation_type": install_type,
        "github_releases_url": UPDATE_RELEASES_URL,
        "release_api_url": UPDATE_PRIMARY_URL,
        "fallback_release_api_url": UPDATE_RELEASE_API_URL,
        "supported": install_type == "deb",
        "helper_available": Path(HELPER).exists(),
        "update_available": cmp == 1,
        "update_severity": update_severity(latest, current),
        "can_install": False,
        "latest_release": release,
        "compare": cmp,
        "message": "",
        "docker_update_hint": "docker compose pull && docker compose up -d",
        "progress": get_update_progress(),
        "check": {
            "source": state.get("source"),
            "last_success_at": state.get("last_success_at"),
            "last_check_at": state.get("last_check_at"),
            "stale": bool(state.get("stale")),
            "error": state.get("check_error"),
        },
    }
    if release is None:
        status["message"] = "No successful server update check is available yet."
    elif cmp is None:
        status["message"] = "Version could not be compared safely."
    elif cmp == 0:
        status["message"] = "Server is up to date."
    elif cmp < 0:
        status["message"] = "Installed version is newer than the latest stable release."
    elif install_type == "deb":
        status["can_install"] = bool(release.get("deb_asset") and release.get("sha256_asset") and Path(HELPER).exists())
        status["message"] = "Update available for Debian installation."
        if not Path(HELPER).exists():
            status["message"] = "Update available, but the Debian update helper is not installed yet."
    elif install_type == "docker":
        status["message"] = "Update available. Pull the latest Docker image and restart the stack."
    else:
        status["message"] = "Update available, but this installation type is not self-updateable."
    if state.get("stale") and state.get("check_error"):
        status["message"] = f"{status['message']} Latest check failed; showing the last successful result."
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
    if sha_asset.get("name") != f"{deb_name}.sha256":
        raise RuntimeError("Release checksum asset does not match Debian package name.")

    process = subprocess.Popen(
        ["sudo", "-n", HELPER],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )
    return {
        "started": True,
        "pid": process.pid,
        "log_path": UPDATE_LOG_PATH,
        "target_version": version,
    }
