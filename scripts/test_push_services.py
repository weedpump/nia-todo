#!/usr/bin/env python3
"""Push service configuration tests."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TMP = tempfile.TemporaryDirectory()
os.environ["NIA_TODO_DATA_DIR"] = TMP.name
sys.path.insert(0, str(ROOT / "api"))

from db import get_db  # noqa: E402
from services.push import get_vapid_subject  # noqa: E402


def assert_equal(actual, expected, message):
    if actual != expected:
        raise AssertionError(f"{message}: expected {expected!r}, got {actual!r}")


def set_public_base_url(value: str):
    with get_db() as db:
        db.execute("CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)")
        db.execute(
            """INSERT INTO app_config (key, value, updated_at)
               VALUES ('public_base_url', ?, datetime('now'))
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at""",
            (value,),
        )


def test_env_vapid_subject_wins():
    os.environ["NIA_TODO_VAPID_SUBJECT"] = "mailto:push@example.com"
    set_public_base_url("https://todo.example.com/app")
    assert_equal(get_vapid_subject(), "mailto:push@example.com", "env VAPID subject should win")
    os.environ.pop("NIA_TODO_VAPID_SUBJECT", None)


def test_public_base_url_origin_is_used():
    set_public_base_url("https://todo.example.com/app")
    assert_equal(get_vapid_subject(), "https://todo.example.com", "public base URL origin should be used")


def test_http_public_base_url_is_ignored_for_vapid():
    set_public_base_url("http://todo.example.com")
    assert_equal(get_vapid_subject(), "https://localhost", "non-HTTPS public base URL should not be used")


def main():
    tests = [
        test_env_vapid_subject_wins,
        test_public_base_url_origin_is_used,
        test_http_public_base_url_is_ignored_for_vapid,
    ]
    try:
        for test in tests:
            test()
            print(f"✅ {test.__name__}")
        print(f"\nPush service tests passed: {len(tests)}/{len(tests)}")
    finally:
        TMP.cleanup()


if __name__ == "__main__":
    main()
