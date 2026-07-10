#!/usr/bin/env python3
"""Focused tests for release-time native app artifact reuse."""

import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def assert_equal(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def test_embed_native_downloads_decouples_web_and_native_versions():
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        downloads = tmp_path / "downloads"
        windows = tmp_path / "nia-todo-v2.11.1-windows-x64-setup.exe"
        android = tmp_path / "nia-todo-v2.11.1-android-arm64.apk"
        linux = tmp_path / "nia-todo-desktop-v2.11.1-linux-amd64.deb"
        windows.write_bytes(b"windows-installer")
        android.write_bytes(b"android-apk")
        linux.write_bytes(b"linux-deb")

        subprocess.run(
            [
                str(ROOT / "scripts/release/embed-native-downloads.py"),
                "--download-dir", str(downloads),
                "--web-version", "2.12.0",
                "--native-app-version", "2.11.1",
                "--windows-installer", str(windows),
                "--android-apk", str(android),
                "--linux-deb", str(linux),
            ],
            cwd=ROOT,
            check=True,
        )

        manifest = json.loads((downloads / "app-downloads.json").read_text(encoding="utf-8"))
        assert_equal(manifest["web_version"], "v2.12.0", "web release version")
        assert_equal(manifest["version"], "v2.11.1", "manifest update version")
        assert_equal(manifest["native_app_version"], "v2.11.1", "native app version")
        assert_equal(manifest["latest"]["version"], "v2.11.1", "latest update version")

        by_platform = {entry["platform"]: entry for entry in manifest["apps"]}
        assert_equal(by_platform["windows"]["version"], "v2.11.1", "windows app version")
        assert_equal(by_platform["windows"]["filename"], "nia-todo-v2.11.1-windows-x64-setup.exe", "windows filename")
        assert_equal(by_platform["android"]["version"], "v2.11.1", "android app version")
        assert_equal(by_platform["android"]["filename"], "nia-todo-v2.11.1-android-arm64.apk", "android filename")
        assert_equal(by_platform["linux"]["version"], "v2.11.1", "linux app version")
        assert_equal(by_platform["linux"]["filename"], "nia-todo-desktop-v2.11.1-linux-amd64.deb", "linux filename")
        assert (downloads / "nia-todo-v2.11.1-windows-x64-setup.exe").is_file()
        assert (downloads / "nia-todo-v2.11.1-android-arm64.apk").is_file()
        assert (downloads / "nia-todo-desktop-v2.11.1-linux-amd64.deb").is_file()
        assert not (downloads / "nia-todo-v2.12.0-windows-x64-setup.exe").exists()
        assert not (downloads / "nia-todo-v2.12.0-android-arm64.apk").exists()
        assert not (downloads / "nia-todo-desktop-v2.12.0-linux-amd64.deb").exists()


def test_release_scripts_expose_reuse_native_version_flow():
    release_sh = (ROOT / "release.sh").read_text(encoding="utf-8")
    public_release = (ROOT / "scripts/release/public-release.sh").read_text(encoding="utf-8")
    full_bundle = (ROOT / "scripts/release/build-full-bundle.sh").read_text(encoding="utf-8")
    docker_build = (ROOT / "scripts/release/build-docker.sh").read_text(encoding="utf-8")

    assert "--reuse-native-app-version" in release_sh
    assert "stage_reused_native_artifacts" in release_sh
    assert "validate_reused_native_floor" in release_sh
    assert "SOURCE_MIN_NATIVE_CLIENT_VERSION" in release_sh
    assert "--reuse-native-app-version cannot be combined with --set-min-app-version" in release_sh
    assert "gh release download \"${NATIVE_TAG}\"" in release_sh
    assert "--native-app-version \"${NATIVE_APP_VERSION}\"" in release_sh
    assert "LINUX_DEB_STAGING" in release_sh
    assert "npm run tauri -- build --bundles deb" in release_sh

    assert "--native-app-version" in public_release
    assert "--linux-deb" in public_release
    assert "BUNDLE_ARGS" in public_release and "DOCKER_ARGS" in public_release

    for label, text in (("full-bundle", full_bundle), ("docker", docker_build)):
        assert "--native-app-version" in text, f"{label} must accept native app version"
        assert "--linux-deb" in text, f"{label} must accept Linux Debian package input"
        assert "embed-native-downloads.py" in text, f"{label} must use shared manifest writer"


def test_release_shell_syntax():
    subprocess.run(
        [
            "bash", "-n",
            "release.sh",
            "scripts/release/public-release.sh",
            "scripts/release/build-full-bundle.sh",
            "scripts/release/build-docker.sh",
        ],
        cwd=ROOT,
        check=True,
    )


def main():
    test_embed_native_downloads_decouples_web_and_native_versions()
    test_release_scripts_expose_reuse_native_version_flow()
    test_release_shell_syntax()
    print("✅ release native reuse tests passed")


if __name__ == "__main__":
    main()
