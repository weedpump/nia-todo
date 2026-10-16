#!/usr/bin/env python3
"""Release contract for the Windows-only Tauri updater."""

import json
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_tauri_updater_is_windows_only_and_signed():
    cargo = tomllib.loads((ROOT / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8"))
    windows_dependencies = cargo["target"]["cfg(windows)"]["dependencies"]
    updater_dependency = windows_dependencies["tauri-plugin-updater"]
    updater_version = updater_dependency if isinstance(updater_dependency, str) else updater_dependency["version"]
    assert updater_version.startswith("2.")
    assert "tauri-plugin-updater" not in cargo.get("dependencies", {})

    base_config = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    assert "createUpdaterArtifacts" not in base_config["bundle"]
    assert "updater" not in base_config.get("plugins", {})

    config = json.loads((ROOT / "src-tauri" / "tauri.windows.conf.json").read_text(encoding="utf-8"))
    assert config["bundle"]["createUpdaterArtifacts"] is True
    updater = config["plugins"]["updater"]
    assert updater["dangerousInsecureTransportProtocol"] is True
    assert updater["requireSignedVersion"] is True
    assert updater["windows"]["installMode"] == "passive"
    assert isinstance(updater["pubkey"], str) and len(updater["pubkey"]) > 80

    capability = json.loads((ROOT / "src-tauri" / "capabilities" / "windows-updater.json").read_text(encoding="utf-8"))
    assert capability["platforms"] == ["windows"]
    assert capability["permissions"] == ["allow-desktop-install-update"]

    build_script = (ROOT / "src-tauri" / "build.rs").read_text(encoding="utf-8")
    assert '"desktop_install_update"' in build_script


def test_all_authorized_windows_builds_publish_updater_signatures():
    workflow = (ROOT / ".github" / "workflows" / "build.yml").read_text(encoding="utf-8")
    signed_step = workflow.split("- name: Build signed Windows installer", 1)[1].split(
        "- name: Rename to a fixed artifact name", 1
    )[0]
    signature_upload = workflow.split("- name: Upload Windows updater signature", 1)[1].split(
        "\n\n  build-android:", 1
    )[0]
    assert "if: inputs.version" not in signed_step
    assert "cargo install cargo-xwin --locked" in workflow
    assert "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}" in signed_step
    assert "TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}" in signed_step
    assert "Build unsigned Windows ad-hoc installer" not in workflow
    assert '"createUpdaterArtifacts":false' not in workflow
    assert "if: inputs.version" not in signature_upload
    assert "windows-x64-setup.exe.sig" in workflow
    assert "if-no-files-found: error" in workflow
    assert workflow.count("archive: false") >= 2
    assert "--require-windows-signature" in workflow
    assert "windows_app_version=0.0.0" not in workflow
    assert '--windows-version "${{ steps.apps.outputs.windows_app_version }}"' in workflow


def test_windows_download_is_bounded_before_signature_installation():
    source = (ROOT / "src-tauri" / "src" / "windows_update.rs").read_text(encoding="utf-8")
    assert "download_and_install" not in source
    assert "MAX_WINDOWS_UPDATE_BYTES" in source
    assert "expected_size" in source
    assert "bytes.len().saturating_add(count)" in source
    assert ".install(&bytes)" in source
    assert "spawn_blocking(move || {" in source
    assert "update.restart_after_install(true).install(&bytes)" in source



def main():
    test_tauri_updater_is_windows_only_and_signed()
    test_all_authorized_windows_builds_publish_updater_signatures()
    test_windows_download_is_bounded_before_signature_installation()
    print("✅ Windows Tauri updater release contract passed")


if __name__ == "__main__":
    main()
