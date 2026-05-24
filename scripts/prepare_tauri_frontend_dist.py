#!/usr/bin/env python3
"""Prepare a clean frontend dist for Tauri builds.

Tauri embeds the full frontendDist directory into the desktop binary. The live
web/downloads directory contains generated installers/APKs and must never be
bundled into native apps.
"""
from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "web"
TARGET = ROOT / "src-tauri" / "frontend-dist"
EXCLUDED_DIRS = {"downloads"}


def ignore(path: str, names: list[str]) -> set[str]:
    current = Path(path).resolve()
    if current == SOURCE:
        return {name for name in names if name in EXCLUDED_DIRS}
    return set()


def main() -> None:
    if not SOURCE.is_dir():
        raise SystemExit(f"Frontend source not found: {SOURCE}")

    if TARGET.exists():
        shutil.rmtree(TARGET)

    shutil.copytree(SOURCE, TARGET, ignore=ignore)
    print(f"Prepared Tauri frontend dist: {TARGET} (excluded: {', '.join(sorted(EXCLUDED_DIRS))})")


if __name__ == "__main__":
    main()
