#!/usr/bin/env python3
"""Todo projects can become household-owned without changing their contents."""

import asyncio
import os
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory() as tmp:
    os.environ["NIA_TODO_DATA_DIR"] = tmp
    sys.path.insert(0, str(ROOT / "api"))

    from fastapi import HTTPException

    from db import get_db
    from migrate import run_migrations
    from routers.admin import delete_user
    import routers.projects as projects_router
    from routers.projects import (
        ProjectCreate,
        ProjectHouseholdTransfer,
        ProjectUpdate,
        create_project,
        delete_project,
        list_projects,
        transfer_project_to_household_endpoint,
        update_project,
    )
    from routers.sections import SectionCreate, SectionUpdate, create_section, update_section
    from routers.todos import TodoCreate, create_todo
    from services.entity_access import (
        create_household,
        grant_entity_access,
        invite_household_member,
        respond_to_household_invite,
    )
    from services.sharing import can_access_project, can_edit_project, can_manage_todos

    run_migrations()

    with get_db() as db:
        owner_id = db.execute("INSERT INTO users (username) VALUES ('owner')").lastrowid
        member_id = db.execute("INSERT INTO users (username) VALUES ('member')").lastrowid
        personal_user_id = db.execute("INSERT INTO users (username) VALUES ('personal-user')").lastrowid
        outsider_id = db.execute("INSERT INTO users (username) VALUES ('outsider')").lastrowid
        household_id = create_household(db, "Home", owner_id)
        invite_id = invite_household_member(db, household_id, owner_id, member_id)
        respond_to_household_invite(db, invite_id, member_id, accept=True)
        db.commit()

    personal = asyncio.run(create_project(ProjectCreate(name="Personal project"), owner_id))
    project_id = personal["id"]
    assert personal["ownership_type"] == "user", personal

    with get_db() as db:
        default_workspace_id = db.execute(
            "SELECT id FROM workspaces WHERE user_id = ? AND is_default = 1",
            (owner_id,),
        ).fetchone()["id"]
        special_workspace_id = db.execute(
            """INSERT INTO workspaces (name, color, icon, sort_order, user_id, is_default, updated_at)
               VALUES ('Work', '#6366f1', 'briefcase', 1, ?, 0, datetime('now'))""",
            (owner_id,),
        ).lastrowid
        db.commit()
    household_in_special_workspace = asyncio.run(
        create_project(
            ProjectCreate(
                name="Household default workspace",
                household_id=household_id,
                workspace_id=special_workspace_id,
            ),
            owner_id,
        )
    )
    with get_db() as db:
        stored_workspace_id = db.execute(
            "SELECT workspace_id FROM projects WHERE id = ?",
            (household_in_special_workspace["id"],),
        ).fetchone()["workspace_id"]
    assert stored_workspace_id == default_workspace_id, stored_workspace_id
    assert household_in_special_workspace["workspace_id"] == default_workspace_id, household_in_special_workspace

    personal_in_special_workspace = asyncio.run(
        create_project(
            ProjectCreate(name="Personal work project", workspace_id=special_workspace_id),
            owner_id,
        )
    )
    personal_child_in_special_workspace = asyncio.run(
        create_project(
            ProjectCreate(
                name="Personal work child",
                parent_id=personal_in_special_workspace["id"],
                workspace_id=special_workspace_id,
            ),
            owner_id,
        )
    )
    special_workspace_transfer = asyncio.run(
        transfer_project_to_household_endpoint(
            personal_in_special_workspace["id"],
            ProjectHouseholdTransfer(household_id=household_id),
            owner_id,
        )
    )
    transferred_views = special_workspace_transfer.get("transferred_projects", [])
    assert {project["id"] for project in transferred_views} == {
        personal_in_special_workspace["id"],
        personal_child_in_special_workspace["id"],
    }, special_workspace_transfer
    assert all(project["ownership_type"] == "household" for project in transferred_views), transferred_views
    assert all(project["workspace_id"] == default_workspace_id for project in transferred_views), transferred_views
    with get_db() as db:
        transferred_workspace_id = db.execute(
            "SELECT workspace_id FROM projects WHERE id = ?",
            (personal_in_special_workspace["id"],),
        ).fetchone()["workspace_id"]
    assert transferred_workspace_id == default_workspace_id, transferred_workspace_id

    transferred = asyncio.run(
        transfer_project_to_household_endpoint(
            project_id,
            ProjectHouseholdTransfer(household_id=household_id),
            owner_id,
        )
    )
    assert transferred["ownership_type"] == "household", transferred
    assert transferred["owner_household_id"] == household_id, transferred

    personal_parent = asyncio.run(create_project(ProjectCreate(name="Personal parent"), owner_id))
    personal_child = asyncio.run(
        create_project(ProjectCreate(name="Personal child", parent_id=personal_parent["id"]), owner_id)
    )
    with get_db() as db:
        grant_entity_access(db, "project", personal_parent["id"], owner_id, outsider_id)
        db.commit()
        assert can_access_project(db, personal_child["id"], outsider_id)
    transferred_child = asyncio.run(
        transfer_project_to_household_endpoint(
            personal_child["id"],
            ProjectHouseholdTransfer(household_id=household_id),
            owner_id,
        )
    )
    assert transferred_child["parent_id"] is None, transferred_child
    with get_db() as db:
        assert not can_access_project(db, personal_child["id"], outsider_id)
        assert can_access_project(db, personal_parent["id"], outsider_id)

    transfer_race_root = asyncio.run(create_project(ProjectCreate(name="Transfer race root"), owner_id))
    with get_db() as db:
        db.execute("DELETE FROM workspaces WHERE user_id = ?", (owner_id,))
        db.commit()
        assert db.execute("SELECT 1 FROM workspaces WHERE user_id = ?", (owner_id,)).fetchone() is None
    transfer_enumerated = threading.Event()
    continue_transfer = threading.Event()
    transfer_errors = []
    child_create_errors = []
    original_participant_lookup = projects_router.get_project_participant_user_ids

    def pause_after_subtree_enumeration(db, target_id):
        participants = original_participant_lookup(db, target_id)
        if target_id == transfer_race_root["id"] and not transfer_enumerated.is_set():
            transfer_enumerated.set()
            assert continue_transfer.wait(timeout=5)
        return participants

    def run_transfer():
        try:
            asyncio.run(
                transfer_project_to_household_endpoint(
                    transfer_race_root["id"],
                    ProjectHouseholdTransfer(household_id=household_id),
                    owner_id,
                )
            )
        except Exception as error:
            transfer_errors.append(error)

    def create_concurrent_child():
        try:
            asyncio.run(
                create_project(
                    ProjectCreate(name="Concurrent personal child", parent_id=transfer_race_root["id"]),
                    owner_id,
                )
            )
        except Exception as error:
            child_create_errors.append(error)

    projects_router.get_project_participant_user_ids = pause_after_subtree_enumeration
    transfer_thread = threading.Thread(target=run_transfer)
    child_thread = threading.Thread(target=create_concurrent_child)
    try:
        transfer_thread.start()
        assert transfer_enumerated.wait(timeout=5), "household transfer did not reach serialized enumeration"
        child_thread.start()
        child_thread.join(timeout=0.1)
        assert child_thread.is_alive(), "concurrent child creation bypassed the transfer writer lock"
        continue_transfer.set()
        transfer_thread.join(timeout=5)
        child_thread.join(timeout=5)
    finally:
        continue_transfer.set()
        projects_router.get_project_participant_user_ids = original_participant_lookup
    assert not transfer_thread.is_alive() and not child_thread.is_alive()
    assert not transfer_errors, transfer_errors
    assert child_create_errors, "concurrent personal child unexpectedly committed"
    with get_db() as db:
        assert not db.execute(
            "SELECT 1 FROM projects WHERE name = 'Concurrent personal child'"
        ).fetchone()

    delete_race_root = asyncio.run(
        create_project(ProjectCreate(name="Delete race root", household_id=household_id), member_id)
    )
    delete_enumerated = threading.Event()
    continue_delete = threading.Event()
    delete_errors = []
    delete_child_errors = []
    original_participant_lookup = projects_router.get_project_participant_user_ids

    def pause_after_delete_enumeration(db, target_id):
        participants = original_participant_lookup(db, target_id)
        if (
            threading.current_thread().name == "project-subtree-delete"
            and target_id == delete_race_root["id"]
            and not delete_enumerated.is_set()
        ):
            delete_enumerated.set()
            assert continue_delete.wait(timeout=5)
        return participants

    def run_delete():
        try:
            asyncio.run(delete_project(delete_race_root["id"], owner_id))
        except Exception as error:
            delete_errors.append(error)

    def create_child_during_delete():
        try:
            asyncio.run(
                create_project(
                    ProjectCreate(
                        name="Concurrent household child",
                        parent_id=delete_race_root["id"],
                        household_id=household_id,
                    ),
                    member_id,
                )
            )
        except Exception as error:
            delete_child_errors.append(error)

    projects_router.get_project_participant_user_ids = pause_after_delete_enumeration
    delete_thread = threading.Thread(target=run_delete, name="project-subtree-delete")
    delete_child_thread = threading.Thread(target=create_child_during_delete)
    try:
        delete_thread.start()
        assert delete_enumerated.wait(timeout=5), "project delete did not reach serialized enumeration"
        delete_child_thread.start()
        delete_child_thread.join(timeout=0.1)
        assert delete_child_thread.is_alive(), "concurrent child creation bypassed the delete writer lock"
        continue_delete.set()
        delete_thread.join(timeout=5)
        delete_child_thread.join(timeout=5)
    finally:
        continue_delete.set()
        projects_router.get_project_participant_user_ids = original_participant_lookup
    assert not delete_thread.is_alive() and not delete_child_thread.is_alive()
    assert not delete_errors, delete_errors
    assert delete_child_errors, "concurrent household child unexpectedly committed"
    with get_db() as db:
        assert not db.execute("SELECT 1 FROM projects WHERE id = ?", (delete_race_root["id"],)).fetchone()
        assert not db.execute(
            "SELECT 1 FROM projects WHERE name = 'Concurrent household child'"
        ).fetchone()
        assert not db.execute(
            "SELECT 1 FROM entity_access WHERE entity_type = 'project' AND entity_id = ?",
            (delete_race_root["id"],),
        ).fetchone()

    with get_db() as db:
        assert can_access_project(db, project_id, member_id)
        assert can_manage_todos(db, project_id, member_id)
        assert not can_edit_project(db, project_id, member_id)
        assert can_edit_project(db, project_id, owner_id)

    member_projects = list_projects(member_id)["projects"]
    member_view = next(project for project in member_projects if project["id"] == project_id)
    assert member_view["ownership_type"] == "household", member_view
    assert member_view["is_shared"] == 1 and member_view["is_owner"] == 0, member_view

    owner_projects = list_projects(owner_id)["projects"]
    owner_view = next(project for project in owner_projects if project["id"] == project_id)
    assert owner_view["is_owner"] == 1, owner_view

    try:
        asyncio.run(update_project(project_id, ProjectUpdate(name="Member rename"), member_id))
    except HTTPException as error:
        assert error.status_code == 403, error
    else:
        raise AssertionError("ordinary household member changed project metadata")

    renamed = asyncio.run(update_project(project_id, ProjectUpdate(name="Household project"), owner_id))
    assert renamed["name"] == "Household project", renamed

    created_for_household = asyncio.run(
        create_project(
            ProjectCreate(name="Member-created", household_id=household_id),
            member_id,
        )
    )
    assert created_for_household["ownership_type"] == "household", created_for_household
    assert created_for_household["owner_household_id"] == household_id, created_for_household

    household_section = asyncio.run(
        create_section(created_for_household["id"], SectionCreate(name="Member section"), member_id)
    )
    renamed_section = asyncio.run(
        update_section(household_section["id"], SectionUpdate(name="Shared section"), owner_id)
    )
    assert renamed_section["name"] == "Shared section", renamed_section
    household_todo = asyncio.run(
        create_todo(TodoCreate(title="Persistent household content", project_id=created_for_household["id"]), member_id)
    )
    asyncio.run(delete_user(member_id, True))
    with get_db() as db:
        assert db.execute("SELECT 1 FROM users WHERE id = ?", (member_id,)).fetchone() is None
        assert db.execute("SELECT 1 FROM projects WHERE id = ?", (created_for_household["id"],)).fetchone()
        assert db.execute("SELECT 1 FROM sections WHERE id = ?", (household_section["id"],)).fetchone()
        assert db.execute("SELECT 1 FROM todos WHERE id = ?", (household_todo["id"],)).fetchone()
        assert can_access_project(db, created_for_household["id"], owner_id)

    personal_only = asyncio.run(create_project(ProjectCreate(name="Disposable personal project"), personal_user_id))
    personal_todo = asyncio.run(
        create_todo(TodoCreate(title="Disposable attachment metadata", project_id=personal_only["id"]), personal_user_id)
    )
    with get_db() as db:
        db.execute(
            """INSERT INTO todo_attachments
               (todo_id, user_id, original_filename, stored_filename, content_type, size_bytes)
               VALUES (?, ?, 'missing.txt', 'missing.txt', 'text/plain', 7)""",
            (personal_todo["id"], personal_user_id),
        )
        db.commit()
    asyncio.run(delete_user(personal_user_id, True))
    with get_db() as db:
        assert db.execute("SELECT 1 FROM users WHERE id = ?", (personal_user_id,)).fetchone() is None
        assert db.execute("SELECT 1 FROM projects WHERE id = ?", (personal_only["id"],)).fetchone() is None

    try:
        asyncio.run(delete_user(owner_id, True))
    except HTTPException as error:
        assert error.status_code == 409, error
    else:
        raise AssertionError("household owner was deleted without ownership transfer")

print("✅ Todo projects support household ownership and inherited content access")
