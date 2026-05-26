#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${NIA_TODO_DATA_DIR:-/var/lib/nia-todo}"
BACKUP_DIR="${NIA_TODO_BACKUP_DIR:-${DATA_DIR}/backups}"
DB_PATH="${NIA_TODO_DB:-nia-todo.db}"
if [[ "${DB_PATH}" != /* ]]; then
  DB_PATH="${DATA_DIR}/${DB_PATH}"
fi
AVATAR_DIR="${NIA_TODO_AVATAR_DIR:-${DATA_DIR}/avatars}"
VAPID_KEYS_PATH="${NIA_TODO_VAPID_KEYS:-${DATA_DIR}/vapid_keys.json}"
LOCK_FILE="${BACKUP_DIR}/.nia-todo-backup.lock"

mkdir -p "${BACKUP_DIR}"

{
  flock -n 9 || { echo "$(date -Is) another backup run is active, skipping"; exit 0; }
  python3 - <<'PY' "${DATA_DIR}" "${BACKUP_DIR}" "${DB_PATH}" "${AVATAR_DIR}" "${VAPID_KEYS_PATH}"
import hashlib
import json
import os
import sqlite3
import sys
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

data_dir = Path(sys.argv[1])
backup_dir = Path(sys.argv[2])
db_path = Path(sys.argv[3])
avatar_dir = Path(sys.argv[4])
vapid_keys_path = Path(sys.argv[5])
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

db_sha256 = sha256_file(tmp_db)
avatar_files = sorted(p for p in avatar_dir.rglob('*') if p.is_file()) if avatar_dir.exists() else []
avatar_manifest = []
for path in avatar_files:
    avatar_manifest.append({
        'path': str(Path('avatars') / path.relative_to(avatar_dir)),
        'size_bytes': path.stat().st_size,
        'sha256': sha256_file(path),
    })

vapid_manifest = None
if vapid_keys_path.exists():
    vapid_manifest = {
        'path': 'vapid_keys.json',
        'size_bytes': vapid_keys_path.stat().st_size,
        'sha256': sha256_file(vapid_keys_path),
    }

metadata = {
    'type': 'nia-todo-daily-backup',
    'format': 'zip-with-db-metadata-avatars-and-vapid',
    'data_dir': str(data_dir),
    'source_db': str(db_path),
    'source_avatars': str(avatar_dir),
    'source_vapid_keys': str(vapid_keys_path),
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
    'avatars': {
        'directory': 'avatars/',
        'file_count': len(avatar_files),
        'files': avatar_manifest,
    },
    'vapid_keys': vapid_manifest,
    'retention': '30 rotating daily slots; slot is overwritten after 30 days',
}

with zipfile.ZipFile(tmp_zip, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
    zf.write(tmp_db, 'nia-todo.db')
    zf.writestr('metadata.json', json.dumps(metadata, indent=2) + '\n')
    for path in avatar_files:
        zf.write(path, str(Path('avatars') / path.relative_to(avatar_dir)))
    if vapid_keys_path.exists():
        zf.write(vapid_keys_path, 'vapid_keys.json')

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
    f'avatar_files={len(avatar_files)} archive_size={backup.stat().st_size}'
)
PY
} 9>"${LOCK_FILE}"
