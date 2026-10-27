#!/usr/bin/env python3
import asyncio
import json
import sqlite3
import sys
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from routers import me
from routers.me import ModulePreferencesUpdate, update_module_preferences
from services.module_visibility import (
    has_enabled_registered_module,
    module_preferences_payload,
    normalize_disabled_modules,
    normalized_user_disabled_modules,
    registered_module_ids,
)


def main():
    assert normalize_disabled_modules(["recipes", "tasks", "recipes", "invalid id"]) == ["recipes", "tasks"]
    assert normalize_disabled_modules(["tasks", "shopping", "recipes", "future-module"]) == [
        "tasks",
        "shopping",
        "recipes",
        "future-module",
    ]
    assert normalize_disabled_modules([]) == []
    assert registered_module_ids() == ("tasks", "shopping", "recipes")
    assert has_enabled_registered_module(["tasks", "shopping"])
    assert not has_enabled_registered_module(["tasks", "shopping", "recipes"])
    assert normalized_user_disabled_modules(["future-module", "tasks", "shopping", "recipes"]) == [
        "future-module",
        "shopping",
        "recipes",
    ]

    payload = module_preferences_payload({
        "disabled_modules_json": json.dumps(["tasks", "recipes"]),
    })
    assert payload == {"disabled_modules": ["tasks", "recipes"]}

    fallback = module_preferences_payload({"disabled_modules_json": "not-json"})
    assert fallback == {"disabled_modules": []}

    repaired = module_preferences_payload({
        "disabled_modules_json": json.dumps(["future-module", "tasks", "shopping", "recipes"]),
    })
    assert repaired == {"disabled_modules": ["future-module", "shopping", "recipes"]}

    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, disabled_modules_json TEXT NOT NULL DEFAULT '[]')")
    db.execute("INSERT INTO users (id) VALUES (1)")
    db.commit()

    @contextmanager
    def fake_get_db():
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise

    broadcasts = []

    async def fake_broadcast_change(event, data, user_id):
        broadcasts.append((event, data, user_id))

    original_get_db = me.get_db
    original_broadcast_change = me.broadcast_change
    me.get_db = fake_get_db
    me.broadcast_change = fake_broadcast_change
    try:
        result = asyncio.run(update_module_preferences(
            ModulePreferencesUpdate(disabled_modules=["shopping", "recipes"]),
            user_id=1,
        ))
        assert result == {"disabled_modules": ["shopping", "recipes"]}
        stored = db.execute("SELECT disabled_modules_json FROM users WHERE id = 1").fetchone()[0]
        assert json.loads(stored) == ["shopping", "recipes"]
        assert broadcasts == [("module_preferences_update", result, 1)]

        try:
            asyncio.run(update_module_preferences(
                ModulePreferencesUpdate(disabled_modules=["tasks", "shopping", "recipes"]),
                user_id=1,
            ))
        except Exception as exc:
            assert getattr(exc, "status_code", None) == 422
        else:
            raise AssertionError("disabling every registered module must be rejected")
    finally:
        me.get_db = original_get_db
        me.broadcast_change = original_broadcast_change
        db.close()

    workspace_source = (ROOT / "api" / "routers" / "workspaces.py").read_text()
    assert "hidden_modules" not in workspace_source
    assert "workspace_visibility" not in workspace_source

    print("✅ Account module visibility contract passed")


if __name__ == "__main__":
    main()
