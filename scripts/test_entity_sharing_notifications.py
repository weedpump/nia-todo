#!/usr/bin/env python3
"""Entity-share notifications are generic and fail open to in-app delivery."""

import asyncio
import os
import sys
import tempfile
from pathlib import Path

from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory() as tmp:
    os.environ["NIA_TODO_DATA_DIR"] = tmp
    sys.path.insert(0, str(ROOT / "api"))

    from db import get_db
    from migrate import run_migrations
    import services.entity_sharing_notifications as notifications
    from services.email_templates import EMAIL_COPY, entity_share_invite_email

    # The registry-backed cookbook label must be localized and escaped by the
    # same notification template used by existing container types.
    for language, copy in EMAIL_COPY.items():
        subject, text, html = entity_share_invite_email(
            display_name="Recipient", username="recipient", entity_type="cookbook",
            entity_name="Family <&> recipes", inviter_name="Owner",
            link="https://nia.example.invalid/", language=language,
        )
        assert copy["entity_type_cookbook"] in text, language
        assert "Family <&> recipes" in text, language
        assert "Family &lt;&amp;&gt; recipes" in html, language
        assert "Family <&> recipes" not in html, language

    run_migrations()
    with get_db() as db:
        actor_id = db.execute(
            "INSERT INTO users (username, display_name) VALUES ('owner', 'Owner Name')"
        ).lastrowid
        target_id = db.execute(
            """INSERT INTO users
               (username, display_name, email, email_verified_at, language)
               VALUES ('target', 'Target Name', 'target@example.invalid', datetime('now'), 'de')"""
        ).lastrowid
        db.commit()
        actor = dict(db.execute("SELECT * FROM users WHERE id = ?", (actor_id,)).fetchone())
        target = dict(db.execute("SELECT * FROM users WHERE id = ?", (target_id,)).fetchone())

        sent = []
        audits = []
        notifications.can_send_email_links = lambda: True
        notifications.get_public_base_url = lambda request, require_configured=True: "https://nia.example.invalid/"
        notifications.send_email = lambda **payload: sent.append(payload)
        notifications.log_audit = lambda db, event_type, **kwargs: audits.append((event_type, kwargs))
        request = Request({
            "type": "http",
            "method": "POST",
            "path": "/",
            "headers": [],
            "scheme": "https",
            "server": ("nia.example.invalid", 443),
            "client": ("127.0.0.1", 1),
            "query_string": b"",
        })

        delivery = asyncio.run(notifications.notify_entity_share_invite(
            db=db,
            request=request,
            target=target,
            actor=actor,
            entity_type="shopping_list",
            entity_id=41,
            entity_name="Weekly groceries",
        ))
        assert delivery == "email", delivery
        assert len(sent) == 1, sent
        assert sent[0]["to"] == "target@example.invalid", sent
        assert "Weekly groceries" in sent[0]["subject"], sent
        assert "Einkaufsliste" in sent[0]["text"], sent
        assert audits[0][0] == "entity_share_email_sent", audits
        assert "entity_type=shopping_list" in audits[0][1]["details"], audits

        sent.clear()
        audits.clear()
        notifications.send_email = lambda **payload: (_ for _ in ()).throw(RuntimeError("smtp down"))
        delivery = asyncio.run(notifications.notify_entity_share_invite(
            db=db,
            request=request,
            target=target,
            actor=actor,
            entity_type="project",
            entity_id=42,
            entity_name="Launch",
        ))
        assert delivery == "in_app", delivery
        assert audits[0][0] == "entity_share_email_failed", audits

        notifications.can_send_email_links = lambda: False
        audits.clear()
        delivery = asyncio.run(notifications.notify_entity_share_invite(
            db=db,
            request=request,
            target=target,
            actor=actor,
            entity_type="project",
            entity_id=43,
            entity_name="No SMTP",
        ))
        assert delivery == "in_app", delivery
        assert audits == [], audits

        notifications.can_send_email_links = lambda: True
        notifications.get_public_base_url = lambda request, require_configured=True: (_ for _ in ()).throw(RuntimeError("missing URL"))
        audits.clear()
        delivery = asyncio.run(notifications.notify_entity_share_invite(
            db=db,
            request=request,
            target=target,
            actor=actor,
            entity_type="shopping_list",
            entity_id=44,
            entity_name="URL fallback",
        ))
        assert delivery == "in_app", delivery
        assert audits[0][0] == "entity_share_email_failed", audits

print("✅ Generic entity-share notifications passed")
