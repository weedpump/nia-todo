#!/usr/bin/env python3
"""Behavioral checks for avatar upload/delete profile notifications."""
import asyncio
import io
import sqlite3
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from starlette.requests import Request

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / "api"))

from routers import me


def request_with_body(body: bytes, content_type: str) -> Request:
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.request", "body": b"", "more_body": False}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request({
        "type": "http",
        "method": "PUT",
        "path": "/api/me/avatar",
        "headers": [(b"content-type", content_type.encode())],
    }, receive)


def create_db(path: Path):
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, avatar_url TEXT, avatar_updated_at TEXT)")
    db.execute("INSERT INTO users (id) VALUES (1)")
    db.commit()
    db.close()


async def main():
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        db_path = root / "test.db"
        avatar_dir = root / "avatars"
        create_db(db_path)

        @contextmanager
        def get_test_db():
            db = sqlite3.connect(db_path)
            db.row_factory = sqlite3.Row
            try:
                yield db
            finally:
                db.close()

        events = []

        async def record_event(event_type, payload, user_id, *args, **kwargs):
            events.append((event_type, payload, user_id))

        image = Image.new("RGB", (32, 24), "#6366f1")
        body = io.BytesIO()
        image.save(body, "PNG")

        with patch.object(me, "get_db", get_test_db), patch.object(me, "AVATAR_DIR", avatar_dir), patch.object(me, "broadcast_change", record_event):
            uploaded = await me.upload_own_avatar(request_with_body(body.getvalue(), "image/png"), user_id=1)
            assert uploaded["avatar_url"] == "/api/avatars/user-1.webp"
            assert uploaded["avatar_updated_at"]
            assert events == [("avatar_update", uploaded, 1)]

            deleted = await me.delete_own_avatar(user_id=1)
            assert deleted == {"avatar_url": None, "avatar_updated_at": None}
            assert events[-1] == ("avatar_update", deleted, 1)

    print("✅ Avatar upload/delete emit user-scoped realtime updates")


if __name__ == "__main__":
    asyncio.run(main())
