#!/usr/bin/env python3
"""Regression check for attachment authorization before filesystem effects."""

from pathlib import Path

content = (Path(__file__).resolve().parents[1] / "api" / "routers" / "todos.py").read_text()
auth = "todo = _require_attachment_writable_todo(db, todo_id, user_id)"
mkdir = "target_path.parent.mkdir(parents=True, exist_ok=True)"
assert content.index(auth) < content.index(mkdir)
print("✅ Attachment directory creation follows authorization")
