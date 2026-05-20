"""Project sharing helpers."""

from typing import Optional


def is_project_owner(db, project_id: int, user_id: int) -> bool:
    row = db.execute("SELECT user_id FROM projects WHERE id = ?", (project_id,)).fetchone()
    return bool(row and row[0] == user_id)


def is_project_member(db, project_id: int, user_id: int) -> bool:
    row = db.execute(
        """
        SELECT id FROM project_members
        WHERE project_id = ? AND user_id = ? AND status = 'accepted'
        """,
        (project_id, user_id),
    ).fetchone()
    return row is not None


def can_access_project(db, project_id: int, user_id: int) -> bool:
    return is_project_owner(db, project_id, user_id) or is_project_member(db, project_id, user_id)


def can_edit_project(db, project_id: int, user_id: int) -> bool:
    return is_project_owner(db, project_id, user_id)


def can_manage_todos(db, project_id: int, user_id: int) -> bool:
    return can_access_project(db, project_id, user_id)


def get_project_ids_for_user(db, user_id: int) -> list[int]:
    rows = db.execute(
        """
        SELECT id FROM projects WHERE user_id = ?
        UNION
        SELECT project_id AS id FROM project_members WHERE user_id = ? AND status = 'accepted'
        ORDER BY id
        """,
        (user_id, user_id),
    ).fetchall()
    return [r[0] for r in rows]


def get_project_member_rows(db, project_id: int, include_pending: bool = True):
    if include_pending:
        rows = db.execute(
            """
            SELECT pm.*, u.username, u.display_name
            FROM project_members pm
            JOIN users u ON u.id = pm.user_id
            WHERE pm.project_id = ? AND pm.status IN ('pending', 'accepted', 'declined', 'left', 'removed')
            ORDER BY CASE pm.status WHEN 'accepted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, u.username
            """,
            (project_id,),
        ).fetchall()
    else:
        rows = db.execute(
            """
            SELECT pm.*, u.username, u.display_name
            FROM project_members pm
            JOIN users u ON u.id = pm.user_id
            WHERE pm.project_id = ? AND pm.status = 'accepted'
            ORDER BY u.username
            """,
            (project_id,),
        ).fetchall()
    return [dict(r) for r in rows]
