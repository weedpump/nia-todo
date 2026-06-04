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
            address TEXT DEFAULT '',
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            radius_m INTEGER NOT NULL DEFAULT 150,
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
            label TEXT DEFAULT '',
            address TEXT DEFAULT '',
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            radius_m INTEGER NOT NULL DEFAULT 150,
            enabled INTEGER NOT NULL DEFAULT 1,
            triggered_at TEXT,
            source TEXT NOT NULL DEFAULT 'explicit',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        """
    )
    db.execute("INSERT INTO users (id, username) VALUES (1, 'tobi')")
    db.execute("INSERT INTO projects (id, name, user_id, is_inbox) VALUES (1, 'Inbox', 1, 1)")
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
    return TestClient(app)


def main():
    db = make_db()
    client = make_client(db)

    place_response = client.post("/api/places", json={
        "name": "Zuhause",
        "address": "Johanneck 24",
        "latitude": 48.42,
        "longitude": 11.55,
        "radius_m": 120,
        "icon": "home",
    })
    assert_true(place_response.status_code == 200, place_response.text)
    place = place_response.json()
    assert_true(place["name"] == "Zuhause", place)

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
    assert_true(todo["location_reminder"]["latitude"] == 48.42, todo)
    assert_true(todo["location_reminder"]["radius_m"] == 120, todo)

    # Updating a saved place must not silently move already-created reminders.
    moved_place = client.patch(f"/api/places/{place['id']}", json={"latitude": 49.0, "longitude": 12.0, "radius_m": 300})
    assert_true(moved_place.status_code == 200, moved_place.text)
    fetched = client.get(f"/api/todos/{todo['id']}").json()
    assert_true(fetched["location_reminder"]["latitude"] == 48.42, fetched)
    assert_true(fetched["location_reminder"]["radius_m"] == 120, fetched)

    removed = client.patch(f"/api/todos/{todo['id']}", json={"location_reminder": None})
    assert_true(removed.status_code == 200, removed.text)
    assert_true(removed.json()["location_reminder"] is None, removed.json())

    print("✅ Location reminder backend tests passed")


if __name__ == "__main__":
    main()
