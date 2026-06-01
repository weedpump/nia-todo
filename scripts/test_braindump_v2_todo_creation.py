#!/usr/bin/env python3
"""BrainDump v2 confirmed-candidate todo creation tests."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from routers.braindump_v2 import BrainDumpTodoCandidate, _create_todos_from_braindump_candidates, _load_braindump_workspace_context  # noqa: E402


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def make_db():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, braindump_enabled INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE workspaces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            user_id INTEGER,
            is_default INTEGER DEFAULT 0
        );
        CREATE TABLE projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            user_id INTEGER,
            is_inbox INTEGER DEFAULT 0,
            sort_order INTEGER DEFAULT 0,
            parent_id INTEGER,
            workspace_id INTEGER
        );
        CREATE TABLE project_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            status TEXT DEFAULT 'accepted',
            workspace_id INTEGER
        );
        CREATE TABLE sections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0
        );
        CREATE TABLE todos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            priority INTEGER DEFAULT 3,
            is_pinned INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending',
            project_id INTEGER,
            section_id INTEGER,
            due_date TEXT,
            completed_at TEXT,
            updated_at TEXT,
            user_id INTEGER
        );
        CREATE TABLE reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            todo_id INTEGER NOT NULL,
            remind_at TEXT NOT NULL,
            sent_at TEXT,
            user_id INTEGER
        );
        """
    )
    db.execute("INSERT INTO users (id, username, braindump_enabled) VALUES (1, 'tobi', 1)")
    db.execute("INSERT INTO workspaces (id, name, user_id, is_default) VALUES (1, 'Privat', 1, 1)")
    db.execute("INSERT INTO workspaces (id, name, user_id, is_default) VALUES (2, 'Arbeit', 1, 0)")
    db.execute("INSERT INTO projects (id, name, user_id, is_inbox, workspace_id) VALUES (1, 'Inbox', 1, 1, 1)")
    db.execute("INSERT INTO projects (id, name, user_id, is_inbox, workspace_id) VALUES (2, 'Einkaufsliste', 1, 0, 1)")
    db.execute("INSERT INTO projects (id, name, user_id, is_inbox, workspace_id) VALUES (3, 'Haushalt', 1, 0, 1)")
    db.execute("INSERT INTO projects (id, name, user_id, is_inbox, workspace_id) VALUES (4, 'Inbox', 1, 1, 2)")
    db.execute("INSERT INTO projects (id, name, user_id, is_inbox, workspace_id) VALUES (5, 'IT', 1, 0, 2)")
    db.execute("INSERT INTO sections (id, project_id, name) VALUES (9, 1, 'Keller')")
    db.execute("INSERT INTO sections (id, project_id, name) VALUES (10, 2, 'Obst und Gemüse')")
    db.execute("INSERT INTO sections (id, project_id, name) VALUES (11, 2, 'Milchprodukte')")
    db.execute("INSERT INTO sections (id, project_id, name) VALUES (12, 3, 'Keller')")
    db.execute("INSERT INTO sections (id, project_id, name) VALUES (13, 5, 'Serverraum')")
    return db


def test_creates_confirmed_candidates_with_project_section_and_reminder():
    db = make_db()
    candidates = [
        BrainDumpTodoCandidate(title="Hafermilch", project_name="Einkaufsliste", section_name="Milchprodukte"),
        BrainDumpTodoCandidate(title="Bananen", project_name="Einkaufsliste", section_name="Obst und Gemüse"),
        BrainDumpTodoCandidate(title="Snoopy Futter geben", reminder="2026-05-30T18:00+02:00", deadline="2026-05-30T18:00+02:00"),
        BrainDumpTodoCandidate(title="Alte Kartons entsorgen", project_name="Haushalt", section_name="Keller"),
    ]
    created = _create_todos_from_braindump_candidates(db, 1, candidates)
    db.commit()
    assert_true(len(created) == 4, created)
    by_title = {todo["title"]: todo for todo in created}
    assert_true(by_title["Hafermilch"]["project_id"] == 2, by_title)
    assert_true(by_title["Hafermilch"]["section_id"] == 11, by_title)
    assert_true(by_title["Bananen"]["section_id"] == 10, by_title)
    assert_true(by_title["Alte Kartons entsorgen"]["project_id"] == 3, by_title)
    assert_true(by_title["Alte Kartons entsorgen"]["section_id"] == 12, by_title)
    snoopy = by_title["Snoopy Futter geben"]
    assert_true(snoopy["project_id"] == 1, snoopy)
    assert_true(snoopy["due_date"] == "2026-05-30T18:00+02:00", snoopy)
    assert_true(snoopy["reminders"][0]["remind_at"] == "2026-05-30T18:00+02:00", snoopy)


def test_project_null_uses_inbox_even_with_matching_inbox_section_name():
    db = make_db()
    created = _create_todos_from_braindump_candidates(
        db,
        1,
        [BrainDumpTodoCandidate(title="Alte Kartons entsorgen", section_name="Keller")],
    )
    assert_true(created[0]["project_id"] == 1, created)
    assert_true(created[0]["section_id"] is None, created)


def test_workspace_context_filters_projects_and_routes_inbox():
    db = make_db()
    context = _load_braindump_workspace_context(db, 1, workspace_id=2)
    project_names = [project["name"] for project in context["projects"]]
    assert_true(context["workspace_name"] == "Arbeit", context)
    assert_true(project_names == ["Inbox", "IT"], project_names)
    assert_true(context["projects"][1]["sections"] == ["Serverraum"], context)

    created = _create_todos_from_braindump_candidates(
        db,
        1,
        [BrainDumpTodoCandidate(title="Backup prüfen"), BrainDumpTodoCandidate(title="Rack aufräumen", project_name="IT", section_name="Serverraum")],
        workspace_id=2,
    )
    by_title = {todo["title"]: todo for todo in created}
    assert_true(by_title["Backup prüfen"]["project_id"] == 4, by_title)
    assert_true(by_title["Rack aufräumen"]["project_id"] == 5, by_title)
    assert_true(by_title["Rack aufräumen"]["section_id"] == 13, by_title)


def test_workspace_context_project_from_other_workspace_falls_back_to_inbox():
    db = make_db()
    created = _create_todos_from_braindump_candidates(db, 1, [BrainDumpTodoCandidate(title="X", project_name="Einkaufsliste")], workspace_id=2)
    assert_true(created[0]["project_id"] == 4, created)
    assert_true(created[0]["section_id"] is None, created)


def test_unknown_project_name_falls_back_to_inbox():
    db = make_db()
    created = _create_todos_from_braindump_candidates(db, 1, [BrainDumpTodoCandidate(title="X", project_name="Gibt es nicht")])
    assert_true(created[0]["project_id"] == 1, created)
    assert_true(created[0]["section_id"] is None, created)


def test_unknown_project_name_ignores_matching_inbox_section():
    db = make_db()
    created = _create_todos_from_braindump_candidates(db, 1, [BrainDumpTodoCandidate(title="X", project_name="Gibt es nicht", section_name="Keller")])
    assert_true(created[0]["project_id"] == 1, created)
    assert_true(created[0]["section_id"] is None, created)


def test_section_outside_project_is_cleared():
    db = make_db()
    created = _create_todos_from_braindump_candidates(db, 1, [BrainDumpTodoCandidate(title="X", project_name="Einkaufsliste", section_name="Keller")])
    assert_true(created[0]["project_id"] == 2, created)
    assert_true(created[0]["section_id"] is None, created)


def main():
    tests = [
        test_creates_confirmed_candidates_with_project_section_and_reminder,
        test_project_null_uses_inbox_even_with_matching_inbox_section_name,
        test_workspace_context_filters_projects_and_routes_inbox,
        test_workspace_context_project_from_other_workspace_falls_back_to_inbox,
        test_unknown_project_name_falls_back_to_inbox,
        test_unknown_project_name_ignores_matching_inbox_section,
        test_section_outside_project_is_cleared,
    ]
    for test in tests:
        test()
        print(f"✅ {test.__name__}")
    print(f"\nBrainDump v2 todo creation tests passed: {len(tests)}/{len(tests)}")


if __name__ == "__main__":
    main()
