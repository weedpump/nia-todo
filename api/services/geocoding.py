"""Address geocoding helpers for location reminders.

Only target addresses are geocoded. Runtime/device location never goes through the server.
"""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from functools import lru_cache

from fastapi import HTTPException

DEFAULT_RADIUS_M = 150
_NOMINATIM_URL = os.environ.get("NIA_TODO_GEOCODING_NOMINATIM_URL", "https://nominatim.openstreetmap.org/search")
_USER_AGENT = os.environ.get("NIA_TODO_GEOCODING_USER_AGENT", "nia-todo/1.0 (selfhosted location reminders)")
_PROVIDER = os.environ.get("NIA_TODO_GEOCODING_PROVIDER", "disabled").strip().lower()


@lru_cache(maxsize=512)
def geocode_address(address: str) -> dict:
    cleaned = " ".join(str(address or "").strip().split())
    if not cleaned:
        raise HTTPException(422, "Address is required")

    if _PROVIDER not in {"nominatim", "osm"}:
        raise HTTPException(503, "Address geocoding is not configured")

    query = urllib.parse.urlencode({
        "q": cleaned,
        "format": "jsonv2",
        "limit": "1",
        "addressdetails": "0",
    })
    request = urllib.request.Request(
        f"{_NOMINATIM_URL}?{query}",
        headers={"User-Agent": _USER_AGENT},
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(502, f"Address geocoding failed: {error}")

    if not payload:
        raise HTTPException(422, "Address could not be geocoded")
    first = payload[0]
    try:
        latitude = float(first["lat"])
        longitude = float(first["lon"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(502, "Address geocoding returned invalid coordinates")
    return {
        "address": cleaned,
        "latitude": latitude,
        "longitude": longitude,
    }
