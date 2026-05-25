"""SMTP email delivery service."""

import mimetypes
import smtplib
from email.message import EmailMessage
from email.utils import formataddr
from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from services.email_config import get_email_config, is_email_configured
from services.email_templates import LOGO_CID, test_email

BASE_DIR = Path(__file__).resolve().parents[2]
LOGO_PATH = BASE_DIR / "web" / "static" / "icons" / "icon-192.png"


def _sender(config: dict) -> str:
    address = config.get("mail_from_address") or ""
    name = config.get("mail_from_name") or "nia-todo"
    return formataddr((name, address)) if name else address


def _attach_inline_logo(message: EmailMessage, html_part: EmailMessage, html: str) -> None:
    """Attach the app logo as CID image for broad mail-client compatibility."""
    if f"cid:{LOGO_CID}" not in html or not LOGO_PATH.exists():
        return

    content_type, _ = mimetypes.guess_type(LOGO_PATH.name)
    maintype, subtype = (content_type or "image/png").split("/", 1)
    html_part.add_related(
        LOGO_PATH.read_bytes(),
        maintype=maintype,
        subtype=subtype,
        cid=f"<{LOGO_CID}>",
    )


def send_email(*, to: str, subject: str, text: str, html: Optional[str] = None) -> None:
    """Send one email using the configured SMTP server."""
    config = get_email_config(include_secret=True)
    if not is_email_configured():
        raise HTTPException(400, "Email is not configured")

    message = EmailMessage()
    message["From"] = _sender(config)
    message["To"] = to
    message["Subject"] = subject
    if config.get("mail_reply_to"):
        message["Reply-To"] = config["mail_reply_to"]
    message.set_content(text)
    if html:
        message.add_alternative(html, subtype="html")
        html_part = message.get_payload()[-1]
        _attach_inline_logo(message, html_part, html)

    host = config["smtp_host"]
    port = int(config["smtp_port"])
    security = config["smtp_security"]

    try:
        if security == "tls":
            smtp = smtplib.SMTP_SSL(host, port, timeout=15)
        else:
            smtp = smtplib.SMTP(host, port, timeout=15)
        with smtp:
            smtp.ehlo()
            if security == "starttls":
                smtp.starttls()
                smtp.ehlo()
            if config.get("smtp_auth_enabled"):
                smtp.login(config.get("smtp_username") or "", config.get("smtp_password_secret") or "")
            smtp.send_message(message)
    except smtplib.SMTPAuthenticationError:
        raise HTTPException(400, "SMTP authentication failed")
    except (smtplib.SMTPException, OSError) as exc:
        raise HTTPException(400, f"Email could not be sent: {type(exc).__name__}")


def send_test_email(to: str) -> None:
    subject, text, html = test_email(to=to)
    send_email(to=to, subject=subject, text=text, html=html)
