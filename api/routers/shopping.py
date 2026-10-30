"""Shopping-list endpoints and household-aware content access."""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from db import get_db, now_iso
from routers.auth import require_auth
from services.appearance import normalize_color, normalize_icon
from services.entity_access import (
    get_entity_ownership,
    get_entity_participant_user_ids,
    grant_entity_access,
    is_household_participant,
    leave_entity_access,
    register_household_entity,
    register_personal_entity,
    resolve_entity_access,
    revoke_entity_access,
    transfer_entity_to_household,
)
from services.utils import sanitize_text
from services.websocket import broadcast_change

router = APIRouter(prefix="/api/shopping")


async def broadcast_sync_to_users(user_ids: set[int]):
    """Lazy bridge avoids the shopping/websocket snapshot import cycle."""
    from routers.websocket import broadcast_sync_to_users as broadcast
    await broadcast(user_ids)


class ShoppingListCreate(BaseModel):
    name: str = Field(..., max_length=200)
    color: str = "#6366f1"
    icon: Optional[str] = "shopping-cart"
    sort_order: int = 0
    household_id: Optional[int] = None
    client_mutation_id: Optional[str] = Field(default=None, max_length=200)


class ShoppingListUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    color: Optional[str] = None
    icon: Optional[str] = None
    sort_order: Optional[int] = None


class ShoppingListShareCreate(BaseModel):
    identifier: str = Field(..., max_length=320)


class ShoppingListHouseholdTransfer(BaseModel):
    household_id: int


class ShoppingSectionCreate(BaseModel):
    name: str = Field(..., max_length=200)
    sort_order: int = 0
    client_mutation_id: Optional[str] = Field(default=None, max_length=200)


class ShoppingSectionUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    sort_order: Optional[int] = None


class ShoppingStoreCreate(BaseModel):
    name: str = Field(..., max_length=120)
    household_id: Optional[int] = None
    sort_order: int = 0
    client_mutation_id: Optional[str] = Field(default=None, max_length=200)


class ShoppingStoreUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=120)
    sort_order: Optional[int] = None
    active: Optional[bool] = None


class ShoppingItemCreate(BaseModel):
    name: str = Field(..., max_length=500)
    section_id: Optional[int] = None
    quantity_value: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)
    quantity_unit: Optional[str] = Field(default=None, max_length=40)
    store_ids: list[int] = Field(default_factory=list)
    sort_order: int = 0
    client_mutation_id: Optional[str] = Field(default=None, max_length=200)


class ShoppingItemUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=500)
    section_id: Optional[int] = None
    quantity_value: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)
    quantity_unit: Optional[str] = Field(default=None, max_length=40)
    store_ids: Optional[list[int]] = None
    completed: Optional[bool] = None
    sort_order: Optional[int] = None


class ShoppingPreferencesUpdate(BaseModel):
    selected_store_id: Optional[int] = None
    hide_empty_sections: bool = False


def _clean_required(value: str, field: str, max_length: int) -> str:
    cleaned = sanitize_text(value or "").strip()
    if not cleaned:
        raise HTTPException(422, f"{field} is required")
    if len(cleaned) > max_length:
        raise HTTPException(422, f"{field} is too long")
    return cleaned


def _get_user_by_identifier(db, identifier: str) -> Optional[dict]:
    row = db.execute(
        """SELECT id, username, display_name
           FROM users
           WHERE username = ?
              OR (lower(email) = lower(?) AND email_verified_at IS NOT NULL)
           ORDER BY CASE WHEN username = ? THEN 0 ELSE 1 END
           LIMIT 1""",
        (identifier, identifier, identifier),
    ).fetchone()
    return dict(row) if row else None


def _clean_optional(value: Optional[str], max_length: int) -> Optional[str]:
    if value is None:
        return None
    cleaned = sanitize_text(value).strip()
    return cleaned[:max_length] or None


def _store_view(row) -> dict:
    result = dict(row)
    result["active"] = bool(result["active"])
    result["ownership_type"] = "household" if result["owner_household_id"] is not None else "user"
    return result


def _accessible_store_rows(db, user_id: int):
    return db.execute(
        """SELECT DISTINCT store.*
           FROM shopping_stores store
           LEFT JOIN household_members member
             ON member.household_id = store.owner_household_id
            AND member.user_id = ?
            AND member.status = 'accepted'
           LEFT JOIN households household
             ON household.id = store.owner_household_id
           WHERE store.owner_user_id = ?
              OR member.user_id IS NOT NULL
              OR household.owner_user_id = ?
           ORDER BY store.active DESC, store.sort_order, store.id""",
        (user_id, user_id, user_id),
    ).fetchall()


def _normalize_store_ids(
    db,
    user_id: int,
    values: list[int] | None,
    *,
    retained_store_ids: set[int] | None = None,
) -> list[int]:
    store_ids = []
    seen = set()
    accessible = {int(row["id"]) for row in _accessible_store_rows(db, user_id)}
    retained = retained_store_ids or set()
    for value in values or []:
        store_id = int(value)
        if store_id in seen:
            continue
        if store_id not in accessible and store_id not in retained:
            raise HTTPException(400, "Shopping store is not accessible")
        seen.add(store_id)
        store_ids.append(store_id)
        if len(store_ids) > 50:
            raise HTTPException(422, "Too many shopping stores")
    return store_ids


def _store_row_for_user(db, store_id: int, user_id: int):
    row = db.execute("SELECT * FROM shopping_stores WHERE id = ?", (store_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Shopping store not found")
    allowed = row["owner_user_id"] == user_id
    if row["owner_household_id"] is not None:
        allowed = is_household_participant(db, row["owner_household_id"], user_id)
    if not allowed:
        raise HTTPException(404, "Shopping store not found")
    return row


def _store_recipient_ids(db, row) -> set[int]:
    if row["owner_user_id"] is not None:
        return {int(row["owner_user_id"])}
    household_id = row["owner_household_id"]
    household = db.execute("SELECT owner_user_id FROM households WHERE id = ?", (household_id,)).fetchone()
    recipient_ids = {int(household["owner_user_id"])} if household else set()
    recipient_ids.update(
        int(member["user_id"])
        for member in db.execute(
            "SELECT user_id FROM household_members WHERE household_id = ? AND status = 'accepted'",
            (household_id,),
        ).fetchall()
    )
    return recipient_ids


def _permissions_for_list(db, shopping_list_id: int, user_id: int, *, write: bool = False, manage: bool = False):
    row = db.execute("SELECT * FROM shopping_lists WHERE id = ?", (shopping_list_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Shopping list not found")
    permissions = resolve_entity_access(db, "shopping_list", shopping_list_id, user_id)
    allowed = permissions.can_manage_metadata if manage else permissions.can_edit_content if write else permissions.can_view
    if not allowed:
        raise HTTPException(404, "Shopping list not found")
    return row, permissions


def _shopping_list_view(db, row, user_id: int) -> Optional[dict]:
    permissions = resolve_entity_access(db, "shopping_list", row["id"], user_id)
    if not permissions.can_view:
        return None
    ownership = get_entity_ownership(db, "shopping_list", row["id"]) or {}
    result = dict(row)
    result["owner_user_id"] = ownership.get("owner_user_id")
    result["owner_household_id"] = ownership.get("owner_household_id")
    result["ownership_type"] = "household" if ownership.get("owner_household_id") is not None else "user"
    result["can_edit"] = bool(permissions.can_edit_content)
    result["can_manage"] = bool(permissions.can_manage_metadata)
    result["is_owner"] = bool(permissions.can_manage_metadata)
    result["is_shared"] = not result["is_owner"]
    result["household_name"] = None
    result["owner_username"] = None
    result["owner_display_name"] = None
    if result["owner_household_id"] is not None:
        household = db.execute("SELECT name FROM households WHERE id = ?", (result["owner_household_id"],)).fetchone()
        result["household_name"] = household["name"] if household else None
    elif result["owner_user_id"] is not None:
        owner = db.execute("SELECT username, display_name FROM users WHERE id = ?", (result["owner_user_id"],)).fetchone()
        if owner:
            result["owner_username"] = owner["username"]
            result["owner_display_name"] = owner["display_name"]
    return result


def _section_view(row) -> dict:
    return dict(row)


def _item_view(db, row, user_id: int) -> dict:
    result = dict(row)
    assignments = db.execute(
        """SELECT store.*
           FROM shopping_item_stores assignment
           JOIN shopping_stores store ON store.id = assignment.shopping_store_id
           WHERE assignment.shopping_item_id = ?
           ORDER BY assignment.sort_order, store.id""",
        (row["id"],),
    ).fetchall()
    accessible_store_ids = {int(store["id"]) for store in _accessible_store_rows(db, user_id)}
    result["store_ids"] = [int(assignment["id"]) for assignment in assignments]
    result["stores"] = [
        _store_view(assignment)
        for assignment in assignments
        if int(assignment["id"]) in accessible_store_ids
    ]
    result["completed"] = bool(result["completed"])
    return result


def _preference_view(shopping_list_id: int, user_id: int, row=None) -> dict:
    return {
        "shopping_list_id": shopping_list_id,
        "user_id": user_id,
        "selected_store_id": row["selected_store_id"] if row else None,
        "hide_empty_sections": bool(row["hide_empty_sections"]) if row else False,
    }


def _recipient_ids(db, shopping_list_id: int) -> set[int]:
    return get_entity_participant_user_ids(db, "shopping_list", shopping_list_id)


async def _broadcast_item_change(db, event_type: str, row, actor_user_id: int, shopping_list_id: int):
    for recipient_id in sorted(_recipient_ids(db, shopping_list_id) | {actor_user_id}):
        await broadcast_change(event_type, _item_view(db, row, recipient_id), recipient_id)


async def _broadcast_list_change(db, event_type: str, row, actor_user_id: int, shopping_list_id: int):
    for recipient_id in sorted(_recipient_ids(db, shopping_list_id) | {actor_user_id}):
        view = _shopping_list_view(db, row, recipient_id)
        if view is not None:
            await broadcast_change(event_type, view, recipient_id)


def get_sync_shopping_stores(db, user_id: int) -> list[dict]:
    return [_store_view(row) for row in _accessible_store_rows(db, user_id)]


def get_sync_shopping_lists(db, user_id: int) -> list[dict]:
    """Build recipient-specific complete shopping-list snapshots."""
    results = []
    rows = db.execute("SELECT * FROM shopping_lists ORDER BY sort_order, id").fetchall()
    for row in rows:
        result = _shopping_list_view(db, row, user_id)
        if result is None:
            continue
        shopping_list_id = row["id"]
        sections = db.execute(
            "SELECT * FROM shopping_sections WHERE shopping_list_id = ? ORDER BY sort_order, id",
            (shopping_list_id,),
        ).fetchall()
        items = db.execute(
            "SELECT * FROM shopping_items WHERE shopping_list_id = ? ORDER BY completed, sort_order, id",
            (shopping_list_id,),
        ).fetchall()
        preference = db.execute(
            "SELECT * FROM shopping_list_preferences WHERE shopping_list_id = ? AND user_id = ?",
            (shopping_list_id, user_id),
        ).fetchone()
        result["sections"] = [_section_view(section) for section in sections]
        result["items"] = [_item_view(db, item, user_id) for item in items]
        result["preferences"] = _preference_view(shopping_list_id, user_id, preference)
        results.append(result)
    return results


@router.get("/snapshot")
def get_shopping_snapshot(user_id: int = Depends(require_auth)):
    with get_db() as db:
        return {
            "shopping_lists": get_sync_shopping_lists(db, user_id),
            "shopping_stores": get_sync_shopping_stores(db, user_id),
        }


@router.get("/stores")
def list_shopping_stores(user_id: int = Depends(require_auth)):
    with get_db() as db:
        return {"shopping_stores": get_sync_shopping_stores(db, user_id)}


@router.post("/stores")
async def create_shopping_store(data: ShoppingStoreCreate, user_id: int = Depends(require_auth)):
    name = _clean_required(data.name, "Shopping store name", 120)
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        if data.household_id is not None and not is_household_participant(db, data.household_id, user_id):
            raise HTTPException(403, "Not a member of this household")
        owner_field = "owner_household_id" if data.household_id is not None else "owner_user_id"
        owner_id = data.household_id if data.household_id is not None else user_id
        if data.client_mutation_id:
            existing = db.execute(
                f"SELECT * FROM shopping_stores WHERE {owner_field} = ? AND client_mutation_id = ?",
                (owner_id, data.client_mutation_id),
            ).fetchone()
            if existing:
                return _store_view(existing)
        try:
            cursor = db.execute(
                """INSERT INTO shopping_stores
                   (name, owner_user_id, owner_household_id, sort_order, created_by_user_id, client_mutation_id, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    name,
                    None if data.household_id is not None else user_id,
                    data.household_id,
                    data.sort_order,
                    user_id,
                    data.client_mutation_id,
                    now_iso(),
                ),
            )
            store_id = int(cursor.lastrowid)
            db.commit()
        except sqlite3.IntegrityError as exc:
            db.rollback()
            raise HTTPException(409, "Shopping store could not be saved") from exc
        row = db.execute("SELECT * FROM shopping_stores WHERE id = ?", (store_id,)).fetchone()
        result = _store_view(row)
        recipient_ids = _store_recipient_ids(db, row)
        await broadcast_change("shopping_store_create", result, user_id, recipient_ids=recipient_ids)
        return result


@router.patch("/stores/{store_id}")
async def update_shopping_store(store_id: int, data: ShoppingStoreUpdate, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        _store_row_for_user(db, store_id, user_id)
        updates = []
        values = []
        if "name" in data.model_fields_set:
            updates.append("name = ?")
            values.append(_clean_required(data.name or "", "Shopping store name", 120))
        if "sort_order" in data.model_fields_set:
            updates.append("sort_order = ?")
            values.append(data.sort_order)
        if "active" in data.model_fields_set:
            updates.append("active = ?")
            values.append(1 if data.active else 0)
        if updates:
            updates.append("updated_at = ?")
            values.append(now_iso())
            values.append(store_id)
            db.execute(f"UPDATE shopping_stores SET {', '.join(updates)} WHERE id = ?", values)
        db.commit()
        updated = db.execute("SELECT * FROM shopping_stores WHERE id = ?", (store_id,)).fetchone()
        result = _store_view(updated)
        recipient_ids = _store_recipient_ids(db, updated)
    await broadcast_change("shopping_store_update", result, user_id, recipient_ids=recipient_ids)
    return result


@router.delete("/stores/{store_id}")
async def delete_shopping_store(store_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        _store_row_for_user(db, store_id, user_id)
        db.execute("UPDATE shopping_stores SET active = 0, updated_at = ? WHERE id = ?", (now_iso(), store_id))
        db.commit()
        updated = db.execute("SELECT * FROM shopping_stores WHERE id = ?", (store_id,)).fetchone()
        result = _store_view(updated)
        recipient_ids = _store_recipient_ids(db, updated)
    await broadcast_change("shopping_store_delete", result, user_id, recipient_ids=recipient_ids)
    return result


@router.get("/lists")
def list_shopping_lists(user_id: int = Depends(require_auth)):
    with get_db() as db:
        rows = db.execute("SELECT * FROM shopping_lists ORDER BY sort_order, id").fetchall()
        lists = [_shopping_list_view(db, row, user_id) for row in rows]
        return {"shopping_lists": [row for row in lists if row is not None]}


@router.post("/lists")
async def create_shopping_list(data: ShoppingListCreate, user_id: int = Depends(require_auth)):
    name = _clean_required(data.name, "Shopping list name", 200)
    color = normalize_color(data.color)
    icon = normalize_icon(data.icon)
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        if data.client_mutation_id:
            existing = db.execute(
                "SELECT * FROM shopping_lists WHERE created_by_user_id = ? AND client_mutation_id = ?",
                (user_id, data.client_mutation_id),
            ).fetchone()
            if existing:
                view = _shopping_list_view(db, existing, user_id)
                if view is not None:
                    return view
        if data.household_id is not None and not is_household_participant(db, data.household_id, user_id):
            raise HTTPException(403, "Not a member of this household")
        try:
            cursor = db.execute(
                """INSERT INTO shopping_lists
                   (name, color, icon, sort_order, created_by_user_id, client_mutation_id, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (name, color, icon, data.sort_order, user_id, data.client_mutation_id, now_iso()),
            )
            shopping_list_id = int(cursor.lastrowid)
            if data.household_id is None:
                register_personal_entity(db, "shopping_list", shopping_list_id, user_id)
            else:
                register_household_entity(db, "shopping_list", shopping_list_id, user_id, data.household_id)
            db.commit()
        except (sqlite3.IntegrityError, ValueError) as exc:
            db.rollback()
            if data.client_mutation_id:
                existing = db.execute(
                    "SELECT * FROM shopping_lists WHERE created_by_user_id = ? AND client_mutation_id = ?",
                    (user_id, data.client_mutation_id),
                ).fetchone()
                if existing:
                    view = _shopping_list_view(db, existing, user_id)
                    if view is not None:
                        return view
            raise HTTPException(409, "Shopping list could not be saved") from exc
        row = db.execute("SELECT * FROM shopping_lists WHERE id = ?", (shopping_list_id,)).fetchone()
        result = _shopping_list_view(db, row, user_id)
        await _broadcast_list_change(db, "shopping_list_create", row, user_id, shopping_list_id)
        return result


@router.patch("/lists/{shopping_list_id}")
async def update_shopping_list(shopping_list_id: int, data: ShoppingListUpdate, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        _permissions_for_list(db, shopping_list_id, user_id, manage=True)
        updates = []
        values = []
        if "name" in data.model_fields_set:
            updates.append("name = ?")
            values.append(_clean_required(data.name or "", "Shopping list name", 200))
        if "color" in data.model_fields_set:
            updates.append("color = ?")
            values.append(normalize_color(data.color))
        if "icon" in data.model_fields_set:
            updates.append("icon = ?")
            values.append(normalize_icon(data.icon))
        if "sort_order" in data.model_fields_set:
            updates.append("sort_order = ?")
            values.append(data.sort_order)
        if updates:
            updates.append("updated_at = ?")
            values.append(now_iso())
            values.append(shopping_list_id)
            db.execute(f"UPDATE shopping_lists SET {', '.join(updates)} WHERE id = ?", values)
        db.commit()
        row = db.execute("SELECT * FROM shopping_lists WHERE id = ?", (shopping_list_id,)).fetchone()
        result = _shopping_list_view(db, row, user_id)
        if result is None:
            raise HTTPException(404, "Shopping list not found")
        await _broadcast_list_change(db, "shopping_list_update", row, user_id, shopping_list_id)
        return result


@router.delete("/lists/{shopping_list_id}")
async def delete_shopping_list(shopping_list_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        _permissions_for_list(db, shopping_list_id, user_id, manage=True)
        recipient_ids = _recipient_ids(db, shopping_list_id)
        db.execute(
            "DELETE FROM entity_access_grants WHERE entity_access_id IN (SELECT id FROM entity_access WHERE entity_type = 'shopping_list' AND entity_id = ?)",
            (shopping_list_id,),
        )
        db.execute("DELETE FROM entity_access WHERE entity_type = 'shopping_list' AND entity_id = ?", (shopping_list_id,))
        db.execute("DELETE FROM shopping_lists WHERE id = ?", (shopping_list_id,))
        db.commit()
    result = {"id": shopping_list_id, "deleted": True}
    await broadcast_change("shopping_list_delete", result, user_id, recipient_ids=recipient_ids)
    return result


@router.post("/lists/{shopping_list_id}/household")
async def transfer_shopping_list_to_household(
    shopping_list_id: int,
    data: ShoppingListHouseholdTransfer,
    user_id: int = Depends(require_auth),
):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        row, permissions = _permissions_for_list(db, shopping_list_id, user_id, manage=True)
        ownership = get_entity_ownership(db, "shopping_list", shopping_list_id) or {}
        if ownership.get("owner_household_id") is not None:
            raise HTTPException(409, "Shopping list already belongs to a household")
        if ownership.get("owner_user_id") != user_id or not permissions.can_manage_access:
            raise HTTPException(403, "Only the personal shopping-list owner can transfer it")
        previous_recipient_ids = _recipient_ids(db, shopping_list_id)
        try:
            transfer_entity_to_household(db, "shopping_list", shopping_list_id, user_id, data.household_id)
            db.commit()
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        current_recipient_ids = _recipient_ids(db, shopping_list_id)
        result = _shopping_list_view(db, row, user_id)
    await broadcast_sync_to_users(previous_recipient_ids | current_recipient_ids)
    return result


@router.post("/lists/{shopping_list_id}/leave")
async def leave_shopping_list(shopping_list_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        _, permissions = _permissions_for_list(db, shopping_list_id, user_id)
        ownership = get_entity_ownership(db, "shopping_list", shopping_list_id) or {}
        if ownership.get("owner_household_id") is not None:
            raise HTTPException(409, "Household shopping lists cannot be left directly")
        if permissions.can_manage_access:
            raise HTTPException(400, "Owner cannot leave their own shopping list")
        if "direct" not in permissions.sources:
            raise HTTPException(403, "Not authorized to leave this shopping list")
        recipient_ids = _recipient_ids(db, shopping_list_id)
        try:
            leave_entity_access(db, "shopping_list", shopping_list_id, user_id)
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        db.commit()
    await broadcast_sync_to_users(recipient_ids)
    return {"id": shopping_list_id, "left": True}


def _require_personal_list_manager(db, shopping_list_id: int, user_id: int):
    row, permissions = _permissions_for_list(db, shopping_list_id, user_id, manage=True)
    ownership = get_entity_ownership(db, "shopping_list", shopping_list_id) or {}
    if ownership.get("owner_household_id") is not None:
        raise HTTPException(409, "Household shopping lists cannot be shared directly")
    if not permissions.can_manage_access:
        raise HTTPException(403, "Shopping list access cannot be managed")
    return row


@router.get("/lists/{shopping_list_id}/members")
def list_shopping_list_members(shopping_list_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        _require_personal_list_manager(db, shopping_list_id, user_id)
        rows = db.execute(
            """SELECT user.id, user.username, user.display_name, grant_row.created_at
               FROM entity_access access
               JOIN entity_access_grants grant_row ON grant_row.entity_access_id = access.id
               JOIN users user ON user.id = grant_row.user_id
               WHERE access.entity_type = 'shopping_list' AND access.entity_id = ?
               ORDER BY lower(COALESCE(user.display_name, user.username)), user.id""",
            (shopping_list_id,),
        ).fetchall()
        return {"members": [dict(row) for row in rows]}


@router.post("/lists/{shopping_list_id}/members")
async def share_shopping_list(shopping_list_id: int, data: ShoppingListShareCreate, user_id: int = Depends(require_auth)):
    identifier = _clean_required(data.identifier, "User identifier", 320)
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        _require_personal_list_manager(db, shopping_list_id, user_id)
        target = _get_user_by_identifier(db, identifier)
        if not target:
            raise HTTPException(404, "User not found")
        try:
            grant_entity_access(db, "shopping_list", shopping_list_id, user_id, int(target["id"]))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        db.commit()
        sync_user_ids = _recipient_ids(db, shopping_list_id)
        member = {key: target.get(key) for key in ("id", "username", "display_name")}
    await broadcast_sync_to_users(sync_user_ids)
    return member


@router.delete("/lists/{shopping_list_id}/members/{member_user_id}")
async def revoke_shopping_list_member(shopping_list_id: int, member_user_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        _require_personal_list_manager(db, shopping_list_id, user_id)
        sync_user_ids = _recipient_ids(db, shopping_list_id) | {member_user_id}
        try:
            revoke_entity_access(db, "shopping_list", shopping_list_id, user_id, member_user_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        db.commit()
    await broadcast_sync_to_users(sync_user_ids)
    return {"id": member_user_id, "revoked": True}


@router.get("/lists/{shopping_list_id}")
def get_shopping_list(shopping_list_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        row, _ = _permissions_for_list(db, shopping_list_id, user_id)
        sections = db.execute(
            "SELECT * FROM shopping_sections WHERE shopping_list_id = ? ORDER BY sort_order, id",
            (shopping_list_id,),
        ).fetchall()
        items = db.execute(
            "SELECT * FROM shopping_items WHERE shopping_list_id = ? ORDER BY completed, sort_order, id",
            (shopping_list_id,),
        ).fetchall()
        preference = db.execute(
            "SELECT * FROM shopping_list_preferences WHERE shopping_list_id = ? AND user_id = ?",
            (shopping_list_id, user_id),
        ).fetchone()
        result = _shopping_list_view(db, row, user_id)
        result["sections"] = [_section_view(section) for section in sections]
        result["items"] = [_item_view(db, item, user_id) for item in items]
        result["preferences"] = _preference_view(shopping_list_id, user_id, preference)
        return result


@router.post("/lists/{shopping_list_id}/sections")
async def create_shopping_section(shopping_list_id: int, data: ShoppingSectionCreate, user_id: int = Depends(require_auth)):
    name = _clean_required(data.name, "Section name", 200)
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        _permissions_for_list(db, shopping_list_id, user_id, manage=True)
        if data.client_mutation_id:
            existing = db.execute(
                "SELECT * FROM shopping_sections WHERE shopping_list_id = ? AND client_mutation_id = ?",
                (shopping_list_id, data.client_mutation_id),
            ).fetchone()
            if existing:
                return _section_view(existing)
        try:
            cursor = db.execute(
                """INSERT INTO shopping_sections
                   (shopping_list_id, name, sort_order, created_by_user_id, client_mutation_id, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (shopping_list_id, name, data.sort_order, user_id, data.client_mutation_id, now_iso()),
            )
            section_id = int(cursor.lastrowid)
            db.commit()
        except sqlite3.IntegrityError as exc:
            db.rollback()
            if data.client_mutation_id:
                existing = db.execute(
                    "SELECT * FROM shopping_sections WHERE shopping_list_id = ? AND client_mutation_id = ?",
                    (shopping_list_id, data.client_mutation_id),
                ).fetchone()
                if existing:
                    return _section_view(existing)
            raise HTTPException(409, "Shopping section could not be saved") from exc
        row = db.execute("SELECT * FROM shopping_sections WHERE id = ?", (section_id,)).fetchone()
        result = _section_view(row)
        await broadcast_change("shopping_section_create", result, user_id, recipient_ids=_recipient_ids(db, shopping_list_id))
        return result


@router.patch("/sections/{section_id}")
async def update_shopping_section(section_id: int, data: ShoppingSectionUpdate, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        section = db.execute("SELECT * FROM shopping_sections WHERE id = ?", (section_id,)).fetchone()
        if not section:
            raise HTTPException(404, "Shopping section not found")
        shopping_list_id = section["shopping_list_id"]
        _permissions_for_list(db, shopping_list_id, user_id, manage=True)
        updates = []
        values = []
        if "name" in data.model_fields_set:
            updates.append("name = ?")
            values.append(_clean_required(data.name or "", "Section name", 200))
        if "sort_order" in data.model_fields_set:
            updates.append("sort_order = ?")
            values.append(data.sort_order)
        if updates:
            updates.append("updated_at = ?")
            values.append(now_iso())
            values.append(section_id)
            db.execute(f"UPDATE shopping_sections SET {', '.join(updates)} WHERE id = ?", values)
        db.commit()
        updated = db.execute("SELECT * FROM shopping_sections WHERE id = ?", (section_id,)).fetchone()
        result = _section_view(updated)
        recipient_ids = _recipient_ids(db, shopping_list_id)
    await broadcast_change("shopping_section_update", result, user_id, recipient_ids=recipient_ids)
    return result


@router.delete("/sections/{section_id}")
async def delete_shopping_section(section_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        section = db.execute("SELECT * FROM shopping_sections WHERE id = ?", (section_id,)).fetchone()
        if not section:
            raise HTTPException(404, "Shopping section not found")
        shopping_list_id = section["shopping_list_id"]
        _permissions_for_list(db, shopping_list_id, user_id, manage=True)
        db.execute("UPDATE shopping_items SET section_id = NULL, updated_at = ? WHERE section_id = ?", (now_iso(), section_id))
        db.execute("DELETE FROM shopping_sections WHERE id = ?", (section_id,))
        db.commit()
        payload = {"id": section_id, "shopping_list_id": shopping_list_id}
        await broadcast_change("shopping_section_delete", payload, user_id, recipient_ids=_recipient_ids(db, shopping_list_id))
        return {"deleted": section_id}


@router.post("/lists/{shopping_list_id}/items")
async def create_shopping_item(shopping_list_id: int, data: ShoppingItemCreate, user_id: int = Depends(require_auth)):
    name = _clean_required(data.name, "Item name", 500)
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        _permissions_for_list(db, shopping_list_id, user_id, write=True)
        if data.client_mutation_id:
            existing = db.execute(
                "SELECT * FROM shopping_items WHERE shopping_list_id = ? AND client_mutation_id = ?",
                (shopping_list_id, data.client_mutation_id),
            ).fetchone()
            if existing:
                return _item_view(db, existing, user_id)
        store_ids = _normalize_store_ids(db, user_id, data.store_ids)
        if data.section_id is not None:
            section = db.execute(
                "SELECT id FROM shopping_sections WHERE id = ? AND shopping_list_id = ?",
                (data.section_id, shopping_list_id),
            ).fetchone()
            if not section:
                raise HTTPException(400, "Section does not belong to the shopping list")
        try:
            cursor = db.execute(
                """INSERT INTO shopping_items
                   (shopping_list_id, section_id, name, quantity_value, quantity_unit,
                    sort_order, client_mutation_id, created_by_user_id, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    shopping_list_id,
                    data.section_id,
                    name,
                    data.quantity_value,
                    _clean_optional(data.quantity_unit, 40),
                    data.sort_order,
                    data.client_mutation_id,
                    user_id,
                    now_iso(),
                ),
            )
            item_id = int(cursor.lastrowid)
            db.executemany(
                "INSERT INTO shopping_item_stores (shopping_item_id, shopping_store_id, sort_order) VALUES (?, ?, ?)",
                [(item_id, store_id, index) for index, store_id in enumerate(store_ids)],
            )
            db.commit()
        except sqlite3.IntegrityError as exc:
            db.rollback()
            raise HTTPException(409, "Shopping item could not be saved") from exc
        row = db.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
        result = _item_view(db, row, user_id)
        await _broadcast_item_change(db, "shopping_item_create", row, user_id, shopping_list_id)
        return result


@router.patch("/items/{item_id}")
async def update_shopping_item(item_id: int, data: ShoppingItemUpdate, user_id: int = Depends(require_auth)):
    fields_set = getattr(data, "model_fields_set", getattr(data, "__fields_set__", set()))
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
        if not existing:
            raise HTTPException(404, "Shopping item not found")
        shopping_list_id = existing["shopping_list_id"]
        _permissions_for_list(db, shopping_list_id, user_id, write=True)
        updates = {}
        if "name" in fields_set:
            updates["name"] = _clean_required(data.name, "Item name", 500)
        if "section_id" in fields_set:
            if data.section_id is not None:
                section = db.execute(
                    "SELECT id FROM shopping_sections WHERE id = ? AND shopping_list_id = ?",
                    (data.section_id, shopping_list_id),
                ).fetchone()
                if not section:
                    raise HTTPException(400, "Section does not belong to the shopping list")
            updates["section_id"] = data.section_id
        if "quantity_value" in fields_set:
            updates["quantity_value"] = data.quantity_value
        if "quantity_unit" in fields_set:
            updates["quantity_unit"] = _clean_optional(data.quantity_unit, 40)
        store_ids = None
        if "store_ids" in fields_set:
            retained_store_ids = {
                int(row["shopping_store_id"])
                for row in db.execute(
                    "SELECT shopping_store_id FROM shopping_item_stores WHERE shopping_item_id = ?",
                    (item_id,),
                ).fetchall()
            }
            store_ids = _normalize_store_ids(
                db,
                user_id,
                data.store_ids,
                retained_store_ids=retained_store_ids,
            )
        if "sort_order" in fields_set:
            _permissions_for_list(db, shopping_list_id, user_id, manage=True)
            updates["sort_order"] = data.sort_order
        if "completed" in fields_set:
            updates["completed"] = int(bool(data.completed))
            updates["completed_at"] = now_iso() if data.completed else None
            updates["completed_by_user_id"] = user_id if data.completed else None
        if updates:
            updates["updated_at"] = now_iso()
            allowed = {
                "name", "section_id", "quantity_value", "quantity_unit",
                "sort_order", "completed", "completed_at", "completed_by_user_id", "updated_at",
            }
            safe = {key: value for key, value in updates.items() if key in allowed}
            set_clause = ", ".join(f"{key} = :{key}" for key in safe)
            db.execute(f"UPDATE shopping_items SET {set_clause} WHERE id = :id", {**safe, "id": item_id})
        if store_ids is not None:
            db.execute("DELETE FROM shopping_item_stores WHERE shopping_item_id = ?", (item_id,))
            db.executemany(
                "INSERT INTO shopping_item_stores (shopping_item_id, shopping_store_id, sort_order) VALUES (?, ?, ?)",
                [(item_id, store_id, index) for index, store_id in enumerate(store_ids)],
            )
        if updates or store_ids is not None:
            db.commit()
        row = db.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
        result = _item_view(db, row, user_id)
        await _broadcast_item_change(db, "shopping_item_update", row, user_id, shopping_list_id)
        return result


@router.delete("/items/{item_id}")
async def delete_shopping_item(item_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT shopping_list_id FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
        if not existing:
            raise HTTPException(404, "Shopping item not found")
        shopping_list_id = int(existing["shopping_list_id"])
        _permissions_for_list(db, shopping_list_id, user_id, write=True)
        recipient_ids = _recipient_ids(db, shopping_list_id)
        db.execute("DELETE FROM shopping_items WHERE id = ?", (item_id,))
        db.commit()
    result = {"id": item_id, "shopping_list_id": shopping_list_id, "deleted": True}
    await broadcast_change("shopping_item_delete", result, user_id, recipient_ids=recipient_ids)
    return result


@router.delete("/lists/{shopping_list_id}/items/completed")
async def delete_completed_shopping_items(shopping_list_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        _permissions_for_list(db, shopping_list_id, user_id, manage=True)
        recipient_ids = _recipient_ids(db, shopping_list_id)
        item_ids = [int(row["id"]) for row in db.execute(
            "SELECT id FROM shopping_items WHERE shopping_list_id = ? AND completed = 1",
            (shopping_list_id,),
        ).fetchall()]
        db.execute("DELETE FROM shopping_items WHERE shopping_list_id = ? AND completed = 1", (shopping_list_id,))
        db.commit()
    result = {"shopping_list_id": shopping_list_id, "deleted_ids": item_ids}
    await broadcast_change("shopping_items_completed_delete", result, user_id, recipient_ids=recipient_ids)
    return result


@router.put("/lists/{shopping_list_id}/preferences")
async def update_shopping_preferences(
    shopping_list_id: int,
    data: ShoppingPreferencesUpdate,
    user_id: int = Depends(require_auth),
):
    with get_db() as db:
        _permissions_for_list(db, shopping_list_id, user_id)
        selected_store_id = data.selected_store_id
        if selected_store_id is not None:
            selected_store_id = _normalize_store_ids(db, user_id, [selected_store_id])[0]
        db.execute(
            """INSERT INTO shopping_list_preferences
               (shopping_list_id, user_id, selected_store_id, hide_empty_sections, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(shopping_list_id, user_id) DO UPDATE SET
                   selected_store_id = excluded.selected_store_id,
                   hide_empty_sections = excluded.hide_empty_sections,
                   updated_at = excluded.updated_at""",
            (
                shopping_list_id,
                user_id,
                selected_store_id,
                int(data.hide_empty_sections),
                now_iso(),
            ),
        )
        db.commit()
        row = db.execute(
            "SELECT * FROM shopping_list_preferences WHERE shopping_list_id = ? AND user_id = ?",
            (shopping_list_id, user_id),
        ).fetchone()
        result = _preference_view(shopping_list_id, user_id, row)
        await broadcast_change("shopping_preferences_update", result, user_id, recipient_ids={user_id})
        return result
