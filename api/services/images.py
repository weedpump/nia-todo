"""Bounded raster decoding shared by private application images."""

import io

from PIL import Image, ImageOps, UnidentifiedImageError


def validate_image_dimensions(image: Image.Image, max_pixels: int) -> Image.Image:
    width, height = image.size
    if width <= 0 or height <= 0 or width * height > max_pixels:
        raise Image.DecompressionBombError("Image dimensions exceed the pixel limit")
    return image


def load_raster_image(body: bytes, *, max_pixels: int, formats=None,
                      transpose: bool = False, mode: str = "RGB") -> Image.Image:
    """Verify and bound before decoding pixels; return an independent image."""
    with Image.open(io.BytesIO(body)) as header:
        if formats is not None and header.format not in formats:
            raise UnidentifiedImageError("Unsupported raster image format")
        validate_image_dimensions(header, max_pixels)
        header.verify()
    with Image.open(io.BytesIO(body)) as source:
        validate_image_dimensions(source, max_pixels)
        oriented = ImageOps.exif_transpose(source) if transpose else source
        image = oriented.convert(mode)
        image.load()
        return image
