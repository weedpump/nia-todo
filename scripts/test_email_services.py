#!/usr/bin/env python3
"""Unit-style tests for SMTP/email services with fake SMTP transports."""

import os
import sys
import uuid
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
API_DIR = BASE / "api"
TEST_DB_NAME = f"nia-todo-email-test-{uuid.uuid4().hex}.db"
TEST_DB_PATH = API_DIR / "data" / TEST_DB_NAME

os.environ["NIA_TODO_DB"] = TEST_DB_NAME
sys.path.insert(0, str(API_DIR))

from migrate import run_migrations  # noqa: E402
from services.email_config import get_email_config, update_email_config  # noqa: E402
from services.email import send_email, send_test_email  # noqa: E402
from services.email_templates import email_verification_email, password_setup_email, project_share_invite_email, test_email, two_factor_code_email  # noqa: E402
import services.email as email_service  # noqa: E402


class FakeSMTPBase:
    instances = []

    def __init__(self, host, port, timeout=None):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.events = []
        self.message = None
        self.__class__.instances.append(self)

    def __enter__(self):
        self.events.append("enter")
        return self

    def __exit__(self, exc_type, exc, tb):
        self.events.append("exit")
        return False

    def ehlo(self):
        self.events.append("ehlo")

    def starttls(self):
        self.events.append("starttls")

    def login(self, username, password):
        self.events.append(("login", username, password))

    def send_message(self, message):
        self.events.append("send_message")
        self.message = message


class FakeSMTP(FakeSMTPBase):
    instances = []


class FakeSMTPSSL(FakeSMTPBase):
    instances = []


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def configure_email(*, security="starttls", auth=True):
    update_email_config({
        "smtp_enabled": True,
        "smtp_host": "smtp.example.invalid",
        "smtp_port": 465 if security == "tls" else 587,
        "smtp_security": security,
        "smtp_auth_enabled": auth,
        "smtp_username": "nia@example.invalid" if auth else "",
        "smtp_password_secret": "super-secret" if auth else "",
        "mail_from_address": "todo@example.invalid",
        "mail_from_name": "nia-todo Test",
        "mail_reply_to": "reply@example.invalid",
        "password_link_ttl_hours": 24,
    })


def reset_fakes():
    FakeSMTP.instances.clear()
    FakeSMTPSSL.instances.clear()
    email_service.smtplib.SMTP = FakeSMTP
    email_service.smtplib.SMTP_SSL = FakeSMTPSSL


def test_secret_redaction():
    configure_email(security="starttls", auth=True)
    public_config = get_email_config()
    secret_config = get_email_config(include_secret=True)
    assert_true("smtp_password_secret" not in public_config, "public config leaked smtp_password_secret")
    assert_true(public_config["smtp_password_configured"] is True, "public config did not expose configured flag")
    assert_true(secret_config["smtp_password_secret"] == "super-secret", "secret config lost password")


def test_starttls_auth_send():
    reset_fakes()
    configure_email(security="starttls", auth=True)
    send_email(to="user@example.invalid", subject="Hello", text="Plain", html="<p>HTML</p>")
    assert_true(len(FakeSMTP.instances) == 1, "STARTTLS should use SMTP")
    smtp = FakeSMTP.instances[0]
    assert_true(smtp.host == "smtp.example.invalid" and smtp.port == 587, "SMTP host/port mismatch")
    assert_true("starttls" in smtp.events, "STARTTLS was not called")
    assert_true(("login", "nia@example.invalid", "super-secret") in smtp.events, "SMTP auth was not called")
    assert_true("send_message" in smtp.events, "message was not sent")
    assert_true(smtp.message["From"] == "nia-todo Test <todo@example.invalid>", "From header mismatch")
    assert_true(smtp.message["Reply-To"] == "reply@example.invalid", "Reply-To header mismatch")
    assert_true(smtp.message["To"] == "user@example.invalid", "To header mismatch")


def test_branded_email_templates():
    subject, text, html = password_setup_email(
        display_name="Tobi",
        username="tobi",
        link="https://todo.example.invalid/set-password?token=abc",
        purpose="reset",
        expires_hours=24,
    )
    assert_true(subject == "nia-todo Passwort zurücksetzen", "password reset subject mismatch")
    assert_true("Passwort zurücksetzen" in html and "nia-todo" in html, "branded password HTML missing content")
    assert_true("https://todo.example.invalid/set-password?token=abc" in text, "plain text reset link missing")
    assert_true("Deine Aufgaben. Klar sortiert." in html, "brand tagline missing")

    _, _, invite_html = project_share_invite_email(
        display_name="",
        username="moni",
        project_name="Urlaub",
        inviter_name="Tobi",
        link="https://todo.example.invalid/",
    )
    assert_true("Projektfreigabe erhalten" in invite_html and "Einladung ansehen" in invite_html, "invite template missing action")

    _, code_text, code_html = two_factor_code_email(display_name="", username="tobi", code="123456", purpose="login")
    assert_true("123456" in code_text and "123456" in code_html, "2FA code missing from template")

    _, _, test_html = test_email()
    assert_true("Diese Test-Mail wurde über die aktuell gespeicherte SMTP-Konfiguration versendet." in test_html, "test email detail missing")
    assert_true("<ul" not in test_html and "<li" not in test_html, "single test email detail should not render as bullet list")

    malicious_project = "Bad\r\nBcc: attacker@example.invalid <script>alert(1)</script>"
    subject, _, html = project_share_invite_email(
        display_name='<img src=x onerror=alert(1)>',
        username="user",
        project_name=malicious_project,
        inviter_name='<script>alert(2)</script>',
        link='https://todo.example.invalid/?q=<script>alert(3)</script>',
    )
    assert_true("\r" not in subject and "\n" not in subject, "subject contains CRLF")
    assert_true("Bcc:" in subject and len(subject) <= 140, "subject sanitizing/truncation missing")
    assert_true("<script>" not in html and "&lt;script&gt;" in html, "HTML payload was not escaped")
    assert_true("&lt;img src=x onerror=alert(1)&gt;" in html, "display name was not escaped")


def test_all_system_email_templates_use_split_layout():
    templates = [
        password_setup_email(display_name="Tobi", username="tobi", link="https://todo.example.invalid/set-password?token=abc", purpose="reset", expires_hours=24),
        password_setup_email(display_name="Tobi", username="tobi", link="https://todo.example.invalid/set-password?token=abc", purpose="invite", expires_hours=24),
        email_verification_email(display_name="Tobi", username="tobi", link="https://todo.example.invalid/verify?token=abc", expires_hours=24),
        project_share_invite_email(display_name="", username="moni", project_name="Urlaub", inviter_name="Tobi", link="https://todo.example.invalid/project"),
        two_factor_code_email(display_name="", username="tobi", code="123456", purpose="login"),
        test_email(),
    ]
    for subject, text, html in templates:
        assert_true(subject, "template subject missing")
        assert_true(text, "plain text template missing")
        assert_true('src="cid:nia-todo-logo"' in html, "template logo does not use CID")
        assert_true("<!--[if mso]>" in html, "Outlook/MSO layout missing")
        assert_true("<!--[if !mso]><!-->" in html, "modern layout missing")
        assert_true("modern-hero" in html and "hero-shell" in html, "modern hero layout missing")
        assert_true("v:roundrect" in html and "mso-style-textfill-fill-color:#ffffff" in html, "Outlook hero fallback missing")
        assert_true("Deine Aufgaben. Klar sortiert." in html, "brand tagline missing")


def test_render_system_email_handles_empty_paragraphs():
    from services.email_templates import render_system_email

    subject, text, html = render_system_email(
        subject="Empty Body",
        title="Fallback Title",
        greeting_name="Tobi",
        paragraphs=[],
        preheader=None,
    )
    assert_true(subject == "Empty Body", "subject changed unexpectedly")
    assert_true("Fallback Title" in html, "empty paragraph fallback title missing")
    assert_true("Hallo Tobi" in text, "plain text greeting missing")


def test_send_test_email_uses_branded_template():
    reset_fakes()
    configure_email(security="starttls", auth=True)
    send_test_email("user@example.invalid")
    smtp = FakeSMTP.instances[0]
    html_parts = [part.get_content() for part in smtp.message.walk() if part.get_content_type() == "text/html"]
    rendered = "\n".join(html_parts)
    image_parts = [part for part in smtp.message.walk() if part.get_content_maintype() == "image"]
    assert_true("SMTP funktioniert" in rendered, "test email did not use branded template")
    assert_true("Deine Aufgaben. Klar sortiert." in rendered, "test email brand tagline missing")
    assert_true('src="cid:nia-todo-logo"' in rendered, "test email logo does not use CID source")
    assert_true(len(image_parts) == 1, "test email did not attach exactly one inline image")
    assert_true(image_parts[0]["Content-ID"] == "<nia-todo-logo>", "inline logo Content-ID mismatch")
    assert_true(image_parts[0].get_content_disposition() == "inline", "inline logo should not be a regular attachment")


def test_tls_ssl_send_without_starttls():
    reset_fakes()
    configure_email(security="tls", auth=False)
    send_email(to="user@example.invalid", subject="TLS", text="TLS body")
    assert_true(len(FakeSMTPSSL.instances) == 1, "TLS should use SMTP_SSL")
    assert_true(len(FakeSMTP.instances) == 0, "TLS should not use plain SMTP")
    smtp = FakeSMTPSSL.instances[0]
    assert_true(smtp.port == 465, "SMTP_SSL port mismatch")
    assert_true("starttls" not in smtp.events, "SMTP_SSL must not call STARTTLS")
    assert_true(not any(isinstance(event, tuple) and event[0] == "login" for event in smtp.events), "Auth disabled but login called")
    assert_true("send_message" in smtp.events, "TLS message was not sent")


def main():
    try:
        run_migrations()
        test_secret_redaction()
        test_starttls_auth_send()
        test_branded_email_templates()
        test_all_system_email_templates_use_split_layout()
        test_render_system_email_handles_empty_paragraphs()
        test_send_test_email_uses_branded_template()
        test_tls_ssl_send_without_starttls()
        print("✅ Email service tests passed")
    finally:
        try:
            TEST_DB_PATH.unlink()
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    main()
