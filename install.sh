#!/bin/bash
# Install or update nia-todo from a full server bundle.

set -euo pipefail

APP_DIR="${NIA_TODO_APP_DIR:-/opt/nia-todo}"
ETC_DIR="${NIA_TODO_ETC_DIR:-/etc/nia-todo}"
DATA_DIR="${NIA_TODO_DATA_DIR:-/var/lib/nia-todo}"
SERVICE_NAME="${NIA_TODO_SERVICE_NAME:-nia-todo}"
USER_NAME="${NIA_TODO_USER:-nia-todo}"
GROUP_NAME="${NIA_TODO_GROUP:-nia-todo}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo ./install.sh)." >&2
  exit 1
fi

if ! getent group "${GROUP_NAME}" >/dev/null; then
  groupadd --system "${GROUP_NAME}"
fi
if ! id "${USER_NAME}" >/dev/null 2>&1; then
  useradd --system --gid "${GROUP_NAME}" --home-dir "${APP_DIR}" --shell /usr/sbin/nologin "${USER_NAME}"
fi

mkdir -p "${APP_DIR}" "${ETC_DIR}" "${DATA_DIR}" "${DATA_DIR}/backups" "${DATA_DIR}/avatars"

if [ -f "${DATA_DIR}/nia-todo.db" ]; then
  cp "${DATA_DIR}/nia-todo.db" "${DATA_DIR}/backups/pre-install-$(date +%Y%m%d-%H%M%S).db" || true
fi

# One-time migration from pre-public-package layout.
if [ -d "${APP_DIR}/api/data" ]; then
  cp -an "${APP_DIR}/api/data/." "${DATA_DIR}/" || true
fi

# Replace application files. Runtime data lives in DATA_DIR, not APP_DIR.
find "${APP_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a "${SOURCE_DIR}/." "${APP_DIR}/"
install -d -m 755 "${APP_DIR}/scripts"
cp -a "${SOURCE_DIR}/scripts/." "${APP_DIR}/scripts/"
rm -rf "${APP_DIR}/api/data"
mkdir -p "${APP_DIR}/api/data"
: > "${APP_DIR}/api/data/.gitkeep"

if [ ! -f "${ETC_DIR}/nia-todo.env" ]; then
  cat > "${ETC_DIR}/nia-todo.env" <<ENV
NIA_TODO_HOST=0.0.0.0
NIA_TODO_PORT=8753
NIA_TODO_DATA_DIR=${DATA_DIR}
NIA_TODO_DB=nia-todo.db
ENV
elif ! grep -q '^NIA_TODO_DATA_DIR=' "${ETC_DIR}/nia-todo.env"; then
  printf '\nNIA_TODO_DATA_DIR=%s\n' "${DATA_DIR}" >> "${ETC_DIR}/nia-todo.env"
fi
if [ "${SERVICE_NAME}" != "nia-todo" ]; then
  if grep -q '^NIA_TODO_SERVICE_NAME=' "${ETC_DIR}/nia-todo.env"; then
    sed -i "s/^NIA_TODO_SERVICE_NAME=.*/NIA_TODO_SERVICE_NAME=${SERVICE_NAME}/" "${ETC_DIR}/nia-todo.env"
  else
    printf '\nNIA_TODO_SERVICE_NAME=%s\n' "${SERVICE_NAME}" >> "${ETC_DIR}/nia-todo.env"
  fi
fi

python3 -m venv "${APP_DIR}/.venv"
if [ -d "${APP_DIR}/wheelhouse" ]; then
  "${APP_DIR}/.venv/bin/pip" install --no-index --find-links="${APP_DIR}/wheelhouse" -r "${APP_DIR}/requirements.txt"
  rm -rf "${APP_DIR}/wheelhouse"
else
  "${APP_DIR}/.venv/bin/pip" install -r "${APP_DIR}/requirements.txt"
fi

# Ensure start.sh uses the venv Python without modifying application code.
cat > "${APP_DIR}/run-service.sh" <<'RUN'
#!/bin/bash
set -euo pipefail
cd /opt/nia-todo
export PATH="/opt/nia-todo/.venv/bin:${PATH}"
exec ./start.sh
RUN
chmod +x "${APP_DIR}/run-service.sh" "${APP_DIR}/start.sh"

cp "${APP_DIR}/packaging/systemd/nia-todo.service" "/etc/systemd/system/${SERVICE_NAME}.service"
sed -i 's#ExecStart=/opt/nia-todo/start.sh#ExecStart=/opt/nia-todo/run-service.sh#' "/etc/systemd/system/${SERVICE_NAME}.service"
cp "${APP_DIR}/packaging/systemd/nia-todo-backup.service" "/etc/systemd/system/${SERVICE_NAME}-backup.service"
cp "${APP_DIR}/packaging/systemd/nia-todo-backup.timer" "/etc/systemd/system/${SERVICE_NAME}-backup.timer"
install -m 755 "${APP_DIR}/scripts/nia-todo-backup.sh" "/usr/local/bin/nia-todo-backup"
install -m 755 "${APP_DIR}/scripts/nia-todo-restore.sh" "/usr/local/bin/nia-todo-restore"
install -m 755 -o root -g root "${APP_DIR}/scripts/nia-todo-server-update.sh" "/usr/local/bin/nia-todo-server-update"
install -d -m 0755 -o root -g root "/var/cache/nia-todo/updates"
if [ "${SERVICE_NAME}" != "nia-todo" ]; then
  cat > "${ETC_DIR}/update-source.env" <<ENV
SERVICE_NAME=${SERVICE_NAME}
ENV
  chown root:root "${ETC_DIR}/update-source.env"
  chmod 0644 "${ETC_DIR}/update-source.env"
fi
cat > "/etc/sudoers.d/nia-todo-server-update" <<SUDOERS
${USER_NAME} ALL=(root) NOPASSWD: /usr/local/bin/nia-todo-server-update ""
SUDOERS
chmod 440 "/etc/sudoers.d/nia-todo-server-update"

chown -R "${USER_NAME}:${GROUP_NAME}" "${APP_DIR}" "${DATA_DIR}"
chmod 750 "${DATA_DIR}"
[ ! -f "${DATA_DIR}/vapid_keys.json" ] || chmod 600 "${DATA_DIR}/vapid_keys.json"
chown -R root:root "${ETC_DIR}"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"
systemctl enable --now "${SERVICE_NAME}-backup.timer"
systemctl restart "${SERVICE_NAME}.service"

echo "nia-todo installed/updated in ${APP_DIR}."
echo "Service: systemctl status ${SERVICE_NAME}"
echo "Backup timer: systemctl status ${SERVICE_NAME}-backup.timer"
