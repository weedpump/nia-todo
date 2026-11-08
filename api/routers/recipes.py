"""Cookbook metadata lifecycle; recipes themselves are a subsequent slice."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field, field_validator

from db import get_db, now_iso
from routers.auth import require_auth
from services.appearance import normalize_color, normalize_icon
from services.entity_access import (
    get_entity_access_boundary_user_ids, get_entity_ownership, is_household_participant,
    register_household_entity, register_personal_entity,
    transfer_entity_to_household,
)
from services.recipes import get_cookbook_view, get_sync_cookbooks
from services.utils import sanitize_text

router = APIRouter(prefix="/api/recipes")
CookbookId = Annotated[int, Path(gt=0, le=9223372036854775807)]


async def broadcast_sync_to_users(user_ids: set[int]):
    from routers.websocket import broadcast_sync_to_users as broadcast
    await broadcast(user_ids)


class CookbookCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000)
    color: str = "#6366f1"
    icon: str | None = "book-open"
    sort_order: int = Field(default=0, ge=-9223372036854775808, le=9223372036854775807)
    household_id: int | None = Field(default=None, gt=0, le=9223372036854775807)
    client_mutation_id: str | None = Field(default=None, min_length=1, max_length=200)


class CookbookUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    color: str | None = None
    icon: str | None = None
    sort_order: int | None = Field(default=None, ge=-9223372036854775808, le=9223372036854775807)

    @field_validator("sort_order", "description")
    @classmethod
    def reject_explicit_null(cls, value):
        if value is None:
            raise ValueError("Value cannot be null")
        return value


class CookbookHouseholdTransfer(BaseModel):
    household_id: int = Field(gt=0, le=9223372036854775807)


def _name(value: str | None) -> str:
    cleaned = sanitize_text(value or "").strip()
    if not cleaned:
        raise HTTPException(422, "Cookbook name is required")
    return cleaned


def _require_cookbook(db, cookbook_id: int, user_id: int, *, manage: bool = False):
    view = get_cookbook_view(db, cookbook_id, user_id)
    if view is None or (manage and not view["can_manage"]):
        raise HTTPException(404, "Cookbook not found")
    return view


@router.get("/cookbooks")
def list_cookbooks(user_id: int = Depends(require_auth)):
    with get_db() as db:
        return {"cookbooks": get_sync_cookbooks(db, user_id)}


@router.get("/cookbooks/{cookbook_id}")
def get_cookbook(cookbook_id: CookbookId, user_id: int = Depends(require_auth)):
    with get_db() as db:
        return _require_cookbook(db, cookbook_id, user_id)


@router.post("/cookbooks")
async def create_cookbook(data: CookbookCreate, user_id: int = Depends(require_auth)):
    name, color, icon = _name(data.name), normalize_color(data.color), normalize_icon(data.icon)
    mutation_id = data.client_mutation_id.strip() if data.client_mutation_id is not None else None
    if mutation_id == "":
        raise HTTPException(422, "Client mutation ID is required")
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        if mutation_id is not None:
            existing = db.execute("SELECT cookbook_id FROM cookbook_creation_receipts WHERE user_id = ? AND client_mutation_id = ?", (user_id, mutation_id)).fetchone()
            if existing:
                if existing["cookbook_id"] is None:
                    raise HTTPException(404, "Cookbook not found")
                return _require_cookbook(db, existing["cookbook_id"], user_id)
        if data.household_id is not None and not is_household_participant(db, data.household_id, user_id):
            raise HTTPException(403, "Not a member of this household")
        cookbook_id = db.execute(
            """INSERT INTO cookbooks (name, description, color, icon, sort_order, created_by_user_id, client_mutation_id, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (name, sanitize_text(data.description).strip(), color, icon, data.sort_order, user_id, mutation_id, now_iso()),
        ).lastrowid
        if mutation_id is not None:
            db.execute("INSERT INTO cookbook_creation_receipts (user_id, client_mutation_id, cookbook_id) VALUES (?, ?, ?)", (user_id, mutation_id, cookbook_id))
        if data.household_id is None:
            register_personal_entity(db, "cookbook", cookbook_id, user_id)
        else:
            register_household_entity(db, "cookbook", cookbook_id, user_id, data.household_id)
        result = _require_cookbook(db, cookbook_id, user_id)
        recipients = get_entity_access_boundary_user_ids(db, "cookbook", cookbook_id)
        db.commit()
    await broadcast_sync_to_users(recipients)
    return result


@router.patch("/cookbooks/{cookbook_id}")
async def update_cookbook(cookbook_id: CookbookId, data: CookbookUpdate, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        _require_cookbook(db, cookbook_id, user_id, manage=True)
        updates = data.model_dump(exclude_unset=True)
        for field in updates:
            if field == "name": updates[field] = _name(updates[field])
            elif field == "description": updates[field] = sanitize_text(updates[field]).strip()
            elif field == "color": updates[field] = normalize_color(updates[field])
            elif field == "icon": updates[field] = normalize_icon(updates[field])
        if updates:
            updates["updated_at"] = now_iso()
            db.execute("UPDATE cookbooks SET " + ", ".join(field + " = ?" for field in updates) + " WHERE id = ?", (*updates.values(), cookbook_id))
        result = _require_cookbook(db, cookbook_id, user_id)
        recipients = get_entity_access_boundary_user_ids(db, "cookbook", cookbook_id)
        db.commit()
    await broadcast_sync_to_users(recipients)
    return result


@router.delete("/cookbooks/{cookbook_id}")
async def delete_cookbook(cookbook_id: CookbookId, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        _require_cookbook(db, cookbook_id, user_id, manage=True)
        recipients = get_entity_access_boundary_user_ids(db, "cookbook", cookbook_id)
        db.execute("DELETE FROM entity_access WHERE entity_type = 'cookbook' AND entity_id = ?", (cookbook_id,))
        db.execute("DELETE FROM cookbooks WHERE id = ?", (cookbook_id,))
        db.commit()
    await broadcast_sync_to_users(recipients)
    return {"id": cookbook_id, "deleted": True}


@router.post("/cookbooks/{cookbook_id}/household")
async def transfer_cookbook_to_household(cookbook_id: CookbookId, data: CookbookHouseholdTransfer, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        _require_cookbook(db, cookbook_id, user_id, manage=True)
        ownership = get_entity_ownership(db, "cookbook", cookbook_id)
        if ownership["owner_household_id"] is not None:
            raise HTTPException(409, "Cookbook already belongs to a household")
        recipients = get_entity_access_boundary_user_ids(db, "cookbook", cookbook_id)
        try:
            transfer_entity_to_household(db, "cookbook", cookbook_id, user_id, data.household_id)
        except PermissionError as error:
            raise HTTPException(403, str(error)) from error
        recipients.update(get_entity_access_boundary_user_ids(db, "cookbook", cookbook_id))
        result = _require_cookbook(db, cookbook_id, user_id)
        db.commit()
    await broadcast_sync_to_users(recipients)
    return result
