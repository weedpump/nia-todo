#!/bin/bash
# Reset the nia-todo admin password for package installs.

set -euo pipefail

DEFAULT_ETC_DIR="/etc/nia-todo"
ETC_DIR="${NIA_TODO_ETC_DIR:-${DEFAULT_ETC_DIR}}"
ENV_FILE="${NIA_TODO_ENV_FILE:-${ETC_DIR}/nia-todo.env}"

if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

DEFAULT_APP_DIR="/opt/nia-todo"
if [ ! -d "${DEFAULT_APP_DIR}" ] && [ -d "/app" ]; then
  DEFAULT_APP_DIR="/app"
fi
APP_DIR="${NIA_TODO_APP_DIR:-${DEFAULT_APP_DIR}}"
PYTHON="${NIA_TODO_PYTHON:-${APP_DIR}/.venv/bin/python3}"
SCRIPT="${APP_DIR}/api/change_admin_password.py"

if [ ! -x "${PYTHON}" ]; then
  PYTHON="$(command -v python3)"
fi

if [ ! -f "${SCRIPT}" ]; then
  echo "nia-todo admin password reset script not found: ${SCRIPT}" >&2
  exit 1
fi

exec "${PYTHON}" "${SCRIPT}" "$@"
