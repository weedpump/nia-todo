"""Generic private routing settings; available without a BrainDump entitlement."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from db import get_db
from routers.auth import require_auth
from services.routing_memory import routing_state, reset_routing_memory, set_routing_enabled

router = APIRouter(prefix="/api/routing-memory")


async def broadcast_routing_settings(user_id: int):
    # Memory is private to this account, even when its destinations are shared.
    from routers.websocket import broadcast_sync_to_users
    await broadcast_sync_to_users({user_id})


class RoutingSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool


@router.get("")
def get_routing_memory(user_id: int = Depends(require_auth)):
    with get_db() as db:
        return routing_state(db, user_id)


@router.patch("")
async def update_routing_memory(data: RoutingSettings, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        result = set_routing_enabled(db, user_id, data.enabled)
        db.commit()
    await broadcast_routing_settings(user_id)
    return result


@router.delete("")
async def clear_routing_memory(user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        deleted = reset_routing_memory(db, user_id)
        result = routing_state(db, user_id)
        db.commit()
    await broadcast_routing_settings(user_id)
    return {**result, "deleted": deleted}
