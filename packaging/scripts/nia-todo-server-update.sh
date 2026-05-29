#!/bin/bash
# Root-only helper used by the admin panel to install the latest verified nia-todo .deb.
# The unprivileged app process may only start this helper; it cannot choose a package path.

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-}"
NIA_TODO_SERVICE_NAME="${NIA_TODO_SERVICE_NAME:-}"
CACHE_DIR="/var/cache/nia-todo/updates"
STATUS_FILE="${CACHE_DIR}/status.json"
UPDATE_LOG_DIR="/var/lib/nia-todo/update-logs"
UPDATE_LOG_FILE="${UPDATE_LOG_DIR}/nia-todo-server-update.log"
SOURCE_CONFIG="/etc/nia-todo/update-source.env"
RELEASE_API_LATEST="${RELEASE_API_LATEST:-https://api.github.com/repos/weedpump/nia-todo/releases/latest}"
UNIT_NAME="nia-todo-server-update"

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
RELEASE_API_LATEST="${RELEASE_API_LATEST:-https://api.github.com/repos/weedpump/nia-todo/releases/latest}"

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
install -d -m 0755 -o root -g root "${UPDATE_LOG_DIR}"
touch "${UPDATE_LOG_FILE}"
chmod 0644 "${UPDATE_LOG_FILE}" || true
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
export RELEASE_API_LATEST SERVICE_NAME NIA_TODO_SERVICE_NAME="${SERVICE_NAME}"
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
        --setenv="RELEASE_API_LATEST=${RELEASE_API_LATEST}" \
        --setenv="SERVICE_NAME=${SERVICE_NAME}" \
        --setenv="NIA_TODO_SERVICE_NAME=${SERVICE_NAME}" \
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

api_url = os.environ.get("RELEASE_API_LATEST", "https://api.github.com/repos/weedpump/nia-todo/releases/latest")
cache_dir = Path("/var/cache/nia-todo/updates")
asset_re = re.compile(r"^nia-todo-server-v(?P<version>[0-9]+\.[0-9]+\.[0-9]+)-full\.deb$")


def fetch_json(url: str):
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "nia-todo-root-update-helper"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


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

print("phase=fetch_release", file=sys.stderr)
release = fetch_json(api_url)
tag = str(release.get("tag_name") or "")
if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag):
    raise RuntimeError(f"latest release tag is not stable SemVer: {tag!r}")
tag_version = tag[1:]
assets = release.get("assets") or []
deb = None
for asset in assets:
    if isinstance(asset, dict) and asset_re.fullmatch(str(asset.get("name") or "")):
        deb = asset
        break
if not deb:
    raise RuntimeError("release does not contain a nia-todo full Debian package")
deb_name = str(deb.get("name") or "")
deb_version = asset_re.fullmatch(deb_name).group("version")
if deb_version != tag_version:
    raise RuntimeError(f"Debian package version {deb_version!r} does not match release tag {tag!r}")
sha_name = deb_name + ".sha256"
sha = next((asset for asset in assets if isinstance(asset, dict) and asset.get("name") == sha_name), None)
if not sha:
    raise RuntimeError(f"release does not contain matching checksum asset {sha_name}")

print(f"phase=download_checksum version={tag_version}", file=sys.stderr)
sha_text = fetch_bytes(str(sha["browser_download_url"]), 64 * 1024).decode("utf-8", errors="replace")
parts = sha_text.strip().split()
if not parts or not re.fullmatch(r"[a-fA-F0-9]{64}", parts[0]):
    raise RuntimeError("checksum asset does not contain a valid SHA256")
if len(parts) > 1 and Path(parts[-1]).name != deb_name:
    raise RuntimeError("checksum asset filename does not match Debian package")
expected_sha = parts[0].lower()

print(f"phase=download_deb asset={deb_name}", file=sys.stderr)
data = fetch_bytes(str(deb["browser_download_url"]), 350 * 1024 * 1024)
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

if [ -f /var/lib/nia-todo/nia-todo.db ]; then
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
