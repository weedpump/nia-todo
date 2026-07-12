#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <backup.zip>" >&2
  exit 1
fi

ARCHIVE="$1"
DATA_DIR="${NIA_TODO_DATA_DIR:-/var/lib/nia-todo}"
BACKUP_DIR="${NIA_TODO_BACKUP_DIR:-${DATA_DIR}/backups}"
DB_PATH="${NIA_TODO_DB:-nia-todo.db}"
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

python3 - <<'PY' "${ARCHIVE}" "${TMP_DIR}"
import sys
import zipfile
from pathlib import Path
archive = Path(sys.argv[1])
target = Path(sys.argv[2]).resolve()
with zipfile.ZipFile(archive) as zf:
    for member in zf.infolist():
        destination = (target / member.filename).resolve()
        if not str(destination).startswith(str(target) + '/') and destination != target:
            raise SystemExit(f'unsafe archive member: {member.filename}')
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

mkdir -p "${DATA_DIR}" "${BACKUP_DIR}" "$(dirname "${DB_PATH}")"
if [[ -f "${DB_PATH}" ]]; then
  cp "${DB_PATH}" "${DB_PATH}.restore-backup.$(date +%Y%m%d-%H%M%S)"
fi
cp "${TMP_DIR}/nia-todo.db" "${DB_PATH}"

python3 - <<'PY' "${TMP_DIR}" "${DATA_DIR}" "${BACKUP_DIR}" "${DB_PATH}"
import shutil
import sys
from pathlib import Path

tmp_dir = Path(sys.argv[1]).resolve()
data_dir = Path(sys.argv[2]).resolve()
backup_dir = Path(sys.argv[3]).resolve()
db_path = Path(sys.argv[4]).resolve()
archive_data_dir = tmp_dir / 'data'

# Backwards compatibility for archives created before the generic data/ layout.
legacy_roots = [name for name in ('avatars', 'attachments') if (tmp_dir / name).exists()]
if not archive_data_dir.exists() and not legacy_roots and not (tmp_dir / 'vapid_keys.json').exists():
    raise SystemExit(0)

def is_relative_to(path: Path, other: Path) -> bool:
    try:
        path.relative_to(other)
        return True
    except ValueError:
        return False

def protected(path: Path) -> bool:
    resolved = path.resolve()
    if resolved == db_path:
        return True
    if is_relative_to(resolved, backup_dir):
        return True
    if resolved.name.startswith(db_path.name + '.restore-backup.'):
        return True
    return False

def contains_protected_path(path: Path) -> bool:
    resolved = path.resolve()
    return is_relative_to(db_path, resolved) or is_relative_to(backup_dir, resolved)

def cleanup_runtime_path(path: Path):
    if protected(path):
        return
    if path.is_dir() and contains_protected_path(path):
        for child in path.iterdir():
            cleanup_runtime_path(child)
        if not any(path.iterdir()) and not contains_protected_path(path):
            path.rmdir()
        return
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)

# Restore the runtime DATA_DIR snapshot exactly, without deleting backup archives or
# the freshly restored DB. This removes stale attachment/runtime files that are not
# present in the archive anymore, including stale siblings beside nested DB files.
for child in data_dir.iterdir():
    cleanup_runtime_path(child)

if archive_data_dir.exists():
    for source in archive_data_dir.rglob('*'):
        if not source.is_file():
            continue
        rel = source.relative_to(archive_data_dir)
        target = data_dir / rel
        if protected(target):
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
else:
    for name in legacy_roots:
        target = data_dir / name
        shutil.copytree(tmp_dir / name, target, dirs_exist_ok=True)
    vapid = tmp_dir / 'vapid_keys.json'
    if vapid.exists():
        shutil.copy2(vapid, data_dir / 'vapid_keys.json')

vapid_target = data_dir / 'vapid_keys.json'
if vapid_target.exists():
    try:
        vapid_target.chmod(0o600)
    except OSError:
        pass
PY

RESTORE_USER="${NIA_TODO_USER:-nia-todo}"
RESTORE_GROUP="${NIA_TODO_GROUP:-nia-todo}"
if getent passwd "${RESTORE_USER}" >/dev/null 2>&1 && getent group "${RESTORE_GROUP}" >/dev/null 2>&1; then
  chown -R "${RESTORE_USER}:${RESTORE_GROUP}" "${DATA_DIR}"
fi

if [[ "${DB_PATH}" != "${DATA_DIR}"/* ]]; then
  echo "Warning: NIA_TODO_DB is outside NIA_TODO_DATA_DIR; only DATA_DIR runtime files are included in backups." >&2
fi

echo "Restored ${ARCHIVE} -> ${DATA_DIR}"
