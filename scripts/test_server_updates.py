#!/usr/bin/env python3
"""Focused tests for server update status logic."""

import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from services import server_updates


def assert_equal(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def test_version_compare():
    assert_equal(server_updates.compare_versions("2.5.4", "2.5.3"), 1, "newer")
    assert_equal(server_updates.compare_versions("v2.5.3", "2.5.3"), 0, "equal with v")
    assert_equal(server_updates.compare_versions("2.5.2", "2.5.3"), -1, "older")
    assert_equal(server_updates.compare_versions("2.5.4", "2.5.4-dev"), None, "dev unsafe")


def test_docker_status_is_hint_only():
    release = {
        "tag_name": "v2.5.5",
        "version": "2.5.5",
        "html_url": "https://example.invalid/release",
        "deb_asset": {"name": "nia-todo-server-v2.5.5-full.deb", "browser_download_url": "https://example.invalid/deb"},
        "sha256_asset": {"name": "nia-todo-server-v2.5.5-full.deb.sha256", "browser_download_url": "https://example.invalid/sha"},
    }
    with patch.object(server_updates, "_read_web_app_version", return_value="2.5.4"), \
         patch.object(server_updates, "detect_installation_type", return_value="docker"), \
         patch.object(server_updates, "get_latest_release", return_value=release):
        status = server_updates.get_update_status()
    assert_equal(status["update_available"], True, "docker update available")
    assert_equal(status["can_install"], False, "docker cannot self-install")
    assert "Docker" in status["message"]


def test_deb_requires_helper():
    release = {
        "tag_name": "v2.5.5",
        "version": "2.5.5",
        "html_url": "https://example.invalid/release",
        "deb_asset": {"name": "nia-todo-server-v2.5.5-full.deb", "browser_download_url": "https://example.invalid/deb"},
        "sha256_asset": {"name": "nia-todo-server-v2.5.5-full.deb.sha256", "browser_download_url": "https://example.invalid/sha"},
    }
    with patch.object(server_updates, "_read_web_app_version", return_value="2.5.4"), \
         patch.object(server_updates, "detect_installation_type", return_value="deb"), \
         patch.object(server_updates, "get_latest_release", return_value=release), \
         patch.object(server_updates.Path, "exists", return_value=False):
        status = server_updates.get_update_status()
    assert_equal(status["update_available"], True, "deb update available")
    assert_equal(status["can_install"], False, "deb helper missing")


def main():
    test_version_compare()
    test_docker_status_is_hint_only()
    test_deb_requires_helper()
    print("✅ server update tests passed")


if __name__ == "__main__":
    main()
