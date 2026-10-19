#!/usr/bin/env python3
"""Attachment filesystem consistency and failure-injection regressions."""

from __future__ import annotations

import contextlib
import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

import routers.todos as todos_router  # noqa: E402
from routers.auth import require_auth  # noqa: E402
from services.attachments import reconcile_attachment_files  # noqa: E402


def make_db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:", check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, attachment_quota_bytes INTEGER);
        CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, user_id INTEGER, is_inbox INTEGER DEFAULT 0);
        CREATE TABLE sections (id INTEGER PRIMARY KEY, name TEXT, project_id INTEGER);
        CREATE TABLE project_members (id INTEGER PRIMARY KEY, project_id INTEGER, user_id INTEGER, status TEXT);
        CREATE TABLE todos (
            id INTEGER PRIMARY KEY, title TEXT, description TEXT DEFAULT '', priority INTEGER DEFAULT 3,
            is_pinned INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', due_date TEXT, completed_at TEXT,
            project_id INTEGER, section_id INTEGER, sort_order REAL DEFAULT 0, recurring_rule TEXT,
            parent_id INTEGER, created_at TEXT, updated_at TEXT, user_id INTEGER, client_mutation_id TEXT
        );
        CREATE TABLE todo_subtasks (id INTEGER PRIMARY KEY, todo_id INTEGER, title TEXT, is_done INTEGER, sort_order INTEGER, created_at TEXT, updated_at TEXT);
        CREATE TABLE todo_comments (id INTEGER PRIMARY KEY, todo_id INTEGER, user_id INTEGER, body TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE reminders (id INTEGER PRIMARY KEY, todo_id INTEGER, remind_at TEXT, sent_at TEXT, source TEXT, created_at TEXT, user_id INTEGER);
        CREATE TABLE saved_places (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, icon TEXT);
        CREATE TABLE location_reminders (
            id INTEGER PRIMARY KEY, todo_id INTEGER, user_id INTEGER, place_id INTEGER,
            latitude REAL, longitude REAL, radius_meters REAL, trigger_type TEXT,
            created_at TEXT, updated_at TEXT
        );
        CREATE TABLE todo_attachments (
            id INTEGER PRIMARY KEY, todo_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
            client_mutation_id TEXT, original_filename TEXT NOT NULL, stored_filename TEXT NOT NULL,
            content_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at TEXT
        );
        CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
        INSERT INTO users (id, username) VALUES (1, 'owner');
        INSERT INTO projects (id, name, user_id, is_inbox) VALUES (1, 'Inbox', 1, 1);
        INSERT INTO todos (id, title, project_id, user_id) VALUES (10, 'File consistency', 1, 1);
        INSERT INTO todo_attachments (id, todo_id, user_id, original_filename, stored_filename, content_type, size_bytes)
            VALUES (100, 10, 1, 'kept.txt', 'kept.txt', 'text/plain', 4);
        """
    )
    db.commit()
    return db


async def noop_broadcast(*_args, **_kwargs):
    return None


def make_client(db: sqlite3.Connection, *, raise_server_exceptions: bool = False) -> TestClient:
    app = FastAPI()
    app.include_router(todos_router.router)
    app.dependency_overrides[require_auth] = lambda: 1

    @contextlib.contextmanager
    def fake_get_db():
        yield db

    todos_router.get_db = fake_get_db
    todos_router.broadcast_change = noop_broadcast
    return TestClient(app, raise_server_exceptions=raise_server_exceptions)


def main() -> None:
    db = make_db()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "attachments"
        root.mkdir()
        todos_router.ATTACHMENT_DIR = root
        todo_dir = root / "10"
        todo_dir.mkdir()
        kept = todo_dir / "kept.txt"
        kept.write_bytes(b"kept")
        outside = Path(tmp) / "outside.txt"
        outside.write_bytes(b"outside")
        outside_dir = Path(tmp) / "outside-dir"
        outside_dir.mkdir()
        (root / "99").symlink_to(outside_dir, target_is_directory=True)
        try:
            todos_router._stored_attachment_path(99, "escaped.txt")
            raise AssertionError("symlinked todo directories must not escape ATTACHMENT_DIR")
        except Exception as exc:
            assert getattr(exc, "status_code", None) == 400

        same_dir_target = todo_dir / "real.txt"
        same_dir_target.write_bytes(b"real")
        same_dir_link = todo_dir / "stored-link.txt"
        same_dir_link.symlink_to(same_dir_target)
        try:
            todos_router._stored_attachment_path(10, "stored-link.txt")
            raise AssertionError("symlinked attachment targets must be rejected")
        except Exception as exc:
            assert getattr(exc, "status_code", None) == 400

        client = make_client(db)
        original_unlink = Path.unlink
        original_replace = Path.replace

        def fail_attachment_move(path: Path, target: Path, *args, **kwargs):
            if path == kept and target.name.startswith(".delete-"):
                raise OSError("injected attachment move failure")
            return original_replace(path, target, *args, **kwargs)

        setattr(Path, "replace", fail_attachment_move)
        try:
            move_response = client.delete("/api/todos/10/attachments/100")
        finally:
            setattr(Path, "replace", original_replace)
        assert move_response.status_code == 500, move_response.text
        assert db.execute("SELECT 1 FROM todo_attachments WHERE id = 100").fetchone(), "move failure must preserve attachment metadata"
        assert kept.exists(), "move failure must leave the attachment file available for retry"

        def fail_unlink(path: Path, *args, **kwargs):
            if path.name.startswith(".delete-"):
                raise OSError("injected unlink failure")
            return original_unlink(path, *args, **kwargs)

        Path.unlink = fail_unlink
        try:
            response = client.delete("/api/todos/10/attachments/100")
        finally:
            Path.unlink = original_unlink
        assert response.status_code == 500, response.text
        assert not db.execute("SELECT 1 FROM todo_attachments WHERE id = 100").fetchone(), "filesystem cleanup must run only after the metadata deletion commits"
        assert not kept.exists(), "committed deletion must not restore the attachment to its downloadable path"
        quarantined_attachment = next(root.glob("10/.delete-*"))
        assert quarantined_attachment.exists(), "failed post-commit cleanup must leave a quarantined file for reconciliation"

        old = time.time() - (3 * 24 * 60 * 60)
        os.utime(quarantined_attachment, (old, old))
        quarantine_result = reconcile_attachment_files(db, attachment_dir=root, minimum_age_seconds=24 * 60 * 60, now=time.time())
        assert quarantined_attachment in quarantine_result["deleted"]
        assert not quarantined_attachment.exists(), "unreferenced quarantined attachment cleanup must be retryable by reconciliation"

        db.execute(
            "INSERT INTO todo_attachments (id, todo_id, user_id, original_filename, stored_filename, content_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (100, 10, 1, "kept.txt", "kept.txt", "text/plain", 4),
        )
        db.commit()
        todo_dir.mkdir(exist_ok=True)
        kept.write_bytes(b"kept")

        orphan = todo_dir / "orphan.txt"
        orphan.write_bytes(b"orphan")
        os.utime(orphan, (old, old))
        young = todo_dir / "young.txt"
        young.write_bytes(b"young")
        referenced = todo_dir / "kept.txt"
        os.utime(referenced, (old, old))
        os.utime(outside, (old, old))
        outside_link = todo_dir / "outside-link.txt"
        outside_link.symlink_to(outside)

        result = reconcile_attachment_files(db, attachment_dir=root, minimum_age_seconds=24 * 60 * 60, now=time.time())
        assert orphan in result["deleted"]
        assert not orphan.exists()
        assert young.exists(), "young files must be retained conservatively"
        assert referenced.exists(), "database-referenced files must be retained"
        assert outside.exists(), "reconciliation must never delete outside ATTACHMENT_DIR"
        assert outside_link.is_symlink(), "reconciliation must retain symlinks instead of following them outside ATTACHMENT_DIR"


        failing = todo_dir / "failing.txt"
        failing.write_bytes(b"failure")
        os.utime(failing, (old, old))
        Path.unlink = lambda path, *args, **kwargs: (_ for _ in ()).throw(OSError("injected reconciliation failure")) if path == failing else original_unlink(path, *args, **kwargs)
        try:
            failed_result = reconcile_attachment_files(db, attachment_dir=root, minimum_age_seconds=24 * 60 * 60, now=time.time())
        finally:
            Path.unlink = original_unlink
        assert failing.exists()
        assert any(entry["path"] == failing for entry in failed_result["errors"]), "reconciliation errors must be visible and retryable"

        referenced_quarantine = todo_dir / ".delete-attachment-100-restore"
        kept.replace(referenced_quarantine)
        os.utime(referenced_quarantine, (old, old))
        restored_attachment = reconcile_attachment_files(db, attachment_dir=root, minimum_age_seconds=24 * 60 * 60, now=time.time())
        assert kept in restored_attachment["restored"]
        assert kept.read_bytes() == b"kept", "referenced quarantined attachments must be restored instead of deleted"

        referenced_todo_quarantine = root / ".delete-todo-10-restore"
        todo_dir.replace(referenced_todo_quarantine)
        os.utime(referenced_todo_quarantine, (old, old))
        restored_todo = reconcile_attachment_files(db, attachment_dir=root, minimum_age_seconds=24 * 60 * 60, now=time.time())
        assert todo_dir in restored_todo["restored"]
        assert kept.exists(), "referenced quarantined todo directories must be restored instead of deleted"

        success_client = make_client(db, raise_server_exceptions=True)
        delete_response = success_client.delete("/api/todos/10/attachments/100")
        assert delete_response.status_code == 200, delete_response.text
        assert not db.execute("SELECT 1 FROM todo_attachments WHERE id = 100").fetchone()
        assert not kept.exists()

        original_rmtree = todos_router.shutil.rmtree
        todo_dir_replace = Path.replace

        def fail_todo_move(path: Path, target: Path, *args, **kwargs):
            if path == todo_dir and target.name.startswith(".delete-todo-"):
                raise OSError("injected todo move failure")
            return todo_dir_replace(path, target, *args, **kwargs)

        setattr(Path, "replace", fail_todo_move)
        try:
            todo_move_response = client.delete("/api/todos/10")
        finally:
            setattr(Path, "replace", todo_dir_replace)
        assert todo_move_response.status_code == 500, todo_move_response.text
        assert db.execute("SELECT 1 FROM todos WHERE id = 10").fetchone(), "todo move failure must preserve todo metadata"
        assert todo_dir.exists(), "todo move failure must leave files available for retry"

        todos_router.shutil.rmtree = lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("injected todo cleanup failure"))
        try:
            todo_response = client.delete("/api/todos/10")
        finally:
            todos_router.shutil.rmtree = original_rmtree
        assert todo_response.status_code == 500, todo_response.text
        assert not db.execute("SELECT 1 FROM todos WHERE id = 10").fetchone(), "todo cleanup must run only after the database deletion commits"
        assert not todo_dir.exists()
        quarantined_todo = next(root.glob(".delete-todo-10-*"))
        for path in quarantined_todo.rglob("*"):
            if path.is_file():
                os.utime(path, (old, old))
        os.utime(quarantined_todo, (old, old))
        reconcile_attachment_files(db, attachment_dir=root, minimum_age_seconds=24 * 60 * 60, now=time.time())
        assert not quarantined_todo.exists(), "quarantined todo cleanup must be retryable by reconciliation"

    print("✅ Attachment filesystem consistency tests passed")


if __name__ == "__main__":
    main()
