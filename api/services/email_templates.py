"""HTML/text email templates for nia-todo system emails."""

from html import escape


def _button_html(label: str, url: str) -> str:
    safe_label = escape(label)
    safe_url = escape(url, quote=True)
    return (
        '<p style="margin: 24px 0;">'
        f'<a href="{safe_url}" style="display:inline-block;background:#6366f1;color:#ffffff;'
        'text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">'
        f'{safe_label}</a></p>'
    )


def _layout(title: str, body_html: str) -> str:
    return f"""
    <!doctype html>
    <html lang="de">
      <body style="margin:0;padding:24px;background:#f8fafc;color:#0f172a;font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;">
        <main style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:18px;padding:28px;">
          <h1 style="font-size:22px;line-height:1.25;margin:0 0 18px;">{escape(title)}</h1>
          {body_html}
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0 16px;">
          <p style="font-size:12px;color:#64748b;margin:0;">Diese Mail wurde automatisch von nia-todo gesendet.</p>
        </main>
      </body>
    </html>
    """.strip()


def password_setup_email(*, display_name: str, username: str, link: str, purpose: str, expires_hours: int) -> tuple[str, str, str]:
    """Return subject, text, html for invite/reset setup links."""
    safe_name = display_name or username
    is_invite = purpose == "invite"
    subject = "Dein nia-todo Zugang" if is_invite else "nia-todo Passwort zurücksetzen"
    title = "Willkommen bei nia-todo" if is_invite else "Passwort zurücksetzen"
    intro = (
        f"Hallo {safe_name},\n\nfür deinen nia-todo Zugang wurde ein Setup-Link erstellt."
        if is_invite else
        f"Hallo {safe_name},\n\nfür deinen nia-todo Account wurde ein Passwort-Link erstellt."
    )
    action = "Passwort setzen" if is_invite else "Passwort zurücksetzen"
    text = (
        f"{intro}\n\n"
        f"{action}:\n{link}\n\n"
        f"Der Link ist {expires_hours} Stunden gültig.\n"
        "Wenn du das nicht erwartet hast, ignoriere diese Mail."
    )
    body = (
        f"<p>Hallo {escape(safe_name)},</p>"
        f"<p>{'Für deinen nia-todo Zugang wurde ein Setup-Link erstellt.' if is_invite else 'Für deinen nia-todo Account wurde ein Passwort-Link erstellt.'}</p>"
        f"{_button_html(action, link)}"
        f"<p style=\"font-size:13px;color:#475569;\">Der Link ist {expires_hours} Stunden gültig.</p>"
        f"<p style=\"font-size:13px;color:#475569;\">Falls der Button nicht funktioniert, kopiere diesen Link:<br>"
        f"<a href=\"{escape(link, quote=True)}\" style=\"color:#6366f1;word-break:break-all;\">{escape(link)}</a></p>"
        "<p style=\"font-size:13px;color:#475569;\">Wenn du das nicht erwartet hast, ignoriere diese Mail.</p>"
    )
    return subject, text, _layout(title, body)
