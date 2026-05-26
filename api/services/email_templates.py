"""Shared HTML/text email templates for nia-todo system emails."""

from __future__ import annotations

from html import escape

BRAND_NAME = "nia-todo"
TEXT_COLOR = "#0f172a"
MUTED_COLOR = "#64748b"
LINK_COLOR = "#4f46e5"
LOGO_CID = "nia-todo-logo"
MAX_SUBJECT_LENGTH = 140


EMAIL_COPY = {
    "de": {
        "auto_sent": "Diese E-Mail wurde automatisch von nia-todo gesendet.",
        "button_fallback": "Falls der Button nicht funktioniert, kopiere diesen Link:",
        "link_fallback": "Falls der Link nicht funktioniert, kopiere diese Adresse:",
        "greeting": "Hallo {name},",
        "greeting_default": "du",
        "tagline": "Deine Aufgaben. Klar sortiert.",
        "system_mail": "System-E-Mail",
        "unexpected": "Wenn du diese E-Mail nicht erwartet hast, kannst du sie ignorieren.",
        "project_share_subject": "Projektfreigabe: {project_name}",
        "project_share_title": "Projektfreigabe erhalten",
        "project_share_paragraph": "{inviter_name} hat das Projekt \"{project_name}\" mit dir geteilt.",
        "project_share_action": "Einladung ansehen",
        "project_share_detail": "Du kannst die Einladung in nia-todo annehmen oder ablehnen.",
        "project_share_preheader": "{inviter_name} hat ein Projekt mit dir geteilt.",
        "email_verify_subject": "nia-todo E-Mail bestätigen",
        "email_verify_title": "E-Mail-Adresse bestätigen",
        "email_verify_paragraph": "Bitte bestätige diese E-Mail-Adresse für dein nia-todo-Konto.",
        "email_verify_action": "E-Mail bestätigen",
        "link_expires_hours": "Der Link ist {hours} Stunden gültig.",
        "email_verify_unexpected": "Wenn du diese Änderung nicht angefordert hast, ignoriere diese E-Mail.",
        "email_verify_preheader": "Bestätige deine E-Mail-Adresse für nia-todo.",
        "password_invite_subject": "Dein nia-todo-Zugang",
        "password_reset_subject": "nia-todo Passwort zurücksetzen",
        "password_invite_title": "Willkommen bei nia-todo",
        "password_reset_title": "Passwort zurücksetzen",
        "password_invite_paragraph": "Für deinen nia-todo-Zugang wurde ein Einrichtungslink erstellt.",
        "password_reset_paragraph": "Für dein nia-todo-Konto wurde ein Passwort-Link erstellt.",
        "password_invite_action": "Passwort festlegen",
        "password_reset_action": "Passwort zurücksetzen",
        "password_unexpected": "Wenn du das nicht erwartet hast, ignoriere diese E-Mail.",
        "password_invite_preheader": "Richte deinen nia-todo-Zugang ein.",
        "password_reset_preheader": "Setze dein nia-todo-Passwort zurück.",
        "security_code": "Sicherheitscode",
        "login_code": "Login-Code",
        "reauth_subject": "Dein nia-todo Reauth-Code",
        "twofa_subject": "Dein nia-todo 2FA-Code",
        "code_paragraph": "Dein {label} lautet:",
        "code_expires_minutes": "Der Code ist {minutes} Minuten gültig.",
        "code_tip": "Tipp: Du kannst in den Einstellungen zusätzlich einen Authenticator oder Passkey einrichten.",
        "code_preheader": "Dein nia-todo {label}: {code}",
        "smtp_test_title": "SMTP funktioniert",
        "smtp_test_paragraph": "Wenn du diese E-Mail siehst, funktioniert die SMTP-Konfiguration von nia-todo.",
        "smtp_test_detail": "Diese Test-E-Mail wurde über die aktuell gespeicherte SMTP-Konfiguration versendet.",
        "smtp_test_preheader": "Die SMTP-Konfiguration von nia-todo funktioniert.",
    },
    "en": {
        "auto_sent": "This email was sent automatically by nia-todo.",
        "button_fallback": "If the button does not work, copy this link:",
        "link_fallback": "If the link does not work, copy this address:",
        "greeting": "Hi {name},",
        "greeting_default": "there",
        "tagline": "Your tasks. Clearly organized.",
        "system_mail": "System email",
        "unexpected": "If you did not expect this email, you can ignore it.",
        "project_share_subject": "Project share: {project_name}",
        "project_share_title": "Project shared with you",
        "project_share_paragraph": "{inviter_name} shared the project \"{project_name}\" with you.",
        "project_share_action": "View invitation",
        "project_share_detail": "You can accept or decline the invitation in nia-todo.",
        "project_share_preheader": "{inviter_name} shared a project with you.",
        "email_verify_subject": "Confirm your nia-todo email",
        "email_verify_title": "Confirm email address",
        "email_verify_paragraph": "Please confirm this email address for your nia-todo account.",
        "email_verify_action": "Confirm email",
        "link_expires_hours": "The link is valid for {hours} hours.",
        "email_verify_unexpected": "If you did not request this change, ignore this email.",
        "email_verify_preheader": "Confirm your email address for nia-todo.",
        "password_invite_subject": "Your nia-todo access",
        "password_reset_subject": "Reset your nia-todo password",
        "password_invite_title": "Welcome to nia-todo",
        "password_reset_title": "Reset password",
        "password_invite_paragraph": "A setup link was created for your nia-todo access.",
        "password_reset_paragraph": "A password link was created for your nia-todo account.",
        "password_invite_action": "Set password",
        "password_reset_action": "Reset password",
        "password_unexpected": "If you did not expect this, ignore this email.",
        "password_invite_preheader": "Set up your nia-todo access.",
        "password_reset_preheader": "Reset your nia-todo password.",
        "security_code": "security code",
        "login_code": "login code",
        "reauth_subject": "Your nia-todo reauth code",
        "twofa_subject": "Your nia-todo 2FA code",
        "code_paragraph": "Your {label} is:",
        "code_expires_minutes": "The code is valid for {minutes} minutes.",
        "code_tip": "Tip: You can also add an authenticator or passkey in settings.",
        "code_preheader": "Your nia-todo {label}: {code}",
        "smtp_test_title": "SMTP works",
        "smtp_test_paragraph": "If you can see this email, nia-todo's SMTP configuration works.",
        "smtp_test_detail": "This test email was sent using the currently saved SMTP configuration.",
        "smtp_test_preheader": "nia-todo's SMTP configuration works.",
    },
}


def _language(value: str | None) -> str:
    return "en" if str(value or "").lower() == "en" else "de"


def _copy(language: str | None) -> dict[str, str]:
    return EMAIL_COPY[_language(language)]



def _clean_subject(value: str) -> str:
    """Return a single-line, reasonably sized e-mail subject."""
    cleaned = " ".join(str(value or "").split())
    if len(cleaned) <= MAX_SUBJECT_LENGTH:
        return cleaned
    return cleaned[: MAX_SUBJECT_LENGTH - 1].rstrip() + "..."


def _logo_src() -> str:
    """Prefer CID logos because most mail clients block remote images and dislike data URIs."""
    return f"cid:{LOGO_CID}"


def _text_email(*, greeting: str, paragraphs: list[str], action_label: str | None = None, action_url: str | None = None, details: list[str] | None = None, inline_code: str | None = None, language: str = "de") -> str:
    parts = [greeting, *paragraphs]
    if inline_code and len(parts) > 1:
        parts[-1] = f"{parts[-1]} {inline_code}"
    if action_label and action_url:
        parts.append(f"{action_label}:\n{action_url}")
    if details:
        parts.extend(details)
    parts.append(_copy(language)["auto_sent"] if language == "de" else _copy(language)["auto_sent"])
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


def _modern_fallback_link_html(link: str, *, language: str = "de") -> str:
    safe_link = escape(link)
    safe_href = escape(link, quote=True)
    return (
        f'<p class="modern-muted" style="margin:18px 0 0;color:{MUTED_COLOR};font-size:13px;line-height:1.6;">'
        f'{escape(_copy(language)["button_fallback"])}<br>'
        f'<a class="modern-link" href="{safe_href}" style="color:{LINK_COLOR};word-break:break-all;text-decoration:underline;">{safe_link}</a>'
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


def _outlook_fallback_link_html(link: str, *, language: str = "de") -> str:
    safe_link = escape(link)
    safe_href = escape(link, quote=True)
    return (
        '<p style="margin:18px 0 0;font-family:Arial,sans-serif;font-size:13px;line-height:20px;color:#64748b;">'
        f'{escape(_copy(language)["link_fallback"])}<br>'
        f'<a href="{safe_href}" style="color:{LINK_COLOR};word-break:break-all;text-decoration:underline;">{safe_link}</a>'
        '</p>'
    )


def _detail_box(items: list[str]) -> str:
    if not items:
        return ""
    if len(items) == 1:
        content = f'<div class="modern-detail-text" style="margin:0;color:#475569;font-size:14px;line-height:1.5;">{escape(items[0])}</div>'
    else:
        rows = "".join(
            f'<li class="modern-detail-text" style="margin:7px 0;color:#475569;font-size:14px;line-height:1.5;">{escape(item)}</li>'
            for item in items
        )
        content = f'<ul style="margin:0;padding-left:19px;">{rows}</ul>'
    return (
        '<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:24px 0 0;">'
        '<tr>'
        '<td class="modern-detail-box" style="padding:15px 17px;border:1px solid #e2e8f0;border-radius:16px;background:#f8fafc;">'
        f'{content}'
        '</td>'
        '</tr>'
        '</table>'
    )


def _modern_body_html(*, safe_name: str, paragraphs: list[str], action_label: str | None, action_url: str | None, details: list[str], inline_code: str | None = None, language: str = "de") -> str:
    body = [f'<p class="modern-text" style="margin:0 0 16px;font-size:16px;line-height:1.7;color:#334155;">{escape(_copy(language)["greeting"].format(name=safe_name))}</p>']
    for index, paragraph in enumerate(paragraphs):
        suffix = ""
        if inline_code and index == len(paragraphs) - 1:
            suffix = f' <strong class="modern-code" style="font-weight:900;color:#0f172a;">{escape(inline_code)}</strong>'
        body.append(f'<p class="modern-text" style="margin:0 0 16px;font-size:16px;line-height:1.7;color:#334155;">{escape(paragraph)}{suffix}</p>')
    if action_label and action_url:
        body.append(_modern_button_html(action_label, action_url))
        body.append(_modern_fallback_link_html(action_url, language=language))
    body.append(_detail_box(details))
    return "".join(body)


def _outlook_body_html(*, safe_name: str, paragraphs: list[str], action_label: str | None, action_url: str | None, details: list[str], inline_code: str | None = None, language: str = "de") -> str:
    body = [f'<p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:16px;line-height:27px;color:#334155;">{escape(_copy(language)["greeting"].format(name=safe_name))}</p>']
    for index, paragraph in enumerate(paragraphs):
        suffix = ""
        if inline_code and index == len(paragraphs) - 1:
            suffix = f' <strong style="font-weight:bold;color:#0f172a;mso-style-textfill-type:solid;mso-style-textfill-fill-color:#0f172a;mso-style-textfill-fill-alpha:100000;">{escape(inline_code)}</strong>'
        body.append(f'<p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:16px;line-height:27px;color:#334155;">{escape(paragraph)}{suffix}</p>')
    if action_label and action_url:
        body.append(_outlook_action_link_html(action_label, action_url))
        body.append(_outlook_fallback_link_html(action_url, language=language))
    body.append(_detail_box(details))
    return "".join(body)


def _layout(*, title: str, preheader: str, modern_body_html: str, outlook_body_html: str, language: str = "de") -> str:
    safe_title = escape(title)
    safe_preheader = escape(preheader)
    logo_src = escape(_logo_src(), quote=True)
    return f"""<!doctype html>
<html lang="{_language(language)}">
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
      .modern-text {{ color:#dbe4ff !important; }}
      .modern-code {{ color:#ffffff !important; }}
      .modern-muted {{ color:#a5b4fc !important; }}
      .modern-link {{ color:#c7d2fe !important; }}
      .modern-detail-box {{ background:#111a33 !important; border-color:rgba(199,210,254,.24) !important; }}
      .modern-detail-text {{ color:#dbe4ff !important; }}
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
                    <div style="font-family:Arial,sans-serif;font-size:13px;line-height:18px;color:#dbe4ff;mso-style-textfill-type:solid;mso-style-textfill-fill-color:#dbe4ff;mso-style-textfill-fill-alpha:100000;">{escape(_copy(language)["tagline"])}</div>
                  </td>
                </tr>
              </table>
              <table role="presentation" width="584" cellspacing="0" cellpadding="0" border="0" style="width:584px;border-collapse:collapse;"><tr><td height="30" style="height:30px;line-height:30px;font-size:0;">&nbsp;</td></tr></table>
              <div style="font-family:Arial,sans-serif;font-size:12px;line-height:16px;font-weight:bold;color:#dbe4ff;mso-style-textfill-type:solid;mso-style-textfill-fill-color:#dbe4ff;mso-style-textfill-fill-alpha:100000;">{escape(_copy(language)["system_mail"].upper())}</div>
              <table role="presentation" width="584" cellspacing="0" cellpadding="0" border="0" style="width:584px;border-collapse:collapse;"><tr><td height="10" style="height:10px;line-height:10px;font-size:0;">&nbsp;</td></tr></table>
              <div style="font-family:Arial,sans-serif;font-size:32px;line-height:36px;font-weight:bold;color:#ffffff;mso-style-textfill-type:solid;mso-style-textfill-fill-color:#ffffff;mso-style-textfill-fill-alpha:100000;">{safe_title}</div>
            </v:textbox>
          </v:roundrect>
        </td></tr>
        <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:30px 28px 24px;">
          {outlook_body_html}
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;"><tr><td style="border-top:1px solid #e5e7eb;padding:16px 0 0;font-family:Arial,sans-serif;font-size:14px;line-height:22px;color:#64748b;">{escape(_copy(language)["unexpected"])}</td></tr></table>
        </td></tr>
        <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:0 28px 32px;font-family:Arial,sans-serif;font-size:12px;line-height:18px;color:#94a3b8;">{escape(_copy(language)["auto_sent"])}</td></tr>
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
                <td style="padding-left:13px;vertical-align:middle;"><div style="font-size:18px;font-weight:900;letter-spacing:-.025em;color:#ffffff;line-height:1.15;">{BRAND_NAME}</div><div style="font-size:13px;color:#c7d2fe;line-height:1.35;margin-top:3px;">{escape(_copy(language)["tagline"])}</div></td>
              </tr></table>
              <div style="height:30px;line-height:30px;font-size:0;">&nbsp;</div>
              <div style="font-size:12px;color:#c7d2fe;font-weight:800;text-transform:uppercase;letter-spacing:.10em;margin-bottom:10px;">{escape(_copy(language)["system_mail"])}</div>
              <h1 style="margin:0;font-size:32px;line-height:1.08;letter-spacing:-.05em;color:#ffffff;font-weight:900;">{safe_title}</h1>
            </td></tr>
          </table>
        </td></tr>
        <tr><td class="modern-body" style="padding:30px 28px 24px;background:#ffffff;">
          {modern_body_html}
        </td></tr>
        <tr><td class="modern-footer modern-muted" style="padding:0 28px 32px;background:#ffffff;color:#94a3b8;font-size:12px;line-height:1.5;">{escape(_copy(language)["auto_sent"])}<br>{escape(_copy(language)["unexpected"])}</td></tr>
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
    inline_code: str | None = None,
    language: str = "de",
) -> tuple[str, str, str]:
    """Return subject, plain text and branded HTML for a nia-todo system email."""
    language = _language(language)
    copy = _copy(language)
    safe_name = greeting_name.strip() if greeting_name else copy["greeting_default"]
    greeting = copy["greeting"].format(name=safe_name)
    cleaned_subject = _clean_subject(subject)
    safe_paragraphs = [str(paragraph) for paragraph in paragraphs if str(paragraph).strip()]
    safe_details = [str(item) for item in (details or []) if str(item).strip()]
    safe_inline_code = str(inline_code).strip() if inline_code else None
    text = _text_email(greeting=greeting, paragraphs=safe_paragraphs, action_label=action_label, action_url=action_url, details=safe_details, inline_code=safe_inline_code, language=language)
    modern_body = _modern_body_html(safe_name=safe_name, paragraphs=safe_paragraphs, action_label=action_label, action_url=action_url, details=safe_details, inline_code=safe_inline_code, language=language)
    outlook_body = _outlook_body_html(safe_name=safe_name, paragraphs=safe_paragraphs, action_label=action_label, action_url=action_url, details=safe_details, inline_code=safe_inline_code, language=language)
    html = _layout(
        title=title,
        preheader=preheader or (safe_paragraphs[0] if safe_paragraphs else title),
        modern_body_html=modern_body,
        outlook_body_html=outlook_body,
        language=language,
    )
    return cleaned_subject, text, html


def project_share_invite_email(*, display_name: str, username: str, project_name: str, inviter_name: str, link: str, language: str = "de") -> tuple[str, str, str]:
    copy = _copy(language)
    safe_name = display_name or username
    return render_system_email(
        subject=copy["project_share_subject"].format(project_name=project_name),
        title=copy["project_share_title"],
        greeting_name=safe_name,
        paragraphs=[copy["project_share_paragraph"].format(inviter_name=inviter_name, project_name=project_name)],
        action_label=copy["project_share_action"],
        action_url=link,
        details=[copy["project_share_detail"]],
        preheader=copy["project_share_preheader"].format(inviter_name=inviter_name),
        language=language,
    )


def email_verification_email(*, display_name: str, username: str, link: str, expires_hours: int, language: str = "de") -> tuple[str, str, str]:
    copy = _copy(language)
    safe_name = display_name or username
    return render_system_email(
        subject=copy["email_verify_subject"],
        title=copy["email_verify_title"],
        greeting_name=safe_name,
        paragraphs=[copy["email_verify_paragraph"]],
        action_label=copy["email_verify_action"],
        action_url=link,
        details=[copy["link_expires_hours"].format(hours=expires_hours), copy["email_verify_unexpected"]],
        preheader=copy["email_verify_preheader"],
        language=language,
    )


def password_setup_email(*, display_name: str, username: str, link: str, purpose: str, expires_hours: int, language: str = "de") -> tuple[str, str, str]:
    """Return subject, text, html for invite/reset setup links."""
    copy = _copy(language)
    safe_name = display_name or username
    is_invite = purpose == "invite"
    prefix = "password_invite" if is_invite else "password_reset"
    return render_system_email(
        subject=copy[f"{prefix}_subject"],
        title=copy[f"{prefix}_title"],
        greeting_name=safe_name,
        paragraphs=[copy[f"{prefix}_paragraph"]],
        action_label=copy[f"{prefix}_action"],
        action_url=link,
        details=[copy["link_expires_hours"].format(hours=expires_hours), copy["password_unexpected"]],
        preheader=copy[f"{prefix}_preheader"],
        language=language,
    )


def two_factor_code_email(*, display_name: str, username: str, code: str, purpose: str = "login", expires_minutes: int = 10, language: str = "de") -> tuple[str, str, str]:
    copy = _copy(language)
    safe_name = display_name or username
    is_reauth = purpose == "reauth"
    label = copy["security_code"] if is_reauth else copy["login_code"]
    return render_system_email(
        subject=copy["reauth_subject"] if is_reauth else copy["twofa_subject"],
        title=label,
        greeting_name=safe_name,
        paragraphs=[copy["code_paragraph"].format(label=label)],
        details=[copy["code_expires_minutes"].format(minutes=expires_minutes), copy["code_tip"]],
        preheader=copy["code_preheader"].format(label=label, code=code),
        inline_code=code,
        language=language,
    )


def test_email(*, to: str | None = None, language: str = "de") -> tuple[str, str, str]:
    copy = _copy(language)
    return render_system_email(
        subject="nia-todo SMTP Test",
        title=copy["smtp_test_title"],
        greeting_name=copy["greeting_default"],
        paragraphs=[copy["smtp_test_paragraph"]],
        details=[copy["smtp_test_detail"]],
        preheader=copy["smtp_test_preheader"],
        language=language,
    )
