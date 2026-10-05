#!/usr/bin/env python3
"""Regression tests for persistent login rate-limit isolation and pruning."""

import contextlib
import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))
TEST_DATA_DIR = tempfile.TemporaryDirectory(prefix="nia-todo-rate-limit-")
os.environ["NIA_TODO_DATA_DIR"] = TEST_DATA_DIR.name

import rate_limit as module  # noqa: E402
from rate_limit import RateLimiter  # noqa: E402

conn = sqlite3.connect(":memory:")
conn.execute(
    "CREATE TABLE login_rate_limit_attempts "
    "(id INTEGER PRIMARY KEY, bucket TEXT, bucket_key TEXT, attempted_at INTEGER)"
)


@contextlib.contextmanager
def fake_get_db():
    yield conn


module.get_db = fake_get_db


def reset():
    conn.execute("DELETE FROM login_rate_limit_attempts")
    conn.commit()
    return RateLimiter()


def test_success_cannot_clear_other_account():
    limiter = reset()
    ip = "198.51.100.10"
    for _ in range(5):
        assert limiter.check_login(ip, "victim")
        limiter.record_failed_login(ip, "victim")
    limiter.record_successful_login(ip, "attacker")
    assert not limiter.check_login(ip, "victim")


def test_global_account_backstop():
    limiter = reset()
    for index in range(25):
        ip = f"198.51.{index // 255}.{index % 255}"
        assert limiter.check_login(ip, "victim")
        limiter.record_failed_login(ip, "victim")
    assert not limiter.check_login("203.0.113.10", "victim")


def test_successes_do_not_consume_budget():
    limiter = reset()
    for _ in range(6):
        assert limiter.check_login("198.51.100.10", "user")
        limiter.record_successful_login("198.51.100.10", "user")


def test_prune_expired_removes_stale_memory_and_database_state():
    limiter = reset()
    conn.execute(
        "INSERT INTO login_rate_limit_attempts(bucket,bucket_key,attempted_at) VALUES('ip','stale',?)",
        (int(time.time()) - 3600,),
    )
    conn.commit()
    limiter.api_requests["stale"] = [time.time() - 120]
    limiter.password_reset_attempts["stale"] = [time.time() - 7200]

    limiter.prune_expired()

    assert "stale" not in limiter.api_requests
    assert "stale" not in limiter.password_reset_attempts
    assert conn.execute("SELECT COUNT(*) FROM login_rate_limit_attempts").fetchone()[0] == 0


if __name__ == "__main__":
    test_success_cannot_clear_other_account()
    test_global_account_backstop()
    test_successes_do_not_consume_budget()
    test_prune_expired_removes_stale_memory_and_database_state()
    print("✅ Login rate-limit regression tests passed")
