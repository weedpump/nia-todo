#!/usr/bin/env python3
import argparse
import json
import subprocess
from pathlib import Path

EXPECTED_TAURI_VERSION = "2.12.1"
SUPPRESSION = '@file:Suppress("DEPRECATION")'


def resolve_tauri_root(manifest_path: Path) -> Path:
    metadata = subprocess.run(
        [
            "cargo",
            "metadata",
            "--manifest-path",
            str(manifest_path),
            "--format-version",
            "1",
            "--locked",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    packages = json.loads(metadata.stdout)["packages"]
    matches = [
        package
        for package in packages
        if package["name"] == "tauri" and package["version"] == EXPECTED_TAURI_VERSION
    ]
    if len(matches) != 1:
        raise SystemExit(
            f"Expected exactly one tauri {EXPECTED_TAURI_VERSION} package, found {len(matches)}"
        )
    return Path(matches[0]["manifest_path"]).resolve().parent


def patch_tauri_android_gradle(tauri_root: Path) -> None:
    gradle_file = tauri_root / "mobile" / "android" / "build.gradle.kts"
    if not gradle_file.is_file():
        raise SystemExit(f"Missing Tauri Android Gradle file: {gradle_file}")
    source = gradle_file.read_text(encoding="utf-8")
    if source.startswith(f"{SUPPRESSION}\n"):
        return
    if source.startswith("@file:Suppress"):
        raise SystemExit(f"Unexpected existing file suppression in {gradle_file}")
    gradle_file.write_text(f"{SUPPRESSION}\n\n{source}", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tauri-root", type=Path)
    parser.add_argument(
        "--manifest-path",
        type=Path,
        default=Path("src-tauri/Cargo.toml"),
    )
    args = parser.parse_args()
    tauri_root = args.tauri_root.resolve() if args.tauri_root else resolve_tauri_root(args.manifest_path)
    patch_tauri_android_gradle(tauri_root)


if __name__ == "__main__":
    main()
