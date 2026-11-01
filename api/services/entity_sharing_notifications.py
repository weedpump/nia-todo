"""Generic notification delivery for direct entity-share invitations."""

from starlette.concurrency import run_in_threadpool

from services.audit import log_audit
from services.email import send_email
from services.email_config import can_send_email_links
from services.email_templates import entity_share_invite_email
from services.instance_config import get_public_base_url


async def notify_entity_share_invite(
    *,
    db,
    request,
    target: dict,
    actor: dict,
    entity_type: str,
    entity_id: int,
    entity_name: str,
) -> str:
    """Send the shared invitation email when possible, otherwise keep in-app delivery."""
    if not (
        request is not None
        and can_send_email_links()
        and target.get("email")
        and target.get("email_verified_at")
    ):
        return "in_app"

    details = f"entity_type={entity_type}; entity_id={entity_id}; invited_by={actor.get('id')}"
    try:
        subject, text, html = entity_share_invite_email(
            display_name=str(target.get("display_name") or target.get("username") or ""),
            username=str(target.get("username") or ""),
            entity_type=entity_type,
            entity_name=entity_name,
            inviter_name=str(actor.get("display_name") or actor.get("username") or ""),
            link=get_public_base_url(request, require_configured=True),
            language=target.get("language") or "de",
        )
        await run_in_threadpool(
            send_email,
            to=target["email"],
            subject=subject,
            text=text,
            html=html,
        )
        log_audit(db, "entity_share_email_sent", user_id=target["id"], details=details)
        return "email"
    except Exception:
        log_audit(
            db,
            "entity_share_email_failed",
            user_id=target["id"],
            details=f"{details}; fallback=in_app",
        )
        return "in_app"
