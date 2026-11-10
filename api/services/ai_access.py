"""The existing BrainDump permission also gates recipe BrainDump features."""

from fastapi import HTTPException

from db import get_db
from services.braindump_config import get_braindump_config
from services.braindump_v2 import ensure_braindump_enabled


def require_braindump_ai_access(user_id: int, *, config_loader=None, database=None, user_gate=None) -> dict:
    """Return current connection settings after both existing access checks.

    Optional dependencies preserve the legacy router's injectable compatibility
    seam; ordinary callers share the same configuration and user gate directly.
    """
    config = (config_loader or get_braindump_config)(include_secrets=True)
    if not config.get("enabled"):
        raise HTTPException(403, "BrainDump is disabled")
    with (database or get_db)() as db:
        try:
            (user_gate or ensure_braindump_enabled)(db, user_id)
        except PermissionError as error:
            if str(error) == "user_not_found":
                raise HTTPException(404, "User not found") from None
            raise HTTPException(403, "BrainDump is not enabled for this user") from None
    return config
