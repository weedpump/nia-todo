#!/usr/bin/env python3
"""Check due reminders, output as JSON for Nia to send via Telegram."""

import sqlite3
import json
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "api" / "data" / "nia-todo.db"

def main():
    if not DB_PATH.exists():
        print(json.dumps({"reminders": [], "error": "DB not found"}))
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

        reminders = []
        for row in rows:
            reminders.append({
                "reminder_id": row['id'],
                "todo_id": row['todo_id'],
                "title": row['title'],
                "remind_at": row['remind_at'],
                "status": row['status']
            })
            # Mark as sent immediately
            conn.execute(
                "UPDATE reminders SET sent_at = datetime('now') WHERE id = ?",
                (row['id'],)
            )
        conn.commit()

        print(json.dumps({"reminders": reminders, "count": len(reminders)}))
    finally:
        conn.close()

if __name__ == "__main__":
    main()
