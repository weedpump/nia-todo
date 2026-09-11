#!/usr/bin/env python3
"""Ensure third-party GitHub Actions are pinned to immutable commit SHAs."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = sorted((ROOT / ".github" / "workflows").glob("*.yml"))
USES_RE = re.compile(r"^\s*-\s+uses:\s+([^\s@]+)@([^\s#]+)", re.MULTILINE)
SHA_RE = re.compile(r"^[0-9a-f]{40}$")

violations = []
for workflow in WORKFLOWS:
    for action, reference in USES_RE.findall(workflow.read_text()):
        if not SHA_RE.fullmatch(reference):
            violations.append(f"{workflow.relative_to(ROOT)}: {action}@{reference}")

if violations:
    raise AssertionError("Mutable GitHub Action references found:\n" + "\n".join(violations))

print("✅ All third-party GitHub Actions are pinned to commit SHAs")
