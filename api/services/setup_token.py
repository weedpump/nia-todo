"""One-time credential protecting first-run setup endpoints."""
import hmac
import os
import secrets
from pathlib import Path
from typing import Optional

from paths import DATA_DIR

SETUP_TOKEN_PATH = Path(os.getenv("NIA_TODO_SETUP_TOKEN_FILE", DATA_DIR / "setup-token"))


def ensure_setup_token(*, setup_complete: bool) -> Optional[str]:
    if setup_complete:
        consume_setup_token()
        return None
    if SETUP_TOKEN_PATH.is_file():
        token = SETUP_TOKEN_PATH.read_text(encoding="utf-8").strip()
        if token:
            return token
    SETUP_TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    temporary = SETUP_TOKEN_PATH.with_name(f".{SETUP_TOKEN_PATH.name}.{secrets.token_hex(8)}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(token + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(SETUP_TOKEN_PATH)
        os.chmod(SETUP_TOKEN_PATH, 0o600)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return token


def validate_setup_token(candidate: Optional[str]) -> bool:
    if not candidate or not SETUP_TOKEN_PATH.is_file():
        return False
    expected = SETUP_TOKEN_PATH.read_text(encoding="utf-8").strip()
    return bool(expected) and hmac.compare_digest(expected, candidate.strip())


def consume_setup_token() -> None:
    try:
        SETUP_TOKEN_PATH.unlink()
    except FileNotFoundError:
        pass
