#!/usr/bin/env bash
set -euo pipefail

APP_NAME="nia-todo"
DATA_DIR="${NIA_TODO_DATA_DIR:-/var/lib/nia-todo}"
BACKUP_DIR="${NIA_TODO_BACKUP_DIR:-${DATA_DIR}/backups}"
DB_PATH="${NIA_TODO_DB:-${DATA_DIR}/nia-todo.db}"
if [[ "${DB_PATH}" != /* ]]; then
  DB_PATH="${DATA_DIR}/${DB_PATH}"
fi
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/${APP_NAME}-${TIMESTAMP}.zip"
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

mkdir -p "${BACKUP_DIR}"
if [[ ! -f "${DB_PATH}" ]]; then
  echo "Database not found: ${DB_PATH}" >&2
  exit 1
fi

cp "${DB_PATH}" "${TMP_DIR}/nia-todo.db"
if [[ -d "${DATA_DIR}/avatars" ]]; then
  cp -a "${DATA_DIR}/avatars" "${TMP_DIR}/avatars"
fi
if [[ -f "${DATA_DIR}/vapid_keys.json" ]]; then
  cp "${DATA_DIR}/vapid_keys.json" "${TMP_DIR}/vapid_keys.json"
fi

cat > "${TMP_DIR}/metadata.json" <<EOF
{
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "data_dir": "${DATA_DIR}",
  "db_path": "${DB_PATH}"
}
EOF

if command -v zip >/dev/null 2>&1; then
  ( cd "${TMP_DIR}" && zip -qr "${BACKUP_FILE}" . )
else
  python3 - <<'PYZIP' "${TMP_DIR}" "${BACKUP_FILE}"
import os, sys, zipfile
source, target = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for root, _, files in os.walk(source):
        for name in files:
            path = os.path.join(root, name)
            arc = os.path.relpath(path, source)
            zf.write(path, arc)
PYZIP
fi
sha256sum "${BACKUP_FILE}" > "${BACKUP_FILE}.sha256"
chmod 600 "${BACKUP_FILE}" "${BACKUP_FILE}.sha256"
echo "Backup created: ${BACKUP_FILE}"
