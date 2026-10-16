#!/bin/bash
# Repack the Tauri-generated Debian desktop .deb with a package name that does
# not collide with the nia-todo server package.

set -euo pipefail

INPUT="${1:-}"
OUTPUT="${2:-}"
UPDATER_BINARY="${3:-}"
PACKAGE_NAME="${NIA_TODO_DESKTOP_DEB_PACKAGE:-nia-todo-desktop}"
APPLICATION_ID="de.tobiaskneidl.nia-todo"
MEDIA_RECORDER_DEPENDENCY="gstreamer1.0-plugins-bad"
PKEXEC_DEPENDENCY="pkexec"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
POLKIT_POLICY="${REPO_ROOT}/src-tauri/linux/de.tobiaskneidl.nia-todo.desktop-update.policy"

if [ -z "${INPUT}" ] || [ ! -f "${INPUT}" ] || [ -z "${UPDATER_BINARY}" ] || [ ! -f "${UPDATER_BINARY}" ]; then
  echo "Usage: $0 INPUT.deb [OUTPUT.deb] UPDATER_BINARY" >&2
  exit 2
fi
[ -f "${POLKIT_POLICY}" ] || { echo "Missing Polkit policy: ${POLKIT_POLICY}" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 127; }
}
need_cmd dpkg-deb
need_cmd find
need_cmd md5sum
need_cmd sed
need_cmd sort
need_cmd xargs

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
if ! grep -Eq '(^|[[:space:],])gstreamer1\.0-plugins-bad([[:space:],]|$)' "${CONTROL}"; then
  if grep -q '^Depends:' "${CONTROL}"; then
    sed -i "/^Depends:/ s/$/, ${MEDIA_RECORDER_DEPENDENCY}/" "${CONTROL}"
  else
    printf 'Depends: %s\n' "${MEDIA_RECORDER_DEPENDENCY}" >> "${CONTROL}"
  fi
fi
if ! grep -Eq '(^|[[:space:],])pkexec([[:space:],]|$)' "${CONTROL}"; then
  if grep -q '^Depends:' "${CONTROL}"; then
    sed -i "/^Depends:/ s/$/, ${PKEXEC_DEPENDENCY}/" "${CONTROL}"
  else
    printf 'Depends: %s\n' "${PKEXEC_DEPENDENCY}" >> "${CONTROL}"
  fi
fi

install -D -m 0755 "${UPDATER_BINARY}" \
  "${WORK_DIR}/root/usr/lib/nia-todo-desktop/nia-todo-desktop-updater"
install -D -m 0644 "${POLKIT_POLICY}" \
  "${WORK_DIR}/root/usr/share/polkit-1/actions/de.tobiaskneidl.nia-todo.desktop-update.policy"
install -d -m 0700 "${WORK_DIR}/root/var/lib/nia-todo-desktop/updater"

PREINST="${WORK_DIR}/root/DEBIAN/preinst"
PREINST_HOOK="${WORK_DIR}/preinst-stop-desktop"
cat > "${PREINST_HOOK}" <<'EOF'

# Stop the desktop process before dpkg replaces its executable and resources.
case "${1:-}" in
  install|upgrade)
    if [ -e /usr/bin/nia-todo-desktop ]; then
      start-stop-daemon --stop --oknodo --retry=TERM/10/KILL/5 --exec /usr/bin/nia-todo-desktop || {
        status=$?
        echo "Could not stop the running nia-todo desktop app" >&2
        exit "${status}"
      }
    fi
    ;;
esac
EOF

if [ -f "${PREINST}" ]; then
  IFS= read -r shebang < "${PREINST}" || true
  case "${shebang}" in
    '#!/bin/sh'|'#!/bin/bash'|'#!/usr/bin/env sh'|'#!/usr/bin/env bash')
      ;;
    *)
      echo "Unsupported existing preinst interpreter: ${shebang:-<missing shebang>}" >&2
      exit 1
      ;;
  esac
  {
    printf '%s\n' "${shebang}" 'set -e'
    cat "${PREINST_HOOK}"
    sed '1d' "${PREINST}"
  } > "${PREINST}.new"
  mv "${PREINST}.new" "${PREINST}"
else
  {
    printf '%s\n' '#!/bin/sh' 'set -e'
    cat "${PREINST_HOOK}"
    printf '%s\n' 'exit 0'
  } > "${PREINST}"
fi
chmod 0755 "${PREINST}"

DESKTOP_DIR="${WORK_DIR}/root/usr/share/applications"
TAURI_DESKTOP_ENTRY="${DESKTOP_DIR}/nia-todo.desktop"
PORTAL_DESKTOP_ENTRY="${DESKTOP_DIR}/${APPLICATION_ID}.desktop"
if [ ! -f "${TAURI_DESKTOP_ENTRY}" ]; then
  echo "Missing desktop entry ${TAURI_DESKTOP_ENTRY}" >&2
  exit 1
fi
mv "${TAURI_DESKTOP_ENTRY}" "${PORTAL_DESKTOP_ENTRY}"

(
  cd "${WORK_DIR}/root"
  find . -type f ! -path './DEBIAN/*' -printf '%P\0' | sort -z | xargs -0 md5sum
) > "${WORK_DIR}/root/DEBIAN/md5sums"

dpkg-deb --root-owner-group --build "${WORK_DIR}/root" "${OUTPUT}" >/dev/null

echo "${OUTPUT}"
