#!/bin/bash
# Build the nia-todo Docker image from a clean public export.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/release/build-docker.sh VERSION [options]

Options:
  --windows-installer FILE   Signed Windows installer to embed under /downloads
  --android-apk FILE         Signed Android APK to embed under /downloads
  --debian-deb FILE           Debian package to embed under /downloads
  --native-app-version VERSION
                            Native app download version to publish (default: VERSION)
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
DEBIAN_DEB=""
NATIVE_APP_VERSION=""
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
    --debian-deb) DEBIAN_DEB="${2:-}"; shift 2 ;;
    --native-app-version) NATIVE_APP_VERSION="${2:-}"; shift 2 ;;
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
NATIVE_APP_VERSION="${NATIVE_APP_VERSION:-${VERSION}}"
if ! [[ "${NATIVE_APP_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid stable native app version: ${NATIVE_APP_VERSION}" >&2
  exit 2
fi
if [ "${ALLOW_MISSING_APPS}" != "1" ]; then
  [ -n "${WINDOWS_INSTALLER}" ] && [ -f "${WINDOWS_INSTALLER}" ] || { echo "Missing --windows-installer FILE" >&2; exit 1; }
  [ -n "${ANDROID_APK}" ] && [ -f "${ANDROID_APK}" ] || { echo "Missing --android-apk FILE" >&2; exit 1; }
  [ -n "${DEBIAN_DEB}" ] && [ -f "${DEBIAN_DEB}" ] || { echo "Missing --debian-deb FILE" >&2; exit 1; }
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
EMBED_ARGS=(
  --download-dir "${DOWNLOAD_DIR}"
  --web-version "${VERSION}"
  --native-app-version "${NATIVE_APP_VERSION}"
)
if [ -n "${WINDOWS_INSTALLER}" ]; then
  EMBED_ARGS+=(--windows-installer "${WINDOWS_INSTALLER}")
fi
if [ -n "${ANDROID_APK}" ]; then
  EMBED_ARGS+=(--android-apk "${ANDROID_APK}")
fi
if [ -n "${DEBIAN_DEB}" ]; then
  EMBED_ARGS+=(--debian-deb "${DEBIAN_DEB}")
fi
if [ "${ALLOW_MISSING_APPS}" = "1" ]; then
  EMBED_ARGS+=(--allow-missing-apps)
fi
scripts/release/embed-native-downloads.py "${EMBED_ARGS[@]}"

rm -rf "${OUTPUT}/wheelhouse"
mkdir -p "${OUTPUT}/wheelhouse"
OUTPUT_ABS="$(cd "${OUTPUT}" && pwd)"
docker run --rm \
  -v "${OUTPUT_ABS}:/work" \
  -w /work \
  python:3.13.5-slim \
  python -m pip wheel --wheel-dir /work/wheelhouse -r /work/requirements.txt

docker build -t "${TAG}" "${OUTPUT}"
if [ "${LATEST}" = "1" ]; then
  docker tag "${TAG}" nia-todo:latest
fi

echo "✅ Docker image built: ${TAG}"
if [ "${LATEST}" = "1" ]; then echo "✅ Also tagged: nia-todo:latest"; fi
