#!/usr/bin/env python3
"""Focused tests for release-time native app artifact reuse."""

import json
import base64
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
        windows = tmp_path / "nia-todo-v2.11.2-windows-x64-setup.exe"
        windows_signature = tmp_path / "nia-todo-v2.11.2-windows-x64-setup.exe.sig"
        android = tmp_path / "nia-todo-v2.11.1-android-arm64.apk"
        debian = tmp_path / "nia-todo-desktop-v2.11.1-debian-amd64.deb"
        debian_signature = tmp_path / "nia-todo-desktop-v2.11.1-debian-amd64.deb.sig"
        windows.write_bytes(b"windows-installer")
        windows_signature.write_text("signed updater payload\n", encoding="utf-8")
        android.write_bytes(b"android-apk")
        debian.write_bytes(b"debian-deb")
        debian_signature.write_text(
            base64.b64encode(
                b"untrusted comment: test\nRWQtest\ntrusted comment: timestamp:1\tfile:debian.deb\tversion:2.11.1\nRWQtest\n"
            ).decode("ascii") + "\n",
            encoding="utf-8",
        )

        subprocess.run(
            [
                str(ROOT / "scripts/release/embed-native-downloads.py"),
                "--download-dir", str(downloads),
                "--web-version", "2.12.0",
                "--native-app-version", "2.11.1",
                "--windows-version", "2.11.2",
                "--debian-version", "2.11.1",
                "--windows-installer", str(windows),
                "--windows-signature", str(windows_signature),
                "--android-apk", str(android),
                "--debian-deb", str(debian),
                "--debian-signature", str(debian_signature),
            ],
            cwd=ROOT,
            check=True,
        )

        manifest = json.loads((downloads / "app-downloads.json").read_text(encoding="utf-8"))
        assert_equal(manifest["web_version"], "v2.12.0", "web release version")
        assert_equal(manifest["version"], "v2.11.1", "manifest update version")
        assert_equal(manifest["native_app_version"], "v2.11.1", "native app version")
        assert_equal(manifest["latest"]["version"], "v2.11.1", "latest update version")
        assert_equal(manifest["latest"]["debian"]["platform"], "debian", "latest debian platform")

        by_platform = {entry["platform"]: entry for entry in manifest["apps"]}
        assert_equal(by_platform["windows"]["version"], "v2.11.2", "windows app version")
        assert by_platform["windows"]["tauri_updater"] is True
        assert_equal(by_platform["windows"]["filename"], "nia-todo-v2.11.2-windows-x64-setup.exe", "windows filename")
        assert_equal(by_platform["android"]["version"], "v2.11.1", "android app version")
        assert_equal(by_platform["android"]["filename"], "nia-todo-v2.11.1-android-arm64.apk", "android filename")
        assert by_platform["android"]["android_updater"] is True
        assert_equal(by_platform["debian"]["version"], "v2.11.1", "debian app version")
        assert_equal(by_platform["debian"]["filename"], "nia-todo-desktop-v2.11.1-debian-amd64.deb", "debian filename")
        assert by_platform["debian"]["debian_updater"] is True
        assert by_platform["debian"]["signature"] == debian_signature.read_text(encoding="utf-8").strip()
        assert (downloads / "nia-todo-v2.11.2-windows-x64-setup.exe").is_file()
        assert_equal(
            (downloads / "nia-todo-v2.11.2-windows-x64-setup.exe.sig").read_text(encoding="utf-8"),
            "signed updater payload\n",
            "Windows updater signature",
        )
        assert (downloads / "nia-todo-v2.11.1-android-arm64.apk").is_file()
        assert (downloads / "nia-todo-desktop-v2.11.1-debian-amd64.deb").is_file()
        assert (downloads / "nia-todo-desktop-v2.11.1-debian-amd64.deb.sig").is_file()
        assert not (downloads / "nia-todo-v2.12.0-windows-x64-setup.exe").exists()
        assert not (downloads / "nia-todo-v2.12.0-android-arm64.apk").exists()
        assert not (downloads / "nia-todo-desktop-v2.12.0-debian-amd64.deb").exists()


def test_release_scripts_expose_native_app_version_flow():
    full_bundle = (ROOT / "scripts/release/build-full-bundle.sh").read_text(encoding="utf-8")
    docker_build = (ROOT / "scripts/release/build-docker.sh").read_text(encoding="utf-8")

    for label, text in (("full-bundle", full_bundle), ("docker", docker_build)):
        assert "--native-app-version" in text, f"{label} must accept native app version"
        assert "--windows-version" in text, f"{label} must accept Windows app version"
        assert "--debian-version" in text, f"{label} must accept Debian app version"
        assert "--windows-signature" in text, f"{label} must accept Windows updater signature"
        assert "--debian-deb" in text, f"{label} must accept Debian package input"
        assert "--debian-signature" in text, f"{label} must accept Debian updater signature"
        assert "embed-native-downloads.py" in text, f"{label} must use shared manifest writer"
    assert '${FORCE:+--force}' not in docker_build, "docker build must not treat FORCE=0 as enabled"


def test_manual_packaging_uses_the_fresh_android_version():
    workflow = (ROOT / ".github/workflows/build.yml").read_text(encoding="utf-8")

    assert 'android_app_version=${{ inputs.version }}' in workflow
    assert 'android_app_version=$(python3 -c' in workflow
    assert 'android_app_version=${native_app_version}' in workflow
    assert workflow.count('--native-app-version "${{ steps.apps.outputs.android_app_version }}"') == 2


def test_release_docker_push_waits_for_release_tests():
    build_workflow = (ROOT / ".github/workflows/build.yml").read_text(encoding="utf-8")
    release_workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")

    assert "Push release Docker image to GHCR and Docker Hub" not in build_workflow
    assert 'docker save "nia-todo:${{ inputs.version }}" --output "dist/docker/release/nia-todo-v${{ inputs.version }}.tar"' in build_workflow
    assert "name: nia-todo-v${{ inputs.version }}.tar" in build_workflow
    assert "path: dist/docker/release/nia-todo-v${{ inputs.version }}.tar" in build_workflow
    assert "push-docker:" in release_workflow
    assert "name: nia-todo-v${{ env.VERSION }}.tar" in release_workflow
    assert "needs: [prepare-version, build, test, webkit-swipe]" in release_workflow
    assert 'docker load --input "dist/release/docker/nia-todo-v${VERSION}.tar"' in release_workflow
    assert "needs: [prepare-version, build, test, webkit-swipe, push-docker]" not in release_workflow


def test_ad_hoc_windows_artifact_can_remain_unsigned():
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        windows = tmp_path / "windows.exe"
        windows.write_bytes(b"ad-hoc windows installer")
        downloads = tmp_path / "downloads"
        subprocess.run(
            [
                str(ROOT / "scripts/release/embed-native-downloads.py"),
                "--download-dir", str(downloads),
                "--web-version", "2.12.0",
                "--native-app-version", "2.11.1",
                "--windows-version", "2.11.2",
                "--windows-installer", str(windows),
                "--allow-missing-apps",
            ],
            cwd=ROOT,
            check=True,
        )
        assert (downloads / "nia-todo-v2.11.2-windows-x64-setup.exe").is_file()
        assert not (downloads / "nia-todo-v2.11.2-windows-x64-setup.exe.sig").exists()
        manifest = json.loads((downloads / "app-downloads.json").read_text(encoding="utf-8"))
        windows_entry = next(entry for entry in manifest["apps"] if entry["platform"] == "windows")
        assert windows_entry["tauri_updater"] is False


def test_release_windows_artifact_requires_signature():
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        windows = tmp_path / "windows.exe"
        windows.write_bytes(b"release windows installer")
        result = subprocess.run(
            [
                str(ROOT / "scripts/release/embed-native-downloads.py"),
                "--download-dir", str(tmp_path / "downloads"),
                "--web-version", "2.12.0",
                "--native-app-version", "2.12.0",
                "--windows-installer", str(windows),
                "--require-windows-signature",
                "--allow-missing-apps",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0
        assert "unrecognized arguments" not in result.stderr.lower()
        assert "signature" in result.stderr.lower()


def test_release_debian_artifact_requires_signature():
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        debian = tmp_path / "debian.deb"
        debian.write_bytes(b"release debian package")
        result = subprocess.run(
            [
                str(ROOT / "scripts/release/embed-native-downloads.py"),
                "--download-dir", str(tmp_path / "downloads"),
                "--web-version", "2.12.0",
                "--native-app-version", "2.12.0",
                "--debian-deb", str(debian),
                "--require-debian-signature",
                "--allow-missing-apps",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0
        assert "unrecognized arguments" not in result.stderr.lower()
        assert "signature" in result.stderr.lower()


def test_debian_signature_version_must_match_exact_trusted_comment():
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        debian = tmp_path / "debian.deb"
        signature = tmp_path / "debian.deb.sig"
        debian.write_bytes(b"release debian package")
        signature.write_text(
            base64.b64encode(
                b"trusted comment: version:2.11.1\nRWQtest\ntrusted comment: timestamp:1\tfile:debian.deb\tversion:2.11.10\nRWQtest\n"
            ).decode("ascii"),
            encoding="utf-8",
        )
        result = subprocess.run(
            [
                str(ROOT / "scripts/release/embed-native-downloads.py"),
                "--download-dir", str(tmp_path / "downloads"),
                "--web-version", "2.11.1",
                "--native-app-version", "2.11.1",
                "--debian-version", "2.11.1",
                "--debian-deb", str(debian),
                "--debian-signature", str(signature),
                "--allow-missing-apps",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0
        assert "signature" in result.stderr.lower()


def test_release_shell_syntax():
    subprocess.run(
        [
            "bash", "-n",
            "scripts/release/build-full-bundle.sh",
            "scripts/release/build-docker.sh",
            "scripts/release/stage-package-source.sh",
            "scripts/release/prepare-release-version.sh",
            "scripts/release/fetch-latest-native-artifacts.sh",
        ],
        cwd=ROOT,
        check=True,
    )


def main():
    test_embed_native_downloads_decouples_web_and_native_versions()
    test_release_scripts_expose_native_app_version_flow()
    test_manual_packaging_uses_the_fresh_android_version()
    test_release_docker_push_waits_for_release_tests()
    test_ad_hoc_windows_artifact_can_remain_unsigned()
    test_release_windows_artifact_requires_signature()
    test_release_debian_artifact_requires_signature()
    test_debian_signature_version_must_match_exact_trusted_comment()
    test_release_shell_syntax()
    print("✅ release native reuse tests passed")


if __name__ == "__main__":
    main()
