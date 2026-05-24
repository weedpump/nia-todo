"""Shared HTML/text email templates for nia-todo system emails."""

from __future__ import annotations

from html import escape

BRAND_NAME = "nia-todo"
BRAND_COLOR = "#6366f1"
BRAND_COLOR_DARK = "#4f46e5"
BRAND_ACCENT = "#8b5cf6"
TEXT_COLOR = "#0f172a"
MUTED_COLOR = "#64748b"
BORDER_COLOR = "#e2e8f0"
BG_COLOR = "#eef2ff"
PANEL_BG = "#ffffff"
LOGO_CID = "nia-todo-logo"
MAX_SUBJECT_LENGTH = 140


def _clean_subject(value: str) -> str:
    """Return a single-line, reasonably sized e-mail subject."""
    cleaned = " ".join(str(value or "").split())
    if len(cleaned) <= MAX_SUBJECT_LENGTH:
        return cleaned
    return cleaned[: MAX_SUBJECT_LENGTH - 1].rstrip() + "…"


def _logo_src() -> str:
    """Prefer CID logos because most mail clients block remote images and dislike data URIs."""
    return f"cid:{LOGO_CID}"


def _button_html(label: str, url: str) -> str:
    safe_label = escape(label)
    safe_url = escape(url, quote=True)
    return f"""
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 22px;">
        <tr>
          <td bgcolor="{BRAND_COLOR}" style="border-radius:16px;background:{BRAND_COLOR};box-shadow:0 12px 26px rgba(79,70,229,.28);">
            <a href="{safe_url}" style="display:inline-block;padding:14px 24px;border-radius:16px;color:#ffffff;background:{BRAND_COLOR};font-size:15px;font-weight:800;text-decoration:none;letter-spacing:.01em;">
              {safe_label} →
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
        f'<p style="margin:18px 0 0;color:{MUTED_COLOR};font-size:13px;line-height:1.6;">'
        'Falls der Button nicht funktioniert, kopiere diesen Link:<br>'
        f'<a href="{safe_href}" style="color:{BRAND_COLOR_DARK};word-break:break-all;text-decoration:underline;">{safe_link}</a>'
        '</p>'
    )


def _detail_box(items: list[str]) -> str:
    if not items:
        return ""
    rows = "".join(
        f'<li style="margin:7px 0;color:#475569;font-size:14px;line-height:1.5;">{escape(item)}</li>'
        for item in items
    )
    return (
        f'<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:24px 0 0;">'
        '<tr>'
        f'<td style="padding:15px 17px;border:1px solid {BORDER_COLOR};border-radius:16px;background:#f8fafc;">'
        f'<ul style="margin:0;padding-left:19px;">{rows}</ul>'
        '</td>'
        '</tr>'
        '</table>'
    )


def _layout(*, title: str, preheader: str, body_html: str) -> str:
    logo_html = (
        f'<img src="{escape(_logo_src(), quote=True)}" width="48" height="48" alt="nia-todo" '
        'style="display:block;width:48px;height:48px;border:0;border-radius:15px;outline:none;text-decoration:none;">'
    )
    return f"""<!doctype html>
<html lang="de">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>{escape(title)}</title>
  </head>
  <body style="margin:0;padding:0;background:{BG_COLOR};color:{TEXT_COLOR};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">{escape(preheader)}</div>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:{BG_COLOR};margin:0;padding:34px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:640px;margin:0 auto;">
            <tr>
              <td style="padding:0 0 16px;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#ffffff;border:1px solid rgba(226,232,240,.9);border-radius:22px;padding:14px 16px;box-shadow:0 14px 35px rgba(15,23,42,.06);">
                  <tr>
                    <td style="vertical-align:middle;width:48px;padding-right:13px;">{logo_html}</td>
                    <td style="vertical-align:middle;">
                      <div style="font-size:19px;font-weight:900;color:{TEXT_COLOR};letter-spacing:-.025em;line-height:1.15;">{BRAND_NAME}</div>
                      <div style="font-size:12px;color:{MUTED_COLOR};line-height:1.35;margin-top:3px;">Deine Aufgaben. Klar sortiert.</div>
                    </td>
                    <td align="right" style="vertical-align:middle;color:{BRAND_COLOR_DARK};font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;">System-Mail</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="overflow:hidden;background:{PANEL_BG};border:1px solid {BORDER_COLOR};border-radius:28px;box-shadow:0 24px 60px rgba(15,23,42,.10);">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                  <tr>
                    <td style="height:7px;background:{BRAND_COLOR};background-image:linear-gradient(90deg,{BRAND_COLOR}, {BRAND_ACCENT});font-size:0;line-height:0;">&nbsp;</td>
                  </tr>
                  <tr>
                    <td style="padding:36px 34px 32px;">
                      <div style="display:inline-block;margin:0 0 14px;padding:6px 10px;border-radius:999px;background:#eef2ff;color:{BRAND_COLOR_DARK};font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;">nia-todo</div>
                      <h1 style="margin:0 0 18px;font-size:29px;line-height:1.14;letter-spacing:-.04em;color:{TEXT_COLOR};font-weight:900;">{escape(title)}</h1>
                      {body_html}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 8px 0;text-align:center;color:{MUTED_COLOR};font-size:12px;line-height:1.5;">
                Automatisch gesendet von <strong style="color:#475569;">nia-todo</strong>.<br>
                Wenn du diese Mail nicht erwartet hast, kannst du sie ignorieren.
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
    cleaned_subject = _clean_subject(subject)
    safe_paragraphs = [str(paragraph) for paragraph in paragraphs if str(paragraph).strip()]
    text = _text_email(greeting=greeting, paragraphs=safe_paragraphs, action_label=action_label, action_url=action_url, details=details)
    body = [f'<p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:{TEXT_COLOR};">Hallo {escape(safe_name)},</p>']
    for paragraph in safe_paragraphs:
        body.append(f'<p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:{TEXT_COLOR};">{escape(paragraph)}</p>')
    if action_label and action_url:
        body.append(_button_html(action_label, action_url))
        body.append(_fallback_link_html(action_url))
    body.append(_detail_box(details or []))
    html = _layout(title=title, preheader=preheader or (safe_paragraphs[0] if safe_paragraphs else title), body_html="".join(body))
    return cleaned_subject, text, html


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
