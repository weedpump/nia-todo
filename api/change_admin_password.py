#!/usr/bin/env python3
"""
nia-todo: Emergency Admin Password Reset Script
Usage: cd api && python3 change_admin_password.py

Interactive prompt for new admin password.
Validates strength (12+ chars, etc.), hashes with bcrypt, writes to admin_config table.
No FastAPI dependencies - just sqlite3 + bcrypt.
"""

import sys
import re
import getpass
import sqlite3
import bcrypt
from pathlib import Path

DB_PATH = Path(__file__).parent / "data" / "nia-todo-dev.db"

def validate_admin_password(password: str) -> str:
    """Admin passwords require at least 12 characters."""
    if len(password) < 12:
        return "Passwort muss mindestens 12 Zeichen lang sein"
    if not re.search(r'[A-Z]', password):
        return "Passwort muss mindestens einen Großbuchstaben enthalten"
    if not re.search(r'[a-z]', password):
        return "Passwort muss mindestens einen Kleinbuchstaben enthalten"
    if not re.search(r'\d', password):
        return "Passwort muss mindestens eine Ziffer enthalten"
    special_chars = r"!@#$%^&*()_+-=[]{};'\\|,.\/<>?"
    if not any(c in special_chars for c in password):
        return "Passwort muss mindestens ein Sonderzeichen enthalten"
    return ""

def change_admin_password():
    print("=" * 50)
    print("  nia-todo: Admin-Passwort zurücksetzen")
    print("=" * 50)
    print()

    if not DB_PATH.exists():
        print(f"❌ Datenbank nicht gefunden: {DB_PATH}")
        sys.exit(1)

    # Prompt for new password (hidden input)
    new_password = getpass.getpass("Neues Admin-Passwort eingeben: ")
    if not new_password:
        print("❌ Kein Passwort eingegeben. Abbruch.")
        sys.exit(1)

    # Validate strength
    error = validate_admin_password(new_password)
    if error:
        print(f"❌ {error}")
        sys.exit(1)

    # Confirm password
    confirm_password = getpass.getpass("Neues Passwort bestätigen: ")
    if new_password != confirm_password:
        print("❌ Passwörter stimmen nicht überein. Abbruch.")
        sys.exit(1)

    # Hash with bcrypt
    password_hash = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt()).decode()

    # Write to database
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    try:
        # Check if admin_config row exists
        row = conn.execute("SELECT id FROM admin_config WHERE id = 1").fetchone()
        if row:
            conn.execute(
                "UPDATE admin_config SET admin_token_hash = ? WHERE id = 1",
                (password_hash,)
            )
            print("✅ Admin-Passwort aktualisiert.")
        else:
            conn.execute(
                "INSERT INTO admin_config (id, setup_complete, admin_token_hash, created_at) VALUES (?, 0, ?, datetime('now'))",
                (1, password_hash)
            )
            print("✅ Admin-Passwort gesetzt (Setup noch nicht abgeschlossen).")

        conn.commit()
        print()
        print("ℹ️  Hinweis: Alle bestehenden Admin-Sitzungen bleiben gültig,")
        print("   da Admin keine token_version verwendet.")
        print("   Nutze das neue Passwort ab sofort für die Admin-Anmeldung.")
    except Exception as e:
        conn.rollback()
        print(f"❌ Fehler beim Schreiben in die Datenbank: {e}")
        sys.exit(1)
    finally:
        conn.close()

if __name__ == "__main__":
    change_admin_password()
