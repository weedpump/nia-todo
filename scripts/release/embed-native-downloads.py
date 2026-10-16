#!/usr/bin/env python3
"""Copy native app artifacts into /downloads and write app-downloads.json."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

STABLE_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
MAX_SIGNATURE_BYTES = 16 * 1024


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def copy_artifact(source: Path | None, download_dir: Path, filename: str, *, required: bool) -> tuple[str, int]:
    if source and source.is_file():
        target = download_dir / filename
        shutil.copy2(source, target)
        digest = sha256_file(target)
        size = target.stat().st_size
        (download_dir / f"{filename}.sha256").write_text(f"{digest}  {filename}\n", encoding="utf-8")
        return digest, size
    if required:
        raise SystemExit(f"Missing native artifact: {source or filename}")
    return "", 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download-dir", required=True, type=Path)
    parser.add_argument("--web-version", required=True)
    parser.add_argument("--native-app-version", required=True)
    parser.add_argument("--windows-version")
    parser.add_argument("--debian-version")
    parser.add_argument("--windows-installer", type=Path)
    parser.add_argument("--windows-signature", type=Path)
    parser.add_argument("--require-windows-signature", action="store_true")
    parser.add_argument("--android-apk", type=Path)
    parser.add_argument("--debian-deb", type=Path)
    parser.add_argument("--debian-signature", type=Path)
    parser.add_argument("--require-debian-signature", action="store_true")
    parser.add_argument("--allow-missing-apps", action="store_true")
    args = parser.parse_args()

    web_version = args.web_version.strip().removeprefix("v")
    native_version = args.native_app_version.strip().removeprefix("v")
    windows_version = (args.windows_version or native_version).strip().removeprefix("v")
    debian_version = (args.debian_version or native_version).strip().removeprefix("v")
    for label, value in (("web", web_version), ("native app", native_version), ("Windows app", windows_version), ("Debian app", debian_version)):
        if not STABLE_VERSION_RE.fullmatch(value):
            raise SystemExit(f"Invalid {label} version: {value}")

    args.download_dir.mkdir(parents=True, exist_ok=True)
    required = not args.allow_missing_apps

    windows_name = f"nia-todo-v{windows_version}-windows-x64-setup.exe"
    android_name = f"nia-todo-v{native_version}-android-arm64.apk"
    debian_name = f"nia-todo-desktop-v{debian_version}-debian-amd64.deb"
    windows_sha, windows_size = copy_artifact(args.windows_installer, args.download_dir, windows_name, required=required)
    if args.require_windows_signature and args.windows_installer and not args.windows_signature:
        raise SystemExit("Missing required Windows updater signature")
    if args.windows_installer and args.windows_signature:
        if not args.windows_signature.is_file():
            raise SystemExit(f"Missing Windows updater signature: {args.windows_signature}")
        shutil.copy2(args.windows_signature, args.download_dir / f"{windows_name}.sig")
    elif args.windows_signature:
        raise SystemExit("Windows updater signature supplied without Windows installer")
    android_sha, android_size = copy_artifact(args.android_apk, args.download_dir, android_name, required=required)
    debian_sha, debian_size = copy_artifact(args.debian_deb, args.download_dir, debian_name, required=required)
    debian_signature = ""
    if args.require_debian_signature and args.debian_deb and not args.debian_signature:
        raise SystemExit("Missing required Debian updater signature")
    if args.debian_deb and args.debian_signature:
        if not args.debian_signature.is_file():
            raise SystemExit(f"Missing Debian updater signature: {args.debian_signature}")
        signature_bytes = args.debian_signature.read_bytes()
        if not signature_bytes or len(signature_bytes) > MAX_SIGNATURE_BYTES:
            raise SystemExit("Invalid Debian updater signature size")
        try:
            decoded_signature = base64.b64decode(signature_bytes.strip(), validate=True).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as exc:
            raise SystemExit("Invalid Debian updater signature encoding") from exc
        signature_lines = decoded_signature.splitlines()
        trusted_comment = (
            signature_lines[2].removeprefix("trusted comment: ")
            if len(signature_lines) >= 4 and signature_lines[2].startswith("trusted comment: ")
            else ""
        )
        signed_versions = [
            field.removeprefix("version:")
            for field in trusted_comment.split("\t")
            if field.startswith("version:")
        ]
        if signed_versions != [debian_version]:
            raise SystemExit("Debian updater signature does not bind the expected version")
        debian_signature = signature_bytes.decode("ascii").strip()
        shutil.copy2(args.debian_signature, args.download_dir / f"{debian_name}.sig")
    elif args.debian_signature:
        raise SystemExit("Debian updater signature supplied without Debian package")

    apps = []
    if windows_sha:
        apps.append({
            "platform": "windows",
            "arch": "x64",
            "label": "Windows Setup",
            "version": f"v{windows_version}",
            "filename": windows_name,
            "url": f"/downloads/{windows_name}",
            "sha256": windows_sha,
            "size_bytes": windows_size,
            "tauri_updater": bool(args.windows_signature),
        })
    if android_sha:
        apps.append({
            "platform": "android",
            "arch": "arm64",
            "label": "Android APK",
            "version": f"v{native_version}",
            "filename": android_name,
            "url": f"/downloads/{android_name}",
            "sha256": android_sha,
            "size_bytes": android_size,
            "android_updater": True,
        })
    if debian_sha:
        apps.append({
            "platform": "debian",
            "arch": "amd64",
            "label": "Debian Package",
            "version": f"v{debian_version}",
            "filename": debian_name,
            "url": f"/downloads/{debian_name}",
            "sha256": debian_sha,
            "size_bytes": debian_size,
            "debian_updater": bool(debian_signature),
            "signature": debian_signature,
        })

    latest = {"version": f"v{native_version}"}
    for app in apps:
        latest[app["platform"]] = app

    manifest = {
        "version": f"v{native_version}",
        "web_version": f"v{web_version}",
        "native_app_version": f"v{native_version}",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "latest": latest,
        "apps": sorted(apps, key=lambda item: item["platform"]),
    }
    (args.download_dir / "app-downloads.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
