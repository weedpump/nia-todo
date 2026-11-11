"""nia-todo: Dashboard / stats endpoint"""

from fastapi import APIRouter, Depends

from db import get_db
from routers.auth import require_auth
from services.sharing import get_accessible_todo_ids

router = APIRouter(prefix="/api/dashboard")


@router.get("")
def dashboard(user_id: int = Depends(require_auth)):
    with get_db() as db:
        todo_ids = get_accessible_todo_ids(db, user_id)
        if not todo_ids:
            return {"total": 0, "pending": 0, "in_progress": 0, "done": 0, "overdue": 0, "due_today": 0}
        placeholders = ",".join("?" for _ in todo_ids)
        rows = db.execute(
            f"SELECT status, due_date FROM todos WHERE id IN ({placeholders}) AND status != 'archived'",
            tuple(todo_ids),
        ).fetchall()
        total = len(rows)
        pending = sum(row["status"] == "pending" for row in rows)
        inprog = sum(row["status"] == "in_progress" for row in rows)
        done = sum(row["status"] == "done" for row in rows)
        overdue = db.execute(
            f"SELECT COUNT(*) FROM todos WHERE id IN ({placeholders}) AND status IN ('pending','in_progress') AND due_date < date('now')",
            tuple(todo_ids),
        ).fetchone()[0]
        due_today = db.execute(
            f"SELECT COUNT(*) FROM todos WHERE id IN ({placeholders}) AND status IN ('pending','in_progress') AND date(due_date) = date('now')",
            tuple(todo_ids),
        ).fetchone()[0]
        return {
            "total": total,
            "pending": pending,
            "in_progress": inprog,
            "done": done,
            "overdue": overdue,
            "due_today": due_today
        }
