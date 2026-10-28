#!/usr/bin/env python3
"""Regression coverage for household content boundaries and deletion persistence."""

import asyncio
from contextlib import contextmanager
import os
import sqlite3
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory() as tmp:
    os.environ["NIA_TODO_DATA_DIR"] = tmp
    sys.path.insert(0, str(ROOT / "api"))

    from fastapi import HTTPException
    from starlette.requests import Request

    from db import get_db
    import migrate as migrate_module
    from migrate import repair_household_entity_access_migration, run_migrations
    from paths import ATTACHMENT_DIR, DB_PATH
    from routers.admin import delete_user
    import routers.admin as admin_router
    from routers.dashboard import dashboard
    from routers.me import _visible_project_ids_for_workspace
    from routers.places import PlaceUpdate, update_place
    from routers.projects import ProjectCreate, ProjectHouseholdTransfer, ProjectUpdate, clear_done_todos, create_project, delete_project, transfer_project_to_household_endpoint, update_project
    from routers.reminders import list_reminders, mark_reminder_sent
    from routers.sharing import get_shared_projects_for_user
    from routers.sections import SectionCreate, create_section, delete_section
    from routers.todos import TodoCommentCreate, TodoCreate, TodoUpdate, create_todo, create_todo_comment, delete_todo, delete_todo_attachment, delete_todo_comment, get_todo, list_todos, update_todo, upload_todo_attachment
    import routers.todos as todos_router
    from routers.websocket import get_sync_todo_payloads, get_sync_todo_rows
    from routers.workspaces import WorkspaceCreate, create_workspace, delete_workspace, list_workspaces
    import services.push as push_service
    import services.attachments as attachments_service
    import services.websocket as websocket_service
    from services.sharing import can_access_project, get_project_ids_for_user
    from services.entity_access import (
        create_household,
        invite_household_member,
        remove_household_member,
        respond_to_household_invite,
        transfer_household_ownership,
    )

    run_migrations()

    with get_db() as db:
        owner_id = db.execute("INSERT INTO users (username) VALUES ('owner')").lastrowid
        member_id = db.execute("INSERT INTO users (username) VALUES ('member')").lastrowid
        successor_id = db.execute("INSERT INTO users (username) VALUES ('successor')").lastrowid
        recipient_id = db.execute("INSERT INTO users (username) VALUES ('recipient')").lastrowid
        former_member_id = db.execute("INSERT INTO users (username) VALUES ('former-member')").lastrowid
        migration_extra_user_id = db.execute("INSERT INTO users (username) VALUES ('migration-extra')").lastrowid
        hierarchy_gain_id = db.execute("INSERT INTO users (username) VALUES ('hierarchy-gain')").lastrowid
        ancestor_gain_id = db.execute("INSERT INTO users (username) VALUES ('ancestor-gain')").lastrowid
        recipient_workspace_id = db.execute(
            "INSERT INTO workspaces (name, user_id, is_default) VALUES ('Recipient', ?, 1)",
            (recipient_id,),
        ).lastrowid
        household_id = create_household(db, "Home", owner_id)
        for invited_user_id in (member_id, successor_id, former_member_id, hierarchy_gain_id):
            invite_id = invite_household_member(db, household_id, owner_id, invited_user_id)
            respond_to_household_invite(db, invite_id, invited_user_id, accept=True)
        db.commit()

    list_workspaces(hierarchy_gain_id)
    list_workspaces(ancestor_gain_id)
    household_project = asyncio.run(
        create_project(ProjectCreate(name="Household", household_id=household_id), member_id)
    )
    with get_db() as db:
        private_place_id = db.execute(
            "INSERT INTO saved_places (user_id, name, address) VALUES (?, 'Private place', 'Private Street 123')",
            (member_id,),
        ).lastrowid
        db.commit()
    websocket_payloads = {}
    original_broadcast_to_user = websocket_service.manager.broadcast_to_user

    async def capture_todo_broadcast(user_id, message):
        websocket_payloads.setdefault(user_id, []).append(message)
        return True

    websocket_service.manager.broadcast_to_user = capture_todo_broadcast
    try:
        private_todo = asyncio.run(
            create_todo(
                TodoCreate(
                    title="Household todo with private delivery data",
                    project_id=household_project["id"],
                    remind_at="2030-01-01T09:00:00+00:00",
                    location_reminder={
                        "trigger_type": "arrival",
                        "place_id": private_place_id,
                    },
                ),
                member_id,
            )
        )
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    owner_private_payload = websocket_payloads[owner_id][0]["payload"]
    member_private_payload = websocket_payloads[member_id][0]["payload"]
    assert owner_private_payload["reminders"] == [], owner_private_payload
    assert owner_private_payload["location_reminders"] == [], owner_private_payload
    assert member_private_payload["reminders"], member_private_payload
    assert member_private_payload["location_reminders"][0]["address"] == "Private Street 123", member_private_payload
    assert private_todo["location_reminders"][0]["place_name"] == "Private place", private_todo
    websocket_payloads.clear()
    websocket_service.manager.broadcast_to_user = capture_todo_broadcast
    try:
        asyncio.run(
            update_todo(
                private_todo["id"],
                TodoUpdate(
                    remind_at="2030-01-02T09:00:00+00:00",
                    location_reminder={"trigger_type": "departure", "place_id": private_place_id},
                ),
                member_id,
            )
        )
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    assert websocket_payloads[owner_id][0]["payload"]["reminders"] == []
    assert websocket_payloads[owner_id][0]["payload"]["location_reminders"] == []
    assert websocket_payloads[member_id][0]["payload"]["reminders"][0]["remind_at"] == "2030-01-02T09:00:00+00:00"
    assert websocket_payloads[member_id][0]["payload"]["location_reminders"][0]["trigger_type"] == "departure"
    with get_db() as db:
        db.execute(
            "INSERT INTO reminders (todo_id, remind_at, user_id) VALUES (?, '2031-01-01T09:00:00+00:00', NULL)",
            (private_todo["id"],),
        )
        db.commit()
    websocket_payloads.clear()
    websocket_service.manager.broadcast_to_user = capture_todo_broadcast
    try:
        asyncio.run(update_todo(private_todo["id"], TodoUpdate(title="Updated household todo"), member_id))
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    assert [item["remind_at"] for item in websocket_payloads[owner_id][0]["payload"]["reminders"]] == [
        "2031-01-01T09:00:00+00:00"
    ]
    assert [item["remind_at"] for item in websocket_payloads[member_id][0]["payload"]["reminders"]] == [
        "2030-01-02T09:00:00+00:00"
    ]
    with get_db() as db:
        owner_sync_todo = next(todo for todo in get_sync_todo_payloads(db, owner_id) if todo["id"] == private_todo["id"])
        member_sync_todo = next(todo for todo in get_sync_todo_payloads(db, member_id) if todo["id"] == private_todo["id"])
    assert [item["remind_at"] for item in owner_sync_todo["reminders"]] == ["2031-01-01T09:00:00+00:00"]
    assert [item["remind_at"] for item in member_sync_todo["reminders"]] == ["2030-01-02T09:00:00+00:00"]
    legacy_default_todo = asyncio.run(
        create_todo(TodoCreate(title="Legacy owner reminder", project_id=household_project["id"]), member_id)
    )
    with get_db() as db:
        db.execute("UPDATE users SET default_reminder_offset_minutes = 60 WHERE id = ?", (owner_id,))
        db.execute("UPDATE users SET default_reminder_offset_minutes = 15 WHERE id = ?", (member_id,))
        db.execute(
            "INSERT INTO reminders (todo_id, remind_at, user_id, source) VALUES (?, ?, NULL, ?)",
            (legacy_default_todo["id"], "2030-01-01T08:00:00+00:00", todos_router.AUTO_REMINDER_SOURCE),
        )
        db.commit()
    asyncio.run(
        update_todo(
            legacy_default_todo["id"],
            TodoUpdate(due_date="2030-01-02T09:00:00+00:00"),
            member_id,
        )
    )
    with get_db() as db:
        reminder_rows = db.execute(
            "SELECT user_id, remind_at FROM reminders WHERE todo_id = ? ORDER BY user_id IS NOT NULL, user_id",
            (legacy_default_todo["id"],),
        ).fetchall()
    assert [(row["user_id"], row["remind_at"]) for row in reminder_rows] == [
        (None, "2030-01-01T08:00:00+00:00"),
        (member_id, "2030-01-02T08:45:00+00:00"),
    ]
    asyncio.run(
        update_todo(
            legacy_default_todo["id"],
            TodoUpdate(due_date="2030-01-03T09:00:00+00:00"),
            owner_id,
        )
    )
    with get_db() as db:
        owner_updated_reminders = db.execute(
            "SELECT user_id, remind_at FROM reminders WHERE todo_id = ? ORDER BY user_id IS NOT NULL, user_id",
            (legacy_default_todo["id"],),
        ).fetchall()
    owner_updated_values = [(row["user_id"], row["remind_at"]) for row in owner_updated_reminders]
    assert owner_updated_values == [
        (owner_id, "2030-01-03T08:00:00+00:00"),
        (member_id, "2030-01-02T08:45:00+00:00"),
    ], owner_updated_values
    personal_project = asyncio.run(create_project(ProjectCreate(name="Member personal"), member_id))
    household_todo = asyncio.run(
        create_todo(TodoCreate(title="Household content", project_id=household_project["id"]), member_id)
    )
    owner_comment = asyncio.run(
        create_todo_comment(household_todo["id"], TodoCommentCreate(body="Owner comment"), owner_id)
    )
    member_section = asyncio.run(
        create_section(household_project["id"], SectionCreate(name="Shared section"), member_id)
    )
    completed_household_todo = asyncio.run(
        create_todo(TodoCreate(title="Completed household content", project_id=household_project["id"], status="done"), member_id)
    )
    for destructive_operation in (
        lambda: asyncio.run(delete_todo(household_todo["id"], member_id)),
        lambda: asyncio.run(delete_section(member_section["id"], member_id)),
        lambda: asyncio.run(clear_done_todos(household_project["id"], member_id)),
        lambda: asyncio.run(
            delete_todo_comment(household_todo["id"], owner_comment["comment"]["id"], member_id)
        ),
    ):
        try:
            destructive_operation()
        except HTTPException as error:
            assert error.status_code in (403, 404), error
        else:
            raise AssertionError("ordinary household member performed an owner-only destructive operation")
    assert get_todo(completed_household_todo["id"], owner_id)["status"] == "done"
    with get_db() as db:
        assert db.execute(
            "SELECT 1 FROM todo_comments WHERE id = ?",
            (owner_comment["comment"]["id"],),
        ).fetchone() is not None

    recurring_household_todo = asyncio.run(
        create_todo(
            TodoCreate(
                title="Shared recurring content",
                project_id=household_project["id"],
                due_date="2030-01-01T09:00:00+00:00",
                recurring_rule={"frequency": "daily", "interval": 1},
            ),
            member_id,
        )
    )
    with get_db() as db:
        recurring_sync_todo = next(
            todo for todo in get_sync_todo_payloads(db, owner_id)
            if todo["id"] == recurring_household_todo["id"]
        )
    assert recurring_sync_todo["recurring_rule"] == recurring_household_todo["recurring_rule"], recurring_sync_todo
    first_completion = asyncio.run(
        update_todo(recurring_household_todo["id"], TodoUpdate(status="done"), member_id)
    )
    first_next_id = first_completion["recurrence_created_todo"]["id"]
    asyncio.run(update_todo(recurring_household_todo["id"], TodoUpdate(status="pending"), successor_id))
    second_completion = asyncio.run(
        update_todo(recurring_household_todo["id"], TodoUpdate(status="done"), successor_id)
    )
    assert second_completion["recurrence_created_todo"]["id"] == first_next_id
    with get_db() as db:
        assert db.execute(
            "SELECT COUNT(*) AS count FROM todos WHERE parent_id = ? AND due_date = ?",
            (recurring_household_todo["id"], "2030-01-02T09:00:00+00:00"),
        ).fetchone()["count"] == 1
    household_attachment_dir = ATTACHMENT_DIR / str(household_todo["id"])
    household_attachment_dir.mkdir(parents=True, exist_ok=True)
    (household_attachment_dir / "household.txt").write_text("private", encoding="utf-8")
    original_attachment_replace = attachments_service.os.replace

    def fail_todo_cleanup(source, destination):
        if Path(source) == household_attachment_dir:
            raise OSError("todo cleanup blocked")
        return original_attachment_replace(source, destination)

    attachments_service.os.replace = fail_todo_cleanup
    try:
        try:
            asyncio.run(delete_todo(household_todo["id"], owner_id))
        except OSError as error:
            assert str(error) == "todo cleanup blocked", error
        else:
            raise AssertionError("todo deletion ignored attachment cleanup failure")
    finally:
        attachments_service.os.replace = original_attachment_replace
    assert get_todo(household_todo["id"], owner_id)["id"] == household_todo["id"]

    single_attachment_path = household_attachment_dir / "single-delete.txt"
    single_attachment_path.write_text("single", encoding="utf-8")
    with get_db() as db:
        single_attachment_id = db.execute(
            """INSERT INTO todo_attachments
               (todo_id, user_id, original_filename, stored_filename, content_type, size_bytes)
               VALUES (?, ?, 'single-delete.txt', 'single-delete.txt', 'text/plain', 6)""",
            (household_todo["id"], owner_id),
        ).lastrowid
        db.commit()
    with get_db() as db:
        attachment_sync_todo = next(
            todo for todo in get_sync_todo_payloads(db, owner_id) if todo["id"] == household_todo["id"]
        )
    assert attachment_sync_todo["attachments_count"] == 1, attachment_sync_todo
    assert attachment_sync_todo["attachments"][0]["id"] == single_attachment_id, attachment_sync_todo
    assert attachment_sync_todo["attachments"][0]["original_filename"] == "single-delete.txt"

    def fail_single_attachment_stage(source, destination):
        if Path(source) == single_attachment_path:
            raise OSError("single attachment staging blocked")
        return original_attachment_replace(source, destination)

    attachments_service.os.replace = fail_single_attachment_stage
    try:
        try:
            asyncio.run(delete_todo_attachment(household_todo["id"], single_attachment_id, owner_id))
        except OSError as error:
            assert str(error) == "single attachment staging blocked", error
        else:
            raise AssertionError("single attachment deletion bypassed reversible staging")
    finally:
        attachments_service.os.replace = original_attachment_replace
    with get_db() as db:
        assert db.execute("SELECT 1 FROM todo_attachments WHERE id = ?", (single_attachment_id,)).fetchone()
    assert single_attachment_path.exists()

    original_path_unlink = Path.unlink

    def fail_single_attachment_finalize(path, *args, **kwargs):
        if ".cleanup-quarantine" in path.parts and path.name == f"attachment-{single_attachment_id}":
            raise OSError("single attachment finalize blocked")
        return original_path_unlink(path, *args, **kwargs)

    Path.unlink = fail_single_attachment_finalize
    try:
        try:
            asyncio.run(delete_todo_attachment(household_todo["id"], single_attachment_id, owner_id))
        except OSError as error:
            assert str(error) == "single attachment finalize blocked", error
        else:
            raise AssertionError("single attachment finalization failure was hidden")
    finally:
        Path.unlink = original_path_unlink
    with get_db() as db:
        assert not db.execute("SELECT 1 FROM todo_attachments WHERE id = ?", (single_attachment_id,)).fetchone()
        attachments_service.cleanup_stale_attachment_quarantine(db)
    assert not single_attachment_path.exists()
    assert not (ATTACHMENT_DIR / ".cleanup-quarantine").exists()

    # Startup reconciliation must wait for an in-flight writer before deciding
    # whether a staged deletion committed.
    concurrent_path = household_attachment_dir / "concurrent-delete.txt"
    concurrent_path.write_text("concurrent", encoding="utf-8")
    with get_db() as db:
        concurrent_attachment_id = db.execute(
            """INSERT INTO todo_attachments
               (todo_id, user_id, original_filename, stored_filename, content_type, size_bytes)
               VALUES (?, ?, 'concurrent-delete.txt', 'concurrent-delete.txt', 'text/plain', 10)""",
            (household_todo["id"], owner_id),
        ).lastrowid
        db.commit()
    writer = sqlite3.connect(str(DB_PATH), timeout=5)
    writer.row_factory = sqlite3.Row
    writer.execute("PRAGMA foreign_keys = ON")
    writer.execute("BEGIN IMMEDIATE")
    concurrent_attachment = writer.execute(
        "SELECT * FROM todo_attachments WHERE id = ?", (concurrent_attachment_id,)
    ).fetchone()
    concurrent_batch = attachments_service.AttachmentFileCleanupBatch([concurrent_attachment])
    concurrent_batch.__enter__()
    writer.execute("DELETE FROM todo_attachments WHERE id = ?", (concurrent_attachment_id,))
    reconcile_errors = []

    def reconcile_while_writer_active():
        try:
            with get_db() as recovery_db:
                attachments_service.cleanup_stale_attachment_quarantine(recovery_db)
        except Exception as error:
            reconcile_errors.append(error)

    reconcile_thread = threading.Thread(target=reconcile_while_writer_active)
    reconcile_thread.start()
    reconcile_thread.join(timeout=0.1)
    assert reconcile_thread.is_alive(), "reconciliation did not wait for the active writer"
    writer.commit()
    writer.close()
    reconcile_thread.join(timeout=5)
    assert not reconcile_thread.is_alive(), "reconciliation remained blocked after writer commit"
    assert not reconcile_errors, reconcile_errors
    assert not concurrent_path.exists(), "committed attachment deletion was restored by startup recovery"
    with get_db() as db:
        assert not db.execute(
            "SELECT 1 FROM todo_attachments WHERE id = ?", (concurrent_attachment_id,)
        ).fetchone()

    # Startup recovery restores pre-commit crash staging for a still-live todo.
    crashed_cleanup = attachments_service.AttachmentCleanupBatch([household_todo["id"]])
    crashed_cleanup.__enter__()
    assert not household_attachment_dir.exists()
    with get_db() as db:
        attachments_service.cleanup_stale_attachment_quarantine(db)
    assert (household_attachment_dir / "household.txt").read_text(encoding="utf-8") == "private"

    # Startup recovery finalizes staging only when the database row is gone.
    stale_batch_dir = ATTACHMENT_DIR / ".cleanup-quarantine" / "committed-test"
    stale_todo_dir = stale_batch_dir / "999999"
    stale_todo_dir.mkdir(parents=True)
    (stale_todo_dir / "orphan.txt").write_text("deleted", encoding="utf-8")
    with get_db() as db:
        attachments_service.cleanup_stale_attachment_quarantine(db)
    assert not stale_batch_dir.exists()

    # Upload staging discards pre-commit crashes and publishes post-commit crashes.
    inode_race_temp = ATTACHMENT_DIR / ".upload-temp" / "inode-race.tmp"
    lease_opened = threading.Event()
    allow_first_lock = threading.Event()
    lease_ready = threading.Event()
    release_lease = threading.Event()
    lease_errors = []
    original_flock = attachments_service.fcntl.flock
    paused_first_lock = [False]

    def pause_before_first_upload_lock(fd, operation):
        if (
            threading.current_thread().name == "lease-race-uploader"
            and operation == attachments_service.fcntl.LOCK_EX
            and not paused_first_lock[0]
        ):
            paused_first_lock[0] = True
            lease_opened.set()
            assert allow_first_lock.wait(timeout=5)
        return original_flock(fd, operation)

    def run_inode_race_upload():
        try:
            with attachments_service.AttachmentUploadTempLease(inode_race_temp):
                inode_race_temp.write_text("actively streamed", encoding="utf-8")
                lease_ready.set()
                assert release_lease.wait(timeout=5)
        except Exception as error:
            lease_errors.append(error)

    attachments_service.fcntl.flock = pause_before_first_upload_lock
    inode_race_thread = threading.Thread(target=run_inode_race_upload, name="lease-race-uploader")
    try:
        inode_race_thread.start()
        assert lease_opened.wait(timeout=5), "uploader did not pause after opening its first lock inode"
        with get_db() as db:
            attachments_service.cleanup_stale_attachment_quarantine(db)
        allow_first_lock.set()
        assert lease_ready.wait(timeout=5), "uploader did not retry an unlinked lock inode"
        with get_db() as db:
            attachments_service.cleanup_stale_attachment_quarantine(db)
        assert inode_race_temp.read_text(encoding="utf-8") == "actively streamed"
    finally:
        allow_first_lock.set()
        release_lease.set()
        inode_race_thread.join(timeout=5)
        attachments_service.fcntl.flock = original_flock
    assert not inode_race_thread.is_alive(), "inode-race uploader did not finish"
    assert not lease_errors, lease_errors
    with get_db() as db:
        attachments_service.cleanup_stale_attachment_quarantine(db)
    assert not inode_race_temp.exists()

    disappearing_dir_temp = ATTACHMENT_DIR / ".upload-temp" / "directory-race.tmp"
    disappearing_dir_lease = attachments_service.AttachmentUploadTempLease(disappearing_dir_temp)
    disappearing_dir_lease.__enter__()
    original_rmdir = Path.rmdir
    raised_missing_directory = [False]

    def remove_upload_root_before_rmdir(path):
        if path == disappearing_dir_temp.parent and not raised_missing_directory[0]:
            raised_missing_directory[0] = True
            original_rmdir(path)
            raise FileNotFoundError(path)
        return original_rmdir(path)

    Path.rmdir = remove_upload_root_before_rmdir
    try:
        disappearing_dir_lease.__exit__(None, None, None)
    finally:
        Path.rmdir = original_rmdir
    assert raised_missing_directory[0]

    disappearing_lock_root = ATTACHMENT_DIR / ".upload-temp"
    disappearing_lock_root.mkdir(parents=True, exist_ok=True)
    disappearing_lock = disappearing_lock_root / "disappearing.tmp.lock"
    disappearing_lock.touch()
    original_path_open = Path.open
    raised_missing_lock = [False]

    def remove_lock_before_open(path, *args, **kwargs):
        if path == disappearing_lock and not raised_missing_lock[0]:
            raised_missing_lock[0] = True
            path.unlink(missing_ok=True)
            _parent = path.parent
            original_rmdir(_parent)
            raise FileNotFoundError(path)
        return original_path_open(path, *args, **kwargs)

    Path.open = remove_lock_before_open
    try:
        with get_db() as db:
            attachments_service.cleanup_stale_attachment_quarantine(db)
    finally:
        Path.open = original_path_open
    assert raised_missing_lock[0]

    disappearing_entry_root = ATTACHMENT_DIR / ".upload-temp"
    disappearing_entry_root.mkdir(parents=True, exist_ok=True)
    disappearing_entry = disappearing_entry_root / "disappearing-entry.tmp"
    disappearing_entry.touch()
    original_lstat = Path.lstat
    raised_missing_entry = [False]

    def remove_entry_before_lstat(path):
        if path == disappearing_entry and not raised_missing_entry[0]:
            raised_missing_entry[0] = True
            path.unlink(missing_ok=True)
            original_rmdir(path.parent)
            raise FileNotFoundError(path)
        return original_lstat(path)

    Path.lstat = remove_entry_before_lstat
    try:
        with get_db() as db:
            attachments_service.cleanup_stale_attachment_quarantine(db)
    finally:
        Path.lstat = original_lstat
    assert raised_missing_entry[0]

    active_upload_temp = ATTACHMENT_DIR / ".upload-temp" / "active.tmp"
    active_reconcile_errors = []
    with attachments_service.AttachmentUploadTempLease(active_upload_temp):
        active_upload_temp.write_text("uploading", encoding="utf-8")

        def reconcile_active_upload():
            try:
                with get_db() as recovery_db:
                    attachments_service.cleanup_stale_attachment_quarantine(recovery_db)
            except Exception as error:
                active_reconcile_errors.append(error)

        active_reconcile_thread = threading.Thread(target=reconcile_active_upload)
        active_reconcile_thread.start()
        active_reconcile_thread.join(timeout=5)
        assert not active_reconcile_thread.is_alive(), "active-upload reconciliation did not finish"
        assert not active_reconcile_errors, active_reconcile_errors
        assert active_upload_temp.read_text(encoding="utf-8") == "uploading"
    with get_db() as db:
        attachments_service.cleanup_stale_attachment_quarantine(db)
    assert not active_upload_temp.exists()

    orphan_upload_temp = ATTACHMENT_DIR / ".upload-temp" / "orphan.tmp"
    orphan_upload_temp.parent.mkdir(parents=True)
    orphan_upload_temp.write_text("private partial upload", encoding="utf-8")
    with get_db() as db:
        attachments_service.cleanup_stale_attachment_quarantine(db)
    assert not orphan_upload_temp.parent.exists()

    precommit_tmp = ATTACHMENT_DIR / "upload-precommit.tmp"
    precommit_tmp.write_text("precommit", encoding="utf-8")
    with get_db() as db:
        precommit_attachment_id = db.execute(
            """INSERT INTO todo_attachments
               (todo_id, user_id, original_filename, stored_filename, content_type, size_bytes)
               VALUES (?, ?, 'precommit.txt', 'precommit.txt', 'text/plain', 9)""",
            (household_todo["id"], owner_id),
        ).lastrowid
        precommit_staging = attachments_service.AttachmentUploadStaging(precommit_tmp, {
            "id": precommit_attachment_id,
            "todo_id": household_todo["id"],
            "stored_filename": "precommit.txt",
        })
        precommit_staging.stage()
        db.rollback()
        attachments_service.cleanup_stale_attachment_quarantine(db)
    assert not (household_attachment_dir / "precommit.txt").exists()

    postcommit_tmp = ATTACHMENT_DIR / "upload-postcommit.tmp"
    postcommit_tmp.write_text("postcommit", encoding="utf-8")
    with get_db() as db:
        postcommit_attachment_id = db.execute(
            """INSERT INTO todo_attachments
               (todo_id, user_id, original_filename, stored_filename, content_type, size_bytes)
               VALUES (?, ?, 'postcommit.txt', 'postcommit.txt', 'text/plain', 10)""",
            (household_todo["id"], owner_id),
        ).lastrowid
        postcommit_staging = attachments_service.AttachmentUploadStaging(postcommit_tmp, {
            "id": postcommit_attachment_id,
            "todo_id": household_todo["id"],
            "stored_filename": "postcommit.txt",
        })
        postcommit_staging.stage()
        db.commit()
        attachments_service.cleanup_stale_attachment_quarantine(db)
    assert (household_attachment_dir / "postcommit.txt").read_text(encoding="utf-8") == "postcommit"
    asyncio.run(delete_todo_attachment(household_todo["id"], postcommit_attachment_id, owner_id))

    async def upload_request_body():
        return {"type": "http.request", "body": b"\x89PNG\r\n\x1a\nrecovered", "more_body": False}

    upload_request = Request({
        "type": "http",
        "method": "POST",
        "path": "/",
        "headers": [(b"content-type", b"image/png"), (b"x-nia-filename", b"recover-upload.png")],
        "query_string": b"",
    }, upload_request_body)
    original_upload_publish = attachments_service.AttachmentUploadStaging.publish

    def fail_upload_publish(_staging):
        raise OSError("upload publish blocked")

    attachments_service.AttachmentUploadStaging.publish = fail_upload_publish
    try:
        try:
            asyncio.run(upload_todo_attachment(household_todo["id"], upload_request, owner_id))
        except OSError as error:
            assert str(error) == "upload publish blocked", error
        else:
            raise AssertionError("upload publish failure was hidden")
    finally:
        attachments_service.AttachmentUploadStaging.publish = original_upload_publish
    with get_db() as db:
        recovered_upload_row = db.execute(
            """SELECT id, stored_filename FROM todo_attachments
               WHERE todo_id = ? AND original_filename = 'recover-upload.png'""",
            (household_todo["id"],),
        ).fetchone()
        assert recovered_upload_row, "upload metadata did not commit before publish"
        recovered_upload_path = household_attachment_dir / recovered_upload_row["stored_filename"]
        assert not recovered_upload_path.exists()
        attachments_service.cleanup_stale_attachment_quarantine(db)
    assert recovered_upload_path.read_bytes() == b"\x89PNG\r\n\x1a\nrecovered"
    asyncio.run(delete_todo_attachment(household_todo["id"], recovered_upload_row["id"], owner_id))

    class AmbiguousCommitConnection:
        def __init__(self, connection, raise_on_commit):
            self.connection = connection
            self.raise_on_commit = raise_on_commit
            self.commit_count = 0

        def __getattr__(self, name):
            return getattr(self.connection, name)

        def commit(self):
            self.commit_count += 1
            self.connection.commit()
            if self.commit_count == self.raise_on_commit:
                raise RuntimeError("commit outcome ambiguous")

    original_todos_get_db = todos_router.get_db
    ambiguous_commit_number = [1]

    @contextmanager
    def ambiguous_todos_get_db():
        with get_db() as connection:
            yield AmbiguousCommitConnection(connection, ambiguous_commit_number[0])

    # A commit that succeeds and then raises must leave upload staging recoverable.
    ambiguous_upload_request = Request({
        "type": "http",
        "method": "POST",
        "path": "/",
        "headers": [(b"content-type", b"image/png"), (b"x-nia-filename", b"ambiguous-upload.png")],
        "query_string": b"",
    }, upload_request_body)
    todos_router.get_db = ambiguous_todos_get_db
    try:
        try:
            asyncio.run(upload_todo_attachment(household_todo["id"], ambiguous_upload_request, owner_id))
        except RuntimeError as error:
            assert str(error) == "commit outcome ambiguous", error
        else:
            raise AssertionError("ambiguous upload commit was reported as successful")
    finally:
        todos_router.get_db = original_todos_get_db
    with get_db() as db:
        ambiguous_upload_row = db.execute(
            """SELECT id, stored_filename FROM todo_attachments
               WHERE todo_id = ? AND original_filename = 'ambiguous-upload.png'""",
            (household_todo["id"],),
        ).fetchone()
        assert ambiguous_upload_row, db.execute(
            "SELECT id, original_filename, stored_filename FROM todo_attachments WHERE todo_id = ?",
            (household_todo["id"],),
        ).fetchall()
        ambiguous_upload_path = household_attachment_dir / ambiguous_upload_row["stored_filename"]
        assert not ambiguous_upload_path.exists()
        attachments_service.cleanup_stale_attachment_quarantine(db)
    assert ambiguous_upload_path.is_file()

    # The inverse ambiguous deletion commit must retain staging until reconciliation.
    ambiguous_commit_number[0] = 1
    todos_router.get_db = ambiguous_todos_get_db
    try:
        try:
            asyncio.run(delete_todo_attachment(household_todo["id"], ambiguous_upload_row["id"], owner_id))
        except RuntimeError as error:
            assert str(error) == "commit outcome ambiguous", error
        else:
            raise AssertionError("ambiguous attachment deletion was reported as successful")
    finally:
        todos_router.get_db = original_todos_get_db
    with get_db() as db:
        assert not db.execute("SELECT 1 FROM todo_attachments WHERE id = ?", (ambiguous_upload_row["id"],)).fetchone()
        assert not ambiguous_upload_path.exists()
        attachments_service.cleanup_stale_attachment_quarantine(db)
    assert not ambiguous_upload_path.exists()

    # Missing files referenced by committed metadata are observable integrity failures.
    with get_db() as db:
        missing_attachment_id = db.execute(
            """INSERT INTO todo_attachments
               (todo_id, user_id, original_filename, stored_filename, content_type, size_bytes)
               VALUES (?, ?, 'missing.txt', 'missing.txt', 'text/plain', 7)""",
            (household_todo["id"], owner_id),
        ).lastrowid
        db.commit()
    try:
        asyncio.run(delete_todo_attachment(household_todo["id"], missing_attachment_id, owner_id))
    except RuntimeError as error:
        assert str(error) == "Expected attachment file is missing", error
    else:
        raise AssertionError("missing attachment file was silently accepted")
    with get_db() as db:
        assert db.execute("SELECT 1 FROM todo_attachments WHERE id = ?", (missing_attachment_id,)).fetchone()
        db.execute("DELETE FROM todo_attachments WHERE id = ?", (missing_attachment_id,))
        db.commit()

    ambiguous_todo = asyncio.run(
        create_todo(TodoCreate(title="Ambiguous todo deletion", project_id=household_project["id"]), owner_id)
    )
    ambiguous_todo_dir = ATTACHMENT_DIR / str(ambiguous_todo["id"])
    ambiguous_todo_dir.mkdir(parents=True)
    (ambiguous_todo_dir / "ambiguous.txt").write_text("private", encoding="utf-8")
    with get_db() as db:
        db.execute(
            """INSERT INTO todo_attachments
               (todo_id, user_id, original_filename, stored_filename, content_type, size_bytes)
               VALUES (?, ?, 'ambiguous.txt', 'ambiguous.txt', 'text/plain', 7)""",
            (ambiguous_todo["id"], owner_id),
        )
        db.commit()
    ambiguous_commit_number[0] = 1
    todos_router.get_db = ambiguous_todos_get_db
    try:
        try:
            asyncio.run(delete_todo(ambiguous_todo["id"], owner_id))
        except RuntimeError as error:
            assert str(error) == "commit outcome ambiguous", error
        else:
            raise AssertionError("ambiguous todo deletion was reported as successful")
    finally:
        todos_router.get_db = original_todos_get_db
    with get_db() as db:
        assert not db.execute("SELECT 1 FROM todos WHERE id = ?", (ambiguous_todo["id"],)).fetchone()
        assert not ambiguous_todo_dir.exists()
        attachments_service.cleanup_stale_attachment_quarantine(db)
    assert not ambiguous_todo_dir.exists()

    missing_directory_todo = asyncio.run(
        create_todo(TodoCreate(title="Missing attachment directory", project_id=household_project["id"]), owner_id)
    )
    with get_db() as db:
        db.execute(
            """INSERT INTO todo_attachments
               (todo_id, user_id, original_filename, stored_filename, content_type, size_bytes)
               VALUES (?, ?, 'missing-dir.txt', 'missing-dir.txt', 'text/plain', 11)""",
            (missing_directory_todo["id"], owner_id),
        )
        db.commit()
    try:
        asyncio.run(delete_todo(missing_directory_todo["id"], owner_id))
    except RuntimeError as error:
        assert str(error) == "Expected todo attachment directory is missing", error
    else:
        raise AssertionError("missing todo attachment directory was silently accepted")
    with get_db() as db:
        assert db.execute("SELECT 1 FROM todos WHERE id = ?", (missing_directory_todo["id"],)).fetchone()
        db.execute("DELETE FROM todo_attachments WHERE todo_id = ?", (missing_directory_todo["id"],))
        db.commit()
    asyncio.run(delete_todo(missing_directory_todo["id"], owner_id))

    # A concurrent upload must wait behind deletion staging and then revalidate the deleted todo.
    raced_todo = asyncio.run(
        create_todo(TodoCreate(title="Concurrent attachment deletion", project_id=household_project["id"]), owner_id)
    )
    raced_todo_dir = ATTACHMENT_DIR / str(raced_todo["id"])
    raced_todo_dir.mkdir(parents=True)
    (raced_todo_dir / "existing.txt").write_text("existing", encoding="utf-8")
    with get_db() as db:
        db.execute(
            """INSERT INTO todo_attachments
               (todo_id, user_id, original_filename, stored_filename, content_type, size_bytes)
               VALUES (?, ?, 'existing.txt', 'existing.txt', 'text/plain', 8)""",
            (raced_todo["id"], owner_id),
        )
        db.commit()

    race_begin_attempted = threading.Event()
    race_finished = threading.Event()
    race_result = []
    original_cleanup_enter = attachments_service.AttachmentCleanupBatch.__enter__

    class RaceConnection:
        def __init__(self, connection):
            self.connection = connection

        def __getattr__(self, name):
            return getattr(self.connection, name)

        def execute(self, sql, parameters=()):
            if sql.strip().upper().startswith("BEGIN IMMEDIATE"):
                race_begin_attempted.set()
            return self.connection.execute(sql, parameters)

    @contextmanager
    def race_get_db():
        with get_db() as connection:
            if threading.current_thread().name == "attachment-racer":
                yield RaceConnection(connection)
            else:
                yield connection

    async def race_upload_body():
        return {"type": "http.request", "body": b"\x89PNG\r\n\x1a\nraced", "more_body": False}

    def run_racing_upload():
        request = Request({
            "type": "http",
            "method": "POST",
            "path": "/",
            "headers": [(b"content-type", b"image/png"), (b"x-nia-filename", b"raced.png")],
            "query_string": b"",
        }, race_upload_body)
        try:
            asyncio.run(upload_todo_attachment(raced_todo["id"], request, owner_id))
        except Exception as error:
            race_result.append(error)
        finally:
            race_finished.set()

    def enter_cleanup_with_racer(cleanup):
        result = original_cleanup_enter(cleanup)
        if raced_todo["id"] in cleanup.todo_ids:
            racer = threading.Thread(target=run_racing_upload, name="attachment-racer")
            racer.start()
            assert race_begin_attempted.wait(5), "racing upload never reached the writer lock"
        return result

    todos_router.get_db = race_get_db
    attachments_service.AttachmentCleanupBatch.__enter__ = enter_cleanup_with_racer
    try:
        asyncio.run(delete_todo(raced_todo["id"], owner_id))
        assert race_finished.wait(5), "racing upload did not finish after deletion commit"
    finally:
        todos_router.get_db = original_todos_get_db
        attachments_service.AttachmentCleanupBatch.__enter__ = original_cleanup_enter
    assert race_result and isinstance(race_result[0], HTTPException), race_result
    assert race_result[0].status_code == 404, race_result[0]
    with get_db() as db:
        assert not db.execute("SELECT 1 FROM todos WHERE id = ?", (raced_todo["id"],)).fetchone()
        assert not db.execute("SELECT 1 FROM todo_attachments WHERE todo_id = ?", (raced_todo["id"],)).fetchone()
        attachments_service.cleanup_stale_attachment_quarantine(db)
    assert not raced_todo_dir.exists()

    completed_attachment_dir = ATTACHMENT_DIR / str(completed_household_todo["id"])
    completed_attachment_dir.mkdir(parents=True, exist_ok=True)
    (completed_attachment_dir / "completed.txt").write_text("private", encoding="utf-8")
    second_completed_todo = asyncio.run(
        create_todo(
            TodoCreate(title="Second completed attachment", project_id=household_project["id"], status="done"),
            owner_id,
        )
    )
    second_completed_attachment_dir = ATTACHMENT_DIR / str(second_completed_todo["id"])
    second_completed_attachment_dir.mkdir(parents=True, exist_ok=True)
    (second_completed_attachment_dir / "second.txt").write_text("private", encoding="utf-8")
    cleanup_calls = [0]

    def fail_second_project_cleanup(source, destination):
        cleanup_calls[0] += 1
        if cleanup_calls[0] == 2:
            raise OSError("second cleanup blocked")
        return original_attachment_replace(source, destination)

    attachments_service.os.replace = fail_second_project_cleanup
    try:
        try:
            asyncio.run(clear_done_todos(household_project["id"], owner_id))
        except OSError as error:
            assert str(error) == "second cleanup blocked", error
        else:
            raise AssertionError("bulk todo deletion ignored partial attachment cleanup failure")
    finally:
        attachments_service.os.replace = original_attachment_replace
    assert completed_attachment_dir.exists()
    assert second_completed_attachment_dir.exists()
    with get_db() as db:
        assert db.execute("SELECT 1 FROM todos WHERE id = ?", (completed_household_todo["id"],)).fetchone()
        assert db.execute("SELECT 1 FROM todos WHERE id = ?", (second_completed_todo["id"],)).fetchone()
    asyncio.run(clear_done_todos(household_project["id"], owner_id))
    assert not completed_attachment_dir.exists()
    assert not second_completed_attachment_dir.exists()
    list_workspaces(successor_id)
    with get_db() as db:
        member_default_workspace_id = db.execute(
            "SELECT id FROM workspaces WHERE user_id = ? AND is_default = 1",
            (member_id,),
        ).fetchone()["id"]
        successor_default_workspace_id = db.execute(
            "SELECT id FROM workspaces WHERE user_id = ? AND is_default = 1",
            (successor_id,),
        ).fetchone()["id"]
        assert household_project["id"] in _visible_project_ids_for_workspace(
            db, member_id, member_default_workspace_id
        )
        assert household_project["id"] in _visible_project_ids_for_workspace(
            db, successor_id, successor_default_workspace_id
        )
    personal_todo = asyncio.run(
        create_todo(TodoCreate(title="Personal content", project_id=personal_project["id"]), member_id)
    )

    unprojected_personal_todo = asyncio.run(
        update_todo(personal_todo["id"], TodoUpdate(project_id=None), member_id)
    )
    assert unprojected_personal_todo["project_id"] is None, unprojected_personal_todo
    try:
        asyncio.run(
            update_todo(
                personal_todo["id"],
                TodoUpdate(project_id=household_project["id"]),
                member_id,
            )
        )
    except HTTPException as error:
        assert error.status_code == 403, error
    else:
        raise AssertionError("ordinary household member used a NULL-project hop across ownership boundaries")

    try:
        asyncio.run(
            update_todo(
                household_todo["id"],
                TodoUpdate(project_id=personal_project["id"]),
                member_id,
            )
        )
    except HTTPException as error:
        assert error.status_code == 403, error
    else:
        raise AssertionError("ordinary household member moved content across ownership boundaries")

    stored_filename = "preserved.txt"
    attachment_path = ATTACHMENT_DIR / str(household_todo["id"]) / stored_filename
    attachment_path.parent.mkdir(parents=True, exist_ok=True)
    attachment_path.write_text("household attachment")
    with get_db() as db:
        comment_id = db.execute(
            "INSERT INTO todo_comments (todo_id, user_id, body) VALUES (?, ?, 'preserved comment')",
            (household_todo["id"], member_id),
        ).lastrowid
        attachment_id = db.execute(
            """INSERT INTO todo_attachments
               (todo_id, user_id, original_filename, stored_filename, content_type, size_bytes)
               VALUES (?, ?, 'preserved.txt', ?, 'text/plain', 20)""",
            (household_todo["id"], member_id, stored_filename),
        ).lastrowid
        removed_member_reminder_id = db.execute(
            "INSERT INTO reminders (todo_id, remind_at, user_id) VALUES (?, datetime('now'), ?)",
            (household_todo["id"], member_id),
        ).lastrowid
        member_place_id = db.execute(
            "INSERT INTO saved_places (user_id, name, address) VALUES (?, 'Home', 'Old address')",
            (member_id,),
        ).lastrowid
        db.execute(
            """INSERT INTO location_reminders
               (todo_id, user_id, trigger_type, place_id, address)
               VALUES (?, ?, 'arrival', ?, 'Old address')""",
            (household_todo["id"], member_id, member_place_id),
        )
        remove_household_member(db, household_id, owner_id, member_id)
        db.commit()
        household_todo_updated_at = db.execute(
            "SELECT updated_at FROM todos WHERE id = ?",
            (household_todo["id"],),
        ).fetchone()["updated_at"]
        assert household_todo["id"] not in {row["id"] for row in get_sync_todo_rows(db, member_id)}
        assert household_project["id"] not in _visible_project_ids_for_workspace(
            db, member_id, member_default_workspace_id
        )

    try:
        get_todo(household_todo["id"], member_id)
    except HTTPException as error:
        assert error.status_code == 403, error
    else:
        raise AssertionError("removed member retained creator access to household todo")
    try:
        list_todos(project_id=household_project["id"], user_id=member_id)
    except HTTPException as error:
        assert error.status_code == 404, error
    else:
        raise AssertionError("removed member could still list the household project")
    assert removed_member_reminder_id not in {
        reminder["id"] for reminder in list_reminders(user_id=member_id)["reminders"]
    }
    try:
        mark_reminder_sent(removed_member_reminder_id, member_id)
    except HTTPException as error:
        assert error.status_code == 404, error
    else:
        raise AssertionError("removed member could still mutate a household reminder")
    assert dashboard(member_id)["total"] == 1  # The projectless personal todo remains visible.
    delivered_to = []
    original_desktop = push_service.manager.broadcast_desktop_notification
    original_push = push_service.send_push_notification

    async def capture_desktop(user_id, payload):
        delivered_to.append(user_id)
        return False

    async def capture_push(**kwargs):
        delivered_to.append(kwargs["user_id"])
        return False

    push_service.manager.broadcast_desktop_notification = capture_desktop
    push_service.send_push_notification = capture_push
    try:
        asyncio.run(push_service.check_and_send_reminders())
    finally:
        push_service.manager.broadcast_desktop_notification = original_desktop
        push_service.send_push_notification = original_push
    assert member_id not in delivered_to, delivered_to
    asyncio.run(update_place(member_place_id, PlaceUpdate(address="New address"), member_id))
    with get_db() as db:
        assert db.execute(
            "SELECT updated_at FROM todos WHERE id = ?",
            (household_todo["id"],),
        ).fetchone()["updated_at"] == household_todo_updated_at
        assert db.execute(
            "SELECT address FROM location_reminders WHERE todo_id = ? AND user_id = ?",
            (household_todo["id"], member_id),
        ).fetchone()["address"] == "Old address"
    for operation in (
        lambda: asyncio.run(update_todo(household_todo["id"], TodoUpdate(title="stolen"), member_id)),
        lambda: asyncio.run(delete_todo(household_todo["id"], member_id)),
    ):
        try:
            operation()
        except HTTPException as error:
            assert error.status_code == 403, error
        else:
            raise AssertionError("removed member retained write access to household todo")

    asyncio.run(delete_user(member_id, True))
    with get_db() as db:
        comment = db.execute("SELECT user_id, body FROM todo_comments WHERE id = ?", (comment_id,)).fetchone()
        attachment = db.execute(
            "SELECT user_id, stored_filename FROM todo_attachments WHERE id = ?",
            (attachment_id,),
        ).fetchone()
        assert comment and comment["user_id"] is None and comment["body"] == "preserved comment", comment
        assert attachment and attachment["user_id"] is None and attachment["stored_filename"] == stored_filename, attachment
        assert attachment_path.is_file()

    with get_db() as db:
        relationship_user_id = db.execute("INSERT INTO users (username) VALUES ('relationship-delete')").lastrowid
        pending_household_invite_id = invite_household_member(db, household_id, owner_id, relationship_user_id)
        db.commit()
    accepted_relation_project = asyncio.run(create_project(ProjectCreate(name="Accepted relation"), owner_id))
    pending_relation_project = asyncio.run(create_project(ProjectCreate(name="Pending relation"), owner_id))
    relation_todo = asyncio.run(
        create_todo(TodoCreate(title="Preserved relation todo", project_id=accepted_relation_project["id"]), owner_id)
    )
    with get_db() as db:
        db.execute(
            """INSERT INTO project_members (project_id, user_id, invited_by, status)
               VALUES (?, ?, ?, 'accepted')""",
            (accepted_relation_project["id"], relationship_user_id, owner_id),
        )
        db.execute(
            """INSERT INTO project_members (project_id, user_id, invited_by, status)
               VALUES (?, ?, ?, 'pending')""",
            (pending_relation_project["id"], relationship_user_id, owner_id),
        )
        relation_reminder_id = db.execute(
            "INSERT INTO reminders (todo_id, remind_at, user_id) VALUES (?, '2035-01-01T00:00:00+00:00', ?)",
            (relation_todo["id"], relationship_user_id),
        ).lastrowid
        db.commit()
    account_relationship_payloads = {}

    async def capture_account_relationship_delete(user_id, message):
        account_relationship_payloads.setdefault(user_id, []).append(message)
        return True

    websocket_service.manager.broadcast_to_user = capture_account_relationship_delete
    try:
        asyncio.run(delete_user(relationship_user_id, True))
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    with get_db() as db:
        assert db.execute("SELECT 1 FROM reminders WHERE id = ?", (relation_reminder_id,)).fetchone() is None
        assert db.execute("SELECT 1 FROM household_members WHERE id = ?", (pending_household_invite_id,)).fetchone() is None
        assert db.execute("SELECT 1 FROM project_members WHERE user_id = ?", (relationship_user_id,)).fetchone() is None
        assert db.execute("SELECT 1 FROM todos WHERE id = ?", (relation_todo["id"],)).fetchone()
    for affected_user_id in (owner_id, successor_id):
        relationship_syncs = [
            message for message in account_relationship_payloads.get(affected_user_id, [])
            if message.get("type") == "sync_response"
        ]
        assert relationship_syncs, account_relationship_payloads
        assert all(
            member["user_id"] != relationship_user_id
            for member in relationship_syncs[-1]["household"]["members"]
        )

    with get_db() as db:
        accepted_delete_user_id = db.execute("INSERT INTO users (username) VALUES ('accepted-delete')").lastrowid
        accepted_delete_invite_id = invite_household_member(db, household_id, owner_id, accepted_delete_user_id)
        respond_to_household_invite(db, accepted_delete_invite_id, accepted_delete_user_id, accept=True)
        accepted_delete_reminder_id = db.execute(
            "INSERT INTO reminders (todo_id, remind_at, user_id) VALUES (?, '2036-01-01T00:00:00+00:00', ?)",
            (household_todo["id"], accepted_delete_user_id),
        ).lastrowid
        db.commit()
    accepted_delete_payloads = {}

    async def capture_accepted_account_delete(user_id, message):
        accepted_delete_payloads.setdefault(user_id, []).append(message)
        return True

    websocket_service.manager.broadcast_to_user = capture_accepted_account_delete
    try:
        asyncio.run(delete_user(accepted_delete_user_id, True))
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    with get_db() as db:
        assert db.execute("SELECT 1 FROM reminders WHERE id = ?", (accepted_delete_reminder_id,)).fetchone() is None
        assert db.execute("SELECT 1 FROM todos WHERE id = ?", (household_todo["id"],)).fetchone()
    for affected_user_id in (owner_id, successor_id):
        assert any(
            message.get("type") == "sync_response"
            for message in accepted_delete_payloads.get(affected_user_id, [])
        ), accepted_delete_payloads

    shared_workspace = asyncio.run(create_workspace(WorkspaceCreate(name="Shared inbox workspace"), owner_id))
    with get_db() as db:
        shared_workspace_inbox_id = db.execute(
            "SELECT id FROM projects WHERE user_id = ? AND workspace_id = ? AND is_inbox = 1",
            (owner_id, shared_workspace["id"]),
        ).fetchone()["id"]
        db.execute(
            """INSERT INTO project_members (project_id, user_id, invited_by, status, workspace_id)
               VALUES (?, ?, ?, 'accepted', ?)""",
            (shared_workspace_inbox_id, recipient_id, owner_id, recipient_workspace_id),
        )
        db.execute(
            """INSERT INTO project_members (project_id, user_id, invited_by, status)
               VALUES (?, ?, ?, 'pending')""",
            (shared_workspace_inbox_id, ancestor_gain_id, owner_id),
        )
        db.commit()
    shared_workspace_todo = asyncio.run(
        create_todo(TodoCreate(title="Revoked workspace inbox todo", project_id=shared_workspace_inbox_id), owner_id)
    )
    workspace_delete_payloads = {}

    async def capture_workspace_delete(user_id, message):
        workspace_delete_payloads.setdefault(user_id, []).append(message)
        return True

    websocket_service.manager.broadcast_to_user = capture_workspace_delete
    try:
        asyncio.run(delete_workspace(shared_workspace["id"], owner_id))
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    recipient_workspace_syncs = [
        message for message in workspace_delete_payloads.get(recipient_id, [])
        if message.get("type") == "sync_response"
    ]
    assert recipient_workspace_syncs, workspace_delete_payloads
    assert shared_workspace_todo["id"] not in {
        todo["id"] for todo in recipient_workspace_syncs[-1]["todos"]
    }
    pending_workspace_syncs = [
        message for message in workspace_delete_payloads.get(ancestor_gain_id, [])
        if message.get("type") == "sync_response"
    ]
    assert pending_workspace_syncs, workspace_delete_payloads
    assert pending_workspace_syncs[-1]["project_invites"] == []
    owner_workspace_syncs = [
        message for message in workspace_delete_payloads.get(owner_id, [])
        if message.get("type") == "sync_response"
    ]
    assert owner_workspace_syncs, workspace_delete_payloads
    owner_moved_todo = next(
        todo for todo in owner_workspace_syncs[-1]["todos"] if todo["id"] == shared_workspace_todo["id"]
    )
    assert owner_moved_todo["project_id"] != shared_workspace_inbox_id, owner_moved_todo

    disposable_household_project = asyncio.run(
        create_project(ProjectCreate(name="Disposable household", household_id=household_id), former_member_id)
    )
    former_workspace = asyncio.run(
        create_workspace(WorkspaceCreate(name="Former member workspace"), former_member_id)
    )
    workspace_household_project = asyncio.run(
        create_project(
            ProjectCreate(
                name="Workspace-bound household",
                household_id=household_id,
                workspace_id=former_workspace["id"],
            ),
            former_member_id,
        )
    )
    assert workspace_household_project["workspace_id"] != former_workspace["id"], workspace_household_project
    with get_db() as db:
        source_inbox_id = db.execute(
            "SELECT id FROM projects WHERE user_id = ? AND workspace_id = ? AND is_inbox = 1",
            (former_member_id, former_workspace["id"]),
        ).fetchone()["id"]
    former_member_todo = asyncio.run(
        create_todo(
            TodoCreate(title="Must stay with household owner", project_id=disposable_household_project["id"]),
            former_member_id,
        )
    )
    with get_db() as db:
        remove_household_member(db, household_id, owner_id, former_member_id)
        db.commit()
    asyncio.run(delete_workspace(former_workspace["id"], former_member_id))
    with get_db() as db:
        unchanged_household_project = db.execute(
            "SELECT workspace_id FROM projects WHERE id = ?",
            (workspace_household_project["id"],),
        ).fetchone()
        assert unchanged_household_project["workspace_id"] == workspace_household_project["workspace_id"], unchanged_household_project
        assert db.execute(
            "SELECT 1 FROM entity_access WHERE entity_type = 'project' AND entity_id = ?",
            (source_inbox_id,),
        ).fetchone() is None
        db.execute(
            """INSERT INTO project_members (project_id, user_id, invited_by, status)
               VALUES (?, ?, ?, 'pending')""",
            (disposable_household_project["id"], ancestor_gain_id, owner_id),
        )
        db.commit()
    project_delete_payloads = {}

    async def capture_project_delete(user_id, message):
        project_delete_payloads.setdefault(user_id, []).append(message)
        return True

    websocket_service.manager.broadcast_to_user = capture_project_delete
    try:
        asyncio.run(delete_project(disposable_household_project["id"], owner_id))
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    for affected_user_id in (owner_id, successor_id, hierarchy_gain_id, ancestor_gain_id):
        delete_syncs = [
            message for message in project_delete_payloads.get(affected_user_id, [])
            if message.get("type") == "sync_response"
        ]
        assert delete_syncs, project_delete_payloads
    pending_project_delete_sync = [
        message for message in project_delete_payloads[ancestor_gain_id]
        if message.get("type") == "sync_response"
    ][-1]
    assert pending_project_delete_sync["project_invites"] == []
    assert not any(
        message.get("type") == "project_delete"
        for message in project_delete_payloads[ancestor_gain_id]
    ), project_delete_payloads[ancestor_gain_id]
    hierarchy_delete_sync = [
        message for message in project_delete_payloads[hierarchy_gain_id]
        if message.get("type") == "sync_response"
    ][-1]
    assert former_member_todo["id"] not in {todo["id"] for todo in hierarchy_delete_sync["todos"]}
    owner_delete_sync = [
        message for message in project_delete_payloads[owner_id]
        if message.get("type") == "sync_response"
    ][-1]
    rehomed_payload = next(todo for todo in owner_delete_sync["todos"] if todo["id"] == former_member_todo["id"])
    assert rehomed_payload["project_id"] != disposable_household_project["id"], rehomed_payload
    try:
        get_todo(former_member_todo["id"], former_member_id)
    except HTTPException as error:
        assert error.status_code in (403, 404), error
    else:
        raise AssertionError("project deletion restored household content access to its removed creator")
    owner_todo = get_todo(former_member_todo["id"], owner_id)
    assert owner_todo["user_id"] == former_member_id, owner_todo

    with get_db() as db:
        deleted_user_id = db.execute("INSERT INTO users (username) VALUES ('delete-me')").lastrowid
        db.commit()
    deleted_user_project = asyncio.run(create_project(ProjectCreate(name="Delete me"), deleted_user_id))
    deleted_user_todo = asyncio.run(
        create_todo(TodoCreate(title="Delete personal data", project_id=deleted_user_project["id"]), deleted_user_id)
    )
    asyncio.run(update_todo(deleted_user_todo["id"], TodoUpdate(project_id=None), deleted_user_id))
    second_deleted_user_todo = asyncio.run(
        create_todo(TodoCreate(title="Delete second personal data", project_id=deleted_user_project["id"]), deleted_user_id)
    )
    asyncio.run(update_todo(second_deleted_user_todo["id"], TodoUpdate(project_id=None), deleted_user_id))
    deleted_attachment_path = ATTACHMENT_DIR / str(deleted_user_todo["id"]) / "delete.txt"
    deleted_attachment_path.parent.mkdir(parents=True, exist_ok=True)
    deleted_attachment_path.write_text("delete")
    second_deleted_attachment_path = ATTACHMENT_DIR / str(second_deleted_user_todo["id"]) / "delete-second.txt"
    second_deleted_attachment_path.parent.mkdir(parents=True, exist_ok=True)
    second_deleted_attachment_path.write_text("delete second")
    with get_db() as db:
        db.execute(
            """INSERT INTO project_members (project_id, user_id, invited_by, status)
               VALUES (?, ?, ?, 'accepted')""",
            (deleted_user_project["id"], recipient_id, deleted_user_id),
        )
        db.execute(
            "INSERT INTO todo_comments (todo_id, user_id, body) VALUES (?, ?, 'delete')",
            (deleted_user_todo["id"], deleted_user_id),
        )
        db.execute(
            """INSERT INTO todo_attachments
               (todo_id, user_id, original_filename, stored_filename, content_type, size_bytes)
               VALUES (?, ?, 'delete.txt', 'delete.txt', 'text/plain', 6)""",
            (deleted_user_todo["id"], deleted_user_id),
        )
        db.execute(
            "INSERT INTO reminders (todo_id, remind_at, user_id) VALUES (?, datetime('now'), ?)",
            (deleted_user_todo["id"], deleted_user_id),
        )
        db.commit()
    account_cleanup_calls = [0]

    def fail_account_cleanup(source, destination):
        account_cleanup_calls[0] += 1
        if account_cleanup_calls[0] == 2:
            raise OSError("cleanup blocked")
        return original_attachment_replace(source, destination)

    attachments_service.os.replace = fail_account_cleanup
    try:
        try:
            asyncio.run(delete_user(deleted_user_id, True))
        except OSError as error:
            assert str(error) == "cleanup blocked", error
        else:
            raise AssertionError("account deletion ignored attachment cleanup failure")
    finally:
        attachments_service.os.replace = original_attachment_replace
    with get_db() as db:
        assert db.execute("SELECT 1 FROM users WHERE id = ?", (deleted_user_id,)).fetchone() is not None
        assert db.execute("SELECT 1 FROM todos WHERE id = ?", (deleted_user_todo["id"],)).fetchone() is not None
        assert db.execute("SELECT 1 FROM todos WHERE id = ?", (second_deleted_user_todo["id"],)).fetchone() is not None
    assert deleted_attachment_path.is_file()
    assert second_deleted_attachment_path.is_file()
    account_delete_payloads = {}

    async def capture_account_delete(user_id, message):
        account_delete_payloads.setdefault(user_id, []).append(message)
        return True

    websocket_service.manager.broadcast_to_user = capture_account_delete
    try:
        asyncio.run(delete_user(deleted_user_id, True))
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    with get_db() as db:
        assert db.execute("SELECT 1 FROM todos WHERE id = ?", (deleted_user_todo["id"],)).fetchone() is None
        assert db.execute("SELECT 1 FROM reminders WHERE todo_id = ?", (deleted_user_todo["id"],)).fetchone() is None
        assert db.execute("SELECT 1 FROM todo_comments WHERE todo_id = ?", (deleted_user_todo["id"],)).fetchone() is None
        assert db.execute("SELECT 1 FROM todo_attachments WHERE todo_id = ?", (deleted_user_todo["id"],)).fetchone() is None
    assert not deleted_attachment_path.parent.exists()
    assert not second_deleted_attachment_path.parent.exists()
    recipient_account_syncs = [
        message for message in account_delete_payloads.get(recipient_id, [])
        if message.get("type") == "sync_response"
    ]
    assert recipient_account_syncs, account_delete_payloads
    assert deleted_user_project["id"] not in {
        project["id"] for project in recipient_account_syncs[-1]["projects"]
    }

    legacy_project = asyncio.run(create_project(ProjectCreate(name="Legacy shared"), owner_id))
    with get_db() as db:
        db.execute(
            """INSERT INTO project_members
               (project_id, user_id, invited_by, status, workspace_id)
               VALUES (?, ?, ?, 'accepted', ?)""",
            (legacy_project["id"], recipient_id, owner_id, recipient_workspace_id),
        )
        db.commit()
    asyncio.run(
        transfer_project_to_household_endpoint(
            legacy_project["id"],
            ProjectHouseholdTransfer(household_id=household_id),
            owner_id,
        )
    )
    try:
        asyncio.run(
            create_todo(
                TodoCreate(title="Revoked legacy direct share", project_id=legacy_project["id"]),
                recipient_id,
            )
        )
    except HTTPException as error:
        assert error.status_code == 403, error
    else:
        raise AssertionError("former direct project member retained access after household transfer")
    with get_db() as db:
        household_editor_id = db.execute(
            "SELECT owner_user_id FROM households WHERE id = ?",
            (household_id,),
        ).fetchone()["owner_user_id"]
    legacy_shared_todo = asyncio.run(
        create_todo(
            TodoCreate(title="Legacy shared deletion boundary", project_id=legacy_project["id"]),
            household_editor_id,
        )
    )
    with get_db() as db:
        entity_access_id = db.execute(
            "SELECT id FROM entity_access WHERE entity_type = 'project' AND entity_id = ?",
            (legacy_project["id"],),
        ).fetchone()["id"]
        db.execute(
            """INSERT INTO entity_access_grants (entity_access_id, user_id, granted_by_user_id)
               VALUES (?, ?, ?)""",
            (entity_access_id, migration_extra_user_id, owner_id),
        )
        db.commit()
    for shared_editor_id in (recipient_id, migration_extra_user_id):
        try:
            asyncio.run(delete_todo(legacy_shared_todo["id"], shared_editor_id))
        except HTTPException as error:
            assert error.status_code == 403, error
        else:
            raise AssertionError("shared editor deleted a todo without effective ownership")
    inherited_project_payloads = {}

    async def capture_inherited_project(user_id, message):
        inherited_project_payloads.setdefault(user_id, []).append(message)
        return True

    websocket_service.manager.broadcast_to_user = capture_inherited_project
    try:
        inherited_child = asyncio.run(
            create_project(
                ProjectCreate(
                    name="Inherited child",
                    parent_id=legacy_project["id"],
                    household_id=household_id,
                ),
                owner_id,
            )
        )
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    for inherited_user_id in (recipient_id, migration_extra_user_id):
        assert not any(
            message.get("type") == "project_update"
            and message.get("payload", {}).get("id") == inherited_child["id"]
            for message in inherited_project_payloads.get(inherited_user_id, [])
        ), inherited_project_payloads
    inherited_todo_payloads = {}

    async def capture_inherited_todo(user_id, message):
        inherited_todo_payloads.setdefault(user_id, []).append(message)
        return True

    websocket_service.manager.broadcast_to_user = capture_inherited_todo
    try:
        inherited_todo = asyncio.run(
            create_todo(
                TodoCreate(title="Inherited child todo", project_id=inherited_child["id"]),
                owner_id,
            )
        )
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    for inherited_user_id in (recipient_id, migration_extra_user_id):
        assert not any(
            message.get("type") == "todo_create"
            and message.get("payload", {}).get("id") == inherited_todo["id"]
            for message in inherited_todo_payloads.get(inherited_user_id, [])
        ), inherited_todo_payloads
    with get_db() as db:
        for inherited_user_id in (recipient_id, migration_extra_user_id):
            assert not can_access_project(db, inherited_child["id"], inherited_user_id)
            assert inherited_child["id"] not in get_project_ids_for_user(db, inherited_user_id)
    with get_db() as db:
        transfer_household_ownership(db, household_id, owner_id, successor_id)
        db.commit()

    asyncio.run(delete_user(owner_id, True))
    with get_db() as db:
        preserved_grant = db.execute(
            """SELECT granted_by_user_id FROM entity_access_grants
               WHERE entity_access_id = ? AND user_id = ?""",
            (entity_access_id, migration_extra_user_id),
        ).fetchone()
        assert preserved_grant and preserved_grant["granted_by_user_id"] is None, preserved_grant
        membership = db.execute(
            "SELECT invited_by, status FROM project_members WHERE project_id = ? AND user_id = ?",
            (legacy_project["id"], recipient_id),
        ).fetchone()
        assert membership is None, membership
        shared = get_shared_projects_for_user(db, recipient_id)
        assert legacy_project["id"] not in {project["id"] for project in shared}, shared
        assert inherited_child["id"] not in {project["id"] for project in shared}, shared
        assert inherited_child["id"] not in {
            project["id"] for project in get_shared_projects_for_user(db, migration_extra_user_id)
        }

    try:
        asyncio.run(
            update_project(
                legacy_project["id"],
                ProjectUpdate(workspace_id=recipient_workspace_id),
                recipient_id,
            )
        )
    except HTTPException as error:
        assert error.status_code == 403, error
    else:
        raise AssertionError("former direct project member updated a household project")

    transfer_gain_root = asyncio.run(create_project(ProjectCreate(name="Transfer gain root"), successor_id))
    transfer_gain_child = asyncio.run(
        create_project(ProjectCreate(name="Transfer gain child", parent_id=transfer_gain_root["id"]), successor_id)
    )
    transfer_gain_todo = asyncio.run(
        create_todo(TodoCreate(title="Transfer gain todo", project_id=transfer_gain_child["id"]), successor_id)
    )
    transfer_gain_payloads = {}

    async def capture_transfer_gain(user_id, message):
        transfer_gain_payloads.setdefault(user_id, []).append(message)
        return True

    websocket_service.manager.broadcast_to_user = capture_transfer_gain
    try:
        asyncio.run(transfer_project_to_household_endpoint(
            transfer_gain_root["id"], ProjectHouseholdTransfer(household_id=household_id), successor_id
        ))
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    transfer_syncs = [
        message for message in transfer_gain_payloads.get(hierarchy_gain_id, [])
        if message.get("type") == "sync_response"
    ]
    assert transfer_syncs, transfer_gain_payloads
    assert {transfer_gain_root["id"], transfer_gain_child["id"]}.issubset({
        project["id"] for project in transfer_syncs[-1]["projects"]
    })
    assert transfer_gain_todo["id"] in {todo["id"] for todo in transfer_syncs[-1]["todos"]}

    private_household_root = asyncio.run(
        create_project(
            ProjectCreate(name="Private household root", household_id=household_id),
            successor_id,
        )
    )
    with get_db() as db:
        private_root_access_id = db.execute(
            "SELECT id FROM entity_access WHERE entity_type = 'project' AND entity_id = ?",
            (private_household_root["id"],),
        ).fetchone()["id"]
        db.execute(
            """INSERT INTO entity_access_grants (entity_access_id, user_id, granted_by_user_id)
               VALUES (?, ?, ?)""",
            (private_root_access_id, ancestor_gain_id, successor_id),
        )
        assert not can_access_project(db, inherited_child["id"], ancestor_gain_id)
        db.commit()
    project_move_payloads = {}

    async def capture_project_move(user_id, message):
        project_move_payloads.setdefault(user_id, []).append(message)
        return True

    websocket_service.manager.broadcast_to_user = capture_project_move
    try:
        asyncio.run(
            update_project(
                inherited_child["id"],
                ProjectUpdate(parent_id=private_household_root["id"]),
                successor_id,
            )
        )
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    for stale_grant_user_id in (recipient_id, migration_extra_user_id, ancestor_gain_id):
        assert stale_grant_user_id not in project_move_payloads, project_move_payloads
    with get_db() as db:
        for stale_grant_user_id in (recipient_id, migration_extra_user_id, ancestor_gain_id):
            assert not can_access_project(db, inherited_child["id"], stale_grant_user_id)

    todo_move_payloads = {}

    async def capture_todo_move(user_id, message):
        todo_move_payloads.setdefault(user_id, []).append(message)
        return True

    websocket_service.manager.broadcast_to_user = capture_todo_move
    try:
        asyncio.run(
            update_todo(
                legacy_shared_todo["id"],
                TodoUpdate(project_id=private_household_root["id"]),
                successor_id,
            )
        )
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    for stale_grant_user_id in (recipient_id, migration_extra_user_id, ancestor_gain_id):
        assert stale_grant_user_id not in todo_move_payloads, todo_move_payloads

    with get_db() as db:
        db.execute(
            """INSERT INTO project_members
               (project_id, user_id, invited_by, status, workspace_id)
               VALUES (?, ?, ?, 'accepted', ?)""",
            (legacy_project["id"], recipient_id, successor_id, recipient_workspace_id),
        )
        original_schema = db.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_members'"
        ).fetchone()["sql"]
        db.execute("ALTER TABLE project_members RENAME TO project_members_old_058")
        db.execute(original_schema)
        db.commit()
        assert db.execute("SELECT COUNT(*) AS count FROM project_members").fetchone()["count"] == 0
        assert db.execute("SELECT COUNT(*) AS count FROM project_members_old_058").fetchone()["count"] > 0
        repair_household_entity_access_migration(db)
        surviving_membership = db.execute(
            "SELECT status FROM project_members WHERE project_id = ? AND user_id = ?",
            (legacy_project["id"], recipient_id),
        ).fetchone()
        assert surviving_membership and surviving_membership["status"] == "accepted", surviving_membership

        original_schema = db.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_members'"
        ).fetchone()["sql"]
        db.execute("ALTER TABLE project_members RENAME TO project_members_old_058")
        db.execute(original_schema)
        db.execute(
            """INSERT INTO project_members (project_id, user_id, invited_by, status)
               VALUES (?, ?, ?, 'accepted')""",
            (legacy_project["id"], migration_extra_user_id, successor_id),
        )
        db.commit()
        assert db.execute("SELECT COUNT(*) AS count FROM project_members").fetchone()["count"] == 1
        assert db.execute("SELECT COUNT(*) AS count FROM project_members_old_058").fetchone()["count"] == 1
        repair_household_entity_access_migration(db)
        preserved_user_ids = {
            row["user_id"]
            for row in db.execute(
                "SELECT user_id FROM project_members WHERE project_id = ? AND status = 'accepted'",
                (legacy_project["id"],),
            ).fetchall()
        }
        assert preserved_user_ids == {recipient_id, migration_extra_user_id}, preserved_user_ids

        original_schema = db.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_members'"
        ).fetchone()["sql"]
        db.execute("ALTER TABLE project_members RENAME TO project_members_old_058")
        db.execute(original_schema)
        db.execute(
            """UPDATE project_members_old_058
               SET status = 'pending', workspace_id = NULL, updated_at = '2026-01-01T00:00:00+00:00'
               WHERE project_id = ? AND user_id = ?""",
            (legacy_project["id"], migration_extra_user_id),
        )
        db.execute(
            """INSERT INTO project_members
               (project_id, user_id, invited_by, status, workspace_id, updated_at)
               VALUES (?, ?, ?, 'accepted', ?, '2026-02-01T00:00:00+00:00')""",
            (legacy_project["id"], migration_extra_user_id, successor_id, recipient_workspace_id),
        )
        db.commit()
        repair_household_entity_access_migration(db)
        reconciled_membership = db.execute(
            """SELECT status, workspace_id, updated_at FROM project_members
               WHERE project_id = ? AND user_id = ?""",
            (legacy_project["id"], migration_extra_user_id),
        ).fetchone()
        assert dict(reconciled_membership) == {
            "status": "accepted",
            "workspace_id": recipient_workspace_id,
            "updated_at": "2026-02-01T00:00:00+00:00",
        }, reconciled_membership

        project_members_schema = db.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_members'"
        ).fetchone()["sql"]
        db.execute(
            "UPDATE project_members SET updated_at = '2026-04-01T00:00:00+00:00' WHERE project_id = ? AND user_id = ?",
            (legacy_project["id"], recipient_id),
        )
        db.execute("ALTER TABLE project_members RENAME TO project_members_old_058")
        db.execute(project_members_schema)
        db.execute(
            """INSERT INTO project_members
               (project_id, user_id, invited_by, status, created_at, updated_at, workspace_id)
               VALUES (?, ?, NULL, 'pending', '2026-01-01T00:00:00+00:00', '2026-04-01T00:00:00+00:00', NULL)""",
            (legacy_project["id"], recipient_id),
        )
        db.commit()
        repair_household_entity_access_migration(db)
        tie_membership = db.execute(
            "SELECT status, workspace_id FROM project_members WHERE project_id = ? AND user_id = ?",
            (legacy_project["id"], recipient_id),
        ).fetchone()
        assert dict(tie_membership) == {
            "status": "accepted",
            "workspace_id": recipient_workspace_id,
        }, tie_membership

        db.execute(
            project_members_schema.replace(
                "CREATE TABLE project_members", "CREATE TABLE project_members_old_058", 1
            )
        )
        db.execute(
            """INSERT INTO project_members_old_058
               (project_id, user_id, invited_by, status, created_at, updated_at, workspace_id)
               VALUES (?, ?, NULL, 'pending', '2026-01-01T00:00:00+00:00', '2026-04-01T00:00:00+00:00', NULL)""",
            (legacy_project["id"], recipient_id),
        )
        db.commit()
        repair_household_entity_access_migration(db)
        inverse_tie_membership = db.execute(
            "SELECT status, workspace_id FROM project_members WHERE project_id = ? AND user_id = ?",
            (legacy_project["id"], recipient_id),
        ).fetchone()
        assert dict(inverse_tie_membership) == {
            "status": "accepted",
            "workspace_id": recipient_workspace_id,
        }, inverse_tie_membership

        db.execute(
            "UPDATE project_members SET updated_at = NULL WHERE project_id = ? AND user_id = ?",
            (legacy_project["id"], recipient_id),
        )
        db.execute(
            project_members_schema.replace(
                "CREATE TABLE project_members", "CREATE TABLE project_members_old_058", 1
            )
        )
        db.execute(
            """INSERT INTO project_members_old_058
               (project_id, user_id, invited_by, status, created_at, updated_at, workspace_id)
               VALUES (?, ?, NULL, 'pending', '2026-01-01T00:00:00+00:00', NULL, NULL)""",
            (legacy_project["id"], recipient_id),
        )
        db.commit()
        repair_household_entity_access_migration(db)
        null_tie_membership = db.execute(
            "SELECT status, workspace_id FROM project_members WHERE project_id = ? AND user_id = ?",
            (legacy_project["id"], recipient_id),
        ).fetchone()
        assert dict(null_tie_membership) == {
            "status": "accepted",
            "workspace_id": recipient_workspace_id,
        }, null_tie_membership

        db.execute(
            "UPDATE todo_comments SET updated_at = '2026-04-01T00:00:00+00:00' WHERE id = ?",
            (owner_comment["comment"]["id"],),
        )
        comments_tie_schema = db.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'todo_comments'"
        ).fetchone()["sql"]
        owner_comment_row = dict(db.execute(
            "SELECT * FROM todo_comments WHERE id = ?",
            (owner_comment["comment"]["id"],),
        ).fetchone())
        db.execute("ALTER TABLE todo_comments RENAME TO todo_comments_old_058")
        db.execute(comments_tie_schema)
        db.execute(
            """INSERT INTO todo_comments
               (id, todo_id, user_id, body, created_at, updated_at, client_mutation_id)
               VALUES (?, ?, ?, 'tie replacement', ?, ?, ?)""",
            (
                owner_comment_row["id"], owner_comment_row["todo_id"], owner_comment_row["user_id"],
                owner_comment_row["created_at"], owner_comment_row["updated_at"],
                owner_comment_row["client_mutation_id"],
            ),
        )
        db.commit()
        repair_household_entity_access_migration(db)
        tie_comment = db.execute(
            "SELECT body FROM todo_comments WHERE id = ?",
            (owner_comment["comment"]["id"],),
        ).fetchone()
        assert tie_comment["body"] == "Owner comment", tie_comment

        # Matching non-null mutation IDs identify one edited logical comment.
        edited_comment_id = db.execute(
            """INSERT INTO todo_comments
               (todo_id, user_id, body, created_at, updated_at, client_mutation_id)
               VALUES (?, ?, 'edit backup', '2026-06-01T00:00:00+00:00',
                       '2026-06-01T00:00:00+00:00', 'migration-edit-key')""",
            (owner_comment_row["todo_id"], recipient_id),
        ).lastrowid
        comments_edit_schema = db.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'todo_comments'"
        ).fetchone()["sql"]
        edited_comment_row = dict(db.execute(
            "SELECT * FROM todo_comments WHERE id = ?", (edited_comment_id,)
        ).fetchone())
        db.execute("ALTER TABLE todo_comments RENAME TO todo_comments_old_058")
        db.execute(comments_edit_schema)
        db.execute(
            """INSERT INTO todo_comments
               (id, todo_id, user_id, body, created_at, updated_at, client_mutation_id)
               VALUES (?, ?, ?, 'edit current', ?, '2026-06-02T00:00:00+00:00', ?)""",
            (
                edited_comment_row["id"], edited_comment_row["todo_id"], edited_comment_row["user_id"],
                edited_comment_row["created_at"], edited_comment_row["client_mutation_id"],
            ),
        )
        db.commit()
        repair_household_entity_access_migration(db)
        edited_comment = db.execute(
            "SELECT body FROM todo_comments WHERE client_mutation_id = 'migration-edit-key'"
        ).fetchall()
        assert [row["body"] for row in edited_comment] == ["edit current"], edited_comment

        edited_comment_row = dict(db.execute(
            "SELECT * FROM todo_comments WHERE id = ?", (edited_comment_id,)
        ).fetchone())
        db.execute("ALTER TABLE todo_comments RENAME TO todo_comments_old_058")
        db.execute(comments_edit_schema)
        db.execute(
            """INSERT INTO todo_comments
               (id, todo_id, user_id, body, created_at, updated_at, client_mutation_id)
               VALUES (?, ?, ?, 'older current', ?, '2026-06-01T12:00:00+00:00', ?)""",
            (
                edited_comment_row["id"], edited_comment_row["todo_id"], edited_comment_row["user_id"],
                edited_comment_row["created_at"], edited_comment_row["client_mutation_id"],
            ),
        )
        db.commit()
        repair_household_entity_access_migration(db)
        edited_comment = db.execute(
            "SELECT body FROM todo_comments WHERE client_mutation_id = 'migration-edit-key'"
        ).fetchall()
        assert [row["body"] for row in edited_comment] == ["edit current"], edited_comment

        # Invalid backup timestamps remain authoritative conservatively.
        db.execute(
            "UPDATE todo_comments SET body = 'invalid backup', updated_at = 'not-a-date' WHERE id = ?",
            (edited_comment_id,),
        )
        edited_comment_row = dict(db.execute(
            "SELECT * FROM todo_comments WHERE id = ?", (edited_comment_id,)
        ).fetchone())
        db.execute("ALTER TABLE todo_comments RENAME TO todo_comments_old_058")
        db.execute(comments_edit_schema)
        db.execute(
            """INSERT INTO todo_comments
               (id, todo_id, user_id, body, created_at, updated_at, client_mutation_id)
               VALUES (?, ?, ?, 'parseable current', ?, '2026-07-01T00:00:00+00:00', ?)""",
            (
                edited_comment_row["id"], edited_comment_row["todo_id"], edited_comment_row["user_id"],
                edited_comment_row["created_at"], edited_comment_row["client_mutation_id"],
            ),
        )
        db.commit()
        repair_household_entity_access_migration(db)
        invalid_timestamp_comment = db.execute(
            "SELECT body FROM todo_comments WHERE id = ?", (edited_comment_id,)
        ).fetchone()
        assert invalid_timestamp_comment["body"] == "invalid backup", invalid_timestamp_comment

        # Candidate ordering cannot let an older duplicate mutation win.
        db.execute(
            "UPDATE todo_comments SET body = 'mutation base', updated_at = '2026-01-01T00:00:00+00:00' WHERE id = ?",
            (edited_comment_id,),
        )
        edited_comment_row = dict(db.execute(
            "SELECT * FROM todo_comments WHERE id = ?", (edited_comment_id,)
        ).fetchone())
        db.execute("ALTER TABLE todo_comments RENAME TO todo_comments_old_058")
        db.execute(comments_edit_schema)
        for offset, body, updated_at in (
            (1000, 'mutation newest', '2026-03-01T00:00:00+00:00'),
            (1001, 'mutation older', '2026-02-01T00:00:00+00:00'),
        ):
            db.execute(
                """INSERT INTO todo_comments
                   (id, todo_id, user_id, body, created_at, updated_at, client_mutation_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    edited_comment_row["id"] + offset, edited_comment_row["todo_id"],
                    edited_comment_row["user_id"], body, edited_comment_row["created_at"],
                    updated_at, edited_comment_row["client_mutation_id"],
                ),
            )
        db.commit()
        repair_household_entity_access_migration(db)
        ordered_mutation_comment = db.execute(
            "SELECT body FROM todo_comments WHERE client_mutation_id = 'migration-edit-key'"
        ).fetchall()
        assert [row["body"] for row in ordered_mutation_comment] == ["mutation newest"], ordered_mutation_comment

        # NULL authors do not form a unique mutation identity in SQLite.
        null_author_comment_id = db.execute(
            """INSERT INTO todo_comments
               (todo_id, user_id, body, created_at, updated_at, client_mutation_id)
               VALUES (?, NULL, 'null author backup', '2026-08-01T00:00:00+00:00',
                       '2026-08-01T00:00:00+00:00', 'null-author-key')""",
            (owner_comment_row["todo_id"],),
        ).lastrowid
        null_author_schema = db.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'todo_comments'"
        ).fetchone()["sql"]
        db.execute("ALTER TABLE todo_comments RENAME TO todo_comments_old_058")
        db.execute(null_author_schema)
        db.execute(
            """INSERT INTO todo_comments
               (id, todo_id, user_id, body, created_at, updated_at, client_mutation_id)
               VALUES (?, ?, NULL, 'null author current', '2026-08-02T00:00:00+00:00',
                       '2026-08-02T00:00:00+00:00', 'null-author-key')""",
            (null_author_comment_id + 1000, owner_comment_row["todo_id"]),
        )
        db.commit()
        repair_household_entity_access_migration(db)
        null_author_bodies = {
            row["body"] for row in db.execute(
                "SELECT body FROM todo_comments WHERE client_mutation_id = 'null-author-key'"
            ).fetchall()
        }
        assert null_author_bodies == {"null author backup", "null author current"}, null_author_bodies

        comments_schema = db.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'todo_comments'"
        ).fetchone()["sql"]
        db.execute("ALTER TABLE todo_comments RENAME TO todo_comments_old_058")
        db.execute(comments_schema)
        db.execute(
            """INSERT INTO todo_comments
               (id, todo_id, user_id, body, created_at, updated_at)
               VALUES (?, ?, ?, 'collision comment', '2026-03-01T00:00:00+00:00', '2026-03-01T00:00:00+00:00')""",
            (owner_comment["comment"]["id"], private_todo["id"], successor_id),
        )
        db.commit()
        repair_household_entity_access_migration(db)
        collision_comment_bodies = {
            row["body"]
            for row in db.execute(
                "SELECT body FROM todo_comments WHERE body IN ('Owner comment', 'collision comment')"
            ).fetchall()
        }
        assert collision_comment_bodies == {"Owner comment", "collision comment"}, collision_comment_bodies

        same_todo_comment_row = dict(db.execute(
            "SELECT * FROM todo_comments WHERE body = 'Owner comment'"
        ).fetchone())
        db.execute("ALTER TABLE todo_comments RENAME TO todo_comments_old_058")
        db.execute(comments_schema)
        db.execute(
            """INSERT INTO todo_comments
               (id, todo_id, user_id, body, created_at, updated_at, client_mutation_id)
               VALUES (?, ?, ?, 'same todo collision comment', ?, '2026-05-01T00:00:00+00:00', ?)""",
            (
                same_todo_comment_row["id"], same_todo_comment_row["todo_id"],
                same_todo_comment_row["user_id"], same_todo_comment_row["created_at"],
                same_todo_comment_row["client_mutation_id"],
            ),
        )
        db.commit()
        repair_household_entity_access_migration(db)
        same_todo_comment_bodies = {
            row["body"]
            for row in db.execute(
                "SELECT body FROM todo_comments WHERE body IN ('Owner comment', 'same todo collision comment')"
            ).fetchall()
        }
        assert same_todo_comment_bodies == {
            "Owner comment", "same todo collision comment"
        }, same_todo_comment_bodies

        attachments_schema = db.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'todo_attachments'"
        ).fetchone()["sql"]
        db.execute("ALTER TABLE todo_attachments RENAME TO todo_attachments_old_058")
        db.execute(attachments_schema)
        db.execute(
            """INSERT INTO todo_attachments
               (id, todo_id, user_id, original_filename, stored_filename, content_type, size_bytes, created_at)
               VALUES (?, ?, ?, 'collision.txt', 'collision.txt', 'text/plain', 9, '2026-03-01T00:00:00+00:00')""",
            (attachment_id, private_todo["id"], successor_id),
        )
        db.commit()
        repair_household_entity_access_migration(db)
        collision_attachment_names = {
            row["stored_filename"]
            for row in db.execute(
                "SELECT stored_filename FROM todo_attachments WHERE stored_filename IN (?, 'collision.txt')",
                (stored_filename,),
            ).fetchall()
        }
        assert collision_attachment_names == {stored_filename, "collision.txt"}, collision_attachment_names

        same_todo_attachment_row = dict(db.execute(
            "SELECT * FROM todo_attachments WHERE stored_filename = ?", (stored_filename,)
        ).fetchone())
        db.execute("ALTER TABLE todo_attachments RENAME TO todo_attachments_old_058")
        db.execute(attachments_schema)
        db.execute(
            """INSERT INTO todo_attachments
               (id, todo_id, user_id, original_filename, stored_filename, content_type, size_bytes, created_at)
               VALUES (?, ?, ?, 'same-todo.txt', 'same-todo.txt', 'text/plain', 12,
                       '2026-05-01T00:00:00+00:00')""",
            (same_todo_attachment_row["id"], same_todo_attachment_row["todo_id"], successor_id),
        )
        db.commit()
        repair_household_entity_access_migration(db)
        same_todo_attachment_names = {
            row["stored_filename"]
            for row in db.execute(
                "SELECT stored_filename FROM todo_attachments WHERE stored_filename IN (?, 'same-todo.txt')",
                (stored_filename,),
            ).fetchall()
        }
        assert same_todo_attachment_names == {stored_filename, "same-todo.txt"}, same_todo_attachment_names

        db.execute("CREATE INDEX migration_58_atomicity_marker ON project_members(status)")
        db.commit()

        def migration_58_snapshot(connection):
            schema = [tuple(row) for row in connection.execute(
                """SELECT type, name, tbl_name, sql FROM sqlite_master
                   WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"""
            ).fetchall()]
            rows = {}
            for table in ("project_members", "todo_comments", "todo_attachments", "schema_version"):
                rows[table] = [tuple(row) for row in connection.execute(
                    f"SELECT * FROM {table} ORDER BY 1"
                ).fetchall()]
            return schema, rows

        atomicity_source = sqlite3.connect(":memory:")
        atomicity_source.row_factory = sqlite3.Row
        db.backup(atomicity_source)
        original_schema_executor = migrate_module.execute_transactional_schema_script
        for fault_marker in (
            "ALTER TABLE project_members RENAME TO project_members_old_058",
            "ALTER TABLE todo_comments RENAME TO todo_comments_old_058",
            "ALTER TABLE todo_attachments RENAME TO todo_attachments_old_058",
        ):
            fault_db = sqlite3.connect(":memory:")
            fault_db.row_factory = sqlite3.Row
            atomicity_source.backup(fault_db)
            before_fault = migration_58_snapshot(fault_db)

            def injected_schema_executor(connection, script, marker=fault_marker):
                original_schema_executor(connection, script)
                if marker in script:
                    raise sqlite3.OperationalError(f"fault after {marker}")

            migrate_module.execute_transactional_schema_script = injected_schema_executor
            try:
                try:
                    repair_household_entity_access_migration(fault_db)
                except sqlite3.OperationalError as error:
                    assert "fault after" in str(error), error
                else:
                    raise AssertionError(f"migration repair ignored injected fault after {fault_marker}")
            finally:
                migrate_module.execute_transactional_schema_script = original_schema_executor
            assert migration_58_snapshot(fault_db) == before_fault, fault_marker
            fault_db.close()
        atomicity_source.close()

        db.execute("DELETE FROM schema_version")
        db.execute("INSERT INTO schema_version (version, applied_at) VALUES (57, datetime('now'))")
        faulty_comment_rows = db.execute(
            "SELECT id, todo_id, user_id, body, created_at, updated_at FROM todo_comments"
        ).fetchall()
        db.execute("ALTER TABLE todo_comments RENAME TO todo_comments_faulty_source")
        db.execute(
            """CREATE TABLE todo_comments (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   todo_id INTEGER NOT NULL,
                   user_id INTEGER,
                   body TEXT NOT NULL,
                   created_at TEXT,
                   updated_at TEXT
               )"""
        )
        db.executemany(
            """INSERT INTO todo_comments (id, todo_id, user_id, body, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [tuple(row) for row in faulty_comment_rows],
        )
        db.execute("DROP TABLE todo_comments_faulty_source")
        db.commit()
        try:
            repair_household_entity_access_migration(db)
        except Exception as error:
            assert "client_mutation_id" in str(error), error
        else:
            raise AssertionError("fault-injected migration repair unexpectedly succeeded")
        assert db.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'migration_58_atomicity_marker'"
        ).fetchone() is not None
        assert db.execute("SELECT version FROM schema_version").fetchone()["version"] == 57

print("✅ Household content boundaries and deletion persistence remain intact")
