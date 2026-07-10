#!/bin/bash
# Repack the Tauri-generated Linux desktop .deb with a package name that does
# not collide with the nia-todo server package.

set -euo pipefail

INPUT="${1:-}"
OUTPUT="${2:-}"
PACKAGE_NAME="${NIA_TODO_DESKTOP_DEB_PACKAGE:-nia-todo-desktop}"

if [ -z "${INPUT}" ] || [ ! -f "${INPUT}" ]; then
  echo "Usage: $0 INPUT.deb [OUTPUT.deb]" >&2
  exit 2
fi

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 127; }
}
need_cmd dpkg-deb
need_cmd sed

VERSION="$(dpkg-deb -f "${INPUT}" Version)"
ARCH="$(dpkg-deb -f "${INPUT}" Architecture)"
[ -n "${VERSION}" ] || { echo "Could not read Debian package version from ${INPUT}" >&2; exit 1; }
[ -n "${ARCH}" ] || { echo "Could not read Debian package architecture from ${INPUT}" >&2; exit 1; }

if [ -z "${OUTPUT}" ]; then
  OUTPUT="$(dirname "${INPUT}")/${PACKAGE_NAME}_${VERSION}_${ARCH}.deb"
fi

WORK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

dpkg-deb -R "${INPUT}" "${WORK_DIR}/root"
CONTROL="${WORK_DIR}/root/DEBIAN/control"
if ! grep -q '^Package:' "${CONTROL}"; then
  echo "Missing Package field in ${CONTROL}" >&2
  exit 1
fi
sed -i "s/^Package:.*/Package: ${PACKAGE_NAME}/" "${CONTROL}"

dpkg-deb --build "${WORK_DIR}/root" "${OUTPUT}" >/dev/null

echo "${OUTPUT}"
