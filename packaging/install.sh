#!/bin/bash
# Install or update nia-todo from a full server bundle.

set -euo pipefail

APP_DIR="${NIA_TODO_APP_DIR:-/opt/nia-todo}"
ETC_DIR="${NIA_TODO_ETC_DIR:-/etc/nia-todo}"
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

mkdir -p "${APP_DIR}" "${ETC_DIR}"

if [ -f "${APP_DIR}/api/data/nia-todo.db" ]; then
  backup_dir="${APP_DIR}/api/data/backups"
  mkdir -p "${backup_dir}"
  cp "${APP_DIR}/api/data/nia-todo.db" "${backup_dir}/pre-install-$(date +%Y%m%d-%H%M%S).db"
fi

# Preserve runtime data, replace application files.
mkdir -p "${APP_DIR}/api/data"
tmp_data="$(mktemp -d)"
if [ -d "${APP_DIR}/api/data" ]; then
  cp -a "${APP_DIR}/api/data/." "${tmp_data}/" || true
fi

find "${APP_DIR}" -mindepth 1 -maxdepth 1 ! -name api -exec rm -rf {} +
mkdir -p "${APP_DIR}/api"
find "${APP_DIR}/api" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +

cp -a "${SOURCE_DIR}/." "${APP_DIR}/"
rm -rf "${APP_DIR}/api/data"
mkdir -p "${APP_DIR}/api/data"
cp -a "${tmp_data}/." "${APP_DIR}/api/data/" || true
rm -rf "${tmp_data}"

if [ ! -f "${ETC_DIR}/nia-todo.env" ]; then
  cat > "${ETC_DIR}/nia-todo.env" <<ENV
NIA_TODO_HOST=0.0.0.0
NIA_TODO_PORT=8753
NIA_TODO_DB=nia-todo.db
ENV
fi

python3 -m venv "${APP_DIR}/.venv"
"${APP_DIR}/.venv/bin/pip" install --upgrade pip
"${APP_DIR}/.venv/bin/pip" install -r "${APP_DIR}/requirements.txt"

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

chown -R "${USER_NAME}:${GROUP_NAME}" "${APP_DIR}"
chown -R root:root "${ETC_DIR}"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

echo "nia-todo installed/updated in ${APP_DIR}."
echo "Service: systemctl status ${SERVICE_NAME}"
