"""Shared HTML/text email templates for nia-todo system emails."""

from __future__ import annotations

from html import escape

BRAND_NAME = "nia-todo"
TEXT_COLOR = "#0f172a"
MUTED_COLOR = "#64748b"
LINK_COLOR = "#4f46e5"
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


def _text_email(*, greeting: str, paragraphs: list[str], action_label: str | None = None, action_url: str | None = None, details: list[str] | None = None) -> str:
    parts = [greeting, *paragraphs]
    if action_label and action_url:
        parts.append(f"{action_label}:\n{action_url}")
    if details:
        parts.extend(details)
    parts.append("Diese Mail wurde automatisch von nia-todo gesendet.")
    return "\n\n".join(part.strip() for part in parts if part and part.strip())


def _modern_button_html(label: str, url: str) -> str:
    safe_label = escape(label)
    safe_url = escape(url, quote=True)
    return f"""
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 18px;">
        <tr>
          <td class="modern-button" bgcolor="#111827" style="border-radius:14px;background:#111827;">
            <a href="{safe_url}" style="display:inline-block;padding:13px 22px;border-radius:14px;color:#ffffff;background:#111827;font-size:15px;font-weight:800;text-decoration:none;letter-spacing:.01em;">
              {safe_label} →
            </a>
          </td>
        </tr>
      </table>
    """.strip()


def _modern_fallback_link_html(link: str) -> str:
    safe_link = escape(link)
    safe_href = escape(link, quote=True)
    return (
        f'<p style="margin:18px 0 0;color:{MUTED_COLOR};font-size:13px;line-height:1.6;">'
        'Falls der Button nicht funktioniert, kopiere diesen Link:<br>'
        f'<a href="{safe_href}" style="color:{LINK_COLOR};word-break:break-all;text-decoration:underline;">{safe_link}</a>'
        '</p>'
    )


def _outlook_action_link_html(label: str, url: str) -> str:
    safe_label = escape(label)
    safe_url = escape(url, quote=True)
    return (
        '<p style="margin:28px 0 18px;font-family:Arial,sans-serif;font-size:16px;line-height:24px;font-weight:bold;">'
        f'<a href="{safe_url}" style="color:{LINK_COLOR};text-decoration:underline;font-weight:bold;">{safe_label} →</a>'
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
        '<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:24px 0 0;">'
        '<tr>'
        '<td style="padding:15px 17px;border:1px solid #e2e8f0;border-radius:16px;background:#f8fafc;">'
        f'<ul style="margin:0;padding-left:19px;">{rows}</ul>'
        '</td>'
        '</tr>'
        '</table>'
    )


def _modern_body_html(*, safe_name: str, paragraphs: list[str], action_label: str | None, action_url: str | None, details: list[str]) -> str:
    body = [f'<p style="margin:0 0 16px;font-size:16px;line-height:1.7;color:#334155;">Hallo {escape(safe_name)},</p>']
    for paragraph in paragraphs:
        body.append(f'<p style="margin:0 0 16px;font-size:16px;line-height:1.7;color:#334155;">{escape(paragraph)}</p>')
    if action_label and action_url:
        body.append(_modern_button_html(action_label, action_url))
        body.append(_modern_fallback_link_html(action_url))
    body.append(_detail_box(details))
    return "".join(body)


def _outlook_body_html(*, safe_name: str, paragraphs: list[str], action_label: str | None, action_url: str | None, details: list[str]) -> str:
    body = [f'<p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:16px;line-height:27px;color:#334155;">Hallo {escape(safe_name)},</p>']
    for paragraph in paragraphs:
        body.append(f'<p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:16px;line-height:27px;color:#334155;">{escape(paragraph)}</p>')
    if action_label and action_url:
        body.append(_outlook_action_link_html(action_label, action_url))
    body.append(_detail_box(details))
    return "".join(body)


def _layout(*, title: str, preheader: str, modern_body_html: str, outlook_body_html: str) -> str:
    safe_title = escape(title)
    safe_preheader = escape(preheader)
    logo_src = escape(_logo_src(), quote=True)
    return f"""<!doctype html>
<html lang="de">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>{safe_title}</title>
  <style>
    @media (prefers-color-scheme: dark) {{
      .modern-wrap {{ background:#0b1020 !important; }}
      .hero-shell {{ padding:0 !important; background:#0b1020 !important; }}
      .modern-hero {{
        background:#18213f !important;
        background-image:linear-gradient(135deg,#18213f 0%,#1e1b4b 100%) !important;
        border-radius:0 0 30px 30px !important;
        box-shadow:0 1px 0 rgba(199,210,254,.18),0 18px 42px rgba(0,0,0,.42) !important;
      }}
      .modern-body, .modern-footer {{ background:#0b1020 !important; }}
      .modern-button {{ background:#1e293b !important; box-shadow:0 0 0 1px rgba(199,210,254,.22) !important; }}
      .modern-button a {{ background:#1e293b !important; color:#ffffff !important; }}
    }}
  </style>
  <!--[if mso]>
  <style type="text/css">
    table {{ border-collapse: collapse; border-spacing: 0; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }}
    td, p, a, div {{ font-family: Arial, sans-serif !important; mso-line-height-rule: exactly; }}
  </style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:{TEXT_COLOR};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">{safe_preheader}</div>
  <!--[if mso]>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#ffffff;border-collapse:collapse;">
    <tr><td align="center" style="padding:28px 0 34px;background:#ffffff;">
      <table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:640px;border-collapse:collapse;">
        <tr><td style="padding:0;">
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" style="height:214px;v-text-anchor:top;width:640px;" arcsize="14%" stroke="f" fillcolor="#111827">
            <v:fill color="#111827"/>
            <v:textbox inset="28px,30px,28px,30px">
              <table role="presentation" width="584" cellspacing="0" cellpadding="0" border="0" style="width:584px;border-collapse:collapse;">
                <tr>
                  <td width="48" valign="middle" style="width:48px;padding:0;vertical-align:middle;"><img src="{logo_src}" width="48" height="48" alt="nia-todo" style="display:block;width:48px;height:48px;border:0;outline:none;text-decoration:none;"></td>
                  <td valign="middle" style="padding:0 0 0 13px;vertical-align:middle;">
                    <div style="font-family:Arial,sans-serif;font-size:18px;line-height:21px;font-weight:bold;color:#ffffff;mso-style-textfill-type:solid;mso-style-textfill-fill-color:#ffffff;mso-style-textfill-fill-alpha:100000;">{BRAND_NAME}</div>
                    <div style="font-family:Arial,sans-serif;font-size:13px;line-height:18px;color:#dbe4ff;mso-style-textfill-type:solid;mso-style-textfill-fill-color:#dbe4ff;mso-style-textfill-fill-alpha:100000;">Deine Aufgaben. Klar sortiert.</div>
                  </td>
                </tr>
              </table>
              <table role="presentation" width="584" cellspacing="0" cellpadding="0" border="0" style="width:584px;border-collapse:collapse;"><tr><td height="30" style="height:30px;line-height:30px;font-size:0;">&nbsp;</td></tr></table>
              <div style="font-family:Arial,sans-serif;font-size:12px;line-height:16px;font-weight:bold;color:#dbe4ff;mso-style-textfill-type:solid;mso-style-textfill-fill-color:#dbe4ff;mso-style-textfill-fill-alpha:100000;">SYSTEM-MAIL</div>
              <table role="presentation" width="584" cellspacing="0" cellpadding="0" border="0" style="width:584px;border-collapse:collapse;"><tr><td height="10" style="height:10px;line-height:10px;font-size:0;">&nbsp;</td></tr></table>
              <div style="font-family:Arial,sans-serif;font-size:32px;line-height:36px;font-weight:bold;color:#ffffff;mso-style-textfill-type:solid;mso-style-textfill-fill-color:#ffffff;mso-style-textfill-fill-alpha:100000;">{safe_title}</div>
            </v:textbox>
          </v:roundrect>
        </td></tr>
        <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:30px 28px 24px;">
          {outlook_body_html}
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;"><tr><td style="border-top:1px solid #e5e7eb;padding:16px 0 0;font-family:Arial,sans-serif;font-size:14px;line-height:22px;color:#64748b;">Wenn du diese Mail nicht erwartet hast, kannst du sie ignorieren.</td></tr></table>
        </td></tr>
        <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:0 28px 32px;font-family:Arial,sans-serif;font-size:12px;line-height:18px;color:#94a3b8;">Automatisch gesendet von nia-todo.</td></tr>
      </table>
    </td></tr>
  </table>
  <![endif]-->
  <!--[if !mso]><!-->
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="modern-wrap" style="background:#ffffff;padding:0;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;margin:0 auto;">
        <tr><td class="hero-shell" style="padding:0;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr><td class="modern-hero" style="padding:34px 28px 30px;background:#111827;background-image:linear-gradient(135deg,#111827 0%,#1e1b4b 100%);border-radius:0 0 30px 30px;color:#ffffff;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
                <td style="width:48px;vertical-align:middle;"><img src="{logo_src}" width="48" height="48" alt="nia-todo" style="display:block;border:0;border-radius:14px;"></td>
                <td style="padding-left:13px;vertical-align:middle;"><div style="font-size:18px;font-weight:900;letter-spacing:-.025em;color:#ffffff;line-height:1.15;">{BRAND_NAME}</div><div style="font-size:13px;color:#c7d2fe;line-height:1.35;margin-top:3px;">Deine Aufgaben. Klar sortiert.</div></td>
              </tr></table>
              <div style="height:30px;line-height:30px;font-size:0;">&nbsp;</div>
              <div style="font-size:12px;color:#c7d2fe;font-weight:800;text-transform:uppercase;letter-spacing:.10em;margin-bottom:10px;">System-Mail</div>
              <h1 style="margin:0;font-size:32px;line-height:1.08;letter-spacing:-.05em;color:#ffffff;font-weight:900;">{safe_title}</h1>
            </td></tr>
          </table>
        </td></tr>
        <tr><td class="modern-body" style="padding:30px 28px 24px;background:#ffffff;">
          {modern_body_html}
        </td></tr>
        <tr><td class="modern-footer" style="padding:0 28px 32px;background:#ffffff;color:#94a3b8;font-size:12px;line-height:1.5;">Automatisch gesendet von nia-todo.<br>Wenn du diese Mail nicht erwartet hast, kannst du sie ignorieren.</td></tr>
      </table>
    </td></tr>
  </table>
  <!--<![endif]-->
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
    safe_details = [str(item) for item in (details or []) if str(item).strip()]
    text = _text_email(greeting=greeting, paragraphs=safe_paragraphs, action_label=action_label, action_url=action_url, details=safe_details)
    modern_body = _modern_body_html(safe_name=safe_name, paragraphs=safe_paragraphs, action_label=action_label, action_url=action_url, details=safe_details)
    outlook_body = _outlook_body_html(safe_name=safe_name, paragraphs=safe_paragraphs, action_label=action_label, action_url=action_url, details=safe_details)
    html = _layout(
        title=title,
        preheader=preheader or (safe_paragraphs[0] if safe_paragraphs else title),
        modern_body_html=modern_body,
        outlook_body_html=outlook_body,
    )
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
