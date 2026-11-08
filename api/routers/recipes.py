"""Cookbook metadata and revisioned recipe aggregate endpoints."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field, field_validator

from db import get_db, now_iso
from routers.auth import require_auth
from services.appearance import normalize_color, normalize_icon
from services.entity_access import (
    get_entity_access_boundary_user_ids, get_entity_ownership, is_household_participant,
    register_household_entity, register_personal_entity, resolve_entity_access,
    transfer_entity_to_household,
)
from services.recipes import get_cookbook_view, get_sync_cookbooks
from services.recipe_content import RecipeCreate, RecipePatch, get_recipe_view, merge_recipe_patch, write_recipe_children
from services.recipe_shopping_transfer import RecipeShoppingTransfer, apply_recipe_shopping_transfer
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
        db.execute("BEGIN")
        return {"cookbooks": get_sync_cookbooks(db, user_id)}


@router.get("/cookbooks/{cookbook_id}")
def get_cookbook(cookbook_id: CookbookId, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN")
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


def _require_recipe_book(db, cookbook_id: int | None, user_id: int):
    if cookbook_id is None or not db.execute("SELECT 1 FROM cookbooks WHERE id = ?", (cookbook_id,)).fetchone():
        raise HTTPException(404, "Recipe not found")
    if not resolve_entity_access(db, "cookbook", cookbook_id, user_id).can_edit_content:
        raise HTTPException(404, "Recipe not found")


def _recipe_receipt(db, user_id: int, mutation_id: str, operation: str, *, recipe_id=None, cookbook_id=None):
    receipt = db.execute("SELECT * FROM recipe_mutation_receipts WHERE user_id = ? AND client_mutation_id = ?", (user_id, mutation_id)).fetchone()
    if not receipt:
        return None
    _require_recipe_book(db, receipt["cookbook_id"], user_id)
    if receipt["operation"] != operation or (recipe_id is not None and receipt["target_recipe_id"] != recipe_id) or (cookbook_id is not None and receipt["cookbook_id"] != cookbook_id):
        raise HTTPException(409, {"code": "recipe.mutationReused"})
    if operation == "delete":
        return {"id": receipt["target_recipe_id"], "cookbook_id": receipt["cookbook_id"], "deleted": True, "applied_revision": receipt["applied_revision"]}
    current = get_recipe_view(db, receipt["recipe_id"], user_id) if receipt["recipe_id"] is not None else None
    if current is None:
        raise HTTPException(404, "Recipe not found")
    return {**current, "applied_revision": receipt["applied_revision"]}


def _record_recipe_receipt(db, user_id, mutation_id, operation, recipe_id, cookbook_id, revision):
    db.execute(
        """INSERT INTO recipe_mutation_receipts
           (user_id, client_mutation_id, operation, recipe_id, target_recipe_id, cookbook_id, applied_revision)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (user_id, mutation_id, operation, recipe_id, recipe_id, cookbook_id, revision),
    )


def _write_recipe_image(db, recipe_id: int, payload):
    if "image_data" not in payload.model_fields_set:
        return
    from services.recipe_images import normalize_recipe_image
    try:
        image = normalize_recipe_image(payload.image_data)
    except ValueError as error:
        raise HTTPException(422, "Invalid recipe image") from error
    if image is None:
        db.execute("DELETE FROM recipe_images WHERE recipe_id = ?", (recipe_id,))
    else:
        db.execute(
            """INSERT INTO recipe_images (recipe_id, content_hash, content, media_type) VALUES (?, ?, ?, ?)
               ON CONFLICT(recipe_id) DO UPDATE SET content_hash = excluded.content_hash, content = excluded.content, media_type = excluded.media_type""",
            (recipe_id, image["content_hash"], image["content"], image["media_type"]),
        )


def _check_recipe_revision(current, expected_revision):
    if current["revision"] != expected_revision:
        raise HTTPException(409, {"code": "recipe.revisionConflict", "current": current})


@router.post("/cookbooks/{cookbook_id}/recipes")
async def create_recipe(cookbook_id: CookbookId, data: RecipeCreate, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        _require_recipe_book(db, cookbook_id, user_id)
        replay = _recipe_receipt(db, user_id, data.client_mutation_id, "create", cookbook_id=cookbook_id)
        if replay is not None:
            return replay
        recipe_id = db.execute(
            """INSERT INTO recipes (cookbook_id, title, description, base_servings, prep_minutes, cook_minutes, created_by_user_id, client_mutation_id, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (cookbook_id, data.title, data.description, data.base_servings, data.prep_minutes, data.cook_minutes, user_id, data.client_mutation_id, now_iso()),
        ).lastrowid
        write_recipe_children(db, recipe_id, data)
        _write_recipe_image(db, recipe_id, data)
        _record_recipe_receipt(db, user_id, data.client_mutation_id, "create", recipe_id, cookbook_id, 1)
        result = {**get_recipe_view(db, recipe_id, user_id), "applied_revision": 1}
        recipients = get_entity_access_boundary_user_ids(db, "cookbook", cookbook_id)
        db.commit()
    await broadcast_sync_to_users(recipients)
    return result


@router.post("/recipes/{recipe_id}/shopping-transfer")
async def transfer_recipe_to_shopping(recipe_id: CookbookId, data: RecipeShoppingTransfer,
                                      user_id: int = Depends(require_auth)):
    # Compose the same list projection as normal Shopping GET/snapshots, within
    # the transfer writer transaction rather than opening a second connection.
    from routers.shopping import shopping_list_projection
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        receipt, applied = apply_recipe_shopping_transfer(db, recipe_id, user_id, data)
        result = {**receipt, "shopping_list": shopping_list_projection(db, data.shopping_list_id, user_id)}
        recipients = get_entity_access_boundary_user_ids(db, "shopping_list", data.shopping_list_id) if applied else set()
        db.commit()
    if applied:
        await broadcast_sync_to_users(recipients)
    return result


@router.get("/recipes/{recipe_id}")
def get_recipe(recipe_id: CookbookId, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN")
        result = get_recipe_view(db, recipe_id, user_id)
        if result is None:
            raise HTTPException(404, "Recipe not found")
        return result


@router.patch("/recipes/{recipe_id}")
async def update_recipe(recipe_id: CookbookId, data: RecipePatch, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        replay = _recipe_receipt(db, user_id, data.client_mutation_id, "update", recipe_id=recipe_id)
        if replay is not None:
            return replay
        current = get_recipe_view(db, recipe_id, user_id)
        if current is None:
            raise HTTPException(404, "Recipe not found")
        _require_recipe_book(db, current["cookbook_id"], user_id)
        _check_recipe_revision(current, data.expected_revision)
        from pydantic import ValidationError
        try:
            content = RecipeCreate.model_validate(merge_recipe_patch(current, data))
        except ValidationError as error:
            raise HTTPException(422, "Invalid recipe aggregate") from error
        revision = current["revision"] + 1
        db.execute(
            """UPDATE recipes SET title = ?, description = ?, base_servings = ?, prep_minutes = ?, cook_minutes = ?, revision = ?, updated_at = ? WHERE id = ?""",
            (content.title, content.description, content.base_servings, content.prep_minutes, content.cook_minutes, revision, now_iso(), recipe_id),
        )
        write_recipe_children(db, recipe_id, content)
        _write_recipe_image(db, recipe_id, data)
        _record_recipe_receipt(db, user_id, data.client_mutation_id, "update", recipe_id, current["cookbook_id"], revision)
        result = {**get_recipe_view(db, recipe_id, user_id), "applied_revision": revision}
        recipients = get_entity_access_boundary_user_ids(db, "cookbook", current["cookbook_id"])
        db.commit()
    await broadcast_sync_to_users(recipients)
    return result


@router.delete("/recipes/{recipe_id}")
async def delete_recipe(recipe_id: CookbookId, expected_revision: Annotated[int, Query(gt=0, le=9223372036854775807)],
                        client_mutation_id: Annotated[str, Query(min_length=1, max_length=200)], user_id: int = Depends(require_auth)):
    mutation_id = client_mutation_id.strip()
    if not mutation_id:
        raise HTTPException(422, "Client mutation ID is required")
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        replay = _recipe_receipt(db, user_id, mutation_id, "delete", recipe_id=recipe_id)
        if replay is not None:
            return replay
        current = get_recipe_view(db, recipe_id, user_id)
        if current is None:
            raise HTTPException(404, "Recipe not found")
        _require_recipe_book(db, current["cookbook_id"], user_id)
        _check_recipe_revision(current, expected_revision)
        _record_recipe_receipt(db, user_id, mutation_id, "delete", recipe_id, current["cookbook_id"], current["revision"])
        recipients = get_entity_access_boundary_user_ids(db, "cookbook", current["cookbook_id"])
        db.execute("DELETE FROM recipes WHERE id = ?", (recipe_id,))
        db.commit()
        result = {"id": recipe_id, "cookbook_id": current["cookbook_id"], "deleted": True, "applied_revision": current["revision"]}
    await broadcast_sync_to_users(recipients)
    return result
