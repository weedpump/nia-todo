#!/bin/bash
# Build the self-hosted nia-todo full bundle as a Debian package.
# The package contains the server plus bundled native app downloads.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/release/build-full-bundle.sh VERSION --windows-installer FILE --android-apk FILE --debian-deb FILE [options]

Options:
  --native-app-version VERSION
                         Native app download version to publish (default: VERSION)
  --output-dir DIR       Output directory (default: dist/release)
  --work-dir DIR         Build work directory (default: dist/build/full-bundle-VERSION)
  --allow-missing-apps   Allow building a test package without native app files
  --force                Remove existing work directory first
USAGE
}

VERSION=""
WINDOWS_INSTALLER=""
ANDROID_APK=""
DEBIAN_DEB=""
NATIVE_APP_VERSION=""
OUTPUT_DIR="dist/release"
WORK_DIR=""
ALLOW_MISSING_APPS=0
FORCE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --windows-installer) WINDOWS_INSTALLER="${2:-}"; shift 2 ;;
    --android-apk) ANDROID_APK="${2:-}"; shift 2 ;;
    --debian-deb) DEBIAN_DEB="${2:-}"; shift 2 ;;
    --native-app-version) NATIVE_APP_VERSION="${2:-}"; shift 2 ;;
    --output-dir) OUTPUT_DIR="${2:-}"; shift 2 ;;
    --work-dir) WORK_DIR="${2:-}"; shift 2 ;;
    --allow-missing-apps) ALLOW_MISSING_APPS=1; shift ;;
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

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"
WORK_DIR="${WORK_DIR:-dist/build/full-bundle-${VERSION}}"

if [ -e "${WORK_DIR}" ]; then
  [ "${FORCE}" = "1" ] || { echo "Work dir exists: ${WORK_DIR} (use --force)" >&2; exit 1; }
  rm -rf "${WORK_DIR}"
fi
mkdir -p "${WORK_DIR}" "${OUTPUT_DIR}"

EXPORT_DIR="${WORK_DIR}/source"
scripts/release/stage-package-source.sh "${VERSION}" --output "${EXPORT_DIR}" --force

rm -rf "${EXPORT_DIR}/wheelhouse"
mkdir -p "${EXPORT_DIR}/wheelhouse"
EXPORT_DIR_ABS="$(cd "${EXPORT_DIR}" && pwd)"
docker run --rm \
  -v "${EXPORT_DIR_ABS}:/work" \
  -w /work \
  python:3.13.5-slim \
  python -m pip wheel --wheel-dir /work/wheelhouse -r /work/requirements.txt

DOWNLOAD_DIR="${EXPORT_DIR}/web/downloads"
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

DEB_ROOT="${WORK_DIR}/debroot"
PKG_DIR="${DEB_ROOT}/opt/nia-todo"
mkdir -p "${PKG_DIR}" "${DEB_ROOT}/DEBIAN" "${DEB_ROOT}/lib/systemd/system" "${DEB_ROOT}/etc/nia-todo" "${DEB_ROOT}/var/lib/nia-todo"
cp -a "${EXPORT_DIR}/." "${PKG_DIR}/"

cat > "${DEB_ROOT}/etc/nia-todo/nia-todo.env" <<'ENV'
NIA_TODO_HOST=0.0.0.0
NIA_TODO_PORT=8753
NIA_TODO_DATA_DIR=/var/lib/nia-todo
NIA_TODO_DB=nia-todo.db
ENV

cat > "${PKG_DIR}/run-service.sh" <<'RUN'
#!/bin/bash
set -euo pipefail
cd /opt/nia-todo
export PATH="/opt/nia-todo/.venv/bin:${PATH}"
exec ./start.sh
RUN
chmod +x "${PKG_DIR}/run-service.sh" "${PKG_DIR}/start.sh"

cp "${EXPORT_DIR}/packaging/systemd/nia-todo.service" "${DEB_ROOT}/lib/systemd/system/nia-todo.service"
sed -i 's#ExecStart=/opt/nia-todo/start.sh#ExecStart=/opt/nia-todo/run-service.sh#' "${DEB_ROOT}/lib/systemd/system/nia-todo.service"
cp "${EXPORT_DIR}/packaging/systemd/nia-todo-backup.service" "${DEB_ROOT}/lib/systemd/system/nia-todo-backup.service"
cp "${EXPORT_DIR}/packaging/systemd/nia-todo-backup.timer" "${DEB_ROOT}/lib/systemd/system/nia-todo-backup.timer"

cat > "${DEB_ROOT}/DEBIAN/conffiles" <<'EOF'
/etc/nia-todo/nia-todo.env
EOF

cat > "${DEB_ROOT}/DEBIAN/control" <<EOF
Package: nia-todo
Version: ${VERSION}
Section: web
Priority: optional
Architecture: all
Depends: python3 (>= 3.10), python3-venv, adduser, sudo
Maintainer: nia-todo maintainers
Description: Self-hosted todo system with bundled native app downloads
EOF

cat > "${DEB_ROOT}/DEBIAN/postinst" <<'POSTINST'
#!/bin/bash
set -e
if ! getent group nia-todo >/dev/null; then
  addgroup --system nia-todo
fi
if ! id nia-todo >/dev/null 2>&1; then
  adduser --system --ingroup nia-todo --home /opt/nia-todo --no-create-home --disabled-login nia-todo
fi
if [ -f /etc/nia-todo/nia-todo.env ] && ! grep -q '^NIA_TODO_DATA_DIR=' /etc/nia-todo/nia-todo.env; then
  printf '\nNIA_TODO_DATA_DIR=/var/lib/nia-todo\n' >> /etc/nia-todo/nia-todo.env
fi
mkdir -p /var/lib/nia-todo /var/lib/nia-todo/backups /var/lib/nia-todo/avatars /var/lib/nia-todo/attachments /opt/nia-todo/api/data
install -d -m 0755 -o root -g root /var/cache/nia-todo/updates
if [ -f /var/lib/nia-todo/nia-todo.db ]; then
  cp /var/lib/nia-todo/nia-todo.db "/var/lib/nia-todo/backups/pre-upgrade-$(date +%Y%m%d-%H%M%S).db" || true
fi
if [ -d /opt/nia-todo/api/data ]; then
  cp -an /opt/nia-todo/api/data/. /var/lib/nia-todo/ || true
fi
rm -rf /opt/nia-todo/api/data
mkdir -p /opt/nia-todo/api/data
: > /opt/nia-todo/api/data/.gitkeep
python3 -m venv /opt/nia-todo/.venv
if ! /opt/nia-todo/.venv/bin/pip install --no-index --find-links=/opt/nia-todo/wheelhouse -r /opt/nia-todo/requirements.txt; then
  /opt/nia-todo/.venv/bin/pip install -r /opt/nia-todo/requirements.txt
fi
rm -rf /opt/nia-todo/wheelhouse
install -m 755 /opt/nia-todo/scripts/nia-todo-backup.sh /usr/local/bin/nia-todo-backup
install -m 755 /opt/nia-todo/scripts/nia-todo-restore.sh /usr/local/bin/nia-todo-restore
install -m 755 /opt/nia-todo/scripts/nia-todo-admin-password-reset.sh /usr/local/bin/nia-todo-admin-password-reset
install -m 755 -o root -g root /opt/nia-todo/scripts/nia-todo-server-update.sh /usr/local/bin/nia-todo-server-update
mkdir -p /etc/sudoers.d
cat > /etc/sudoers.d/nia-todo-server-update <<'SUDOERS'
nia-todo ALL=(root) NOPASSWD: /usr/local/bin/nia-todo-server-update ""
SUDOERS
chmod 440 /etc/sudoers.d/nia-todo-server-update
chown -R nia-todo:nia-todo /opt/nia-todo /var/lib/nia-todo
chmod 750 /var/lib/nia-todo
[ ! -f /var/lib/nia-todo/vapid_keys.json ] || chmod 600 /var/lib/nia-todo/vapid_keys.json
systemctl daemon-reload || true
systemctl enable nia-todo.service || true
systemctl enable --now nia-todo-backup.timer || true
systemctl restart nia-todo.service || true
POSTINST
chmod 755 "${DEB_ROOT}/DEBIAN/postinst"

cat > "${DEB_ROOT}/DEBIAN/prerm" <<'PRERM'
#!/bin/bash
set -e
if [ "${1:-}" = "remove" ]; then
  systemctl stop nia-todo-backup.timer || true
  systemctl disable nia-todo-backup.timer || true
  systemctl stop nia-todo.service || true
  systemctl disable nia-todo.service || true
fi
PRERM
chmod 755 "${DEB_ROOT}/DEBIAN/prerm"

find "${DEB_ROOT}" -type f -name '*.pyc' -delete
PACKAGE="${OUTPUT_DIR}/nia-todo-server-v${VERSION}-full.deb"
dpkg-deb --build "${DEB_ROOT}" "${PACKAGE}" >/dev/null
(cd "${OUTPUT_DIR}" && sha256sum "$(basename "${PACKAGE}")") > "${PACKAGE}.sha256"

echo "✅ Full bundle package: ${PACKAGE}"
echo "✅ Checksum: ${PACKAGE}.sha256"
