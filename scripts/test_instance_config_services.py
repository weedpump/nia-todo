#!/usr/bin/env python3
"""Instance config service tests."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

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


def main():
    tests = [
        test_source_floor_wins_over_older_db_value,
        test_higher_configured_value_still_wins,
        test_empty_config_uses_source_floor,
    ]
    for test in tests:
        test()
        print(f"✅ {test.__name__}")
    print(f"\nInstance config service tests passed: {len(tests)}/{len(tests)}")


if __name__ == "__main__":
    main()
