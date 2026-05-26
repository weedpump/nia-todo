#!/bin/bash
# Build the nia-todo Docker image from a clean public export.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/release/build-docker.sh VERSION [options]

Options:
  --windows-installer FILE   Signed Windows installer to embed under /downloads
  --android-apk FILE         Signed Android APK to embed under /downloads
  --allow-missing-apps       Allow building a test image without native app files
  --tag TAG                  Docker tag to build (default: nia-todo:VERSION)
  --latest                   Also tag as nia-todo:latest
  --output DIR               Export/build context directory (default: dist/docker/nia-todo-VERSION)
  --force                    Remove existing build context first
USAGE
}

VERSION=""
WINDOWS_INSTALLER=""
ANDROID_APK=""
ALLOW_MISSING_APPS=0
TAG=""
LATEST=0
OUTPUT=""
FORCE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --windows-installer) WINDOWS_INSTALLER="${2:-}"; shift 2 ;;
    --android-apk) ANDROID_APK="${2:-}"; shift 2 ;;
    --allow-missing-apps) ALLOW_MISSING_APPS=1; shift ;;
    --tag) TAG="${2:-}"; shift 2 ;;
    --latest) LATEST=1; shift ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --*) echo "Unknown option: $1" >&2; usage; exit 2 ;;
    *) [ -z "${VERSION}" ] || { echo "Multiple versions supplied" >&2; exit 2; }; VERSION="$1"; shift ;;
  esac
done

[ -n "${VERSION}" ] || { usage; exit 2; }
if ! [[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid stable version: ${VERSION}" >&2
  exit 2
fi
if [ "${ALLOW_MISSING_APPS}" != "1" ]; then
  [ -n "${WINDOWS_INSTALLER}" ] && [ -f "${WINDOWS_INSTALLER}" ] || { echo "Missing --windows-installer FILE" >&2; exit 1; }
  [ -n "${ANDROID_APK}" ] && [ -f "${ANDROID_APK}" ] || { echo "Missing --android-apk FILE" >&2; exit 1; }
fi
TAG="${TAG:-nia-todo:${VERSION}}"
OUTPUT="${OUTPUT:-dist/docker/nia-todo-${VERSION}}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker command not found; cannot build image on this host" >&2
  exit 127
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

scripts/release/export-public.sh "${VERSION}" --output "${OUTPUT}" ${FORCE:+--force}

DOWNLOAD_DIR="${OUTPUT}/web/downloads"
mkdir -p "${DOWNLOAD_DIR}"
WINDOWS_NAME="nia-todo-v${VERSION}-windows-x64-setup.exe"
ANDROID_NAME="nia-todo-v${VERSION}-android-arm64.apk"
WINDOWS_SHA=""
ANDROID_SHA=""
WINDOWS_SIZE=0
ANDROID_SIZE=0

if [ -n "${WINDOWS_INSTALLER}" ] && [ -f "${WINDOWS_INSTALLER}" ]; then
  cp "${WINDOWS_INSTALLER}" "${DOWNLOAD_DIR}/${WINDOWS_NAME}"
  WINDOWS_SHA="$(sha256sum "${DOWNLOAD_DIR}/${WINDOWS_NAME}" | awk '{print $1}')"
  WINDOWS_SIZE="$(stat -c '%s' "${DOWNLOAD_DIR}/${WINDOWS_NAME}")"
  printf '%s  %s\n' "${WINDOWS_SHA}" "${WINDOWS_NAME}" > "${DOWNLOAD_DIR}/${WINDOWS_NAME}.sha256"
elif [ "${ALLOW_MISSING_APPS}" != "1" ]; then
  echo "Missing --windows-installer FILE" >&2
  exit 1
fi

if [ -n "${ANDROID_APK}" ] && [ -f "${ANDROID_APK}" ]; then
  cp "${ANDROID_APK}" "${DOWNLOAD_DIR}/${ANDROID_NAME}"
  ANDROID_SHA="$(sha256sum "${DOWNLOAD_DIR}/${ANDROID_NAME}" | awk '{print $1}')"
  ANDROID_SIZE="$(stat -c '%s' "${DOWNLOAD_DIR}/${ANDROID_NAME}")"
  printf '%s  %s\n' "${ANDROID_SHA}" "${ANDROID_NAME}" > "${DOWNLOAD_DIR}/${ANDROID_NAME}.sha256"
elif [ "${ALLOW_MISSING_APPS}" != "1" ]; then
  echo "Missing --android-apk FILE" >&2
  exit 1
fi

python3 - "${DOWNLOAD_DIR}" "${VERSION}" "${WINDOWS_NAME}" "${WINDOWS_SHA}" "${WINDOWS_SIZE}" "${ANDROID_NAME}" "${ANDROID_SHA}" "${ANDROID_SIZE}" <<'PYD'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

download_dir = Path(sys.argv[1])
version = sys.argv[2]
windows_name, windows_sha, windows_size = sys.argv[3], sys.argv[4], int(sys.argv[5])
android_name, android_sha, android_size = sys.argv[6], sys.argv[7], int(sys.argv[8])
apps = []
if windows_sha:
    apps.append({"platform": "windows", "arch": "x64", "label": "Windows Setup", "version": f"v{version}", "filename": windows_name, "url": f"/downloads/{windows_name}", "sha256": windows_sha, "size_bytes": windows_size})
if android_sha:
    apps.append({"platform": "android", "arch": "arm64", "label": "Android APK", "version": f"v{version}", "filename": android_name, "url": f"/downloads/{android_name}", "sha256": android_sha, "size_bytes": android_size})
manifest = {"version": f"v{version}", "web_version": f"v{version}", "generated_at": datetime.now(timezone.utc).isoformat(), "latest": {"version": f"v{version}"}, "apps": sorted(apps, key=lambda item: item["platform"])}
(download_dir / "app-downloads.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PYD

rm -rf "${OUTPUT}/wheelhouse"
mkdir -p "${OUTPUT}/wheelhouse"
docker run --rm \
  -v "${OUTPUT}:/work" \
  -w /work \
  python:3.13.5-slim \
  python -m pip wheel --wheel-dir /work/wheelhouse -r /work/requirements.txt

docker build -t "${TAG}" "${OUTPUT}"
if [ "${LATEST}" = "1" ]; then
  docker tag "${TAG}" nia-todo:latest
fi

echo "✅ Docker image built: ${TAG}"
if [ "${LATEST}" = "1" ]; then echo "✅ Also tagged: nia-todo:latest"; fi
