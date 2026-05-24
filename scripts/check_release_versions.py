#!/usr/bin/env python3
"""Check nia-todo release/dev version consistency without building."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def first(pattern: str, text: str, label: str) -> str:
    match = re.search(pattern, text, re.MULTILINE)
    if not match:
        raise SystemExit(f"missing {label}")
    return match.group(1)


def normalize_version(value: str) -> str:
    return str(value or "").strip().lstrip("vV")


def parse_version(value: str) -> tuple[list[int], list[str]]:
    core, _, prerelease = normalize_version(value).partition("-")
    return [int(part) if part.isdigit() else 0 for part in core.split(".")], prerelease.split(".") if prerelease else []


def compare_prerelease(left: list[str], right: list[str]) -> int:
    if not left and not right:
        return 0
    if not left:
        return 1
    if not right:
        return -1
    for idx in range(max(len(left), len(right))):
        if idx >= len(left):
            return -1
        if idx >= len(right):
            return 1
        lval, rval = left[idx], right[idx]
        lnum = int(lval) if lval.isdigit() else None
        rnum = int(rval) if rval.isdigit() else None
        if lnum is not None and rnum is not None and lnum != rnum:
            return 1 if lnum > rnum else -1
        if lnum is not None and rnum is None:
            return -1
        if lnum is None and rnum is not None:
            return 1
        if lval != rval:
            return 1 if lval > rval else -1
    return 0


def compare_versions(left: str, right: str) -> int:
    left_core, left_pre = parse_version(left)
    right_core, right_pre = parse_version(right)
    for idx in range(max(len(left_core), len(right_core))):
        lval = left_core[idx] if idx < len(left_core) else 0
        rval = right_core[idx] if idx < len(right_core) else 0
        if lval != rval:
            return 1 if lval > rval else -1
    return compare_prerelease(left_pre, right_pre)


def cargo_lock_app_version() -> str:
    lines = read("src-tauri/Cargo.lock").splitlines()
    for idx, line in enumerate(lines[:-1]):
        if line.strip() == 'name = "nia-todo-desktop"':
            return first(r'version = "([^"]+)"', lines[idx + 1], "Cargo.lock nia-todo-desktop version")
    raise SystemExit("missing Cargo.lock package nia-todo-desktop")


def main() -> int:
    expected = sys.argv[1] if len(sys.argv) > 1 else None
    config_js = read("web/static/js/core/config.js")
    sw_js = read("web/sw.js")
    index_html = read("web/index.html")
    instance_config = read("api/services/instance_config.py")
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
    min_native_client_version = first(r'"min_native_client_version"\s*:\s*"([^"]+)"', instance_config, "min_native_client_version")

    baseline = expected or versions["web APP_VERSION"]
    failures = []
    for label, value in versions.items():
        if value != baseline:
            failures.append(f"{label}: {value} != {baseline}")
    if not re.match(r"^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$", min_native_client_version):
        failures.append(f"min_native_client_version is not valid SemVer: {min_native_client_version}")
    elif compare_versions(min_native_client_version, baseline) > 0:
        failures.append(f"min_native_client_version {min_native_client_version} must not exceed app version {baseline}")

    if failures:
        print("Version consistency check FAILED:", file=sys.stderr)
        for failure in failures:
            print(f" - {failure}", file=sys.stderr)
        return 1

    print(f"Version consistency check OK: {baseline}")
    for label in sorted(versions):
        print(f" - {label}: {versions[label]}")
    print(f" - min_native_client_version: {min_native_client_version} (manual compatibility floor)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
