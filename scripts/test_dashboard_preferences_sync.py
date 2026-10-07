#!/usr/bin/env python3
"""Account-wide dashboard preference sync API regression tests."""

from __future__ import annotations

import contextlib
import asyncio
import json
import sqlite3
import sys
from pathlib import Path

from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

import routers.me as me_router  # noqa: E402



def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def make_db():
    db = sqlite3.connect(":memory:", check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        PRAGMA foreign_keys = ON;
        CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            username TEXT NOT NULL,
            dashboard_preferences_sync_enabled INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE workspaces (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL,
            is_default INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE projects (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL,
            workspace_id INTEGER
        );
        CREATE TABLE project_members (
            id INTEGER PRIMARY KEY,
            project_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            workspace_id INTEGER,
            status TEXT NOT NULL DEFAULT 'accepted'
        );
        CREATE TABLE dashboard_preferences (
            user_id INTEGER NOT NULL,
            workspace_id INTEGER NOT NULL,
            preferences_json TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (user_id, workspace_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );
        INSERT INTO users (id, username) VALUES (1, 'tobi'), (2, 'other');
        INSERT INTO workspaces (id, user_id) VALUES (10, 1), (20, 1), (30, 2);
        INSERT INTO projects (id, user_id, workspace_id) VALUES (100, 1, 10), (200, 1, 20), (300, 2, 30), (400, 2, 30);
        INSERT INTO project_members (id, project_id, user_id, workspace_id, status)
        VALUES (1, 400, 1, 10, 'accepted');
        """
    )
    db.commit()
    return db


def install_fakes(db, events):
    @contextlib.contextmanager
    def fake_get_db():
        yield db

    async def capture(event_type, payload, user_id, *_args, **_kwargs):
        events.append((event_type, payload, user_id))

    me_router.get_db = fake_get_db
    me_router.broadcast_change = capture


def preferences(project_ids=None):
    return {
        "version": 3,
        "compactDisplay": False,
        "groupByStatus": True,
        "showFocus": True,
        "showActiveProjects": True,
        "showProjectWidgets": True,
        "projectScope": {"mode": "include" if project_ids else "all", "projectIds": project_ids or []},
        "stats": ["total", "pending", "in_progress", "overdue"],
        "focusItems": ["overdue", "due_today", "due_week", "high_priority"],
        "hideEmptyFocusItems": False,
        "activeProjects": {"limit": 4, "sort": "recent"},
    }


def main():
    db = make_db()
    events = []
    install_fakes(db, events)

    initial = me_router.get_dashboard_preferences(user_id=1)
    assert_true(initial == {"enabled": False, "preferences": {}}, initial)

    enabled = asyncio.run(me_router.update_dashboard_preferences(me_router.DashboardPreferencesSyncRequest(**{
        "enabled": True,
        "preferences": {"10": preferences([100, 400]), "20": preferences([200])},
    }), user_id=1))
    assert_true(enabled["enabled"] is True, enabled)
    assert_true(set(enabled["preferences"]) == {"10", "20"}, enabled)
    assert_true(events[-1][0] == "dashboard_preferences_update", events)
    assert_true(events[-1][2] == 1, events)

    stored = db.execute("SELECT preferences_json FROM dashboard_preferences WHERE user_id = 1 AND workspace_id = 10").fetchone()
    assert_true(json.loads(stored["preferences_json"])["projectScope"]["projectIds"] == [100, 400], stored)

    try:
        asyncio.run(me_router.update_dashboard_preferences(me_router.DashboardPreferencesSyncRequest(**{
            "enabled": True,
            "preferences": {"30": preferences([300])},
        }), user_id=1))
        raise AssertionError("foreign workspace must be rejected")
    except HTTPException as exc:
        assert_true(exc.status_code == 404, exc)

    try:
        asyncio.run(me_router.update_dashboard_preferences(me_router.DashboardPreferencesSyncRequest(**{
            "enabled": True,
            "preferences": {"10": preferences([200])},
        }), user_id=1))
        raise AssertionError("project from another workspace must be rejected")
    except HTTPException as exc:
        assert_true(exc.status_code == 400, exc)

    try:
        asyncio.run(me_router.update_dashboard_preferences(me_router.DashboardPreferencesSyncRequest(**{
            "enabled": True,
            "preferences": {"10": {**preferences(), "stats": ["total", "total", "done", "overdue"]}},
        }), user_id=1))
        raise AssertionError("duplicate stats must be rejected")
    except HTTPException as exc:
        assert_true(exc.status_code == 422, exc)

    for field, invalid_values in (
        ("stats", [["nested"], "pending", "in_progress", "overdue"]),
        ("focusItems", [{"nested": True}]),
    ):
        try:
            asyncio.run(me_router.update_dashboard_preferences(me_router.DashboardPreferencesSyncRequest(**{
                "enabled": True,
                "preferences": {"10": {**preferences(), field: invalid_values}},
            }), user_id=1))
            raise AssertionError(f"unhashable {field} entries must be rejected")
        except HTTPException as exc:
            assert_true(exc.status_code == 422, exc)

    disabled = asyncio.run(me_router.update_dashboard_preferences(me_router.DashboardPreferencesSyncRequest(enabled=False), user_id=1))
    assert_true(disabled == {"enabled": False, "preferences": {}}, disabled)
    assert_true(db.execute("SELECT COUNT(*) FROM dashboard_preferences WHERE user_id = 1").fetchone()[0] == 0, "disable must delete server copies")

    print("✅ Dashboard preference sync API tests passed")


if __name__ == "__main__":
    main()
