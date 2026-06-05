#!/usr/bin/env python3
"""Copy native app artifacts into /downloads and write app-downloads.json."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

STABLE_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")


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
    parser.add_argument("--windows-installer", type=Path)
    parser.add_argument("--android-apk", type=Path)
    parser.add_argument("--allow-missing-apps", action="store_true")
    args = parser.parse_args()

    web_version = args.web_version.strip().removeprefix("v")
    native_version = args.native_app_version.strip().removeprefix("v")
    for label, value in (("web", web_version), ("native app", native_version)):
        if not STABLE_VERSION_RE.fullmatch(value):
            raise SystemExit(f"Invalid {label} version: {value}")

    args.download_dir.mkdir(parents=True, exist_ok=True)
    required = not args.allow_missing_apps

    windows_name = f"nia-todo-v{native_version}-windows-x64-setup.exe"
    android_name = f"nia-todo-v{native_version}-android-arm64.apk"
    windows_sha, windows_size = copy_artifact(args.windows_installer, args.download_dir, windows_name, required=required)
    android_sha, android_size = copy_artifact(args.android_apk, args.download_dir, android_name, required=required)

    apps = []
    if windows_sha:
        apps.append({
            "platform": "windows",
            "arch": "x64",
            "label": "Windows Setup",
            "version": f"v{native_version}",
            "filename": windows_name,
            "url": f"/downloads/{windows_name}",
            "sha256": windows_sha,
            "size_bytes": windows_size,
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
        })

    manifest = {
        "version": f"v{native_version}",
        "web_version": f"v{web_version}",
        "native_app_version": f"v{native_version}",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "latest": {"version": f"v{native_version}"},
        "apps": sorted(apps, key=lambda item: item["platform"]),
    }
    (args.download_dir / "app-downloads.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
