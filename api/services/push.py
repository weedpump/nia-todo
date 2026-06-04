"""nia-todo: Push notification services (VAPID, WebPush)"""

import json
import base64
import os
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlparse, urlunparse

from py_vapid import Vapid
from pywebpush import webpush, WebPushException
from cryptography.hazmat.primitives import serialization

from db import get_db
from paths import VAPID_KEYS_PATH
from services.websocket import manager


def _origin_from_url(value: str) -> str:
    parsed = urlparse(str(value or "").strip())
    if parsed.scheme != "https" or not parsed.netloc:
        return ""
    return urlunparse((parsed.scheme, parsed.netloc, "", "", "", ""))


def get_vapid_subject() -> str:
    """Return the VAPID subject/contact claim for this installation."""
    configured = os.getenv("NIA_TODO_VAPID_SUBJECT", "").strip()
    if configured:
        return configured

    try:
        from services.instance_config import get_instance_config

        public_base_url = get_instance_config().get("public_base_url") or ""
        origin = _origin_from_url(public_base_url)
        if origin:
            return origin
    except Exception:
        pass

    return "https://localhost"


def get_vapid_claims() -> dict[str, str]:
    return {"sub": get_vapid_subject()}


def get_vapid_keys() -> tuple[str, str]:
    """Load or generate VAPID key pair."""
    if VAPID_KEYS_PATH.exists():
        try:
            data = json.loads(VAPID_KEYS_PATH.read_text())
            priv = data.get("private_b64url") or data.get("private_pem")
            pub = data.get("public_b64url")
            if priv and pub:
                Vapid.from_string(private_key=priv)
                return priv, pub
        except Exception:
            pass
    v = Vapid()
    v.generate_keys()
    priv_raw = v.private_key.private_numbers().private_value.to_bytes(32, "big")
    priv_b64url = base64.urlsafe_b64encode(priv_raw).decode().rstrip("=")
    pub_raw = v.public_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint
    )
    pub_b64url = base64.urlsafe_b64encode(pub_raw).decode().rstrip("=")
    VAPID_KEYS_PATH.parent.mkdir(parents=True, exist_ok=True)
    VAPID_KEYS_PATH.write_text(json.dumps({"private_b64url": priv_b64url, "public_b64url": pub_b64url}))
    return priv_b64url, pub_b64url


def get_vapid_private_key() -> str:
    return get_vapid_keys()[0]


def get_vapid_public_key() -> str:
    return get_vapid_keys()[1]


async def send_push_notification(user_id: int, title: str, body: str, tag: str, url: str = "/", todo_id: int = None) -> bool:
    """Send push notification to all subscriptions of a user."""
    priv_key = get_vapid_private_key()
    payload = json.dumps({"title": title, "body": body, "tag": tag, "url": url, "todoId": todo_id})

    with get_db() as db:
        subs = db.execute(
            "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?",
            (user_id,)
        ).fetchall()

    if not subs:
        return False

    success = False
    for sub in subs:
        subscription_info = {
            "endpoint": sub["endpoint"],
            "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}
        }
        try:
            webpush(
                subscription_info=subscription_info,
                data=payload,
                vapid_private_key=priv_key,
                vapid_claims=get_vapid_claims(),
                ttl=3600,
            )
            success = True
        except WebPushException as e:
            if e.response and e.response.status_code in (404, 410):
                try:
                    with get_db() as db:
                        db.execute("DELETE FROM push_subscriptions WHERE id = ?", (sub["id"],))
                        db.commit()
                except Exception:
                    pass
    return success


async def check_and_send_reminders():
    """Check for due reminders and send push notifications."""
    try:
        with get_db() as db:
            rows = db.execute("""
                SELECT r.id, r.todo_id, r.remind_at, COALESCE(r.user_id, t.user_id) AS user_id, t.title, t.status
                FROM reminders r
                JOIN todos t ON r.todo_id = t.id
                WHERE datetime(r.remind_at) <= datetime('now')
                  AND r.sent_at IS NULL
                  AND COALESCE(r.user_id, t.user_id) IS NOT NULL
                  AND t.status IN ('pending', 'in_progress')
                ORDER BY r.remind_at
            """).fetchall()

        for row in rows:
            payload = {
                "id": row["id"],
                "todo_id": row["todo_id"],
                "title": "⏰ Erinnerung",
                "body": row["title"],
                "tag": f"reminder-{row['todo_id']}",
                "url": "/",
                "remind_at": row["remind_at"],
            }
            desktop_success = await manager.broadcast_desktop_notification(
                row["user_id"],
                {"type": "reminder_due", "payload": payload},
            )
            push_success = await send_push_notification(
                user_id=row["user_id"],
                title=payload["title"],
                body=payload["body"],
                tag=payload["tag"],
                url=payload["url"],
                todo_id=row["todo_id"]
            )
            if desktop_success or push_success:
                with get_db() as db:
                    db.execute(
                        "UPDATE reminders SET sent_at = datetime('now') WHERE id = ?",
                        (row["id"],)
                    )
                    db.commit()
    except Exception as e:
        print(f"[PUSH] Reminder check error: {e}")


async def cleanup_subscriptions():
    """Clean up expired push subscriptions."""
    priv_key = get_vapid_private_key()
    payload = json.dumps({"_health_check": True, "_silent": True})

    with get_db() as db:
        subs = db.execute(
            "SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions"
        ).fetchall()

    removed = 0
    total = len(subs)
    for sub in subs:
        subscription_info = {
            "endpoint": sub["endpoint"],
            "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}
        }
        try:
            webpush(
                subscription_info=subscription_info,
                data=payload,
                vapid_private_key=priv_key,
                vapid_claims=get_vapid_claims(),
                ttl=60,
            )
        except WebPushException as e:
            if e.response and e.response.status_code in (404, 410):
                try:
                    with get_db() as db:
                        db.execute("DELETE FROM push_subscriptions WHERE id = ?", (sub["id"],))
                        db.commit()
                        removed += 1
                except Exception:
                    pass

    print(f"[PUSH] Cleanup complete: {removed}/{total} dead subscriptions removed")
