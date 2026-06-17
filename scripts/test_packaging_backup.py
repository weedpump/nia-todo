#!/usr/bin/env python3
"""Packaging backup/restore regression tests."""

import json
import os
import sqlite3
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKUP_SCRIPT = ROOT / "packaging/scripts/nia-todo-backup.sh"
RESTORE_SCRIPT = ROOT / "packaging/scripts/nia-todo-restore.sh"


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def make_db(path: Path):
    con = sqlite3.connect(path)
    try:
        con.execute("CREATE TABLE schema_version (version INTEGER NOT NULL)")
        con.execute("INSERT INTO schema_version (version) VALUES (123)")
        con.execute("CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL)")
        con.execute("INSERT INTO todos (title) VALUES ('backup regression')")
        con.commit()
    finally:
        con.close()


def run():
    with tempfile.TemporaryDirectory(prefix="nia-todo-packaging-backup-") as tmp:
        base = Path(tmp)
        data = base / "data"
        backups = base / "backups"
        avatars = data / "avatars"
        attachments = data / "attachments"
        restore_data = base / "restore-data"
        restore_avatars = restore_data / "avatars"
        restore_attachments = restore_data / "attachments"
        data.mkdir()
        avatars.mkdir()
        (attachments / "42").mkdir(parents=True)
        make_db(data / "nia-todo.db")
        (avatars / "user-1.webp").write_bytes(b"avatar-bytes")
        (attachments / "42" / "file.txt").write_bytes(b"attachment-bytes")
        (data / "vapid_keys.json").write_text('{"public":"key"}\n')

        env = os.environ.copy()
        env.update({
            "NIA_TODO_DATA_DIR": str(data),
            "NIA_TODO_BACKUP_DIR": str(backups),
            "NIA_TODO_DB": "nia-todo.db",
            "NIA_TODO_AVATAR_DIR": str(avatars),
            "NIA_TODO_ATTACHMENT_DIR": str(attachments),
            "NIA_TODO_VAPID_KEYS": str(data / "vapid_keys.json"),
        })
        subprocess.run([str(BACKUP_SCRIPT)], check=True, env=env, cwd=ROOT)

        archives = sorted(backups.glob("nia-todo-daily-slot-*.zip"))
        assert_true(len(archives) == 1, f"expected one backup archive, got {archives}")
        archive = archives[0]
        with zipfile.ZipFile(archive) as zf:
            names = set(zf.namelist())
            assert_true("nia-todo.db" in names, names)
            assert_true("avatars/user-1.webp" in names, names)
            assert_true("attachments/42/file.txt" in names, names)
            assert_true("vapid_keys.json" in names, names)
            metadata = json.loads(zf.read("metadata.json"))
        assert_true(metadata["attachments"]["file_count"] == 1, metadata)
        assert_true(metadata["attachments"]["files"][0]["path"] == "attachments/42/file.txt", metadata)

        restore_data.mkdir()
        make_db(restore_data / "nia-todo.db")
        (restore_attachments / "stale").mkdir(parents=True)
        (restore_attachments / "stale" / "old.txt").write_text("stale")
        restore_env = os.environ.copy()
        restore_env.update({
            "NIA_TODO_DATA_DIR": str(restore_data),
            "NIA_TODO_DB": "nia-todo.db",
            "NIA_TODO_AVATAR_DIR": str(restore_avatars),
            "NIA_TODO_ATTACHMENT_DIR": str(restore_attachments),
            "NIA_TODO_VAPID_KEYS": str(restore_data / "vapid_keys.json"),
        })
        subprocess.run([str(RESTORE_SCRIPT), str(archive)], check=True, env=restore_env, cwd=ROOT)

        assert_true((restore_avatars / "user-1.webp").read_bytes() == b"avatar-bytes", "avatar was not restored")
        assert_true((restore_attachments / "42" / "file.txt").read_bytes() == b"attachment-bytes", "attachment was not restored")
        assert_true(not (restore_attachments / "stale" / "old.txt").exists(), "stale attachments should be replaced on restore")
        con = sqlite3.connect(restore_data / "nia-todo.db")
        try:
            count = con.execute("SELECT COUNT(*) FROM todos WHERE title='backup regression'").fetchone()[0]
        finally:
            con.close()
        assert_true(count == 1, "database was not restored")

    print("✅ Packaging backup/restore tests passed")


if __name__ == "__main__":
    run()
