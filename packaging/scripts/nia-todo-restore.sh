#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <backup.zip>" >&2
  exit 1
fi

ARCHIVE="$1"
DATA_DIR="${NIA_TODO_DATA_DIR:-/var/lib/nia-todo}"
DB_PATH="${NIA_TODO_DB:-${DATA_DIR}/nia-todo.db}"
if [[ "${DB_PATH}" != /* ]]; then
  DB_PATH="${DATA_DIR}/${DB_PATH}"
fi
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

if [[ ! -f "${ARCHIVE}" ]]; then
  echo "Archive not found: ${ARCHIVE}" >&2
  exit 1
fi

mkdir -p "${DATA_DIR}"
unzip -q "${ARCHIVE}" -d "${TMP_DIR}"
if [[ -f "${DB_PATH}" ]]; then
  cp "${DB_PATH}" "${DB_PATH}.restore-backup.$(date +%Y%m%d-%H%M%S)"
fi
cp "${TMP_DIR}/nia-todo.db" "${DB_PATH}"
if [[ -d "${TMP_DIR}/avatars" ]]; then
  rm -rf "${DATA_DIR}/avatars"
  cp -a "${TMP_DIR}/avatars" "${DATA_DIR}/avatars"
fi
if [[ -f "${TMP_DIR}/vapid_keys.json" ]]; then
  cp "${TMP_DIR}/vapid_keys.json" "${DATA_DIR}/vapid_keys.json"
fi
chmod 600 "${DATA_DIR}/vapid_keys.json" 2>/dev/null || true
echo "Restored ${ARCHIVE} -> ${DATA_DIR}"
