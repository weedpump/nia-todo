#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${NIA_TODO_DATA_DIR:-/var/lib/nia-todo}"
BACKUP_DIR="${NIA_TODO_BACKUP_DIR:-${DATA_DIR}/backups}"
DB_PATH="${NIA_TODO_DB:-nia-todo.db}"
if [[ "${DB_PATH}" != /* ]]; then
  DB_PATH="${DATA_DIR}/${DB_PATH}"
fi
LOCK_FILE="${BACKUP_DIR}/.nia-todo-backup.lock"

mkdir -p "${BACKUP_DIR}"

for custom_path in "${NIA_TODO_AVATAR_DIR:-}" "${NIA_TODO_ATTACHMENT_DIR:-}" "${NIA_TODO_VAPID_KEYS:-}"; do
  if [[ -n "${custom_path}" && "${custom_path}" != "${DATA_DIR}"/* && "${custom_path}" != "${DATA_DIR}" ]]; then
    echo "Warning: custom runtime path outside NIA_TODO_DATA_DIR is not included in backups: ${custom_path}" >&2
  fi
done

{
  flock -n 9 || { echo "$(date -Is) another backup run is active, skipping"; exit 0; }
  python3 - <<'PY' "${DATA_DIR}" "${BACKUP_DIR}" "${DB_PATH}"
import hashlib
import json
import os
import sqlite3
import sys
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

data_dir = Path(sys.argv[1]).resolve()
backup_dir = Path(sys.argv[2]).resolve()
db_path = Path(sys.argv[3]).resolve()
backup_dir.mkdir(parents=True, exist_ok=True)

if not db_path.exists():
    raise SystemExit(f'database not found: {db_path}')

slot = int(time.time() // 86400) % 30
started_at = datetime.now(timezone.utc).isoformat()
backup = backup_dir / f'nia-todo-daily-slot-{slot:02d}.zip'
tmp_zip = backup.with_suffix('.zip.tmp')
meta = backup.with_suffix('.json')
tmp_db = backup_dir / f'.nia-todo-daily-slot-{slot:02d}.db.tmp'

for stale in (tmp_zip, tmp_db):
    stale.unlink(missing_ok=True)

src_con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
dst_con = sqlite3.connect(tmp_db)
try:
    src_con.backup(dst_con)
finally:
    dst_con.close()
    src_con.close()

check_con = sqlite3.connect(tmp_db)
try:
    integrity = check_con.execute('PRAGMA integrity_check').fetchone()[0]
    schema_row = check_con.execute('SELECT version FROM schema_version').fetchone()
    schema_version = schema_row[0] if schema_row else None
finally:
    check_con.close()

if integrity != 'ok':
    tmp_db.unlink(missing_ok=True)
    raise SystemExit(f'backup integrity_check failed: {integrity}')

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def is_relative_to(path: Path, other: Path) -> bool:
    try:
        path.relative_to(other)
        return True
    except ValueError:
        return False

def should_include_data_file(path: Path) -> bool:
    resolved = path.resolve()
    if resolved == db_path:
        return False
    if is_relative_to(resolved, backup_dir):
        return False
    if resolved.name.endswith(('.tmp', '.lock', '-journal', '-wal', '-shm')):
        return False
    if resolved.name.startswith('.') and resolved.suffix in {'.tmp', '.lock'}:
        return False
    return True

db_sha256 = sha256_file(tmp_db)
data_files = sorted(p for p in data_dir.rglob('*') if p.is_file() and should_include_data_file(p)) if data_dir.exists() else []
data_manifest = []
for path in data_files:
    archive_path = Path('data') / path.relative_to(data_dir)
    data_manifest.append({
        'path': str(archive_path),
        'size_bytes': path.stat().st_size,
        'sha256': sha256_file(path),
    })

metadata = {
    'type': 'nia-todo-daily-backup',
    'format': 'zip-with-sqlite-backup-and-data-dir-v2',
    'data_dir': str(data_dir),
    'source_db': str(db_path),
    'excluded_paths': [str(db_path), str(backup_dir)],
    'backup': str(backup),
    'slot': slot,
    'started_at': started_at,
    'finished_at': datetime.now(timezone.utc).isoformat(),
    'schema_version': schema_version,
    'db': {
        'path': 'nia-todo.db',
        'size_bytes': tmp_db.stat().st_size,
        'sha256': db_sha256,
        'integrity_check': integrity,
    },
    'data': {
        'directory': 'data/',
        'file_count': len(data_files),
        'files': data_manifest,
    },
    'retention': '30 rotating daily slots; slot is overwritten after 30 days',
}

with zipfile.ZipFile(tmp_zip, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
    zf.write(tmp_db, 'nia-todo.db')
    zf.writestr('metadata.json', json.dumps(metadata, indent=2) + '\n')
    for path in data_files:
        zf.write(path, str(Path('data') / path.relative_to(data_dir)))

tmp_db.unlink(missing_ok=True)
zip_sha256 = sha256_file(tmp_zip)
os.replace(tmp_zip, backup)
metadata['archive'] = {
    'size_bytes': backup.stat().st_size,
    'sha256': zip_sha256,
}
metadata['finished_at'] = datetime.now(timezone.utc).isoformat()
meta.write_text(json.dumps(metadata, indent=2) + '\n')

print(
    f'{datetime.now().isoformat()} backup ok slot={slot:02d} '
    f'archive={backup} schema={schema_version} db_size={metadata["db"]["size_bytes"]} '
    f'data_files={len(data_files)} archive_size={backup.stat().st_size}'
)
PY
} 9>"${LOCK_FILE}"
