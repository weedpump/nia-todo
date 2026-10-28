"""Project sharing and household access helpers."""

from services.entity_access import (
    get_entity_ownership,
    get_entity_participant_user_ids,
    resolve_entity_access,
)


def get_project_ancestor_ids(db, project_id: int) -> list[int]:
    """Return the project and its ancestors, nearest first, without looping on corrupt data."""
    ancestor_ids = []
    seen = set()
    current_id = project_id
    while current_id is not None and current_id not in seen:
        seen.add(current_id)
        ancestor_ids.append(current_id)
        row = db.execute("SELECT parent_id FROM projects WHERE id = ?", (current_id,)).fetchone()
        if not row:
            break
        current_id = row["parent_id"]
    return ancestor_ids


def _accepted_project_member(db, project_ids: list[int], user_id: int):
    for project_id in project_ids:
        ownership = get_entity_ownership(db, "project", project_id)
        if ownership and ownership["owner_household_id"] is not None:
            continue
        row = db.execute(
            "SELECT * FROM project_members WHERE project_id = ? AND user_id = ? AND status = 'accepted'",
            (project_id, user_id),
        ).fetchone()
        if row:
            return row
    return None


def is_project_owner(db, project_id: int, user_id: int) -> bool:
    return resolve_entity_access(db, "project", project_id, user_id).can_manage_metadata


def is_project_member(db, project_id: int, user_id: int) -> bool:
    flags = get_project_access_flags(db, project_id, user_id)
    return flags["can_view"] and not flags["can_manage"]


def can_access_project(db, project_id: int, user_id: int) -> bool:
    ancestor_ids = get_project_ancestor_ids(db, project_id)
    if any(resolve_entity_access(db, "project", ancestor_id, user_id).can_view for ancestor_id in ancestor_ids):
        return True
    return _accepted_project_member(db, ancestor_ids, user_id) is not None


def can_edit_project(db, project_id: int, user_id: int) -> bool:
    return resolve_entity_access(db, "project", project_id, user_id).can_manage_metadata


def can_manage_todos(db, project_id: int, user_id: int) -> bool:
    return can_access_project(db, project_id, user_id)


def get_project_access_flags(db, project_id: int, user_id: int) -> dict:
    permissions = resolve_entity_access(db, "project", project_id, user_id)
    ancestor_ids = get_project_ancestor_ids(db, project_id)
    direct_member = _accepted_project_member(db, ancestor_ids, user_id)
    inherited_entity_view = any(
        resolve_entity_access(db, "project", ancestor_id, user_id).can_view
        for ancestor_id in ancestor_ids[1:]
    )
    ownership = get_entity_ownership(db, "project", project_id)
    return {
        "can_view": permissions.can_view or inherited_entity_view or direct_member is not None,
        "can_manage": permissions.can_manage_metadata,
        "permissions": permissions,
        "direct_member": direct_member,
        "ownership": ownership,
    }


def get_project_ids_for_user(db, user_id: int) -> list[int]:
    rows = db.execute("SELECT id FROM projects ORDER BY id").fetchall()
    return [row["id"] for row in rows if can_access_project(db, row["id"], user_id)]


def get_project_participant_user_ids(db, project_id: int) -> set[int]:
    """Return exact and inherited recipients for project-scoped realtime events."""
    recipients = set()
    for ancestor_id in get_project_ancestor_ids(db, project_id):
        recipients.update(get_entity_participant_user_ids(db, "project", ancestor_id))
        ownership = get_entity_ownership(db, "project", ancestor_id)
        if ownership and ownership["owner_household_id"] is not None:
            continue
        rows = db.execute(
            "SELECT user_id FROM project_members WHERE project_id = ? AND status = 'accepted'",
            (ancestor_id,),
        ).fetchall()
        recipients.update(row["user_id"] for row in rows)
    return recipients


def get_project_boundary_user_ids(db, project_id: int) -> set[int]:
    """Return participants plus pending invitees affected by a boundary transition."""
    recipients = get_project_participant_user_ids(db, project_id)
    rows = db.execute(
        """SELECT user_id FROM project_members
           WHERE project_id = ? AND status IN ('pending', 'accepted')""",
        (project_id,),
    ).fetchall()
    recipients.update(row["user_id"] for row in rows)
    return recipients


def can_access_todo(db, todo, user_id: int) -> bool:
    project_id = todo["project_id"]
    if project_id is None:
        return todo["user_id"] == user_id
    return can_access_project(db, project_id, user_id)


def get_accessible_todo_ids(db, user_id: int) -> list[int]:
    project_ids = get_project_ids_for_user(db, user_id)
    if project_ids:
        placeholders = ",".join("?" for _ in project_ids)
        rows = db.execute(
            f"SELECT id FROM todos WHERE (project_id IS NULL AND user_id = ?) OR project_id IN ({placeholders})",
            (user_id, *project_ids),
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT id FROM todos WHERE project_id IS NULL AND user_id = ?",
            (user_id,),
        ).fetchall()
    return [row["id"] for row in rows]


def get_todo_reminder_recipient_user_id(db, todo) -> int | None:
    project_id = todo["project_id"]
    if project_id is None:
        return todo["user_id"]
    ownership = get_entity_ownership(db, "project", project_id)
    if not ownership:
        return None
    if ownership["owner_user_id"] is not None:
        return ownership["owner_user_id"]
    household = db.execute(
        "SELECT owner_user_id FROM households WHERE id = ?",
        (ownership["owner_household_id"],),
    ).fetchone()
    return household["owner_user_id"] if household else None


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
    return [dict(row) for row in rows]
