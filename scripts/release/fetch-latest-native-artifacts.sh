#!/bin/bash
# Fetch the Windows/Android/Debian-desktop artifacts bundled in the most
# recent published GitHub release, for ad-hoc Docker/server-.deb test builds
# that don't rebuild native apps from scratch. Requires `gh` to be
# authenticated (GH_TOKEN).
# Usage: scripts/release/fetch-latest-native-artifacts.sh --github-repo OWNER/REPO --output-dir DIR

set -euo pipefail

usage() {
    cat <<USAGE
Usage: $0 --github-repo OWNER/REPO --output-dir DIR
USAGE
}

GITHUB_REPO=""
OUTPUT_DIR=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --github-repo) GITHUB_REPO="${2:-}"; shift 2 ;;
        --output-dir) OUTPUT_DIR="${2:-}"; shift 2 ;;
        --*) echo "❌ Unknown option: $1"; usage; exit 1 ;;
        *) echo "❌ Unexpected argument: $1"; usage; exit 1 ;;
    esac
done
[ -n "${GITHUB_REPO}" ] || { usage; exit 1; }
[ -n "${OUTPUT_DIR}" ] || { usage; exit 1; }

LATEST_TAG="$(gh release view --repo "${GITHUB_REPO}" --json tagName -q .tagName 2>/dev/null || true)"
if [ -z "${LATEST_TAG}" ]; then
    echo "❌ No published GitHub release found on ${GITHUB_REPO} to fetch native apps from."
    echo "   Build fresh native apps instead (tick the windows/android/debian_desktop options)."
    exit 1
fi
NATIVE_APP_VERSION="${LATEST_TAG#v}"
echo "📦 Fetching native apps bundled in release ${LATEST_TAG}..."

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT
gh release download "${LATEST_TAG}" \
    --repo "${GITHUB_REPO}" \
    --pattern "nia-todo-server-${LATEST_TAG}-full.deb" \
    --dir "${WORK_DIR}/download" \
    --clobber
DEB="${WORK_DIR}/download/nia-todo-server-${LATEST_TAG}-full.deb"
[ -f "${DEB}" ] || { echo "❌ Could not download nia-todo-server-${LATEST_TAG}-full.deb"; exit 1; }

dpkg-deb -x "${DEB}" "${WORK_DIR}/extract"
SOURCE_DIR="${WORK_DIR}/extract/opt/nia-todo/web/downloads"

mkdir -p "${OUTPUT_DIR}"
copy_or_fail() {
    local source="$1" dest="$2"
    [ -f "${source}" ] || { echo "❌ Missing expected artifact in ${LATEST_TAG}: ${source}"; exit 1; }
    cp "${source}" "${dest}"
}
copy_or_fail "${SOURCE_DIR}/nia-todo-${LATEST_TAG}-windows-x64-setup.exe" "${OUTPUT_DIR}/nia-todo-ci-windows-x64-setup.exe"
copy_or_fail "${SOURCE_DIR}/nia-todo-${LATEST_TAG}-android-arm64.apk" "${OUTPUT_DIR}/nia-todo-ci-android-arm64.apk"
copy_or_fail "${SOURCE_DIR}/nia-todo-desktop-${LATEST_TAG}-debian-amd64.deb" "${OUTPUT_DIR}/nia-todo-ci-debian-amd64.deb"

echo "native_app_version=${NATIVE_APP_VERSION}" > "${OUTPUT_DIR}/native-app-version.env"
echo "✅ Reused native apps from ${LATEST_TAG} staged in ${OUTPUT_DIR}"
