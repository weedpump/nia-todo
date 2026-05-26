"""nia-todo: Push notification endpoints"""

from typing import Optional
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from db import get_db
from routers.auth import require_auth
from services.push import (
    get_vapid_public_key, send_push_notification
)

router = APIRouter(prefix="/api/push")


class PushSubscription(BaseModel):
    endpoint: str
    keys: dict

class PushTestRequest(BaseModel):
    title: str = "🔔 Test notification"
    body: str = "Push notifications are enabled! ✅"


@router.get("/vapid-public-key")
def get_vapid_public_key_endpoint():
    return {"public_key": get_vapid_public_key()}

@router.post("/subscribe")
def push_subscribe(data: PushSubscription, user_id: int = Depends(require_auth)):
    p256dh = data.keys.get("p256dh")
    auth = data.keys.get("auth")
    if not p256dh or not auth:
        raise HTTPException(400, "Missing p256dh or auth key")
    with get_db() as db:
        db.execute(
            """INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(user_id, endpoint) DO UPDATE SET
               p256dh = excluded.p256dh,
               auth = excluded.auth,
               created_at = datetime('now')""",
            (user_id, data.endpoint, p256dh, auth)
        )
        db.commit()
    return {"subscribed": True}

@router.post("/unsubscribe")
def push_unsubscribe(data: PushSubscription, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute(
            "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?",
            (user_id, data.endpoint)
        )
        db.commit()
    return {"unsubscribed": True}

@router.get("/status")
def push_status(user_id: int = Depends(require_auth)):
    with get_db() as db:
        count = db.execute(
            "SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?",
            (user_id,)
        ).fetchone()[0]
    return {
        "public_key": get_vapid_public_key(),
        "has_subscriptions": count > 0,
        "subscription_count": count
    }

@router.post("/test")
async def push_test(data: PushTestRequest, user_id: int = Depends(require_auth)):
    sent = await send_push_notification(
        user_id=user_id,
        title=data.title,
        body=data.body,
        tag=f"test-{int(datetime.now(timezone.utc).timestamp() * 1000)}",
        url="/"
    )
    return {"sent": sent}
