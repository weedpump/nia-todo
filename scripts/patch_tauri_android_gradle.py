#!/usr/bin/env python3
import argparse
import json
import re
import subprocess
from pathlib import Path

SUPPRESSION = '@file:Suppress("DEPRECATION")'


def tauri_root_from_metadata(metadata: dict, manifest_path: Path) -> Path:
    """Select this app's resolved dependency, not another workspace's Tauri."""
    packages = metadata.get("packages", [])
    roots = [
        package for package in packages
        if Path(package["manifest_path"]).resolve() == manifest_path.resolve()
    ]
    if len(roots) != 1:
        raise SystemExit(f"Expected exactly one Cargo package for {manifest_path}, found {len(roots)}")
    nodes = (metadata.get("resolve") or {}).get("nodes", [])
    root_nodes = [node for node in nodes if node["id"] == roots[0]["id"]]
    if len(root_nodes) != 1:
        raise SystemExit("Expected the app package in Cargo's resolved dependency graph")
    direct_ids = {
        dependency["pkg"] for dependency in root_nodes[0].get("deps", [])
        if any(kind.get("kind") is None for kind in dependency.get("dep_kinds", []))
    }
    matches = [
        package for package in packages
        if package["name"] == "tauri" and package["id"] in direct_ids
    ]
    if len(matches) != 1:
        raise SystemExit(f"Expected exactly one direct tauri dependency, found {len(matches)}")
    if not re.fullmatch(r"2\.\d+\.\d+", matches[0]["version"]):
        raise SystemExit(f"Unsupported Tauri version for the Android Gradle patch: {matches[0]['version']}")
    return Path(matches[0]["manifest_path"]).resolve().parent


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
    return tauri_root_from_metadata(json.loads(metadata.stdout), manifest_path)


def patch_tauri_android_gradle(tauri_root: Path) -> None:
    gradle_file = tauri_root / "mobile" / "android" / "build.gradle.kts"
    if not gradle_file.is_file():
        raise SystemExit(f"Missing Tauri Android Gradle file: {gradle_file}")
    source = gradle_file.read_text(encoding="utf-8")
    if 'id("com.android.library")' not in source or not re.search(r'namespace\s*=\s*"app\.tauri"', source):
        raise SystemExit(f"Unexpected Tauri Android library structure in {gradle_file}")
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
