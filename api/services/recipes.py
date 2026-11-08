"""Cookbook projections scoped through the generic entity access contract."""

from services.entity_access import get_entity_ownership, resolve_entity_access


def get_cookbook_view(db, cookbook_id: int, user_id: int) -> dict | None:
    row = db.execute("SELECT * FROM cookbooks WHERE id = ?", (cookbook_id,)).fetchone()
    if row is None:
        return None
    permissions = resolve_entity_access(db, "cookbook", cookbook_id, user_id)
    if not permissions.can_view:
        return None
    ownership = get_entity_ownership(db, "cookbook", cookbook_id) or {}
    result = dict(row)
    result.update({
        "owner_user_id": ownership.get("owner_user_id"),
        "owner_household_id": ownership.get("owner_household_id"),
        "ownership_type": "household" if ownership.get("owner_household_id") is not None else "user",
        "can_edit": bool(permissions.can_edit_content),
        "can_manage": bool(permissions.can_manage_metadata),
        "is_owner": bool(permissions.can_manage_metadata),
        "is_shared": not permissions.can_manage_metadata,
        "household_name": None, "owner_username": None, "owner_display_name": None,
    })
    if result["owner_household_id"] is not None:
        owner = db.execute("SELECT name FROM households WHERE id = ?", (result["owner_household_id"],)).fetchone()
        result["household_name"] = owner["name"] if owner else None
    else:
        owner = db.execute("SELECT username, display_name FROM users WHERE id = ?", (result["owner_user_id"],)).fetchone()
        if owner:
            result["owner_username"], result["owner_display_name"] = owner["username"], owner["display_name"]
    return result


def get_sync_cookbooks(db, user_id: int) -> list[dict]:
    rows = db.execute(
        """SELECT book.id FROM cookbooks book
           JOIN entity_access access ON access.entity_type = 'cookbook' AND access.entity_id = book.id
           WHERE access.owner_user_id = ?
              OR access.owner_household_id IN (SELECT id FROM households WHERE owner_user_id = ?)
              OR access.owner_household_id IN (SELECT household_id FROM household_members WHERE user_id = ? AND status = 'accepted')
              OR (access.owner_household_id IS NULL AND EXISTS (
                  SELECT 1 FROM entity_access_grants grant_row
                  WHERE grant_row.entity_access_id = access.id AND grant_row.user_id = ? AND grant_row.status = 'accepted'))
           ORDER BY book.sort_order, book.id""",
        (user_id, user_id, user_id, user_id),
    ).fetchall()
    return [view for row in rows if (view := get_cookbook_view(db, row["id"], user_id)) is not None]
