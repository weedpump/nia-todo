#!/usr/bin/env python3
"""Focused tests for server update status logic."""

import json
import subprocess
import sys
import tempfile
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


def test_update_severity():
    assert_equal(server_updates.update_severity("3.0.0", "2.9.9"), "major", "major severity")
    assert_equal(server_updates.update_severity("2.6.0", "2.5.9"), "minor_patch", "minor severity")
    assert_equal(server_updates.update_severity("2.5.10", "2.5.9"), "minor_patch", "patch severity")
    assert_equal(server_updates.update_severity("2.5.9", "2.5.9"), "none", "no update severity")


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


def test_detect_prefers_debian_package_over_container_markers():
    with patch.object(server_updates, "_dpkg_package_installed", return_value=True), \
         patch.object(server_updates, "_looks_like_debian_systemd_install", return_value=False), \
         patch.object(server_updates, "_proc_cgroup_mentions_docker", return_value=True), \
         patch.object(server_updates.Path, "exists", return_value=True):
        install_type = server_updates.detect_installation_type()
    assert_equal(install_type, "deb", "dpkg package wins over container markers")


def test_detect_debian_systemd_install_when_dpkg_metadata_missing():
    with patch.object(server_updates, "_dpkg_package_installed", return_value=False), \
         patch.object(server_updates, "_looks_like_debian_systemd_install", return_value=True), \
         patch.object(server_updates, "_proc_cgroup_mentions_docker", return_value=False), \
         patch.object(server_updates.Path, "exists", return_value=False):
        install_type = server_updates.detect_installation_type()
    assert_equal(install_type, "deb", "systemd/helper install is treated as deb")


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


def test_update_helper_detaches_via_systemd_run_before_package_install():
    helper = ROOT / "packaging/scripts/nia-todo-server-update.sh"
    subprocess.run(["bash", "-n", str(helper)], check=True)
    text = helper.read_text(encoding="utf-8")
    assert "systemd-run" in text
    assert "--systemd-child" in text
    assert text.index("systemd-run") < text.index("apt-get install -y")


def test_update_progress_status_file():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "status.json"
        path.write_text(json.dumps({"state": "success", "message": "done", "target_version": "9.9.9"}), encoding="utf-8")
        with patch.object(server_updates, "UPDATE_STATUS_FILE", path):
            progress = server_updates.get_update_progress()
    assert_equal(progress["state"], "success", "progress state")
    assert_equal(progress["target_version"], "9.9.9", "progress target")


def test_update_progress_reconciles_stale_running_status():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "status.json"
        path.write_text(
            json.dumps({"state": "installing", "message": "Installing Debian package...", "target_version": "2.5.5"}),
            encoding="utf-8",
        )
        with patch.object(server_updates, "UPDATE_STATUS_FILE", path), \
             patch.object(server_updates, "_read_web_app_version", return_value="2.5.5"):
            progress = server_updates.get_update_progress()
    assert_equal(progress["state"], "success", "reconciled progress state")
    assert_equal(progress["target_version"], "2.5.5", "reconciled progress target")


def main():
    test_version_compare()
    test_update_severity()
    test_detect_prefers_debian_package_over_container_markers()
    test_detect_debian_systemd_install_when_dpkg_metadata_missing()
    test_docker_status_is_hint_only()
    test_deb_requires_helper()
    test_update_helper_detaches_via_systemd_run_before_package_install()
    test_update_progress_status_file()
    test_update_progress_reconciles_stale_running_status()
    print("✅ server update tests passed")


if __name__ == "__main__":
    main()
