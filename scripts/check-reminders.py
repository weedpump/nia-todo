#!/usr/bin/env python3
"""
Check for due reminders and send Telegram notifications.
Called by cron or heartbeat. Uses OpenClaw system event injection
or direct Telegram Bot API if token available.
"""

import sqlite3
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "api" / "data" / "nia-todo.db"
SECRETS = Path.home() / ".openclaw" / "workspace" / ".secrets" / "service-tokens.json"

def send_telegram(text: str) -> bool:
    """Send Telegram message via OpenClaw or direct Bot API."""
    # Try OpenClaw wake event first (if called from OpenClaw context)
    try:
        # Check if we're inside OpenClaw and can inject a system event
        # This is the preferred way - OpenClaw handles routing
        if 'OPENCLAW_SESSION' in os.environ:
            print(f"[OPENCLAW] {text}")
            return True
    except:
        pass

    # Fallback: direct Telegram Bot API
    try:
        if SECRETS.exists():
            with open(SECRETS) as f:
                tokens = json.load(f)
            bot_token = tokens.get("telegram", {}).get("botToken")
            if not bot_token:
                return False
            # Use curl to send message
            import urllib.request
            import urllib.parse
            chat_id = os.environ.get("TELEGRAM_CHAT_ID", "7997944997")
            payload = urllib.parse.urlencode({
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML"
            }).encode()
            req = urllib.request.Request(
                f"https://api.telegram.org/bot{bot_token}/sendMessage",
                data=payload,
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"}
            )
            urllib.request.urlopen(req, timeout=10)
            return True
    except Exception as e:
        print(f"[ERROR] Telegram send failed: {e}")
        return False

    return False

def check_reminders():
    if not DB_PATH.exists():
        print("[WARN] Database not found")
        return

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute("""
            SELECT r.id, r.todo_id, r.remind_at, t.title, t.status
            FROM reminders r
            JOIN todos t ON r.todo_id = t.id
            WHERE r.remind_at <= datetime('now')
            AND r.sent_at IS NULL
            AND t.status IN ('pending', 'in_progress')
            ORDER BY r.remind_at
        """).fetchall()

        if not rows:
            print("[OK] No due reminders")
            return

        for row in rows:
            remind_time = datetime.fromisoformat(row['remind_at'].replace('Z', '+00:00'))
            text = (
                f"⏰ <b>Erinnerung</b>\n\n"
                f"<b>{row['title']}</b>\n"
                f"Fällig: {remind_time.strftime('%d.%m.%Y %H:%M')}\n\n"
                f"Mit /done{row['todo_id']} erledigen oder in der Web-UI abhaken."
            )

            if send_telegram(text):
                # Mark as sent
                conn.execute(
                    "UPDATE reminders SET sent_at = datetime('now') WHERE id = ?",
                    (row['id'],)
                )
                conn.commit()
                print(f"[SENT] Reminder for todo #{row['todo_id']}: {row['title']}")
            else:
                print(f"[FAIL] Could not send reminder for todo #{row['todo_id']}")

    finally:
        conn.close()

if __name__ == "__main__":
    check_reminders()
