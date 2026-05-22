"""Validation helpers for user-controlled appearance fields."""

import re
from typing import Optional

from fastapi import HTTPException

HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

VALID_ICON_NAMES = {
    "layout-dashboard", "circle", "clock", "flame", "check", "check-circle", "plus", "trash-2",
    "calendar", "calendar-days", "chart-line", "triangle-alert", "settings", "monitor", "sun", "moon",
    "refresh-cw", "x", "arrow-left", "edit-3", "image", "key-round", "bell", "smartphone", "keyboard",
    "share-2", "download", "clipboard", "ban", "folder", "briefcase", "home", "code", "server",
    "shopping-cart", "heart", "star", "users", "user-plus", "log-out", "menu", "search", "mail",
    "inbox", "lock-keyhole", "shield", "database", "cloud", "wifi", "wrench", "rocket", "car",
    "plane", "book-open", "file-text", "laptop", "cpu", "terminal", "hammer", "bug", "package",
    "archive", "tag", "bookmark", "flag", "map-pin",
}


def normalize_color(value: Optional[str], *, field: str = "color") -> str:
    """Return a safe hex color or raise 422 for invalid user input."""
    color = str(value or "").strip()
    if not HEX_COLOR_RE.fullmatch(color):
        raise HTTPException(422, f"Invalid {field}")
    if len(color) == 4:
        color = "#" + "".join(ch * 2 for ch in color[1:])
    return color.lower()


def normalize_icon(value: Optional[str], *, field: str = "icon") -> Optional[str]:
    """Return an allowlisted Lucide icon name, None for empty, or raise 422."""
    if value is None:
        return None
    icon = str(value).strip()
    if not icon:
        return None
    if icon not in VALID_ICON_NAMES:
        raise HTTPException(422, f"Invalid {field}")
    return icon
