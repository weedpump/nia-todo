#!/usr/bin/env python3
"""Instance config service tests."""

from __future__ import annotations

import sys
import json
import sqlite3
import tempfile
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from services import instance_config  # noqa: E402
from services.instance_config import _max_native_client_version  # noqa: E402


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def test_source_floor_wins_over_older_db_value():
    assert_true(_max_native_client_version("2.4.0", "2.8.0") == "2.8.0", "source floor should win")


def test_higher_configured_value_still_wins():
    assert_true(_max_native_client_version("2.9.0", "2.8.0") == "2.9.0", "higher configured value should win")


def test_empty_config_uses_source_floor():
    assert_true(_max_native_client_version("", "2.8.0") == "2.8.0", "empty config should use source floor")


@contextmanager
def temporary_config_db():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "config.db"
        conn = sqlite3.connect(path)
        conn.executescript((ROOT / "api/migrations/019_add_instance_config.sql").read_text(encoding="utf-8"))
        conn.executescript((ROOT / "api/migrations/053_add_update_analytics_config.sql").read_text(encoding="utf-8"))
        conn.close()

        @contextmanager
        def db_factory():
            db = sqlite3.connect(path)
            db.row_factory = sqlite3.Row
            try:
                yield db
                db.commit()
            finally:
                db.close()

        with patch.object(instance_config, "get_db", db_factory):
            yield db_factory


def test_update_analytics_defaults_enabled_and_is_returned():
    with temporary_config_db():
        config = instance_config.get_instance_config()
    assert_true(config["update_analytics_enabled"] is True, "update analytics should default enabled")


def test_update_analytics_update_is_persisted_and_audited():
    with temporary_config_db() as db_factory:
        config = instance_config.update_instance_config(
            public_base_url="",
            allowed_origins=[],
            trusted_proxies=[],
            update_analytics_enabled=False,
            client_ip="198.51.100.10",
        )
        with db_factory() as db:
            stored = db.execute("SELECT value FROM app_config WHERE key = 'update_analytics_enabled'").fetchone()[0]
            audit = db.execute("SELECT changed_keys FROM app_config_audit ORDER BY id DESC LIMIT 1").fetchone()[0]
    assert_true(config["update_analytics_enabled"] is False, "updated config should return disabled")
    assert_true(stored == "false", "disabled setting should persist as false")
    assert_true("update_analytics_enabled" in json.loads(audit), "audit should include changed key")


def test_omitted_update_analytics_setting_preserves_existing_opt_out():
    with temporary_config_db() as db_factory:
        instance_config.update_instance_config(
            public_base_url="",
            allowed_origins=[],
            trusted_proxies=[],
            update_analytics_enabled=False,
        )
        config = instance_config.update_instance_config(
            public_base_url="https://todo.example.org",
            allowed_origins=[],
            trusted_proxies=[],
            update_analytics_enabled=None,
        )
        with db_factory() as db:
            stored = db.execute("SELECT value FROM app_config WHERE key = 'update_analytics_enabled'").fetchone()[0]
    assert_true(config["update_analytics_enabled"] is False, "omitted analytics field should retain opt-out")
    assert_true(stored == "false", "omitted analytics field must not rewrite stored opt-out")


def test_update_analytics_read_failure_fails_closed():
    with patch.object(instance_config, "get_db", side_effect=RuntimeError("database unavailable")):
        enabled = instance_config.get_update_analytics_enabled()
    assert_true(enabled is False, "analytics must stay disabled when its persisted state cannot be read")


def test_ipv4_mapped_peer_matches_ipv4_trusted_proxy():
    with patch.object(instance_config, "get_trusted_proxies", return_value=["10.100.10.12/32"]):
        trusted = instance_config.is_trusted_proxy("::ffff:10.100.10.12")
        forwarded = instance_config.forwarded_client_ip("::ffff:10.100.10.12", "198.51.100.42")
    assert_true(trusted, "IPv4-mapped peer should match the equivalent IPv4 trusted proxy")
    assert_true(forwarded == "198.51.100.42", "forwarded client IP should be accepted from an IPv4-mapped trusted proxy")


def test_ipv4_mapped_peer_does_not_match_different_ipv4_proxy():
    with patch.object(instance_config, "get_trusted_proxies", return_value=["10.100.10.12/32"]):
        trusted = instance_config.is_trusted_proxy("::ffff:10.100.10.13")
    assert_true(trusted is False, "IPv4-mapped peer must not match a different IPv4 trusted proxy")


def main():
    tests = [
        test_source_floor_wins_over_older_db_value,
        test_higher_configured_value_still_wins,
        test_empty_config_uses_source_floor,
        test_update_analytics_defaults_enabled_and_is_returned,
        test_update_analytics_update_is_persisted_and_audited,
        test_omitted_update_analytics_setting_preserves_existing_opt_out,
        test_update_analytics_read_failure_fails_closed,
        test_ipv4_mapped_peer_matches_ipv4_trusted_proxy,
        test_ipv4_mapped_peer_does_not_match_different_ipv4_proxy,
    ]
    for test in tests:
        test()
        print(f"✅ {test.__name__}")
    print(f"\nInstance config service tests passed: {len(tests)}/{len(tests)}")


if __name__ == "__main__":
    main()
