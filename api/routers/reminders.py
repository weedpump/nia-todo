"""nia-todo: Reminder endpoints"""

from fastapi import APIRouter, HTTPException, Depends

from db import get_db, row_to_dict, now_iso
from routers.auth import require_auth
from services.sharing import can_access_todo, get_todo_reminder_recipient_user_id

router = APIRouter(prefix="/api/reminders")


@router.get("")
def list_reminders(due_only: bool = False, user_id: int = Depends(require_auth)):
    with get_db() as db:
        sql = """
            SELECT r.*, t.title, t.status, t.project_id, t.user_id AS todo_user_id FROM reminders r
            JOIN todos t ON r.todo_id = t.id
            WHERE (r.user_id = ? OR r.user_id IS NULL)
              AND t.status IN ('pending','in_progress')
        """
        params = [user_id]
        if due_only:
            sql += " AND r.remind_at <= datetime('now') AND r.sent_at IS NULL"
        sql += " ORDER BY r.remind_at"
        rows = db.execute(sql, params).fetchall()
        reminders = []
        for row in rows:
            todo = {"project_id": row["project_id"], "user_id": row["todo_user_id"]}
            recipient_user_id = row["user_id"] if row["user_id"] is not None else get_todo_reminder_recipient_user_id(db, todo)
            if recipient_user_id == user_id and can_access_todo(db, todo, user_id):
                reminder = dict(row)
                reminder.pop("project_id", None)
                reminder.pop("todo_user_id", None)
                reminders.append(reminder)
        return {"reminders": reminders}

@router.post("/{reminder_id}/sent")
def mark_reminder_sent(reminder_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        reminder = db.execute("""
            SELECT r.*, t.project_id, t.user_id AS todo_user_id FROM reminders r
            JOIN todos t ON r.todo_id = t.id
            WHERE r.id = ? AND (r.user_id = ? OR r.user_id IS NULL)
        """, (reminder_id, user_id)).fetchone()
        if not reminder:
            raise HTTPException(404, "Reminder not found")
        todo = {"project_id": reminder["project_id"], "user_id": reminder["todo_user_id"]}
        recipient_user_id = reminder["user_id"] if reminder["user_id"] is not None else get_todo_reminder_recipient_user_id(db, todo)
        if recipient_user_id != user_id or not can_access_todo(db, todo, user_id):
            raise HTTPException(404, "Reminder not found")
        db.execute("UPDATE reminders SET sent_at = ? WHERE id = ?", (now_iso(), reminder_id))
        db.commit()
        return {"sent": reminder_id}
