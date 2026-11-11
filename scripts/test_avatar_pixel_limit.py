#!/usr/bin/env python3
"""Avatar decoding enforces its pixel budget before converting pixels."""
import io
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
from routers import me

at_limit = SimpleNamespace(size=(4096, 4096))
assert me._validate_avatar_dimensions(at_limit) is at_limit
for dimensions in ((4097, 4096), (0, 1)):
    try:
        me._validate_avatar_dimensions(SimpleNamespace(size=dimensions))
    except Image.DecompressionBombError:
        pass
    else:
        raise AssertionError("Avatar dimension limit must reject before conversion")
body = io.BytesIO()
Image.new("RGB", (3, 3)).save(body, "PNG")
with patch.object(me, "MAX_AVATAR_PIXELS", 4):
    try:
        me._load_avatar_image(body.getvalue(), "image/png")
    except Image.DecompressionBombError:
        pass
    else:
        raise AssertionError("The upload decoder must use the avatar-specific budget")
assert me._load_avatar_image(body.getvalue(), "image/png").size == (3, 3)
print("✅ Shared raster decoding enforces avatar pixel limits before conversion")
