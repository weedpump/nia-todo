"""Private recipe title images, stored atomically with their recipe aggregate."""

import base64
import binascii
import hashlib
import io
import re

from PIL import Image, UnidentifiedImageError

from services.images import load_raster_image

MAX_RECIPE_IMAGE_BYTES = 300 * 1024
MAX_RECIPE_IMAGE_PIXELS = 16 * 1024 * 1024
MAX_RECIPE_IMAGE_EDGE = 1280
_DATA_IMAGE = re.compile(r"data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)\Z")


def normalize_recipe_image(data_uri: str | None) -> dict | None:
    if data_uri is None:
        return None
    if not isinstance(data_uri, str) or len(data_uri) > 430000:
        raise ValueError("Recipe image exceeds the upload limit")
    match = _DATA_IMAGE.fullmatch(data_uri)
    if not match:
        raise ValueError("Unsupported recipe image")
    try:
        raw = base64.b64decode(match[2], validate=True)
        if len(raw) > MAX_RECIPE_IMAGE_BYTES:
            raise ValueError("Recipe image exceeds the upload limit")
        image = load_raster_image(raw, max_pixels=MAX_RECIPE_IMAGE_PIXELS,
                                  formats={"JPEG", "PNG", "WEBP"}, transpose=True)
        image.thumbnail((MAX_RECIPE_IMAGE_EDGE, MAX_RECIPE_IMAGE_EDGE), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, format="WEBP", quality=85, method=4, exif=b"")
        content = output.getvalue()
        if len(content) > MAX_RECIPE_IMAGE_BYTES:
            output = io.BytesIO()
            image.save(output, format="WEBP", quality=65, method=4, exif=b"")
            content = output.getvalue()
        if len(content) > MAX_RECIPE_IMAGE_BYTES:
            raise ValueError("Recipe image exceeds the upload limit")
    except (binascii.Error, UnidentifiedImageError, OSError, SyntaxError,
            Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise ValueError("Invalid recipe image") from error
    return {"content": content, "content_hash": hashlib.sha256(content).hexdigest(), "media_type": "image/webp"}
