#!/usr/bin/env python3
"""Focused tests for server update status logic."""

import asyncio
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import Mock, patch

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


def test_stable_version_rejects_leading_zero_and_unbounded_components():
    assert_equal(server_updates.stable_version("01.2.3"), None, "leading-zero major")
    assert_equal(server_updates.stable_version("1.02.3"), None, "leading-zero minor")
    assert_equal(server_updates.stable_version("1.2.03"), None, "leading-zero patch")
    assert_equal(server_updates.stable_version("999999999999999999999999.2.3"), None, "unbounded major")
    assert_equal(server_updates.stable_version("2147483647.2.3"), "2147483647.2.3", "bounded maximum")
    assert_equal(server_updates.stable_version("2147483648.2.3"), None, "component above maximum")


def test_update_severity():
    assert_equal(server_updates.update_severity("3.0.0", "2.9.9"), "major", "major severity")
    assert_equal(server_updates.update_severity("2.6.0", "2.5.9"), "minor_patch", "minor severity")
    assert_equal(server_updates.update_severity("2.5.10", "2.5.9"), "minor_patch", "patch severity")
    assert_equal(server_updates.update_severity("2.5.9", "2.5.9"), "none", "no update severity")


def test_primary_manifest_normalizes_stable_release_assets():
    payload = {
        "channel": "stable",
        "version": "2.5.5",
        "release_url": "https://github.com/weedpump/nia-todo/releases/tag/v2.5.5",
        "assets": [
            {
                "name": "nia-todo-server-v2.5.5-full.deb",
                "url": "https://github.com/weedpump/nia-todo/releases/download/v2.5.5/nia-todo-server-v2.5.5-full.deb",
                "size": 123,
            },
            {
                "name": "nia-todo-server-v2.5.5-full.deb.sha256",
                "url": "https://github.com/weedpump/nia-todo/releases/download/v2.5.5/nia-todo-server-v2.5.5-full.deb.sha256",
            },
            {
                "name": "release-manifest.json",
                "url": "https://github.com/weedpump/nia-todo/releases/download/v2.5.5/release-manifest.json",
            },
        ],
    }
    release = server_updates._normalize_primary_release(payload)
    assert_equal(release["version"], "2.5.5", "primary version")
    assert_equal(release["tag_name"], "v2.5.5", "primary tag")
    assert_equal(
        release["deb_asset"]["browser_download_url"],
        "https://github.com/weedpump/nia-todo/releases/download/v2.5.5/nia-todo-server-v2.5.5-full.deb",
        "primary deb URL",
    )
    assert_equal(release["sha256_asset"]["name"], "nia-todo-server-v2.5.5-full.deb.sha256", "primary checksum")
    assert_equal(release["manifest_asset"]["name"], "release-manifest.json", "primary release manifest")


def test_primary_manifest_accepts_nested_named_github_asset_urls():
    payload = {
        "channel": "stable",
        "latest": {
            "version": "2.5.7",
            "release_url": "https://github.com/weedpump/nia-todo/releases/tag/v2.5.7",
            "assets": {
                "server_deb": "https://github.com/weedpump/nia-todo/releases/download/v2.5.7/nia-todo-server-v2.5.7-full.deb",
                "server_deb_sha256": "https://github.com/weedpump/nia-todo/releases/download/v2.5.7/nia-todo-server-v2.5.7-full.deb.sha256",
                "manifest": "https://github.com/weedpump/nia-todo/releases/download/v2.5.7/release-manifest.json",
            },
        },
    }
    release = server_updates._normalize_primary_release(payload)
    assert_equal(release["version"], "2.5.7", "nested primary version")
    assert_equal(release["deb_asset"]["name"], "nia-todo-server-v2.5.7-full.deb", "named Debian asset")
    assert_equal(release["sha256_asset"]["name"], "nia-todo-server-v2.5.7-full.deb.sha256", "named checksum asset")
    assert_equal(
        release["manifest_asset"]["browser_download_url"],
        "https://github.com/weedpump/nia-todo/releases/download/v2.5.7/release-manifest.json",
        "named manifest URL",
    )


def test_primary_manifest_rejects_unstable_nested_channel():
    payload = {
        "channel": "stable",
        "latest": {
            "channel": "beta",
            "version": "2.5.7",
            "assets": [],
        },
    }
    try:
        server_updates._normalize_primary_release(payload)
    except ValueError as exc:
        assert "stable channel" in str(exc)
    else:
        raise AssertionError("nested non-stable channel must be rejected")


def test_primary_manifest_rejects_untrusted_debian_asset_urls():
    payload = {
        "channel": "stable",
        "version": "2.5.7",
        "assets": [
            {
                "name": "nia-todo-server-v2.5.7-full.deb",
                "url": "https://attacker.invalid/nia-todo-server-v2.5.7-full.deb",
            },
            {
                "name": "nia-todo-server-v2.5.7-full.deb.sha256",
                "url": "https://github.com/weedpump/nia-todo/releases/download/v2.5.7/nia-todo-server-v2.5.7-full.deb.sha256",
            },
        ],
    }
    try:
        server_updates._normalize_primary_release(payload)
    except ValueError as exc:
        assert "trusted GitHub" in str(exc)
    else:
        raise AssertionError("untrusted Debian asset URL must be rejected")


def _primary_contract_fixtures():
    version = "2.5.8"
    base_assets = {
        "server_deb": f"https://github.com/weedpump/nia-todo/releases/download/v{version}/nia-todo-server-v{version}-full.deb",
        "server_deb_sha256": f"https://github.com/weedpump/nia-todo/releases/download/v{version}/nia-todo-server-v{version}-full.deb.sha256",
    }
    return (
        (
            "valid nested stable release with manifest",
            {
                "channel": "stable",
                "latest": {
                    "channel": "stable",
                    "version": version,
                    "assets": {
                        **base_assets,
                        "manifest": f"https://github.com/weedpump/nia-todo/releases/download/v{version}/release-manifest.json",
                    },
                },
            },
            True,
        ),
        ("latest must be an object", {"channel": "stable", "version": version, "assets": base_assets, "latest": "stable"}, False),
        ("release must be an object", {"channel": "stable", "version": version, "assets": base_assets, "release": []}, False),
        (
            "every manifest level must be stable",
            {"channel": "stable", "latest": {"channel": "stable", "version": version, "assets": base_assets}, "release": {"channel": "beta"}},
            False,
        ),
        (
            "manifest asset must use the exact name",
            {"channel": "stable", "version": version, "assets": base_assets, "manifest_asset": {"name": "manifest.json", "url": f"https://github.com/weedpump/nia-todo/releases/download/v{version}/release-manifest.json"}},
            False,
        ),
        (
            "manifest asset must use a trusted GitHub URL",
            {"channel": "stable", "version": version, "assets": base_assets, "manifest_asset": {"name": "release-manifest.json", "url": "https://attacker.invalid/release-manifest.json"}},
            False,
        ),
        (
            "manifest asset list entry must include a URL",
            {
                "channel": "stable",
                "version": version,
                "assets": [
                    {"name": f"nia-todo-server-v{version}-full.deb", "url": base_assets["server_deb"]},
                    {"name": f"nia-todo-server-v{version}-full.deb.sha256", "url": base_assets["server_deb_sha256"]},
                    {"name": "release-manifest.json"},
                ],
            },
            False,
        ),
    )


def test_primary_manifest_contract_matches_root_helper():
    helper = _load_update_helper_python()
    for label, payload, accepted in _primary_contract_fixtures():
        outcomes = []
        for normalize in (server_updates._normalize_primary_release, helper["normalize_primary_release"]):
            try:
                normalize(payload)
            except (RuntimeError, ValueError):
                outcomes.append(False)
            else:
                outcomes.append(True)
        assert_equal(outcomes, [accepted, accepted], label)


def test_primary_failure_falls_back_to_stable_github_release():
    github = {
        "tag_name": "v2.5.6",
        "html_url": "https://github.com/weedpump/nia-todo/releases/tag/v2.5.6",
        "draft": False,
        "prerelease": False,
        "assets": [],
    }
    with patch.object(server_updates, "_http_json", side_effect=[ValueError("invalid primary"), github]) as request:
        release = server_updates.get_latest_release()
    assert_equal(release["version"], "2.5.6", "fallback version")
    assert_equal(request.call_args_list[0].args[0], server_updates.UPDATE_PRIMARY_URL, "primary requested first")
    assert_equal(request.call_args_list[1].args[0], server_updates.UPDATE_RELEASE_API_URL, "GitHub requested second")


def test_unstable_releases_are_rejected_by_both_sources():
    with patch.object(
        server_updates,
        "_http_json",
        side_effect=[
            {"channel": "beta", "version": "2.6.0-beta.1"},
            {"tag_name": "v2.6.0-rc.1", "prerelease": True, "draft": False, "assets": []},
        ],
    ):
        try:
            server_updates.get_latest_release()
        except server_updates.ReleaseCheckError:
            pass
        else:
            raise AssertionError("unstable releases must not be accepted")


@contextmanager
def temporary_update_db():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "updates.db"

        @contextmanager
        def db_factory():
            conn = sqlite3.connect(path)
            conn.row_factory = sqlite3.Row
            try:
                yield conn
                conn.commit()
            finally:
                conn.close()

        with db_factory() as db:
            db.executescript((ROOT / "api/migrations/052_add_server_update_check_state.sql").read_text(encoding="utf-8"))
        with patch.object(server_updates, "get_db", db_factory):
            yield db_factory


def test_failed_check_retains_last_successful_release_and_marks_stale():
    release = {"tag_name": "v2.5.5", "version": "2.5.5", "html_url": "https://example.invalid", "deb_asset": None, "sha256_asset": None, "manifest_asset": None}
    with temporary_update_db():
        server_updates.record_successful_check(release, source="primary")
        server_updates.record_failed_check("primary: timeout; github: timeout")
        state = server_updates.get_persisted_check_state()
    assert_equal(state["release"], release, "last successful release retained")
    assert_equal(state["stale"], True, "failed state stale")
    assert "timeout" in state["check_error"]
    assert state["last_success_at"]
    assert state["last_check_at"]


def test_public_status_is_minimal_and_uses_retained_release():
    release = {"tag_name": "v2.5.5", "version": "2.5.5", "html_url": "https://example.invalid", "deb_asset": None, "sha256_asset": None, "manifest_asset": None}
    with patch.object(server_updates, "get_persisted_check_state", return_value={"release": release, "stale": True, "check_error": "offline", "last_success_at": "2026-01-01", "last_check_at": "2026-01-02"}), \
         patch.object(server_updates, "_read_web_app_version", return_value="2.5.4"):
        status = server_updates.get_public_update_status()
    assert_equal(status, {"update_available": True, "stale": True}, "minimal public update status")


def test_umami_event_contains_only_safe_fixed_metadata():
    response = Mock()
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    with patch.object(server_updates, "UPDATE_UMAMI_WEBSITE_ID", "website-id"), \
         patch.object(server_updates.urllib.request, "urlopen", return_value=response) as urlopen:
        server_updates.send_update_check_event()
    request = urlopen.call_args.args[0]
    body = json.loads(request.data.decode("utf-8"))
    assert_equal(request.full_url, "https://umami.homelabdiary.dev/api/send", "Umami endpoint")
    assert_equal(
        request.headers["User-agent"],
        "Mozilla/5.0 (X11; Linux x86_64) nia-todo",
        "Umami-compatible generic User-Agent",
    )
    assert_equal(
        body,
        {
            "type": "event",
            "payload": {
                "website": "website-id",
                "hostname": "nia-todo.homelabdiary.dev",
                "url": "/update/stable.json",
                "name": "server-update-check",
            },
        },
        "Umami payload",
    )
    assert_equal(urlopen.call_args.kwargs["timeout"], server_updates.UMAMI_TIMEOUT_SECONDS, "short Umami timeout")


def test_umami_event_is_skipped_when_website_id_is_empty():
    assert_equal(
        server_updates.DEFAULT_UPDATE_UMAMI_WEBSITE_ID,
        "e5caf353-0f3a-44a9-a104-0a879eebdcc4",
        "default Umami website ID",
    )
    with patch.object(server_updates, "UPDATE_UMAMI_WEBSITE_ID", ""), \
         patch.object(server_updates.urllib.request, "urlopen") as urlopen:
        server_updates.send_update_check_event()
    urlopen.assert_not_called()


def test_umami_website_id_environment_override_allows_explicit_disable():
    command = [
        sys.executable,
        "-c",
        "import sys; sys.path.insert(0, 'api'); from services.server_updates import UPDATE_UMAMI_WEBSITE_ID; print(UPDATE_UMAMI_WEBSITE_ID)",
    ]
    env = os.environ.copy()
    env["NIA_TODO_UPDATE_UMAMI_WEBSITE_ID"] = "override-id"
    configured = subprocess.run(command, cwd=ROOT, env=env, check=True, text=True, stdout=subprocess.PIPE).stdout.strip()
    assert_equal(configured, "override-id", "Umami website ID override")
    env["NIA_TODO_UPDATE_UMAMI_WEBSITE_ID"] = ""
    disabled = subprocess.run(command, cwd=ROOT, env=env, check=True, text=True, stdout=subprocess.PIPE).stdout.strip()
    assert_equal(disabled, "", "explicit empty Umami website ID disables tracking")


def test_update_checks_are_serialized_in_process():
    active = 0
    max_active = 0
    calls = 0
    guard = threading.Lock()
    release = {"tag_name": "v2.5.5", "version": "2.5.5", "html_url": "https://example.invalid", "deb_asset": None, "sha256_asset": None, "manifest_asset": None, "source": "primary"}

    def fetch():
        nonlocal active, max_active, calls
        with guard:
            active += 1
            calls += 1
            max_active = max(max_active, active)
        time.sleep(0.04)
        with guard:
            active -= 1
        return release

    async def run():
        with patch.object(server_updates, "get_latest_release", side_effect=fetch), \
             patch.object(server_updates, "record_successful_check"), \
             patch.object(server_updates, "get_public_update_status", return_value={"update_available": True, "stale": False}), \
             patch.object(server_updates, "send_update_check_event"):
            await asyncio.gather(
                server_updates.perform_update_check("admin", broadcast=False),
                server_updates.perform_update_check("scheduled", broadcast=False),
            )

    asyncio.run(run())
    assert_equal(calls, 2, "both triggers perform checks")
    assert_equal(max_active, 1, "only one check runs at a time")


def test_hourly_schedule_targets_selected_minute():
    now = datetime(2026, 10, 1, 12, 17, 30, tzinfo=timezone.utc)
    assert_equal(server_updates.seconds_until_scheduled_minute(now, 42), 24 * 60 + 30, "later minute this hour")
    assert_equal(server_updates.seconds_until_scheduled_minute(now, 5), 47 * 60 + 30, "earlier minute next hour")


def test_background_task_survives_transient_check_failure():
    calls = []
    sleep_calls = 0

    async def perform(trigger):
        calls.append(trigger)
        if trigger == "startup":
            raise RuntimeError("transient check failure")
        return {"update_available": False, "stale": True}

    async def sleep(_delay):
        nonlocal sleep_calls
        sleep_calls += 1
        if sleep_calls >= 2:
            raise asyncio.CancelledError()

    async def run():
        with patch.object(server_updates, "perform_update_check", side_effect=perform), \
             patch.object(server_updates.asyncio, "sleep", side_effect=sleep), \
             patch.object(server_updates, "seconds_until_scheduled_minute", return_value=0):
            try:
                await server_updates.update_check_background_task()
            except asyncio.CancelledError:
                pass

    asyncio.run(run())
    assert_equal(calls, ["startup", "scheduled"], "scheduled checks continue after a transient failure")


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
         patch.object(server_updates, "get_persisted_check_state", return_value={"release": release, "source": "primary", "stale": False, "check_error": None, "last_success_at": "2026-01-01", "last_check_at": "2026-01-01"}):
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
         patch.object(server_updates, "get_persisted_check_state", return_value={"release": release, "source": "primary", "stale": False, "check_error": None, "last_success_at": "2026-01-01", "last_check_at": "2026-01-01"}), \
         patch.object(server_updates.Path, "exists", return_value=False):
        status = server_updates.get_update_status()
    assert_equal(status["update_available"], True, "deb update available")
    assert_equal(status["can_install"], False, "deb helper missing")


def test_update_helper_resolves_service_name_after_source_config():
    helper = ROOT / "packaging/scripts/nia-todo-server-update.sh"
    text = helper.read_text(encoding="utf-8")
    assert 'SERVICE_NAME="${SERVICE_NAME:-}"' in text
    source_index = text.index('source "${SOURCE_CONFIG}"')
    assert source_index < text.index('SERVICE_NAME="${SERVICE_NAME:-${NIA_TODO_SERVICE_NAME:-nia-todo}}"')
    assert source_index < text.index('UPDATE_PRIMARY_URL="${NIA_TODO_UPDATE_PRIMARY_URL:-${UPDATE_PRIMARY_URL:-https://nia-todo.homelabdiary.dev/update/stable.json}}"')
    assert source_index < text.index('UPDATE_RELEASE_API_URL="${NIA_TODO_UPDATE_RELEASE_API_URL:-${UPDATE_RELEASE_API_URL:-${RELEASE_API_LATEST:-https://api.github.com/repos/weedpump/nia-todo/releases/latest}}}"')


def _load_update_helper_python() -> dict[str, Any]:
    helper = (ROOT / "packaging/scripts/nia-todo-server-update.sh").read_text(encoding="utf-8")
    embedded = helper.split("python3 - <<'PY'\n", 1)[1].split('\nprint("phase=fetch_release"', 1)[0]
    namespace = {"__name__": "nia_todo_update_helper_test"}
    exec(compile(embedded, "nia-todo-server-update.sh", "exec"), namespace)
    return namespace


def test_update_helper_uses_website_primary_then_github_fallback_with_trusted_assets():
    helper = _load_update_helper_python()
    primary_url = "https://updates.example.invalid/stable.json"
    github_url = "https://api.github.com/repos/weedpump/nia-todo/releases/latest"
    helper["primary_url"] = primary_url
    helper["github_api_url"] = github_url
    primary = {
        "channel": "stable",
        "latest": {
            "channel": "stable",
            "version": "2.5.8",
            "assets": {
                "server_deb": "https://github.com/weedpump/nia-todo/releases/download/v2.5.8/nia-todo-server-v2.5.8-full.deb",
                "server_deb_sha256": "https://github.com/weedpump/nia-todo/releases/download/v2.5.8/nia-todo-server-v2.5.8-full.deb.sha256",
            },
        },
    }
    github = {
        "tag_name": "v2.5.7",
        "draft": False,
        "prerelease": False,
        "assets": [
            {
                "name": "nia-todo-server-v2.5.7-full.deb",
                "browser_download_url": "https://github.com/weedpump/nia-todo/releases/download/v2.5.7/nia-todo-server-v2.5.7-full.deb",
            },
            {
                "name": "nia-todo-server-v2.5.7-full.deb.sha256",
                "browser_download_url": "https://github.com/weedpump/nia-todo/releases/download/v2.5.7/nia-todo-server-v2.5.7-full.deb.sha256",
            },
        ],
    }
    calls = []
    helper["fetch_json"] = lambda url: calls.append(url) or {primary_url: primary, github_url: github}[url]
    release = helper["get_latest_release"]()
    assert_equal(release["version"], "2.5.8", "helper primary version")
    assert_equal(release["source"], "primary", "helper primary source")
    assert_equal(calls, [primary_url], "helper primary requested first")

    def fallback_fetch(url):
        if url == primary_url:
            raise OSError("primary offline")
        return github

    helper["fetch_json"] = fallback_fetch
    release = helper["get_latest_release"]()
    assert_equal(release["version"], "2.5.7", "helper fallback version")
    assert_equal(release["source"], "github", "helper fallback source")

    evil = {
        "channel": "stable",
        "version": "2.5.8",
        "assets": [
            {"name": "nia-todo-server-v2.5.8-full.deb", "url": "https://attacker.invalid/server.deb"},
            {
                "name": "nia-todo-server-v2.5.8-full.deb.sha256",
                "url": "https://github.com/weedpump/nia-todo/releases/download/v2.5.8/nia-todo-server-v2.5.8-full.deb.sha256",
            },
        ],
    }
    try:
        helper["normalize_primary_release"](evil)
    except RuntimeError as exc:
        assert "trusted GitHub" in str(exc)
    else:
        raise AssertionError("helper must reject untrusted Debian asset URLs")


def test_update_helper_detaches_via_systemd_run_before_package_install():
    helper = ROOT / "packaging/scripts/nia-todo-server-update.sh"
    subprocess.run(["bash", "-n", str(helper)], check=True)
    text = helper.read_text(encoding="utf-8")
    assert 'UPDATE_LOG_DIR="/var/log/nia-todo"' in text
    assert 'UPDATE_LOG_FILE="${UPDATE_LOG_DIR}/nia-todo-server-update.log"' in text
    assert 'StandardOutput=append:${UPDATE_LOG_FILE}' in text
    assert 'StandardError=append:${UPDATE_LOG_FILE}' in text
    assert 'Refusing unsafe update log directory' in text
    assert 'Refusing unsafe update log file' in text
    assert '[[ -L "${UPDATE_LOG_DIR}" ]]' in text
    assert '[[ -L "${UPDATE_LOG_FILE}" ]]' in text
    assert "systemd-run detach failed; refusing to run apt/dpkg" in text
    assert "continuing in current process" not in text
    assert text.index("flock -n 9") < text.index("systemd-run") < text.index("apt-get install -y")


def test_application_does_not_open_or_follow_privileged_update_log():
    release = {
        "tag_name": "v2.5.5",
        "version": "2.5.5",
        "html_url": "https://example.invalid/release",
        "deb_asset": {"name": "nia-todo-server-v2.5.5-full.deb", "browser_download_url": "https://example.invalid/deb"},
        "sha256_asset": {"name": "nia-todo-server-v2.5.5-full.deb.sha256", "browser_download_url": "https://example.invalid/sha"},
    }
    status = {
        "installation_type": "deb",
        "update_available": True,
        "can_install": True,
        "latest_release": release,
    }
    process = Mock(pid=4242)
    with tempfile.TemporaryDirectory() as tmp:
        victim = Path(tmp) / "victim"
        victim.write_text("unchanged", encoding="utf-8")
        malicious_log = Path(tmp) / "nia-todo-server-update.log"
        malicious_log.symlink_to(victim)
        with patch.object(server_updates, "get_update_status", return_value=status), \
             patch.object(server_updates, "UPDATE_LOG_FILE", malicious_log), \
             patch.object(server_updates.Path, "open", side_effect=AssertionError("app must not open the privileged log")), \
             patch.object(server_updates.subprocess, "Popen", return_value=process) as popen:
            result = server_updates.install_latest_deb_update()
        assert_equal(victim.read_text(encoding="utf-8"), "unchanged", "symlink target")
    assert_equal(popen.call_args.args[0], ["sudo", "-n", server_updates.HELPER], "no-argument sudo helper")
    assert_equal(popen.call_args.kwargs["stdout"], subprocess.DEVNULL, "helper stdout discarded safely")
    assert_equal(popen.call_args.kwargs["stderr"], subprocess.DEVNULL, "helper stderr discarded safely")
    assert_equal(result["log_path"], "/var/log/nia-todo/nia-todo-server-update.log", "canonical root-controlled log path")


def test_packaging_creates_root_controlled_update_log():
    expected = (
        "install -d -m 0755 -o root -g root /var/log/nia-todo",
        "install -m 0644 -o root -g root /dev/null /var/log/nia-todo/nia-todo-server-update.log",
    )
    for relative in ("packaging/install.sh", "scripts/release/build-full-bundle.sh"):
        text = (ROOT / relative).read_text(encoding="utf-8")
        for command in expected:
            assert command in text, f"{relative} must provision the privileged update log with: {command}"
        assert "/var/lib/nia-todo/update-logs" not in text


def test_public_installer_persists_custom_service_name_for_app_and_helper():
    text = (ROOT / "packaging/install.sh").read_text(encoding="utf-8")
    assert 'if [ "${SERVICE_NAME}" != "nia-todo" ]; then' in text
    assert "NIA_TODO_SERVICE_NAME=${SERVICE_NAME}" in text
    assert '"${ETC_DIR}/nia-todo.env"' in text
    assert "SERVICE_NAME=${SERVICE_NAME}" in text
    assert '"${ETC_DIR}/update-source.env"' in text


def test_update_sudoers_allows_no_helper_args():
    for relative in ("packaging/install.sh", "scripts/release/build-full-bundle.sh"):
        text = (ROOT / relative).read_text(encoding="utf-8")
        assert '/usr/local/bin/nia-todo-server-update ""' in text


def test_package_integration_disables_umami_before_starting_ci_service():
    text = (ROOT / "scripts/release/install-and-test.sh").read_text(encoding="utf-8")
    drop_in = "NIA_TODO_UPDATE_UMAMI_WEBSITE_ID="
    assert drop_in in text, "package integration tests must not emit production Umami events"
    assert text.index(drop_in) < text.index('apt-get install -y'), "CI telemetry override must exist before package postinst starts the service"


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
    test_stable_version_rejects_leading_zero_and_unbounded_components()
    test_update_severity()
    test_primary_manifest_normalizes_stable_release_assets()
    test_primary_manifest_accepts_nested_named_github_asset_urls()
    test_primary_manifest_rejects_unstable_nested_channel()
    test_primary_manifest_rejects_untrusted_debian_asset_urls()
    test_primary_manifest_contract_matches_root_helper()
    test_primary_failure_falls_back_to_stable_github_release()
    test_unstable_releases_are_rejected_by_both_sources()
    test_failed_check_retains_last_successful_release_and_marks_stale()
    test_public_status_is_minimal_and_uses_retained_release()
    test_umami_event_contains_only_safe_fixed_metadata()
    test_umami_event_is_skipped_when_website_id_is_empty()
    test_umami_website_id_environment_override_allows_explicit_disable()
    test_update_checks_are_serialized_in_process()
    test_hourly_schedule_targets_selected_minute()
    test_background_task_survives_transient_check_failure()
    test_detect_prefers_debian_package_over_container_markers()
    test_detect_debian_systemd_install_when_dpkg_metadata_missing()
    test_docker_status_is_hint_only()
    test_deb_requires_helper()
    test_update_helper_resolves_service_name_after_source_config()
    test_update_helper_uses_website_primary_then_github_fallback_with_trusted_assets()
    test_update_helper_detaches_via_systemd_run_before_package_install()
    test_application_does_not_open_or_follow_privileged_update_log()
    test_packaging_creates_root_controlled_update_log()
    test_public_installer_persists_custom_service_name_for_app_and_helper()
    test_update_sudoers_allows_no_helper_args()
    test_package_integration_disables_umami_before_starting_ci_service()
    test_update_progress_status_file()
    test_update_progress_reconciles_stale_running_status()
    print("✅ server update tests passed")


if __name__ == "__main__":
    main()
