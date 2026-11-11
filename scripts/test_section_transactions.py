#!/usr/bin/env python3
"""Section authorization and writes serialize with concurrent access revocation.

Only disposable SQLite databases are used, with a real second connection/thread;
the installed application, its database and attachment storage are never opened.
"""

import asyncio
import contextlib
import io
import os
import sqlite3
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
TEST_ROOT = tempfile.TemporaryDirectory(prefix="nia-section-transactions-")
os.environ.update({
    "NIA_TODO_DATA_DIR": TEST_ROOT.name,
    "NIA_TODO_DB": str(Path(TEST_ROOT.name) / "unused.db"),
    "NIA_TODO_ATTACHMENT_DIR": str(Path(TEST_ROOT.name) / "attachments"),
    "NIA_TODO_AVATAR_DIR": str(Path(TEST_ROOT.name) / "avatars"),
    "NIA_TODO_BACKUP_DIR": str(Path(TEST_ROOT.name) / "backups"),
    "NIA_TODO_VAPID_KEYS": str(Path(TEST_ROOT.name) / "vapid.json"),
})
sys.path.insert(0, str(ROOT / "api"))

from fastapi import HTTPException
import db as database
import migrate
from db import get_db
from routers import sections
from services.entity_access import (
    create_household, invite_household_member, register_household_entity,
    remove_household_member, respond_to_household_invite, transfer_household_ownership,
)
from services.sharing import can_access_project


def test_section_writer(action, empty_payload=None):
    with tempfile.TemporaryDirectory(dir=TEST_ROOT.name) as directory, \
         patch.object(database, "DB_PATH", Path(directory) / "sections.db"), \
         patch.object(migrate, "DB_PATH", Path(directory) / "sections.db"), \
         patch.object(sections, "broadcast_change", new=AsyncMock()):
        with contextlib.redirect_stdout(io.StringIO()):
            migrate.run_migrations()
        with get_db() as db:
            owner = db.execute("INSERT INTO users(username) VALUES('owner')").lastrowid
            successor = db.execute("INSERT INTO users(username) VALUES('successor')").lastrowid
            household = create_household(db, "Household", owner)
            invite = invite_household_member(db, household, owner, successor)
            respond_to_household_invite(db, invite, successor, accept=True)
            project = db.execute("INSERT INTO projects(name,user_id) VALUES('Project',?)", (owner,)).lastrowid
            register_household_entity(db, "project", project, owner, household)
            section_ids = [db.execute("INSERT INTO sections(project_id,name,user_id) VALUES(?,'Original',?)",
                                     (project, owner)).lastrowid for _ in range(2)]

        async def checked_broadcast(*args, **kwargs):
            # Broadcasting may await slow sockets. Even a no-op PATCH must
            # release its authorization writer lock before that network work.
            with get_db() as other:
                other.execute("PRAGMA busy_timeout = 0")
                other.execute("BEGIN IMMEDIATE")
                other.rollback()

        sections.broadcast_change.side_effect = checked_broadcast
        attempted, resume = threading.Event(), threading.Event()
        blocked = []

        def revoke_from_second_connection():
            with get_db() as db:
                db.execute("PRAGMA busy_timeout = 0")
                try:
                    db.execute("BEGIN IMMEDIATE")
                except sqlite3.OperationalError as error:
                    assert "locked" in str(error).lower(), str(error)
                    blocked.append(True)
                else:
                    db.rollback()
                    blocked.append(False)
                finally:
                    attempted.set()
            assert resume.wait(5), "Writer did not finish"
            with get_db() as db:
                db.execute("BEGIN IMMEDIATE")
                transfer_household_ownership(db, household, owner, successor)
                remove_household_member(db, household, successor, owner)

        def operation(section_id):
            if action == "create":
                return sections.create_section(project, sections.SectionCreate(name="Created"), owner)
            if action == "update":
                return sections.update_section(section_id, sections.SectionUpdate(name="Updated"), owner)
            if action == "update_empty":
                return sections.update_section(section_id, sections.SectionUpdate(**(empty_payload or {})), owner)
            return sections.delete_section(section_id, owner)

        permission_name = "can_edit_project" if action == "delete" else "can_manage_todos"
        original_permission = getattr(sections, permission_name)
        with ThreadPoolExecutor(max_workers=1) as pool:
            revocation = None

            def checked_permission(db, project_id, user_id):
                nonlocal revocation
                assert db.in_transaction, "Authorization must run inside the writer transaction"
                revocation = pool.submit(revoke_from_second_connection)
                assert attempted.wait(5), "Second writer did not attempt the lock"
                assert blocked == [True], "Access revocation committed before the content write"
                return original_permission(db, project_id, user_id)

            try:
                with patch.object(sections, permission_name, side_effect=checked_permission):
                    asyncio.run(operation(section_ids[0]))
            finally:
                resume.set()
            revocation.result(timeout=5)

        with get_db() as db:
            assert not can_access_project(db, project, owner)
            names = {row[0]: row[1] for row in db.execute("SELECT id,name FROM sections WHERE project_id=?", (project,))}
            if action == "create":
                assert len(names) == 3 and "Created" in names.values()
            elif action == "update":
                assert names[section_ids[0]] == "Updated"
            elif action == "update_empty":
                assert names[section_ids[0]] == "Original"
            else:
                assert section_ids[0] not in names
            original = tuple(db.iterdump())
        try:
            asyncio.run(operation(section_ids[1]))
        except HTTPException as error:
            assert error.status_code == (403 if action == "create" else 404)
        else:
            raise AssertionError("Revoked participant performed another section write")
        with get_db() as db:
            assert tuple(db.iterdump()) == original


if __name__ == "__main__":
    for action in ("create", "update", "delete", "update_empty"):
        test_section_writer(action)
        print(f"✅ Section {action}: authorization/write atomic; later revocation blocks follow-up")
    test_section_writer("update_empty", {"name": None, "sort_order": None})
    print("✅ Section null-only update: writer lock released before broadcast; later revocation blocks follow-up")
