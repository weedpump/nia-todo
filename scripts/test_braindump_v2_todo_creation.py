#!/usr/bin/env python3
"""BrainDump v2 confirmed-candidate todo creation tests."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from routers.braindump_v2 import BrainDumpTodoCandidate, _apply_learned_routes, _braindump_learning_settings, _create_todos_from_braindump_candidates, _load_braindump_workspace_context, _reset_braindump_learning  # noqa: E402


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def make_db():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, braindump_enabled INTEGER NOT NULL DEFAULT 1, braindump_learning_enabled INTEGER NOT NULL DEFAULT 1, default_reminder_offset_minutes INTEGER);
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
            recurring_rule TEXT,
            parent_id INTEGER,
            updated_at TEXT,
            user_id INTEGER
        );

        CREATE TABLE todo_subtasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            todo_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            is_done INTEGER NOT NULL DEFAULT 0,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            todo_id INTEGER NOT NULL,
            remind_at TEXT NOT NULL,
            sent_at TEXT,
            source TEXT NOT NULL DEFAULT 'explicit',
            user_id INTEGER
        );
        CREATE TABLE saved_places (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            address TEXT NOT NULL,
            icon TEXT DEFAULT 'pin',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE location_reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            todo_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            trigger_type TEXT NOT NULL,
            place_id INTEGER,
            address TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            triggered_at TEXT,
            source TEXT NOT NULL DEFAULT 'explicit',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE braindump_route_learning (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            workspace_id INTEGER,
            token TEXT NOT NULL,
            project_id INTEGER NOT NULL,
            section_id INTEGER,
            hits INTEGER NOT NULL DEFAULT 1,
            last_used_at TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );
        """
    )
    db.execute("INSERT INTO users (id, username, braindump_enabled, default_reminder_offset_minutes) VALUES (1, 'tobi', 1, NULL)")
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
    db.execute("INSERT INTO sections (id, project_id, name) VALUES (14, 2, 'Vorratschrank')")
    db.execute("INSERT INTO sections (id, project_id, name) VALUES (12, 3, 'Keller')")
    db.execute("INSERT INTO sections (id, project_id, name) VALUES (13, 5, 'Serverraum')")
    db.execute("INSERT INTO saved_places (id, user_id, name, address, icon) VALUES (1, 1, 'Zuhause', 'Johanneck 24, 85307 Paunzhausen', 'home')")
    db.execute("INSERT INTO saved_places (id, user_id, name, address, icon) VALUES (2, 1, 'Baumarkt', 'Baumarkt Freising', 'map-pin')")
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



def test_applies_default_due_reminder_when_deadline_has_no_explicit_reminder():
    db = make_db()
    db.execute("UPDATE users SET default_reminder_offset_minutes = 90 WHERE id = 1")
    created = _create_todos_from_braindump_candidates(
        db,
        1,
        [BrainDumpTodoCandidate(title="Wasserfilter bestellen", deadline="2026-06-05T09:00:00+02:00")],
    )
    todo = created[0]
    assert_true(todo["due_date"] == "2026-06-05T09:00:00+02:00", todo)
    assert_true(todo["reminders"][0]["remind_at"] == "2026-06-05T07:30:00+02:00", todo)
    assert_true(todo["reminders"][0]["source"] == "default_due", todo)


def test_creates_recurring_todo_when_deadline_present():
    db = make_db()
    created = _create_todos_from_braindump_candidates(
        db,
        1,
        [BrainDumpTodoCandidate(
            title="Rauchmelder prüfen",
            deadline="2026-06-05T09:00:00+02:00",
            recurring_rule={"frequency": "monthly", "interval": 6},
        )],
    )
    todo = created[0]
    assert_true(todo["due_date"] == "2026-06-05T09:00:00+02:00", todo)
    assert_true(todo["recurring_rule"] == {"frequency": "monthly", "interval": 6, "preserve_time": True}, todo)


def test_creates_location_reminder_from_saved_place_candidate():
    db = make_db()
    created = _create_todos_from_braindump_candidates(
        db,
        1,
        [BrainDumpTodoCandidate(
            title="Mülltonne rausstellen",
            location_reminder={"trigger_type": "arrival", "place_name": "Zuhause"},
        )],
    )
    todo = created[0]
    assert_true(todo["location_reminder"]["trigger_type"] == "arrival", todo)
    assert_true(todo["location_reminder"]["place_id"] == 1, todo)
    assert_true(todo["location_reminder"]["place_name"] == "Zuhause", todo)
    assert_true(todo["location_reminder"]["address"] == "Johanneck 24, 85307 Paunzhausen", todo)
    assert_true(todo["location_reminder"]["source"] == "braindump", todo)


def test_ignores_unknown_braindump_location_place():
    db = make_db()
    created = _create_todos_from_braindump_candidates(
        db,
        1,
        [BrainDumpTodoCandidate(title="Paket abholen", location_reminder={"trigger_type": "arrival", "place_name": "Packstation"})],
    )
    assert_true(created[0]["location_reminder"] is None, created)


def test_ignores_recurring_rule_without_deadline():
    db = make_db()
    created = _create_todos_from_braindump_candidates(
        db,
        1,
        [BrainDumpTodoCandidate(title="Filter wechseln", recurring_rule={"frequency": "monthly", "interval": 6})],
    )
    assert_true(created[0]["recurring_rule"] is None, created)

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
    assert_true([place["name"] for place in context["places"]] == ["Baumarkt", "Zuhause"], context)

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


def test_route_learning_learns_confirmed_routes_and_applies_conservatively():
    db = make_db()
    for _ in range(2):
        _create_todos_from_braindump_candidates(
            db,
            1,
            [BrainDumpTodoCandidate(title="Snoopy Futter bestellen", project_name="Einkaufsliste", section_name="Milchprodukte")],
            workspace_id=1,
        )
    settings = _braindump_learning_settings(db, 1)
    assert_true(settings["enabled"] is True, settings)
    assert_true(settings["learned_routes"] >= 2, settings)

    parsed = {"candidates": [{"title": "Snoopy Futter kaufen", "project_name": None, "section_name": None, "deadline": None, "reminder": None}]}
    routed = _apply_learned_routes(db, 1, 1, parsed)
    candidate = routed["candidates"][0]
    assert_true(candidate["project_name"] == "Einkaufsliste", candidate)
    assert_true(candidate["section_name"] == "Milchprodukte", candidate)

    other_workspace = _apply_learned_routes(db, 1, 2, parsed)
    assert_true(other_workspace["candidates"][0]["project_name"] is None, other_workspace)


def test_route_learning_can_be_disabled_and_reset():
    db = make_db()
    db.execute("UPDATE users SET braindump_learning_enabled = 0 WHERE id = 1")
    _create_todos_from_braindump_candidates(db, 1, [BrainDumpTodoCandidate(title="Snoopy Futter", project_name="Einkaufsliste")], workspace_id=1)
    assert_true(_braindump_learning_settings(db, 1)["learned_routes"] == 0, "disabled learning should not write rows")

    db.execute("UPDATE users SET braindump_learning_enabled = 1 WHERE id = 1")
    _create_todos_from_braindump_candidates(db, 1, [BrainDumpTodoCandidate(title="Snoopy Futter", project_name="Einkaufsliste")], workspace_id=1)
    assert_true(_braindump_learning_settings(db, 1)["learned_routes"] > 0, "enabled learning should write rows")
    deleted = _reset_braindump_learning(db, 1)
    assert_true(deleted > 0, deleted)
    assert_true(_braindump_learning_settings(db, 1)["learned_routes"] == 0, "reset should delete own rows")


def test_manual_preview_correction_wins_over_previous_route_learning():
    db = make_db()
    # Simulate repeated accepted LLM suggestions for Milchprodukte.
    for _ in range(3):
        _create_todos_from_braindump_candidates(
            db,
            1,
            [BrainDumpTodoCandidate(
                title="Milch",
                project_name="Einkaufsliste",
                section_name="Milchprodukte",
                original_project_name="Einkaufsliste",
                original_section_name="Milchprodukte",
                original_route_present=True,
            )],
            workspace_id=1,
        )

    before = _apply_learned_routes(db, 1, 1, {"candidates": [{"title": "Milch", "project_name": "Einkaufsliste", "section_name": "Milchprodukte"}]})
    assert_true(before["candidates"][0]["section_name"] == "Milchprodukte", before)

    # One explicit user correction in the preview should become the preferred future route.
    _create_todos_from_braindump_candidates(
        db,
        1,
        [BrainDumpTodoCandidate(
            title="Milch",
            project_name="Einkaufsliste",
            section_name="Vorratschrank",
            original_project_name="Einkaufsliste",
            original_section_name="Milchprodukte",
            original_route_present=True,
        )],
        workspace_id=1,
    )

    after = _apply_learned_routes(db, 1, 1, {"candidates": [{"title": "Milch", "project_name": "Einkaufsliste", "section_name": "Milchprodukte"}]})
    assert_true(after["candidates"][0]["section_name"] == "Vorratschrank", after)
    missing_section = _apply_learned_routes(db, 1, 1, {"candidates": [{"title": "Milch", "project_name": "Einkaufsliste", "section_name": None}]})
    assert_true(missing_section["candidates"][0]["section_name"] == "Vorratschrank", missing_section)


def main():
    tests = [
        test_creates_confirmed_candidates_with_project_section_and_reminder,
        test_applies_default_due_reminder_when_deadline_has_no_explicit_reminder,
        test_creates_recurring_todo_when_deadline_present,
        test_creates_location_reminder_from_saved_place_candidate,
        test_ignores_unknown_braindump_location_place,
        test_ignores_recurring_rule_without_deadline,
        test_project_null_uses_inbox_even_with_matching_inbox_section_name,
        test_workspace_context_filters_projects_and_routes_inbox,
        test_workspace_context_project_from_other_workspace_falls_back_to_inbox,
        test_unknown_project_name_falls_back_to_inbox,
        test_unknown_project_name_ignores_matching_inbox_section,
        test_section_outside_project_is_cleared,
        test_route_learning_learns_confirmed_routes_and_applies_conservatively,
        test_route_learning_can_be_disabled_and_reset,
        test_manual_preview_correction_wins_over_previous_route_learning,
    ]
    for test in tests:
        test()
        print(f"✅ {test.__name__}")
    print(f"\nBrainDump v2 todo creation tests passed: {len(tests)}/{len(tests)}")


if __name__ == "__main__":
    main()
