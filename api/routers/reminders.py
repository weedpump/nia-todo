"""nia-todo: Reminder endpoints"""

from fastapi import APIRouter, HTTPException, Depends

from db import get_db, row_to_dict, now_iso
from routers.auth import require_auth

router = APIRouter(prefix="/api/reminders")


@router.get("")
def list_reminders(due_only: bool = False, user_id: int = Depends(require_auth)):
    with get_db() as db:
        sql = """
            SELECT r.*, t.title, t.status FROM reminders r
            JOIN todos t ON r.todo_id = t.id
            WHERE (r.user_id = ? OR (r.user_id IS NULL AND t.user_id = ?))
              AND t.status IN ('pending','in_progress')
        """
        params = [user_id, user_id]
        if due_only:
            sql += " AND r.remind_at <= datetime('now') AND r.sent_at IS NULL"
        sql += " ORDER BY r.remind_at"
        rows = db.execute(sql, params).fetchall()
        return {"reminders": [dict(r) for r in rows]}

@router.post("/{reminder_id}/sent")
def mark_reminder_sent(reminder_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        reminder = db.execute("""
            SELECT r.* FROM reminders r
            JOIN todos t ON r.todo_id = t.id
            WHERE r.id = ? AND (r.user_id = ? OR (r.user_id IS NULL AND t.user_id = ?))
        """, (reminder_id, user_id, user_id)).fetchone()
        if not reminder:
            raise HTTPException(404, "Reminder not found")
        db.execute("UPDATE reminders SET sent_at = ? WHERE id = ?", (now_iso(), reminder_id))
        db.commit()
        return {"sent": reminder_id}
