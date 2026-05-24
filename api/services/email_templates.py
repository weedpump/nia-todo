"""Shared HTML/text email templates for nia-todo system emails."""

from __future__ import annotations

from html import escape
from urllib.parse import urljoin

try:
    from services.instance_config import get_instance_config
except Exception:  # pragma: no cover - keeps template rendering usable in isolated import contexts
    get_instance_config = None

BRAND_NAME = "nia-todo"
BRAND_COLOR = "#6366f1"
BRAND_COLOR_DARK = "#4f46e5"
TEXT_COLOR = "#0f172a"
MUTED_COLOR = "#64748b"
BORDER_COLOR = "#e2e8f0"
BG_COLOR = "#f1f5f9"


def _instance_base_url() -> str:
    if not get_instance_config:
        return ""
    try:
        return str(get_instance_config().get("public_base_url") or "").rstrip("/")
    except Exception:
        return ""


def _logo_url() -> str:
    base_url = _instance_base_url()
    if not base_url:
        return ""
    return urljoin(f"{base_url}/", "static/icons/icon-192.png")


def _button_html(label: str, url: str) -> str:
    safe_label = escape(label)
    safe_url = escape(url, quote=True)
    return f"""
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 24px;">
        <tr>
          <td bgcolor="{BRAND_COLOR}" style="border-radius:14px;box-shadow:0 10px 22px rgba(99,102,241,.26);">
            <a href="{safe_url}" style="display:inline-block;padding:14px 22px;border-radius:14px;color:#ffffff;background:{BRAND_COLOR};font-size:15px;font-weight:800;text-decoration:none;letter-spacing:.01em;">
              {safe_label}
            </a>
          </td>
        </tr>
      </table>
    """.strip()


def _text_email(*, greeting: str, paragraphs: list[str], action_label: str | None = None, action_url: str | None = None, details: list[str] | None = None) -> str:
    parts = [greeting, *paragraphs]
    if action_label and action_url:
        parts.append(f"{action_label}:\n{action_url}")
    if details:
        parts.extend(details)
    parts.append("Diese Mail wurde automatisch von nia-todo gesendet.")
    return "\n\n".join(part.strip() for part in parts if part and part.strip())


def _fallback_link_html(link: str) -> str:
    safe_link = escape(link)
    safe_href = escape(link, quote=True)
    return (
        f'<p style="margin:18px 0 0;color:{MUTED_COLOR};font-size:13px;line-height:1.55;">'
        'Falls der Button nicht funktioniert, kopiere diesen Link:<br>'
        f'<a href="{safe_href}" style="color:{BRAND_COLOR_DARK};word-break:break-all;text-decoration:underline;">{safe_link}</a>'
        '</p>'
    )


def _detail_box(items: list[str]) -> str:
    if not items:
        return ""
    rows = "".join(
        f'<li style="margin:6px 0;color:{MUTED_COLOR};font-size:13px;line-height:1.45;">{escape(item)}</li>'
        for item in items
    )
    return (
        f'<div style="margin:22px 0 0;padding:14px 16px;border:1px solid {BORDER_COLOR};border-radius:14px;background:#f8fafc;">'
        f'<ul style="margin:0;padding-left:18px;">{rows}</ul>'
        '</div>'
    )


def _layout(*, title: str, preheader: str, body_html: str) -> str:
    logo = _logo_url()
    logo_html = (
        f'<img src="{escape(logo, quote=True)}" width="44" height="44" alt="nia-todo" style="display:block;border:0;border-radius:13px;">'
        if logo else
        f'<div style="width:44px;height:44px;border-radius:13px;background:linear-gradient(135deg,{BRAND_COLOR},#8b5cf6);color:#fff;font-size:24px;line-height:44px;text-align:center;font-weight:900;">✓</div>'
    )
    return f"""<!doctype html>
<html lang="de">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{escape(title)}</title>
  </head>
  <body style="margin:0;padding:0;background:{BG_COLOR};color:{TEXT_COLOR};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.5;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">{escape(preheader)}</div>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:{BG_COLOR};margin:0;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:620px;margin:0 auto;">
            <tr>
              <td style="padding:0 0 14px 4px;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="vertical-align:middle;padding-right:12px;">{logo_html}</td>
                    <td style="vertical-align:middle;">
                      <div style="font-size:18px;font-weight:900;color:{TEXT_COLOR};letter-spacing:-.02em;">{BRAND_NAME}</div>
                      <div style="font-size:12px;color:{MUTED_COLOR};">Deine Aufgaben. Klar sortiert.</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="background:#ffffff;border:1px solid {BORDER_COLOR};border-radius:24px;padding:34px 32px;box-shadow:0 18px 45px rgba(15,23,42,.08);">
                <h1 style="margin:0 0 18px;font-size:26px;line-height:1.18;letter-spacing:-.035em;color:{TEXT_COLOR};">{escape(title)}</h1>
                {body_html}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 8px 0;text-align:center;color:{MUTED_COLOR};font-size:12px;line-height:1.45;">
                Diese Mail wurde automatisch von nia-todo gesendet.<br>
                Wenn du sie nicht erwartet hast, kannst du sie ignorieren.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>""".strip()


def render_system_email(
    *,
    subject: str,
    title: str,
    greeting_name: str,
    paragraphs: list[str],
    action_label: str | None = None,
    action_url: str | None = None,
    details: list[str] | None = None,
    preheader: str | None = None,
) -> tuple[str, str, str]:
    """Return subject, plain text and branded HTML for a nia-todo system email."""
    safe_name = greeting_name.strip() if greeting_name else "du"
    greeting = f"Hallo {safe_name},"
    text = _text_email(greeting=greeting, paragraphs=paragraphs, action_label=action_label, action_url=action_url, details=details)
    body = [f'<p style="margin:0 0 16px;font-size:16px;color:{TEXT_COLOR};">Hallo {escape(safe_name)},</p>']
    for paragraph in paragraphs:
        body.append(f'<p style="margin:0 0 16px;font-size:16px;color:{TEXT_COLOR};">{escape(paragraph)}</p>')
    if action_label and action_url:
        body.append(_button_html(action_label, action_url))
        body.append(_fallback_link_html(action_url))
    body.append(_detail_box(details or []))
    html = _layout(title=title, preheader=preheader or paragraphs[0], body_html="".join(body))
    return subject, text, html


def project_share_invite_email(*, display_name: str, username: str, project_name: str, inviter_name: str, link: str) -> tuple[str, str, str]:
    safe_name = display_name or username
    return render_system_email(
        subject=f"Projektfreigabe: {project_name}",
        title="Projektfreigabe erhalten",
        greeting_name=safe_name,
        paragraphs=[f"{inviter_name} hat das Projekt „{project_name}“ mit dir geteilt."],
        action_label="Einladung ansehen",
        action_url=link,
        details=["Du kannst die Einladung in nia-todo annehmen oder ablehnen."],
        preheader=f"{inviter_name} hat ein Projekt mit dir geteilt.",
    )


def email_verification_email(*, display_name: str, username: str, link: str, expires_hours: int) -> tuple[str, str, str]:
    safe_name = display_name or username
    return render_system_email(
        subject="nia-todo E-Mail bestätigen",
        title="E-Mail-Adresse bestätigen",
        greeting_name=safe_name,
        paragraphs=["Bitte bestätige diese E-Mail-Adresse für deinen nia-todo Account."],
        action_label="E-Mail bestätigen",
        action_url=link,
        details=[f"Der Link ist {expires_hours} Stunden gültig.", "Wenn du diese Änderung nicht angefordert hast, ignoriere diese Mail."],
        preheader="Bestätige deine E-Mail-Adresse für nia-todo.",
    )


def password_setup_email(*, display_name: str, username: str, link: str, purpose: str, expires_hours: int) -> tuple[str, str, str]:
    """Return subject, text, html for invite/reset setup links."""
    safe_name = display_name or username
    is_invite = purpose == "invite"
    return render_system_email(
        subject="Dein nia-todo Zugang" if is_invite else "nia-todo Passwort zurücksetzen",
        title="Willkommen bei nia-todo" if is_invite else "Passwort zurücksetzen",
        greeting_name=safe_name,
        paragraphs=["Für deinen nia-todo Zugang wurde ein Setup-Link erstellt." if is_invite else "Für deinen nia-todo Account wurde ein Passwort-Link erstellt."],
        action_label="Passwort setzen" if is_invite else "Passwort zurücksetzen",
        action_url=link,
        details=[f"Der Link ist {expires_hours} Stunden gültig.", "Wenn du das nicht erwartet hast, ignoriere diese Mail."],
        preheader="Richte deinen nia-todo Zugang ein." if is_invite else "Setze dein nia-todo Passwort zurück.",
    )


def two_factor_code_email(*, display_name: str, username: str, code: str, purpose: str = "login", expires_minutes: int = 10) -> tuple[str, str, str]:
    safe_name = display_name or username
    is_reauth = purpose == "reauth"
    label = "Sicherheits-Code" if is_reauth else "Login-Code"
    return render_system_email(
        subject="Dein nia-todo Reauth-Code" if is_reauth else "Dein nia-todo 2FA-Code",
        title=label,
        greeting_name=safe_name,
        paragraphs=[f"Dein {label} lautet: {code}"],
        details=[f"Der Code ist {expires_minutes} Minuten gültig.", "Tipp: Du kannst in den Einstellungen zusätzlich einen Authenticator oder Passkey einrichten."],
        preheader=f"Dein nia-todo {label}: {code}",
    )


def test_email(*, to: str | None = None) -> tuple[str, str, str]:
    return render_system_email(
        subject="nia-todo SMTP Test",
        title="SMTP funktioniert",
        greeting_name="du",
        paragraphs=["Wenn du diese Mail siehst, funktioniert die SMTP-Konfiguration von nia-todo."],
        details=["Diese Test-Mail wurde über die aktuell gespeicherte SMTP-Konfiguration versendet."],
        preheader="Die SMTP-Konfiguration von nia-todo funktioniert.",
    )
