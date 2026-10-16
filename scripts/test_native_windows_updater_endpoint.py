#!/usr/bin/env python3
"""Behavioral contract for the Windows Tauri updater projection."""

import importlib.util
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "api" / "services" / "native_updates.py"


def load_module():
    spec = importlib.util.spec_from_file_location("native_updates", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise AssertionError("native update service module is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def windows_manifest(version: str = "4.2.1") -> dict:
    filename = f"nia-todo-v{version}-windows-x64-setup.exe"
    return {
        "native_app_version": f"v{version}",
        "apps": [
            {
                "platform": "windows",
                "arch": "x64",
                "version": f"v{version}",
                "filename": filename,
                "url": f"/downloads/{filename}",
                "sha256": "a" * 64,
                "size_bytes": 12345,
                "tauri_updater": True,
            }
        ],
    }


def test_projects_existing_manifest_to_tauri_response():
    native_updates = load_module()
    with tempfile.TemporaryDirectory() as tmp:
        downloads = Path(tmp)
        signature = "signed updater payload"
        (downloads / "nia-todo-v4.2.1-windows-x64-setup.exe.sig").write_text(signature, encoding="utf-8")
        payload = native_updates.build_windows_updater_response(
            windows_manifest(),
            downloads,
            "http://todo.example.test/base/path",
        )
        assert payload == {
            "version": "4.2.1",
            "url": "http://todo.example.test/downloads/nia-todo-v4.2.1-windows-x64-setup.exe",
            "signature": signature,
            "size": 12345,
        }


def test_rejects_manifest_that_points_away_from_configured_server():
    native_updates = load_module()
    with tempfile.TemporaryDirectory() as tmp:
        manifest = windows_manifest()
        manifest["apps"][0]["url"] = "https://attacker.invalid/update.exe"
        try:
            native_updates.build_windows_updater_response(manifest, Path(tmp), "http://todo.example.test")
        except ValueError as error:
            assert "download" in str(error).lower()
        else:
            raise AssertionError("foreign Windows update URLs must be rejected")


def test_requires_matching_detached_signature_file():
    native_updates = load_module()
    with tempfile.TemporaryDirectory() as tmp:
        try:
            native_updates.build_windows_updater_response(
                windows_manifest(),
                Path(tmp),
                "http://todo.example.test",
            )
        except ValueError as error:
            assert "signature" in str(error).lower()
        else:
            raise AssertionError("missing Windows updater signature must be rejected")


def test_reports_absent_windows_artifact_as_no_update():
    native_updates = load_module()
    try:
        native_updates.build_windows_updater_response(
            {"native_app_version": "v4.2.1", "apps": []},
            Path("."),
            "http://todo.example.test",
        )
    except LookupError:
        pass
    else:
        raise AssertionError("missing Windows artifact must report no update")


def test_reports_explicitly_unsigned_windows_artifact_as_no_native_update():
    native_updates = load_module()
    manifest = windows_manifest()
    manifest["apps"][0]["tauri_updater"] = False
    try:
        native_updates.build_windows_updater_response(
            manifest,
            Path("."),
            "http://todo.example.test",
        )
    except LookupError:
        pass
    else:
        raise AssertionError("explicitly unsigned Windows artifact must not be offered to Tauri")


def main():
    test_projects_existing_manifest_to_tauri_response()
    test_rejects_manifest_that_points_away_from_configured_server()
    test_requires_matching_detached_signature_file()
    test_reports_absent_windows_artifact_as_no_update()
    test_reports_explicitly_unsigned_windows_artifact_as_no_native_update()
    print("✅ Windows Tauri updater endpoint tests passed")


if __name__ == "__main__":
    main()
