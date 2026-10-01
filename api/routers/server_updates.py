"""Authenticated minimal server-update status for regular users."""

from fastapi import APIRouter, Depends

from routers.auth import require_auth
from services.server_updates import get_public_update_status

router = APIRouter(prefix="/api")


@router.get("/server-update")
def get_server_update_status(user_id: int = Depends(require_auth)):
    del user_id
    return get_public_update_status()
