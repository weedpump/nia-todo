#!/usr/bin/env python3
"""Attachment quota follows current Todo access without deleting shared uploads.

Standalone and disposable: all API imports, migrations, SQLite writes and files
are confined to one TemporaryDirectory. No running Nia service is contacted.
"""

import asyncio
import contextlib
import io
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix="nia-attachment-quota-access-") as temporary:
        isolated = Path(temporary)
        environment = {
            "NIA_TODO_DATA_DIR": temporary,
            "NIA_TODO_DB": str(isolated / "quota-test.db"),
            "NIA_TODO_ATTACHMENT_DIR": str(isolated / "attachments"),
            "NIA_TODO_AVATAR_DIR": str(isolated / "avatars"),
            "NIA_TODO_BACKUP_DIR": str(isolated / "backups"),
            "NIA_TODO_VAPID_KEYS": str(isolated / "vapid_keys.json"),
        }
        with patch.dict(os.environ, environment), contextlib.ExitStack() as mocks:
            # Environment isolation must precede every application import.
            sys.path.insert(0, str(ROOT / "api"))
            from fastapi import HTTPException
            from db import get_db
            from migrate import run_migrations
            from paths import ATTACHMENT_DIR, DB_PATH
            from routers import admin, entity_sharing, households, todos, websocket
            from services.attachments import attachment_usage_bytes, enforce_attachment_upload_policy
            from services.entity_access import (
                create_household,
                grant_entity_access,
                invite_household_member,
                register_household_entity,
                register_personal_entity,
                respond_to_household_invite,
            )

            assert DB_PATH.resolve().is_relative_to(isolated)
            assert ATTACHMENT_DIR.resolve().is_relative_to(isolated)
            assert not DB_PATH.exists(), "Fixture must start with a fresh disposable database"
            with contextlib.redirect_stdout(io.StringIO()):
                run_migrations()
            for router in (admin, entity_sharing, households):
                mocks.enter_context(patch.object(router, "broadcast_sync_to_users", new=AsyncMock()))
            mocks.enter_context(patch.object(admin, "can_send_email_links", return_value=False))
            with get_db() as db:
                db.execute("UPDATE app_config SET value='[\".txt\"]' WHERE key='attachments_allowed_types'")
                db.execute("UPDATE app_config SET value='1' WHERE key='attachments_enabled'")
                db.commit()

            def user(name):
                with get_db() as db:
                    result = db.execute("INSERT INTO users (username) VALUES (?)", (name,)).lastrowid
                    db.commit()
                    return result

            def project(name, owner, *, parent=None, household=None):
                with get_db() as db:
                    result = db.execute(
                        "INSERT INTO projects (name,user_id,parent_id) VALUES (?,?,?)",
                        (name, owner, parent),
                    ).lastrowid
                    if household is None:
                        register_personal_entity(db, "project", result, owner)
                    else:
                        register_household_entity(db, "project", result, owner, household)
                    db.commit()
                    return result

            def todo(title, author, project_id=None):
                with get_db() as db:
                    result = db.execute(
                        "INSERT INTO todos (title,user_id,project_id) VALUES (?,?,?)",
                        (title, author, project_id),
                    ).lastrowid
                    db.commit()
                    return result

            def grant(project_id, owner, recipient):
                with get_db() as db:
                    grant_entity_access(db, "project", project_id, owner, recipient)
                    db.commit()

            def upload_fixture(todo_id, uploader, content):
                with get_db() as db:
                    # Distinct real fixture files; no production upload/storage mocks.
                    stored = f"fixture-{uploader}-{len(content)}.txt"
                    directory = ATTACHMENT_DIR / str(todo_id)
                    directory.mkdir(parents=True, exist_ok=True)
                    path = directory / stored
                    assert not path.exists()
                    path.write_bytes(content)
                    result = db.execute(
                        """INSERT INTO todo_attachments
                           (todo_id,user_id,original_filename,stored_filename,content_type,size_bytes)
                           VALUES (?,?,?,?,'text/plain',?)""",
                        (todo_id, uploader, stored, stored, len(content)),
                    ).lastrowid
                    db.commit()
                    return {"id": result, "todo": todo_id, "uploader": uploader,
                            "path": path, "content": content}

            def usage(actor, expected):
                with get_db() as db:
                    assert not db.in_transaction
                    assert attachment_usage_bytes(db, actor) == expected, (actor, expected)
                    assert not db.in_transaction, "Usage reads must release their own snapshot"
                assert todos.get_attachment_usage(user_id=actor)["used_bytes"] == expected
                listed = next(row for row in admin.list_users(True)["users"] if row["id"] == actor)
                assert listed["attachment_usage_bytes"] == expected, listed

            def access(todo_id, actor, allowed):
                with get_db() as db:
                    snapshot_ids = {row["id"] for row in websocket.get_sync_todo_rows(db, actor)}
                    assert (todo_id in snapshot_ids) == allowed, (todo_id, actor, allowed)
                try:
                    result = todos.get_todo(todo_id, user_id=actor)
                except HTTPException as error:
                    assert not allowed and error.status_code in (403, 404), error
                else:
                    assert allowed and result["id"] == todo_id

            def retained(attachment, reader, *, uploader="original"):
                expected = attachment["uploader"] if uploader == "original" else uploader
                with get_db() as db:
                    row = db.execute("SELECT user_id,size_bytes FROM todo_attachments WHERE id=?",
                                     (attachment["id"],)).fetchone()
                    assert row is not None, "Losing access must not delete shared attachment metadata"
                    assert row["user_id"] == expected, "Quota relief must not reattribute uploads"
                    assert row["size_bytes"] == len(attachment["content"])
                assert attachment["path"].read_bytes() == attachment["content"]
                public = todos.list_todo_attachments(attachment["todo"], user_id=reader)["attachments"]
                row = next(item for item in public if item["id"] == attachment["id"])
                assert row["user_id"] == expected
                response = todos.download_todo_attachment(attachment["todo"], attachment["id"], user_id=reader)
                assert Path(response.path).read_bytes() == attachment["content"]

            def policy(actor, size, *, blocked):
                with get_db() as db:
                    try:
                        result = enforce_attachment_upload_policy(
                            db, user_id=actor, filename="next.txt", content_type="text/plain", size_bytes=size,
                        )
                    except HTTPException as error:
                        assert blocked and error.status_code == 413, error
                    else:
                        assert not blocked, "Quota policy must reject an upload above the accessible usage limit"
                        return result

            # Revocation excludes the former participant's bytes, not the files,
            # the creator's personal tasks, or another uploader's accounting.
            owner, writer, other = (user(name) for name in ("direct-owner", "direct-writer", "direct-other"))
            shared = project("Direct shared", owner)
            grant(shared, owner, writer)
            grant(shared, owner, other)
            shared_todo = todo("Authorship is not project access", writer, shared)
            writer_file = upload_fixture(shared_todo, writer, b"1234567")
            owner_file = upload_fixture(shared_todo, owner, b"owner-file!")
            other_file = upload_fixture(shared_todo, other, b"other-upload!")
            personal_todo = todo("Unassigned personal task", writer)
            personal_file = upload_fixture(personal_todo, writer, b"12345")
            usage(writer, 12)
            usage(owner, len(owner_file["content"]))
            usage(other, len(other_file["content"]))
            access(shared_todo, writer, True)
            with get_db() as db:
                db.execute("UPDATE users SET attachment_quota_bytes=12 WHERE id=?", (writer,))
                db.commit()
                db.execute("BEGIN IMMEDIATE")
                db.execute("UPDATE users SET attachment_quota_bytes=13 WHERE id=?", (writer,))
                assert attachment_usage_bytes(db, writer) == 12
                assert db.in_transaction, "Usage must preserve a caller-owned writer transaction"
                db.rollback()
                assert db.execute("SELECT attachment_quota_bytes FROM users WHERE id=?", (writer,)).fetchone()[0] == 12
            with get_db() as db, patch("services.attachments.can_access_project", side_effect=RuntimeError("ACL unavailable")):
                try:
                    attachment_usage_bytes(db, writer)
                except RuntimeError as error:
                    assert str(error) == "ACL unavailable"
                else:
                    raise AssertionError("ACL failures must not be converted into empty quota usage")
                assert not db.in_transaction, "Failed usage reads must also release their snapshot"
            policy(writer, 7, blocked=True)
            asyncio.run(entity_sharing.remove_entity_member("project", shared, writer, user_id=owner))
            access(shared_todo, writer, False)
            access(personal_todo, writer, True)
            usage(writer, 5)
            usage(owner, len(owner_file["content"]))
            usage(other, len(other_file["content"]))
            assert policy(writer, 7, blocked=False)["used_bytes"] == 5
            policy(writer, 8, blocked=True)
            for attachment in (writer_file, owner_file, other_file):
                retained(attachment, owner)
            retained(personal_file, writer)
            grant(shared, owner, writer)
            access(shared_todo, writer, True)
            usage(writer, 12)
            policy(writer, 1, blocked=True)
            retained(writer_file, owner)
            asyncio.run(entity_sharing.remove_entity_member("project", shared, writer, user_id=owner))
            usage(writer, 5)
            print("✅ Direct revocation, unchanged attribution, personal usage, admin usage and upload quota")

            owner, writer = user("leave-owner"), user("leave-writer")
            shared = project("Voluntarily shared", owner)
            grant(shared, owner, writer)
            shared_todo = todo("Shared attachment after leave", owner, shared)
            attachment = upload_fixture(shared_todo, writer, b"left-upload")
            usage(writer, len(attachment["content"]))
            asyncio.run(entity_sharing.leave_entity("project", shared, user_id=writer))
            access(shared_todo, writer, False)
            usage(writer, 0)
            usage(owner, 0)
            retained(attachment, owner)
            print("✅ Voluntary direct-share leave preserves the uncharged shared upload")

            for transition in ("remove", "leave"):
                owner, writer = user(f"household-{transition}-owner"), user(f"household-{transition}-writer")
                with get_db() as db:
                    household = create_household(db, f"Household {transition}", owner)
                    invitation = invite_household_member(db, household, owner, writer)
                    respond_to_household_invite(db, invitation, writer, accept=True)
                    db.commit()
                shared = project(f"Household project {transition}", owner, household=household)
                shared_todo = todo("Household attachment", owner, shared)
                attachment = upload_fixture(shared_todo, writer, b"household-upload")
                usage(writer, len(attachment["content"]))
                access(shared_todo, writer, True)
                if transition == "remove":
                    asyncio.run(households.remove_household_member_endpoint(household, writer, user_id=owner))
                else:
                    asyncio.run(households.leave_household_endpoint(household, user_id=writer))
                access(shared_todo, writer, False)
                usage(writer, 0)
                usage(owner, 0)
                retained(attachment, owner)
                with get_db() as db:
                    invitation = invite_household_member(db, household, owner, writer)
                    respond_to_household_invite(db, invitation, writer, accept=True)
                    db.commit()
                access(shared_todo, writer, True)
                usage(writer, len(attachment["content"]))
                retained(attachment, owner)
            print("✅ Household removal and leave preserve files while relieving the former member's quota")

            owner, writer = user("hierarchy-owner"), user("hierarchy-writer")
            parent = project("Shared parent", owner)
            child = project("Shared child", owner, parent=parent)
            grandchild = project("Shared grandchild", owner, parent=child)
            grant(parent, owner, writer)
            inherited_todo = todo("Inherited attachment access", owner, grandchild)
            attachment = upload_fixture(inherited_todo, writer, b"inherited-upload")
            access(inherited_todo, writer, True)
            usage(writer, len(attachment["content"]))
            grant(child, owner, writer)
            usage(writer, len(attachment["content"]))  # Two paths must not double-count.
            asyncio.run(entity_sharing.remove_entity_member("project", parent, writer, user_id=owner))
            access(inherited_todo, writer, True)
            usage(writer, len(attachment["content"]))  # The child's grant still authorizes access.
            asyncio.run(entity_sharing.leave_entity("project", child, user_id=writer))
            access(inherited_todo, writer, False)
            usage(writer, 0)
            retained(attachment, owner)
            print("✅ Inherited and alternative access paths neither duplicate nor prematurely relieve quota")

            owner, writer = user("retention-owner"), user("deleted-writer")
            shared = project("Retained shared project", owner)
            grant(shared, owner, writer)
            shared_todo = todo("Retained after account deletion", owner, shared)
            attachment = upload_fixture(shared_todo, writer, b"deleted-user-upload")
            own_attachment = upload_fixture(shared_todo, owner, b"owner-upload")
            usage(writer, len(attachment["content"]))
            asyncio.run(admin.delete_user(writer, True))
            retained(attachment, owner, uploader=None)
            retained(own_attachment, owner)
            usage(owner, len(own_attachment["content"]))
            with get_db() as db:
                assert db.execute("SELECT 1 FROM users WHERE id=?", (writer,)).fetchone() is None
                assert attachment_usage_bytes(db, writer) == 0
                assert db.execute("PRAGMA foreign_key_check").fetchall() == []
            assert not any(row["id"] == writer for row in admin.list_users(True)["users"])
            print("✅ Account deletion preserves anonymous uploads without charging another account")

            print("✅ Restored project and household access charge the original uploader again")


if __name__ == "__main__":
    main()
