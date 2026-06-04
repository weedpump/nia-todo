"""nia-todo: Saved place endpoints for location reminders."""

from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from db import get_db, now_iso
from routers.auth import require_auth
from services.utils import sanitize_text
from services.websocket import broadcast_change
from routers.todos import fetch_todo

router = APIRouter(prefix="/api/places")


class PlacePayload(BaseModel):
    name: str
    address: str
    icon: Optional[str] = "pin"


class PlaceUpdate(BaseModel):
    name: Optional[str] = None
    address: Optional[str] = None
    icon: Optional[str] = None


def _place_dict(row):
    return dict(row) if row else None


def _validate_place_name(name: str) -> str:
    cleaned = sanitize_text(name or "").strip()
    if not cleaned:
        raise HTTPException(422, "Place name is required")
    if len(cleaned) > 120:
        raise HTTPException(422, "Place name is too long")
    return cleaned


def _clean_optional_text(value: str | None, limit: int = 500) -> str:
    cleaned = sanitize_text(value or "").strip()
    return cleaned[:limit]


@router.get("")
def list_places(user_id: int = Depends(require_auth)):
    with get_db() as db:
        rows = db.execute(
            """SELECT * FROM saved_places
               WHERE user_id = ?
               ORDER BY lower(name), id""",
            (user_id,),
        ).fetchall()
        return {"places": [dict(row) for row in rows]}


@router.post("")
def create_place(data: PlacePayload, user_id: int = Depends(require_auth)):
    name = _validate_place_name(data.name)
    address = _clean_optional_text(data.address)
    if not address:
        raise HTTPException(422, "Place address is required")
    now = now_iso()
    try:
        with get_db() as db:
            cursor = db.execute(
                """INSERT INTO saved_places
                   (user_id, name, address, icon, created_at, updated_at)
                   VALUES (?,?,?,?,?,?)""",
                (
                    user_id,
                    name,
                    address,
                    _clean_optional_text(data.icon, 40) or "pin",
                    now,
                    now,
                ),
            )
            db.commit()
            row = db.execute("SELECT * FROM saved_places WHERE id = ?", (cursor.lastrowid,)).fetchone()
            return _place_dict(row)
    except Exception as error:
        if "idx_saved_places_user_name" in str(error) or "UNIQUE" in str(error).upper():
            raise HTTPException(409, "Place name already exists")
        raise


@router.patch("/{place_id}")
async def update_place(place_id: int, data: PlaceUpdate, user_id: int = Depends(require_auth)):
    updates = {}
    dumped = data.model_dump(exclude_unset=True)
    if "name" in dumped:
        updates["name"] = _validate_place_name(data.name or "")
    if "address" in dumped:
        address = _clean_optional_text(data.address)
        if not address:
            raise HTTPException(422, "Place address is required")
        updates["address"] = address
    if "icon" in dumped:
        updates["icon"] = _clean_optional_text(data.icon, 40) or "pin"
    if not updates:
        with get_db() as db:
            row = db.execute("SELECT * FROM saved_places WHERE id = ? AND user_id = ?", (place_id, user_id)).fetchone()
            if not row:
                raise HTTPException(404, "Place not found")
            return _place_dict(row)
    updated_at = now_iso()
    updates["updated_at"] = updated_at
    try:
        todos_to_broadcast = []
        with get_db() as db:
            existing = db.execute("SELECT * FROM saved_places WHERE id = ? AND user_id = ?", (place_id, user_id)).fetchone()
            if not existing:
                raise HTTPException(404, "Place not found")
            linked_todo_ids = []
            if "address" in updates:
                linked_todo_rows = db.execute(
                    """SELECT DISTINCT todo_id FROM location_reminders
                       WHERE place_id = ? AND user_id = ?""",
                    (place_id, user_id),
                ).fetchall()
                linked_todo_ids = [row["todo_id"] for row in linked_todo_rows]
            set_clause = ", ".join(f"{field}=:{field}" for field in updates)
            db.execute(f"UPDATE saved_places SET {set_clause} WHERE id = :id AND user_id = :user_id", {**updates, "id": place_id, "user_id": user_id})
            if "address" in updates and linked_todo_ids:
                placeholders = ",".join("?" for _ in linked_todo_ids)
                db.execute(
                    f"""UPDATE location_reminders
                        SET address = ?, updated_at = ?
                        WHERE place_id = ? AND user_id = ? AND todo_id IN ({placeholders})""",
                    [updates["address"], updated_at, place_id, user_id, *linked_todo_ids],
                )
                db.execute(
                    f"UPDATE todos SET updated_at = ? WHERE id IN ({placeholders})",
                    [updated_at, *linked_todo_ids],
                )
            db.commit()
            row = db.execute("SELECT * FROM saved_places WHERE id = ?", (place_id,)).fetchone()
            for todo_id in linked_todo_ids:
                todo = fetch_todo(db, todo_id, user_id)
                if todo:
                    todos_to_broadcast.append(todo)
            place = _place_dict(row)
        for todo in todos_to_broadcast:
            # Saved-place reminders are user-scoped. Do not broadcast a user-specific
            # location_reminder payload to shared-project members.
            await broadcast_change("todo_update", todo, user_id)
        return place
    except Exception as error:
        if "idx_saved_places_user_name" in str(error) or "UNIQUE" in str(error).upper():
            raise HTTPException(409, "Place name already exists")
        raise


@router.delete("/{place_id}")
def delete_place(place_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        existing = db.execute("SELECT id FROM saved_places WHERE id = ? AND user_id = ?", (place_id, user_id)).fetchone()
        if not existing:
            raise HTTPException(404, "Place not found")
        db.execute("DELETE FROM saved_places WHERE id = ? AND user_id = ?", (place_id, user_id))
        db.commit()
        return {"deleted": place_id}
