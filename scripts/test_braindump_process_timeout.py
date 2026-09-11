#!/usr/bin/env python3
"""Regression test for BrainDump subprocess timeouts."""

import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from routers.braindump_v2 import _run  # noqa: E402

with patch("routers.braindump_v2.subprocess.run") as run:
    run.return_value.returncode = 0
    _run(["ffmpeg", "--version"])
    assert run.call_args.kwargs["timeout"] == 60

print("✅ BrainDump subprocess timeout is enforced")
