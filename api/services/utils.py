"""nia-todo: Shared utilities (validation, sanitization)"""

import re


def sanitize_text(text: str) -> str:
    """Strip HTML tags, remove null bytes, and trim whitespace."""
    if text is None:
        return None
    text = str(text).strip().replace('\x00', '')
    text = re.sub(r'<[^\u003e]+>', '', text)
    return text


def validate_password(password: str, min_length: int = 8) -> str:
    """Validate password meets security requirements. Returns error or empty string."""
    if len(password) < min_length:
        return f"Passwort muss mindestens {min_length} Zeichen lang sein"
    if not re.search(r'[A-Z]', password):
        return "Passwort muss mindestens einen Großbuchstaben enthalten"
    if not re.search(r'[a-z]', password):
        return "Passwort muss mindestens einen Kleinbuchstaben enthalten"
    if not re.search(r'\d', password):
        return "Passwort muss mindestens eine Ziffer enthalten"
    if not re.search(r'[!@#$%^*&*()_+\-=\[\]{};\':"\\|,.\u003c\u003e\/?]', password):
        return "Passwort muss mindestens ein Sonderzeichen enthalten"
    return ""


def validate_admin_password(password: str) -> str:
    """Admin passwords require at least 12 characters."""
    return validate_password(password, min_length=12)
