"""SMTP email delivery service."""

import smtplib
from email.message import EmailMessage
from email.utils import formataddr
from typing import Optional

from fastapi import HTTPException

from services.email_config import get_email_config, is_email_configured
from services.email_templates import test_email


def _sender(config: dict) -> str:
    address = config.get("mail_from_address") or ""
    name = config.get("mail_from_name") or "nia-todo"
    return formataddr((name, address)) if name else address


def send_email(*, to: str, subject: str, text: str, html: Optional[str] = None) -> None:
    """Send one email using the configured SMTP server."""
    config = get_email_config(include_secret=True)
    if not is_email_configured():
        raise HTTPException(400, "E-Mail ist nicht konfiguriert")

    message = EmailMessage()
    message["From"] = _sender(config)
    message["To"] = to
    message["Subject"] = subject
    if config.get("mail_reply_to"):
        message["Reply-To"] = config["mail_reply_to"]
    message.set_content(text)
    if html:
        message.add_alternative(html, subtype="html")

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
        raise HTTPException(400, "SMTP-Authentifizierung fehlgeschlagen")
    except (smtplib.SMTPException, OSError) as exc:
        raise HTTPException(400, f"E-Mail konnte nicht gesendet werden: {type(exc).__name__}")


def send_test_email(to: str) -> None:
    subject, text, html = test_email(to=to)
    send_email(to=to, subject=subject, text=text, html=html)
