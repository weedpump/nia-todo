#!/usr/bin/env python3
"""Location reminder backend regression tests."""

from __future__ import annotations

import contextlib
import sqlite3
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

import routers.places as places_router  # noqa: E402
import routers.todos as todos_router  # noqa: E402
from routers.auth import require_auth  # noqa: E402


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def make_db():
    db = sqlite3.connect(":memory:", check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL);
        CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, user_id INTEGER, is_inbox INTEGER DEFAULT 0);
        CREATE TABLE project_members (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, user_id INTEGER NOT NULL, status TEXT DEFAULT 'accepted');
        CREATE TABLE sections (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL);
        CREATE TABLE todos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            priority INTEGER DEFAULT 3,
            is_pinned INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending',
            due_date TEXT,
            completed_at TEXT,
            project_id INTEGER,
            section_id INTEGER,
            sort_order REAL DEFAULT 0,
            recurring_rule TEXT,
            parent_id INTEGER,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
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
            created_at TEXT DEFAULT (datetime('now')),
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
        CREATE UNIQUE INDEX idx_saved_places_user_name ON saved_places(user_id, lower(name));
        CREATE TABLE location_reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            todo_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            trigger_type TEXT NOT NULL CHECK(trigger_type IN ('arrival', 'departure')),
            place_id INTEGER,
            address TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            triggered_at TEXT,
            source TEXT NOT NULL DEFAULT 'explicit',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        """
    )
    db.execute("INSERT INTO users (id, username) VALUES (1, 'tobi')")
    db.execute("INSERT INTO users (id, username) VALUES (2, 'moni')")
    db.execute("INSERT INTO projects (id, name, user_id, is_inbox) VALUES (1, 'Inbox', 1, 1)")
    db.execute("INSERT INTO project_members (project_id, user_id, status) VALUES (1, 2, 'accepted')")
    db.commit()
    return db


async def noop_broadcast(*_args, **_kwargs):
    return None


def make_client(db):
    app = FastAPI()
    app.include_router(todos_router.router)
    app.include_router(places_router.router)
    app.dependency_overrides[require_auth] = lambda: 1

    @contextlib.contextmanager
    def fake_get_db():
        yield db

    todos_router.get_db = fake_get_db
    places_router.get_db = fake_get_db
    todos_router.broadcast_change = noop_broadcast
    places_router.broadcast_change = noop_broadcast
    return TestClient(app)


def main():
    db = make_db()
    client = make_client(db)

    place_response = client.post("/api/places", json={
        "name": "Zuhause",
        "address": "Johanneck 24",
        "icon": "home",
    })
    assert_true(place_response.status_code == 200, place_response.text)
    place = place_response.json()
    assert_true(place["name"] == "Zuhause", place)
    assert_true(place["address"] == "Johanneck 24", place)
    assert_true("latitude" not in place and "longitude" not in place and "radius_m" not in place, place)

    empty_place = client.post("/api/places", json={"name": "Leer", "address": ""})
    assert_true(empty_place.status_code == 422, empty_place.text)

    todo_response = client.post("/api/todos", json={
        "title": "Müll rausstellen",
        "project_id": 1,
        "location_reminder": {
            "trigger_type": "arrival",
            "place_id": place["id"],
        },
    })
    assert_true(todo_response.status_code == 200, todo_response.text)
    todo = todo_response.json()
    assert_true(todo["location_reminder"]["trigger_type"] == "arrival", todo)
    assert_true(todo["location_reminder"]["place_id"] == place["id"], todo)
    assert_true(todo["location_reminder"]["address"] == "Johanneck 24", todo)
    assert_true("latitude" not in todo["location_reminder"], todo)
    assert_true("longitude" not in todo["location_reminder"], todo)
    assert_true("radius_m" not in todo["location_reminder"], todo)

    forbidden_coordinate_response = client.post("/api/todos", json={
        "title": "Koordinaten dürfen nicht rein",
        "project_id": 1,
        "location_reminder": {
            "trigger_type": "arrival",
            "address": "Johanneck 24",
            "latitude": 48.0,
            "longitude": 11.0,
            "radiusM": 150,
        },
    })
    assert_true(forbidden_coordinate_response.status_code == 422, forbidden_coordinate_response.text)
    assert_true("coordinates or radius" in forbidden_coordinate_response.text, forbidden_coordinate_response.text)

    free_address_response = client.post("/api/todos", json={
        "title": "Beim Baumarkt Schrauben kaufen",
        "project_id": 1,
        "location_reminder": {
            "trigger_type": "departure",
            "address": "Baumarkt Freising",
        },
    })
    assert_true(free_address_response.status_code == 200, free_address_response.text)
    free_address_todo = free_address_response.json()
    assert_true(free_address_todo["location_reminder"]["address"] == "Baumarkt Freising", free_address_todo)
    assert_true("latitude" not in free_address_todo["location_reminder"], free_address_todo)

    # Updating a saved place must move linked reminders so Android geofences use the new place,
    # but the user-scoped reminder payload must not be broadcast to shared-project members.
    place_update_broadcasts = []

    async def capture_place_update_broadcast(*args, **kwargs):
        place_update_broadcasts.append((args, kwargs))

    places_router.broadcast_change = capture_place_update_broadcast
    moved_place = client.patch(f"/api/places/{place['id']}", json={"address": "Neue Adresse"})
    places_router.broadcast_change = noop_broadcast
    assert_true(moved_place.status_code == 200, moved_place.text)
    fetched = client.get(f"/api/todos/{todo['id']}").json()
    assert_true(fetched["location_reminder"]["address"] == "Neue Adresse", fetched)
    assert_true(fetched["location_reminder"]["place_id"] == place["id"], fetched)
    assert_true(len(place_update_broadcasts) == 1, place_update_broadcasts)
    broadcast_args, broadcast_kwargs = place_update_broadcasts[0]
    assert_true(broadcast_args[0] == "todo_update", place_update_broadcasts)
    assert_true(broadcast_args[2] == 1, place_update_broadcasts)
    assert_true(len(broadcast_args) == 3 and "project_id" not in broadcast_kwargs, place_update_broadcasts)

    before_location_patch_updated_at = free_address_todo["updated_at"]
    forbidden_radius_patch = client.patch(f"/api/todos/{free_address_todo['id']}", json={
        "location_reminder": {
            "trigger_type": "arrival",
            "address": "Johanneck 24",
            "radius_m": 150,
        },
    })
    assert_true(forbidden_radius_patch.status_code == 422, forbidden_radius_patch.text)

    patched_location = client.patch(f"/api/todos/{free_address_todo['id']}", json={
        "location_reminder": {
            "trigger_type": "arrival",
            "address": "Johanneck 24",
        },
    })
    assert_true(patched_location.status_code == 200, patched_location.text)
    patched_todo = patched_location.json()
    assert_true(patched_todo["location_reminder"]["address"] == "Johanneck 24", patched_todo)
    assert_true(patched_todo["updated_at"] != before_location_patch_updated_at, patched_todo)
    fetched_after_patch = client.get(f"/api/todos/{free_address_todo['id']}").json()
    assert_true(fetched_after_patch["location_reminder"]["address"] == "Johanneck 24", fetched_after_patch)
    listed_after_patch = client.get("/api/todos").json()["todos"]
    listed_todo = next(item for item in listed_after_patch if item["id"] == free_address_todo["id"])
    assert_true(listed_todo["location_reminder"]["address"] == "Johanneck 24", listed_todo)

    removed = client.patch(f"/api/todos/{todo['id']}", json={"location_reminder": None})
    assert_true(removed.status_code == 200, removed.text)
    assert_true(removed.json()["location_reminder"] is None, removed.json())

    print("✅ Location reminder backend tests passed")


if __name__ == "__main__":
    main()
