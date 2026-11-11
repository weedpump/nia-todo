"""Validation helpers for user-controlled appearance fields."""

import re
from typing import Optional

from fastapi import HTTPException

HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

VALID_ICON_NAMES = {
    "accessibility", "alarm-clock", "ambulance", "archive", "arrow-left", "award", "axe", "baby",
    "ban", "banknote", "bath", "battery", "bed", "bell", "bike", "bird",
    "book-open", "bookmark", "bot", "brain", "briefcase", "bug", "building", "building-2",
    "bus", "cable", "calendar", "calendar-days", "camera", "car", "cat", "chart-bar",
    "chart-column", "chart-line", "check", "check-circle", "chef-hat", "church", "circle", "circle-dollar-sign",
    "clapperboard", "clipboard", "clock", "cloud", "code", "coffee", "cpu", "cross",
    "crown", "database", "dog", "download", "drama", "dumbbell", "earth", "edit-3",
    "factory", "fence", "file-text", "film", "fingerprint", "flag", "flame", "flower",
    "flower-2", "folder", "gamepad-2", "gift", "globe", "graduation-cap", "hammer", "hand-heart",
    "hand-helping", "handshake", "hard-drive", "headphones", "heart", "heart-handshake", "heart-pulse", "home",
    "hospital", "house-heart", "house-plus", "image", "inbox", "key-round", "keyboard", "land-plot",
    "landmark", "languages", "laptop", "layout-dashboard", "leaf", "life-buoy", "link", "list-todo",
    "lock-keyhole", "log-out", "mail", "map", "map-pin", "map-pinned", "mars", "menu",
    "message-circle", "monitor", "moon", "mountain", "music", "network", "newspaper", "notebook-pen",
    "package", "paintbrush", "palette", "paw-print", "pen-tool", "pencil", "person-standing", "phone",
    "pickaxe", "piggy-bank", "plane", "plug", "plus", "podcast", "presentation", "rabbit",
    "radio", "refresh-cw", "rocket", "route", "school", "scissors", "search", "server",
    "settings", "share-2", "shield", "shield-check", "ship", "shopping-bag", "shopping-cart", "shovel",
    "shrub", "smartphone", "smile", "snail", "sofa", "spray-can", "sprout", "squirrel",
    "star", "stethoscope", "store", "sun", "tablet", "tag", "target", "tent",
    "terminal", "ticket", "tractor", "train", "trash-2", "tree-deciduous", "tree-pine", "trees",
    "triangle-alert", "truck", "turtle", "tv", "upload", "user", "user-plus", "users",
    "utensils", "venus", "venus-and-mars", "volleyball", "wallet", "warehouse", "waves", "wifi",
    "worm", "wrench", "x", "zap",
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
