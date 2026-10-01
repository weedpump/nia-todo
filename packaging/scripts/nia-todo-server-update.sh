#!/bin/bash
# Root-only helper used by the admin panel to install the latest verified nia-todo .deb.
# The unprivileged app process may only start this helper; it cannot choose a package path.

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-}"
NIA_TODO_SERVICE_NAME="${NIA_TODO_SERVICE_NAME:-}"
CACHE_DIR="/var/cache/nia-todo/updates"
STATUS_FILE="${CACHE_DIR}/status.json"
UPDATE_LOG_DIR="/var/log/nia-todo"
UPDATE_LOG_FILE="${UPDATE_LOG_DIR}/nia-todo-server-update.log"
SOURCE_CONFIG="/etc/nia-todo/update-source.env"
ENV_CONFIG="/etc/nia-todo/nia-todo.env"
UPDATE_PRIMARY_URL="${UPDATE_PRIMARY_URL:-}"
UPDATE_RELEASE_API_URL="${UPDATE_RELEASE_API_URL:-${RELEASE_API_LATEST:-}}"
UNIT_NAME="nia-todo-server-update"

if [ -f "${ENV_CONFIG}" ]; then
  owner_uid="$(stat -c '%u' "${ENV_CONFIG}")"
  mode="$(stat -c '%a' "${ENV_CONFIG}")"
  perm=$((8#${mode}))
  if [ "${owner_uid}" != "0" ] || [ $((perm & 022)) -ne 0 ]; then
    echo "Refusing insecure environment config ${ENV_CONFIG}; expected root-owned and not group/world-writable." >&2
    exit 2
  fi
  set -a
  # shellcheck disable=SC1090
  source "${ENV_CONFIG}"
  set +a
fi

if [ -f "${SOURCE_CONFIG}" ]; then
  owner_uid="$(stat -c '%u' "${SOURCE_CONFIG}")"
  mode="$(stat -c '%a' "${SOURCE_CONFIG}")"
  perm=$((8#${mode}))
  if [ "${owner_uid}" != "0" ] || [ $((perm & 022)) -ne 0 ]; then
    echo "Refusing insecure update source config ${SOURCE_CONFIG}; expected root-owned and not group/world-writable." >&2
    exit 2
  fi
  # Optional root-owned test hook. The app user cannot pass this through sudo.
  # shellcheck disable=SC1090
  source "${SOURCE_CONFIG}"
fi

SERVICE_NAME="${SERVICE_NAME:-${NIA_TODO_SERVICE_NAME:-nia-todo}}"
UPDATE_PRIMARY_URL="${NIA_TODO_UPDATE_PRIMARY_URL:-${UPDATE_PRIMARY_URL:-https://nia-todo.homelabdiary.dev/update/stable.json}}"
UPDATE_RELEASE_API_URL="${NIA_TODO_UPDATE_RELEASE_API_URL:-${UPDATE_RELEASE_API_URL:-${RELEASE_API_LATEST:-https://api.github.com/repos/weedpump/nia-todo/releases/latest}}}"

if [ "$(id -u)" -ne 0 ]; then
  echo "This helper must run as root." >&2
  exit 1
fi

RUN_IN_PLACE=0
if [ "$#" -eq 1 ] && [ "${1:-}" = "--systemd-child" ]; then
  RUN_IN_PLACE=1
elif [ "$#" -ne 0 ]; then
  echo "Usage: nia-todo-server-update" >&2
  exit 2
fi

install -d -m 0755 -o root -g root "${CACHE_DIR}"

ensure_secure_update_log() {
  local owner_uid mode perm
  if [[ -L "${UPDATE_LOG_DIR}" ]]; then
    echo "Refusing unsafe update log directory ${UPDATE_LOG_DIR}: symbolic links are not allowed." >&2
    exit 2
  fi
  if [[ ! -e "${UPDATE_LOG_DIR}" ]]; then
    install -d -m 0755 -o root -g root "${UPDATE_LOG_DIR}"
  fi
  owner_uid="$(stat -c '%u' "${UPDATE_LOG_DIR}")"
  mode="$(stat -c '%a' "${UPDATE_LOG_DIR}")"
  perm=$((8#${mode}))
  if [[ "${owner_uid}" != "0" || ! -d "${UPDATE_LOG_DIR}" || $((perm & 022)) -ne 0 ]]; then
    echo "Refusing unsafe update log directory ${UPDATE_LOG_DIR}; expected a root-owned directory not writable by group or other." >&2
    exit 2
  fi

  if [[ -L "${UPDATE_LOG_FILE}" ]]; then
    echo "Refusing unsafe update log file ${UPDATE_LOG_FILE}: symbolic links are not allowed." >&2
    exit 2
  fi
  if [[ ! -e "${UPDATE_LOG_FILE}" ]]; then
    install -m 0644 -o root -g root /dev/null "${UPDATE_LOG_FILE}"
  fi
  owner_uid="$(stat -c '%u' "${UPDATE_LOG_FILE}")"
  mode="$(stat -c '%a' "${UPDATE_LOG_FILE}")"
  perm=$((8#${mode}))
  if [[ "${owner_uid}" != "0" || ! -f "${UPDATE_LOG_FILE}" || $((perm & 022)) -ne 0 ]]; then
    echo "Refusing unsafe update log file ${UPDATE_LOG_FILE}; expected a root-owned regular file not writable by group or other." >&2
    exit 2
  fi
}

ensure_secure_update_log
write_status() {
  local state="$1"
  local message="$2"
  local version="${3:-}"
  local unit="${4:-}"
  python3 - "$STATUS_FILE" "$state" "$message" "$version" "$unit" <<'PY_STATUS'
import json
import sys
from datetime import datetime, timezone
path, state, message, version, unit = sys.argv[1:6]
payload = {
    "state": state,
    "message": message,
    "target_version": version or None,
    "unit": unit or None,
    "updated_at": datetime.now(timezone.utc).isoformat(),
}
with open(path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2)
    fh.write("\n")
PY_STATUS
  chmod 0644 "$STATUS_FILE" || true
}

trap 'rc=$?; if [ "$rc" -ne 0 ]; then write_status "failed" "Server update failed. Check the update log." "" "${UNIT_NAME}.service"; fi' EXIT
export UPDATE_PRIMARY_URL UPDATE_RELEASE_API_URL SERVICE_NAME NIA_TODO_SERVICE_NAME="${SERVICE_NAME}"
write_status "running" "Starting server update…" "" "${UNIT_NAME}.service"

exec 9>"${CACHE_DIR}/update.lock"
if [ "${RUN_IN_PLACE}" = "1" ]; then
  flock 9
elif ! flock -n 9; then
  echo "Another nia-todo server update is already running."
  exit 0
fi

if [ "${RUN_IN_PLACE}" != "1" ]; then
  if [ "${NIA_TODO_UPDATE_ALLOW_IN_PLACE:-0}" = "1" ]; then
    echo "Emergency in-place update enabled; dpkg may be interrupted if the app service restarts." >&2
  else
    if ! command -v systemd-run >/dev/null 2>&1; then
      echo "systemd-run is required for safe self-update detachment." >&2
      write_status "failed" "Server update cannot start safely because systemd-run is unavailable." "" "${UNIT_NAME}.service"
      exit 1
    fi
    if systemd-run \
        --unit="${UNIT_NAME}" \
        --collect \
        --property=Type=exec \
        --property=KillMode=process \
        --property="StandardOutput=append:${UPDATE_LOG_FILE}" \
        --property="StandardError=append:${UPDATE_LOG_FILE}" \
        --setenv="UPDATE_PRIMARY_URL=${UPDATE_PRIMARY_URL}" \
        --setenv="UPDATE_RELEASE_API_URL=${UPDATE_RELEASE_API_URL}" \
        --setenv="SERVICE_NAME=${SERVICE_NAME}" \
        --setenv="NIA_TODO_SERVICE_NAME=${SERVICE_NAME}" \
        --setenv="NIA_TODO_DATA_DIR=${NIA_TODO_DATA_DIR:-/var/lib/nia-todo}" \
        --setenv="NIA_TODO_BACKUP_DIR=${NIA_TODO_BACKUP_DIR:-${NIA_TODO_DATA_DIR:-/var/lib/nia-todo}/backups}" \
        --setenv="NIA_TODO_DB=${NIA_TODO_DB:-nia-todo.db}" \
        --setenv="NIA_TODO_AVATAR_DIR=${NIA_TODO_AVATAR_DIR:-${NIA_TODO_DATA_DIR:-/var/lib/nia-todo}/avatars}" \
        --setenv="NIA_TODO_ATTACHMENT_DIR=${NIA_TODO_ATTACHMENT_DIR:-${NIA_TODO_DATA_DIR:-/var/lib/nia-todo}/attachments}" \
        --setenv="NIA_TODO_VAPID_KEYS=${NIA_TODO_VAPID_KEYS:-${NIA_TODO_DATA_DIR:-/var/lib/nia-todo}/vapid_keys.json}" \
        "$(readlink -f "$0")" --systemd-child; then
      write_status "running" "Server update detached from app service. Installing package…" "" "${UNIT_NAME}.service"
      echo "nia-todo server update detached into systemd unit ${UNIT_NAME}."
      exit 0
    fi
    echo "systemd-run detach failed; refusing to run apt/dpkg inside the app service context." >&2
    write_status "failed" "Server update could not detach safely; apt/dpkg was not started." "" "${UNIT_NAME}.service"
    exit 1
  fi
fi

DEB_PATH="$({
python3 - <<'PY'
import hashlib
import json
import os
import re
import sys
import tempfile
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

primary_url = os.environ.get("UPDATE_PRIMARY_URL", "https://nia-todo.homelabdiary.dev/update/stable.json")
github_api_url = os.environ.get("UPDATE_RELEASE_API_URL", "https://api.github.com/repos/weedpump/nia-todo/releases/latest")
cache_dir = Path("/var/cache/nia-todo/updates")
semver_re = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
asset_re = re.compile(r"^nia-todo-server-v(?P<version>[0-9]+\.[0-9]+\.[0-9]+)-full\.deb$")
semver_component_max = 2_147_483_647


def fetch_json(url: str):
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "nia-todo-root-update-helper"})
    with urllib.request.urlopen(req, timeout=30) as response:
        data = json.loads(response.read().decode("utf-8"))
    if not isinstance(data, dict):
        raise RuntimeError("release response must be a JSON object")
    return data


def fetch_bytes(url: str, max_bytes: int):
    req = urllib.request.Request(url, headers={"User-Agent": "nia-todo-root-update-helper"})
    with urllib.request.urlopen(req, timeout=180) as response:
        length = response.headers.get("Content-Length")
        if length and int(length) > max_bytes:
            raise RuntimeError("download too large")
        data = response.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise RuntimeError("download too large")
    return data


def stable_version(value):
    value = str(value or "").strip()
    if value.startswith("v"):
        value = value[1:]
    match = semver_re.fullmatch(value)
    if not match:
        return None
    components = tuple(int(match.group(index)) for index in (1, 2, 3))
    return value if all(component <= semver_component_max for component in components) else None


def asset_from_payload(value):
    if not isinstance(value, dict):
        return None
    name = str(value.get("name") or "").strip()
    url = str(value.get("browser_download_url") or value.get("url") or value.get("download_url") or "").strip()
    return {"name": name, "browser_download_url": url} if name and url else None


def assets_from_payload(data, version):
    values = data.get("assets")
    if isinstance(values, dict):
        semantic_names = {
            "server_deb": f"nia-todo-server-v{version}-full.deb",
            "deb": f"nia-todo-server-v{version}-full.deb",
            "server_deb_sha256": f"nia-todo-server-v{version}-full.deb.sha256",
            "sha256": f"nia-todo-server-v{version}-full.deb.sha256",
            "checksum": f"nia-todo-server-v{version}-full.deb.sha256",
            "manifest": "release-manifest.json",
            "release_manifest": "release-manifest.json",
        }
        named_values = []
        for key, value in values.items():
            name = semantic_names.get(str(key), str(key))
            if isinstance(value, str):
                named_values.append({"name": name, "url": value})
            elif isinstance(value, dict):
                named_values.append({"name": value.get("name") or name, **value})
        values = named_values
    assets = [asset_from_payload(value) for value in values or []]
    for key in ("deb_asset", "sha256_asset", "manifest_asset"):
        asset = asset_from_payload(data.get(key))
        if asset:
            assets.append(asset)
    return [asset for asset in assets if asset is not None]


def trusted_github_asset_url(url, version, filename):
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


def manifest_assets_from_payload(data, assets):
    declared = []
    if "manifest_asset" in data and data["manifest_asset"] is not None:
        asset = asset_from_payload(data["manifest_asset"])
        if not asset or asset["name"] != "release-manifest.json":
            raise RuntimeError("release manifest asset must be named 'release-manifest.json'")
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
            asset = asset_from_payload(value)
            if not asset or asset["name"] != "release-manifest.json":
                raise RuntimeError("release manifest asset must be named 'release-manifest.json'")
            declared.append(asset)
    elif isinstance(values, list):
        for value in values:
            if not isinstance(value, dict) or str(value.get("name") or "").strip() != "release-manifest.json":
                continue
            asset = asset_from_payload(value)
            if not asset:
                raise RuntimeError("release manifest asset must include a download URL")
            declared.append(asset)

    declared.extend(asset for asset in assets if asset["name"] == "release-manifest.json")
    return declared


def normalize_release(data, version_value):
    if not isinstance(data, dict):
        raise RuntimeError("release response must be a JSON object")
    version = stable_version(version_value)
    if not version:
        raise RuntimeError("release version is not stable bounded SemVer")
    assets = assets_from_payload(data, version)
    deb_name = f"nia-todo-server-v{version}-full.deb"
    deb = next((asset for asset in assets if asset["name"] == deb_name), None)
    sha_name = f"{deb_name}.sha256"
    sha = next((asset for asset in assets if asset["name"] == sha_name), None)
    if not deb:
        raise RuntimeError("release does not contain the exact nia-todo full Debian package")
    if not sha:
        raise RuntimeError(f"release does not contain matching checksum asset {sha_name}")
    manifests = manifest_assets_from_payload(data, assets)
    for asset in (deb, sha, *manifests):
        if not trusted_github_asset_url(asset["browser_download_url"], version, asset["name"]):
            raise RuntimeError(f"release asset {asset['name']!r} is not a trusted GitHub HTTPS URL")
    return {"version": version, "deb": deb, "sha": sha, "manifest": manifests[0] if manifests else None}


def normalize_primary_release(data):
    if not isinstance(data, dict):
        raise RuntimeError("primary manifest must be a JSON object")
    for key in ("latest", "release"):
        if key in data and data[key] is not None and not isinstance(data[key], dict):
            raise RuntimeError(f"primary manifest {key} must be an object")
    nested = data.get("latest") or data.get("release")
    payload = {**data, **nested} if isinstance(nested, dict) else data
    for level in (data, data.get("latest"), data.get("release"), payload):
        if not isinstance(level, dict):
            continue
        channel = str(level.get("channel") or "stable").strip().lower()
        if channel != "stable":
            raise RuntimeError("primary manifest is not the stable channel")
    release = normalize_release(payload, payload.get("version") or payload.get("tag_name"))
    return {**release, "source": "primary"}


def normalize_github_release(data):
    if not isinstance(data, dict):
        raise RuntimeError("GitHub release must be a JSON object")
    if data.get("draft") or data.get("prerelease"):
        raise RuntimeError("GitHub release is not stable")
    release = normalize_release(data, data.get("tag_name"))
    return {**release, "source": "github"}


def get_latest_release():
    errors = []
    try:
        return normalize_primary_release(fetch_json(primary_url))
    except Exception as exc:
        errors.append(f"primary: {type(exc).__name__}")
    try:
        return normalize_github_release(fetch_json(github_api_url))
    except Exception as exc:
        errors.append(f"github: {type(exc).__name__}")
    raise RuntimeError("; ".join(errors))


print("phase=fetch_release", file=sys.stderr)
release = get_latest_release()
tag_version = release["version"]
deb = release["deb"]
sha = release["sha"]
deb_name = deb["name"]

print(f"phase=download_checksum version={tag_version} source={release['source']}", file=sys.stderr)
sha_text = fetch_bytes(sha["browser_download_url"], 64 * 1024).decode("utf-8", errors="replace")
parts = sha_text.strip().split()
if not parts or not re.fullmatch(r"[a-fA-F0-9]{64}", parts[0]):
    raise RuntimeError("checksum asset does not contain a valid SHA256")
if len(parts) > 1 and Path(parts[-1]).name != deb_name:
    raise RuntimeError("checksum asset filename does not match Debian package")
expected_sha = parts[0].lower()

print(f"phase=download_deb asset={deb_name}", file=sys.stderr)
data = fetch_bytes(deb["browser_download_url"], 350 * 1024 * 1024)
print("phase=verify_sha256", file=sys.stderr)
actual_sha = hashlib.sha256(data).hexdigest()
if actual_sha != expected_sha:
    raise RuntimeError("downloaded Debian package checksum mismatch")

fd, tmp_name = tempfile.mkstemp(prefix="nia-todo-update-", suffix=".deb", dir=str(cache_dir))
try:
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    os.chmod(tmp_name, 0o644)
    final_path = cache_dir / deb_name
    os.replace(tmp_name, final_path)
    os.chown(final_path, 0, 0)
    os.chmod(final_path, 0o644)
    print(final_path)
except Exception:
    try:
        os.unlink(tmp_name)
    except OSError:
        pass
    raise
PY
} | tail -n 1)"

if [ -z "${DEB_PATH}" ] || [ ! -f "${DEB_PATH}" ]; then
  echo "Helper did not produce a Debian package." >&2
  exit 1
fi

PACKAGE_NAME="$(dpkg-deb -f "${DEB_PATH}" Package)"
PACKAGE_VERSION="$(dpkg-deb -f "${DEB_PATH}" Version)"
EXPECTED_VERSION="$(basename "${DEB_PATH}" | sed -n 's/^nia-todo-server-v\([0-9][0-9.]*\)-full\.deb$/\1/p')"
if [ "${PACKAGE_NAME}" != "nia-todo" ]; then
  echo "Refusing package '${PACKAGE_NAME}', expected 'nia-todo'." >&2
  exit 2
fi
if ! [[ "${PACKAGE_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Refusing non-stable package version '${PACKAGE_VERSION}'." >&2
  exit 2
fi
if [ -z "${EXPECTED_VERSION}" ] || [ "${PACKAGE_VERSION}" != "${EXPECTED_VERSION}" ]; then
  echo "Refusing package version '${PACKAGE_VERSION}', expected '${EXPECTED_VERSION}' from verified release asset." >&2
  exit 2
fi

write_status "running" "Downloaded and verified package. Creating backup…" "${PACKAGE_VERSION}"

if command -v nia-todo-backup >/dev/null 2>&1; then
  nia-todo-backup || true
elif [ -f /var/lib/nia-todo/nia-todo.db ]; then
  mkdir -p /var/lib/nia-todo/backups
  cp /var/lib/nia-todo/nia-todo.db "/var/lib/nia-todo/backups/pre-self-update-$(date +%Y%m%d-%H%M%S).db" || true
fi

if [ "${NIA_TODO_UPDATE_DRY_RUN:-0}" = "1" ]; then
  write_status "success" "Dry-run update completed. Hard reload required." "${PACKAGE_VERSION}"
  echo "nia-todo dry-run update validated package ${PACKAGE_VERSION}."
  exit 0
fi

write_status "running" "Installing Debian package…" "${PACKAGE_VERSION}"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y "${DEB_PATH}"
write_status "success" "nia-todo updated successfully. Service restart requested. Hard reload required." "${PACKAGE_VERSION}"
systemctl restart --no-block "${SERVICE_NAME}.service"

echo "nia-todo updated to ${PACKAGE_VERSION}."
