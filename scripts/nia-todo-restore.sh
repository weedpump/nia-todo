#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <backup.zip>" >&2
  exit 1
fi

ARCHIVE="$1"
DATA_DIR="${NIA_TODO_DATA_DIR:-/var/lib/nia-todo}"
DB_PATH="${NIA_TODO_DB:-nia-todo.db}"
if [[ "${DB_PATH}" != /* ]]; then
  DB_PATH="${DATA_DIR}/${DB_PATH}"
fi
AVATAR_DIR="${NIA_TODO_AVATAR_DIR:-${DATA_DIR}/avatars}"
VAPID_KEYS_PATH="${NIA_TODO_VAPID_KEYS:-${DATA_DIR}/vapid_keys.json}"
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

if [[ ! -f "${ARCHIVE}" ]]; then
  echo "Archive not found: ${ARCHIVE}" >&2
  exit 1
fi

python3 - <<'PY' "${ARCHIVE}" "${TMP_DIR}"
import sys
import zipfile
from pathlib import Path
archive = Path(sys.argv[1])
target = Path(sys.argv[2])
with zipfile.ZipFile(archive) as zf:
    zf.extractall(target)
PY

if [[ ! -f "${TMP_DIR}/nia-todo.db" ]]; then
  echo "Invalid backup: nia-todo.db missing" >&2
  exit 1
fi

python3 - <<'PY' "${TMP_DIR}/nia-todo.db"
import sqlite3
import sys
from pathlib import Path
path = Path(sys.argv[1])
con = sqlite3.connect(path)
try:
    integrity = con.execute('PRAGMA integrity_check').fetchone()[0]
finally:
    con.close()
if integrity != 'ok':
    raise SystemExit(f'restore integrity_check failed: {integrity}')
PY

mkdir -p "${DATA_DIR}" "${AVATAR_DIR}"
if [[ -f "${DB_PATH}" ]]; then
  cp "${DB_PATH}" "${DB_PATH}.restore-backup.$(date +%Y%m%d-%H%M%S)"
fi
cp "${TMP_DIR}/nia-todo.db" "${DB_PATH}"

if [[ -d "${TMP_DIR}/avatars" ]]; then
  rm -rf "${AVATAR_DIR}"
  mkdir -p "$(dirname "${AVATAR_DIR}")"
  cp -a "${TMP_DIR}/avatars" "${AVATAR_DIR}"
fi
if [[ -f "${TMP_DIR}/vapid_keys.json" ]]; then
  mkdir -p "$(dirname "${VAPID_KEYS_PATH}")"
  cp "${TMP_DIR}/vapid_keys.json" "${VAPID_KEYS_PATH}"
  chmod 600 "${VAPID_KEYS_PATH}" 2>/dev/null || true
fi

echo "Restored ${ARCHIVE} -> ${DATA_DIR}"
