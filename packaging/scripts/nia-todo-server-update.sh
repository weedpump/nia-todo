#!/bin/bash
# Root-only helper used by the admin panel to install a verified nia-todo .deb.

set -euo pipefail

DEB_PATH="${1:-}"
ALLOWED_DIR="/var/lib/nia-todo/updates"
SERVICE_NAME="${NIA_TODO_SERVICE_NAME:-nia-todo}"

if [ "$(id -u)" -ne 0 ]; then
  echo "This helper must run as root." >&2
  exit 1
fi

if [ -z "${DEB_PATH}" ]; then
  echo "Usage: nia-todo-server-update /var/lib/nia-todo/updates/nia-todo-server-vX.Y.Z-full.deb" >&2
  exit 2
fi

DEB_PATH="$(readlink -f "${DEB_PATH}")"
case "${DEB_PATH}" in
  ${ALLOWED_DIR}/nia-todo-server-v*-full.deb) ;;
  *)
    echo "Refusing to install package outside ${ALLOWED_DIR}." >&2
    exit 2
    ;;
esac

if [ ! -f "${DEB_PATH}" ]; then
  echo "Debian package not found: ${DEB_PATH}" >&2
  exit 2
fi

PACKAGE_NAME="$(dpkg-deb -f "${DEB_PATH}" Package)"
PACKAGE_VERSION="$(dpkg-deb -f "${DEB_PATH}" Version)"
if [ "${PACKAGE_NAME}" != "nia-todo" ]; then
  echo "Refusing package '${PACKAGE_NAME}', expected 'nia-todo'." >&2
  exit 2
fi
if ! [[ "${PACKAGE_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Refusing non-stable package version '${PACKAGE_VERSION}'." >&2
  exit 2
fi

if [ -f /var/lib/nia-todo/nia-todo.db ]; then
  mkdir -p /var/lib/nia-todo/backups
  cp /var/lib/nia-todo/nia-todo.db "/var/lib/nia-todo/backups/pre-self-update-$(date +%Y%m%d-%H%M%S).db" || true
fi

export DEBIAN_FRONTEND=noninteractive
apt-get install -y "${DEB_PATH}"
systemctl restart "${SERVICE_NAME}.service"

echo "nia-todo updated to ${PACKAGE_VERSION}."
