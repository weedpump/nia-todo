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
        "min_native_client_version": first(r'"min_native_client_version"\s*:\s*"([^"]+)"', instance_config, "min_native_client_version"),
    }

    baseline = expected or versions["web APP_VERSION"]
    failures = []
    for label, value in versions.items():
        if value != baseline:
            failures.append(f"{label}: {value} != {baseline}")

    if failures:
        print("Version consistency check FAILED:", file=sys.stderr)
        for failure in failures:
            print(f" - {failure}", file=sys.stderr)
        return 1

    print(f"Version consistency check OK: {baseline}")
    for label in sorted(versions):
        print(f" - {label}: {versions[label]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
