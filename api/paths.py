"""Shared filesystem paths for nia-todo runtime data."""

import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
DEFAULT_DATA_DIR = APP_DIR / "data"


def _path_from_env(name: str, default: Path | str) -> Path:
    value = os.getenv(name)
    return Path(value).expanduser() if value else Path(default)


DATA_DIR = _path_from_env("NIA_TODO_DATA_DIR", DEFAULT_DATA_DIR)
DB_NAME = os.getenv("NIA_TODO_DB", "nia-todo.db")
DB_PATH = Path(DB_NAME).expanduser()
if not DB_PATH.is_absolute():
    DB_PATH = DATA_DIR / DB_PATH

AVATAR_DIR = _path_from_env("NIA_TODO_AVATAR_DIR", DATA_DIR / "avatars")
VAPID_KEYS_PATH = _path_from_env("NIA_TODO_VAPID_KEYS", DATA_DIR / "vapid_keys.json")
BACKUP_DIR = _path_from_env("NIA_TODO_BACKUP_DIR", DATA_DIR / "backups")
ATTACHMENT_DIR = _path_from_env("NIA_TODO_ATTACHMENT_DIR", DATA_DIR / "attachments")

for directory in (DATA_DIR, DB_PATH.parent, AVATAR_DIR, VAPID_KEYS_PATH.parent, BACKUP_DIR, ATTACHMENT_DIR):
    directory.mkdir(parents=True, exist_ok=True)
