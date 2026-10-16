#!/usr/bin/env python3
"""Release and packaging contract for signed Debian desktop updates."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_authorized_debian_builds_are_signed_and_published():
    workflow = (ROOT / ".github/workflows/build.yml").read_text(encoding="utf-8")
    job = workflow.split("  build-debian-desktop:", 1)[1].split("\n  package:", 1)[0]
    assert "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}" in job
    assert "TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}" in job
    assert "npm run tauri -- signer sign" in job
    assert "--app-version" in job
    assert "nia-todo-desktop-amd64.deb.sig" in job
    assert "archive: false" in job
    assert "if-no-files-found: error" in job


def test_release_pipeline_requires_and_propagates_debian_signature():
    embed = (ROOT / "scripts/release/embed-native-downloads.py").read_text(encoding="utf-8")
    fetch = (ROOT / "scripts/release/fetch-latest-native-artifacts.sh").read_text(encoding="utf-8")
    workflow = (ROOT / ".github/workflows/build.yml").read_text(encoding="utf-8")
    full_bundle = (ROOT / "scripts/release/build-full-bundle.sh").read_text(encoding="utf-8")
    docker = (ROOT / "scripts/release/build-docker.sh").read_text(encoding="utf-8")

    assert '--debian-signature' in embed
    assert '--require-debian-signature' in embed
    assert '"debian_updater": bool(debian_signature)' in embed
    assert '"signature": debian_signature' in embed
    assert "nia-todo-ci-debian-amd64.deb.sig" in fetch
    assert "nia-todo-ci-debian-amd64.deb.sig" in workflow
    assert "--require-debian-signature" in workflow
    assert "--debian-signature" in full_bundle
    assert "--debian-signature" in docker


def test_debian_package_contains_narrow_polkit_update_components():
    repack = (ROOT / "scripts/release/repack-native-debian-deb.sh").read_text(encoding="utf-8")
    helper = ROOT / "src-tauri/src/bin/nia-todo-desktop-updater.rs"
    policy = ROOT / "src-tauri/linux/de.tobiaskneidl.nia-todo.desktop-update.policy"

    assert helper.is_file()
    assert policy.is_file()
    assert "/usr/lib/nia-todo-desktop/nia-todo-desktop-updater" in repack
    assert "/usr/share/polkit-1/actions/de.tobiaskneidl.nia-todo.desktop-update.policy" in repack
    helper_text = helper.read_text(encoding="utf-8")
    assert "PKEXEC_UID" in helper_text
    assert "openat2" in helper_text
    assert "stat.st_mode & 0o077 != 0" in helper_text
    assert "metadata.mode() & 0o777 != 0o700" in helper_text
    assert "minisign_verify" in helper_text
    assert ".trusted_comment()" in helper_text
    assert 'command_output("/usr/bin/dpkg-deb"' in helper_text
    assert 'Command::new("/usr/bin/dpkg")' in helper_text
    assert 'Command::new("/usr/bin/pkexec")' in helper_text
    assert "auth_admin" in policy.read_text(encoding="utf-8")
    assert "auth_admin_keep" not in policy.read_text(encoding="utf-8")


def test_tauri_debian_command_and_capability_are_linux_only():
    build = (ROOT / "src-tauri/build.rs").read_text(encoding="utf-8")
    lib = (ROOT / "src-tauri/src/lib.rs").read_text(encoding="utf-8")
    source = ROOT / "src-tauri/src/debian_update.rs"
    capability = ROOT / "src-tauri/capabilities/debian-updater.json"

    assert '"desktop_install_debian_update"' in build
    assert "mod debian_update;" in lib
    assert "desktop_install_debian_update" in lib
    assert source.is_file()
    assert capability.is_file()
    assert '"platforms": ["linux"]' in capability.read_text(encoding="utf-8")
    text = source.read_text(encoding="utf-8")
    assert "MAX_DEBIAN_UPDATE_BYTES" in text
    assert "spawn_blocking" in text
    assert "redirect(reqwest::redirect::Policy::none())" in text
    assert "native-update-progress" in text
    assert ".trusted_comment()" in text


def main():
    test_authorized_debian_builds_are_signed_and_published()
    test_release_pipeline_requires_and_propagates_debian_signature()
    test_debian_package_contains_narrow_polkit_update_components()
    test_tauri_debian_command_and_capability_are_linux_only()
    print("✅ Debian native updater release contract passed")


if __name__ == "__main__":
    main()
