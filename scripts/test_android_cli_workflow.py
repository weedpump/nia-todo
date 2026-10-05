#!/usr/bin/env python3
"""Ensure Android CLI installation follows Google's rotating signed APT repository."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "build.yml"
workflow = WORKFLOW.read_text(encoding="utf-8")

required_fragments = (
    "https://dl.google.com/linux/linux_signing_key.pub",
    "signed-by=/etc/apt/keyrings/google.asc",
    "https://dl.google.com/android/cli/latest/debian/ stable main",
    "sudo apt-get update",
    "sudo apt-get install -y android-cli",
)
missing = [fragment for fragment in required_fragments if fragment not in workflow]
if missing:
    raise AssertionError(
        "Android CLI workflow does not use the signed rolling APT repository; "
        f"missing: {missing}"
    )

if "/pool/main/a/android-cli/android-cli_" in workflow:
    raise AssertionError("Android CLI workflow pins a package inside the mutable latest repository")

print("✅ Android CLI workflow uses Google's signed rolling APT repository")
