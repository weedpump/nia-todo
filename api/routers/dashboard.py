"""nia-todo: Dashboard / stats endpoint"""

from fastapi import APIRouter, Depends

from db import get_db
from routers.auth import require_auth

router = APIRouter(prefix="/api/dashboard")


@router.get("")
def dashboard(user_id: int = Depends(require_auth)):
    with get_db() as db:
        total = db.execute("SELECT COUNT(*) FROM todos WHERE user_id = ? AND status != 'archived'", (user_id,)).fetchone()[0]
        pending = db.execute("SELECT COUNT(*) FROM todos WHERE user_id = ? AND status = 'pending'", (user_id,)).fetchone()[0]
        inprog = db.execute("SELECT COUNT(*) FROM todos WHERE user_id = ? AND status = 'in_progress'", (user_id,)).fetchone()[0]
        done = db.execute("SELECT COUNT(*) FROM todos WHERE user_id = ? AND status = 'done'", (user_id,)).fetchone()[0]
        overdue = db.execute(
            "SELECT COUNT(*) FROM todos WHERE user_id = ? AND status IN ('pending','in_progress') AND due_date < date('now')", (user_id,)
        ).fetchone()[0]
        due_today = db.execute(
            "SELECT COUNT(*) FROM todos WHERE user_id = ? AND status IN ('pending','in_progress') AND date(due_date) = date('now')", (user_id,)
        ).fetchone()[0]
        return {
            "total": total,
            "pending": pending,
            "in_progress": inprog,
            "done": done,
            "overdue": overdue,
            "due_today": due_today
        }
