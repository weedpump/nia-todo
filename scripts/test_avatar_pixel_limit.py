#!/usr/bin/env python3
"""Regression check for explicit avatar pixel limits."""
from pathlib import Path

content = (Path(__file__).resolve().parents[1] / "api" / "routers" / "me.py").read_text()
assert "MAX_AVATAR_PIXELS" in content
assert "width * height > MAX_AVATAR_PIXELS" in content
assert content.count("Image.DecompressionBombError") >= 3
print("✅ Avatar pixel limits are explicit")
