#!/usr/bin/env python3
import json
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from routers.workspaces import (
    WorkspaceCreate,
    WorkspaceUpdate,
    create_workspace,
    list_workspaces,
    normalize_hidden_modules,
    update_workspace,
    workspace_payload,
)
from services.workspace_visibility import has_visible_registered_module, normalized_workspace_hidden_modules, registered_module_ids


def main():
    assert normalize_hidden_modules(["recipes", "tasks", "recipes", "invalid id"]) == ["recipes", "tasks"]
    assert normalize_hidden_modules(["tasks", "shopping", "recipes", "future-module"]) == ["tasks", "shopping", "recipes", "future-module"]
    assert normalize_hidden_modules([]) == []
    assert registered_module_ids() == ("tasks", "shopping", "recipes")
    assert has_visible_registered_module(["tasks", "shopping"])
    assert not has_visible_registered_module(["tasks", "shopping", "recipes"])
    assert normalized_workspace_hidden_modules(["future-module", "tasks", "shopping", "recipes"]) == ["future-module", "shopping", "recipes"]

    payload = workspace_payload({
        "id": 7,
        "name": "Home",
        "hidden_modules_json": json.dumps(["tasks", "recipes"]),
    })
    assert payload["hidden_modules"] == ["tasks", "recipes"]
    assert "hidden_modules_json" not in payload

    fallback = workspace_payload({"id": 8, "name": "Work", "hidden_modules_json": "not-json"})
    assert fallback["hidden_modules"] == []
    repaired = workspace_payload({
        "id": 9,
        "name": "Future",
        "hidden_modules_json": json.dumps(["future-module", "tasks", "shopping", "recipes"]),
    })
    assert repaired["hidden_modules"] == ["future-module", "shopping", "recipes"]
    websocket_source = (ROOT / "api" / "routers" / "websocket.py").read_text()
    assert '"workspaces": [workspace_payload(r) for r in workspaces_rows]' in websocket_source

    if os.environ.get("NIA_TEST_WORKSPACE_VISIBILITY_INTEGRATION") == "1":
        from db import get_db
        from migrate import run_migrations

        run_migrations()
        with get_db() as db:
            db.execute("INSERT INTO users (id, username) VALUES (1, 'visibility-test')")
        registered_modules = ["tasks", "shopping", "recipes"]
        try:
            asyncio.run(create_workspace(WorkspaceCreate(name="Invalid", hidden_modules=registered_modules), user_id=1))
        except Exception as exc:
            assert getattr(exc, "status_code", None) == 422
        else:
            raise AssertionError("hiding every registered module must be rejected")
        created = asyncio.run(create_workspace(WorkspaceCreate(name="Home", hidden_modules=["tasks"]), user_id=1))
        assert created["hidden_modules"] == ["tasks"]
        updated = asyncio.run(update_workspace(created["id"], WorkspaceUpdate(hidden_modules=["shopping", "recipes"]), user_id=1))
        assert updated["hidden_modules"] == ["shopping", "recipes"]
        listed = list_workspaces(user_id=1)
        home = next(workspace for workspace in listed["workspaces"] if workspace["id"] == created["id"])
        assert home["hidden_modules"] == ["shopping", "recipes"]

    print("✅ Workspace module visibility normalization passed")


if __name__ == "__main__":
    main()
