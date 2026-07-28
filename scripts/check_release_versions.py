#!/usr/bin/env python3
"""Check nia-todo release/dev version consistency without building."""
from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STABLE_VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
DEV_VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev$")
COMPAT_VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-dev)?$")
PRERELEASE_RANK = {"dev": -1}


@dataclass(frozen=True)
class ParsedVersion:
    major: int
    minor: int
    patch: int
    prerelease: str = ""


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def first(pattern: str, text: str, label: str) -> str:
    match = re.search(pattern, text, re.MULTILINE)
    if not match:
        raise SystemExit(f"missing {label}")
    return match.group(1)


def normalize_version(value: str) -> str:
    return str(value or "").strip().lstrip("vV")


def parse_version(value: str) -> ParsedVersion:
    normalized = normalize_version(value)
    match = COMPAT_VERSION_RE.fullmatch(normalized)
    if not match:
        raise ValueError(f"invalid nia-todo version: {value}")
    major, minor, patch = (int(match.group(index)) for index in (1, 2, 3))
    prerelease = "dev" if normalized.endswith("-dev") else ""
    return ParsedVersion(major, minor, patch, prerelease)


def is_valid_stable_version(value: str) -> bool:
    return bool(STABLE_VERSION_RE.fullmatch(normalize_version(value)))


def is_valid_dev_version(value: str) -> bool:
    return bool(DEV_VERSION_RE.fullmatch(normalize_version(value)))


def is_valid_compat_version(value: str) -> bool:
    return bool(COMPAT_VERSION_RE.fullmatch(normalize_version(value)))


def compare_versions(left: str, right: str) -> int:
    left_version = parse_version(left)
    right_version = parse_version(right)
    left_core = (left_version.major, left_version.minor, left_version.patch)
    right_core = (right_version.major, right_version.minor, right_version.patch)
    if left_core != right_core:
        return 1 if left_core > right_core else -1
    left_rank = PRERELEASE_RANK.get(left_version.prerelease, 0)
    right_rank = PRERELEASE_RANK.get(right_version.prerelease, 0)
    if left_rank == right_rank:
        return 0
    return 1 if left_rank > right_rank else -1


def cargo_lock_app_version() -> str:
    lines = read("src-tauri/Cargo.lock").splitlines()
    for idx, line in enumerate(lines[:-1]):
        if line.strip() == 'name = "nia-todo-desktop"':
            return first(r'version = "([^"]+)"', lines[idx + 1], "Cargo.lock nia-todo-desktop version")
    raise SystemExit("missing Cargo.lock package nia-todo-desktop")


def android_generated_warnings(expected_version: str) -> list[str]:
    warnings: list[str] = []
    props_path = ROOT / "src-tauri" / "gen" / "android" / "app" / "tauri.properties"
    if props_path.exists():
        raw = props_path.read_text(encoding="utf-8", errors="replace")
        version_name = first(r"^tauri\.android\.versionName=(.+)$", raw, "tauri.android.versionName").strip()
        if version_name != expected_version:
            warnings.append(f"Android generated tauri.properties versionName is {version_name}, expected {expected_version}; the release workflow rewrites it before the Android build")
    return warnings


def main() -> int:
    expected = normalize_version(sys.argv[1]) if len(sys.argv) > 1 else None
    config_js = read("web/static/js/core/config.js")
    sw_js = read("web/sw.js")
    index_html = read("web/index.html")
    instance_config = read("api/services/instance_config.py")
    min_native_migration = read("api/migrations/029_add_min_native_client_version_config.sql")
    tauri_conf = json.loads(read("src-tauri/tauri.conf.json"))
    cargo_toml = read("src-tauri/Cargo.toml")

    versions = {
        "web APP_VERSION": first(r"APP_VERSION\s*=\s*['\"]v?([^'\"]+)['\"]", config_js, "APP_VERSION"),
        "service worker SW_VERSION": first(r"SW_VERSION\s*=\s*['\"]v?([^'\"]+)['\"]", sw_js, "SW_VERSION"),
        "index visible version": first(r'<span class="version-text">v?([^<]+)</span>', index_html, "index visible version"),
        "tauri.conf version": str(tauri_conf.get("version", "")),
        "Cargo.toml app version": first(r'^version\s*=\s*"([^"]+)"', cargo_toml, "Cargo.toml package version"),
        "Cargo.lock app version": cargo_lock_app_version(),
    }
    min_native_client_version = first(
        r'SOURCE_MIN_NATIVE_CLIENT_VERSION\s*=\s*"([^"]+)"',
        instance_config,
        "min_native_client_version source floor",
    )
    min_native_migration_version = first(
        r"\('min_native_client_version', '([^']+)'\)",
        min_native_migration,
        "min_native_client_version migration default",
    )

    baseline = expected or versions["web APP_VERSION"]
    failures: list[str] = []
    warnings: list[str] = []
    if not (is_valid_stable_version(baseline) or is_valid_dev_version(baseline)):
        failures.append(f"baseline version is not valid stable/dev SemVer: {baseline}")
    for label, value in versions.items():
        if value != baseline:
            failures.append(f"{label}: {value} != {baseline}")
        if not (is_valid_stable_version(value) or is_valid_dev_version(value)):
            failures.append(f"{label} is not valid stable/dev SemVer: {value}")
    if min_native_migration_version != min_native_client_version:
        failures.append(
            "min_native_client_version migration default "
            f"{min_native_migration_version} != source fallback {min_native_client_version}"
        )
    if not is_valid_compat_version(min_native_client_version):
        failures.append(f"min_native_client_version is not valid stable/dev SemVer: {min_native_client_version}")
    else:
        try:
            if compare_versions(min_native_client_version, baseline) > 0:
                failures.append(f"min_native_client_version {min_native_client_version} must not exceed app version {baseline}")
        except ValueError as error:
            failures.append(str(error))
    warnings.extend(android_generated_warnings(baseline))

    if failures:
        print("Version consistency check FAILED:", file=sys.stderr)
        for failure in failures:
            print(f" - {failure}", file=sys.stderr)
        return 1

    print(f"Version consistency check OK: {baseline}")
    for label in sorted(versions):
        print(f" - {label}: {versions[label]}")
    print(f" - min_native_client_version: {min_native_client_version} (manual compatibility floor)")
    for warning in warnings:
        print(f" ⚠️  {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
