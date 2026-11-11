"""Canonical Shopping item writes, amount validation and scoped destinations."""

import math

from fastapi import HTTPException

from db import now_iso
from services.entity_access import resolve_entity_access
from services.creation_receipts import creation_replay
from services.quantity_units import normalize_quantity_unit
from services.utils import sanitize_text


def require_list_access(db, shopping_list_id, user_id, *, write=False, manage=False):
    row = db.execute("SELECT * FROM shopping_lists WHERE id = ?", (shopping_list_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Shopping list not found")
    access = resolve_entity_access(db, "shopping_list", shopping_list_id, user_id)
    allowed = access.can_manage_metadata if manage else access.can_edit_content if write else access.can_view
    if not allowed:
        raise HTTPException(404, "Shopping list not found")
    return row, access


def clean_item_text(value, maximum, *, required=False):
    text = sanitize_text(value or "").strip()
    if required and not text:
        raise HTTPException(422, "Item name is required")
    if len(text) > maximum:
        raise HTTPException(422, "Shopping item text is too long")
    return text


def validate_item_amount(quantity_value, quantity_text):
    text = plain_item_text(quantity_text, 500) or None
    if quantity_value is not None:
        if isinstance(quantity_value, bool) or not math.isfinite(quantity_value) or quantity_value < 0:
            raise HTTPException(422, "Invalid shopping quantity")
        if text:
            raise HTTPException(422, "Numeric and free quantities are mutually exclusive")
    return text


def plain_item_text(value, maximum):
    text = (value or "").replace("\x00", "").strip()
    if len(text) > maximum:
        raise HTTPException(422, "Shopping item text is too long")
    return text


def list_item_targets(db, shopping_list_id):
    return {
        "sections": {row["id"] for row in db.execute("SELECT id FROM shopping_sections WHERE shopping_list_id = ?", (shopping_list_id,))},
        "stores": {row["id"]: bool(row["active"]) for row in db.execute("SELECT id, active FROM shopping_stores WHERE shopping_list_id = ?", (shopping_list_id,))},
    }


def validate_item_target(targets, section_id, store_ids, *, active_only=False):
    if section_id is not None and section_id not in targets["sections"]:
        raise HTTPException(400, "Section does not belong to the shopping list")
    stores = list(dict.fromkeys(store_ids or []))
    if len(stores) > 50:
        raise HTTPException(422, "Too many shopping stores")
    for store in stores:
        if store not in targets["stores"]:
            raise HTTPException(400, "Shopping store does not belong to the shopping list")
        if active_only and not targets["stores"][store]:
            raise HTTPException(400, "Shopping store is inactive")
    return stores


def insert_shopping_item(db, shopping_list_id, user_id, *, name, section_id=None,
                         quantity_value=None, quantity_unit=None, quantity_text=None,
                         note="", store_ids=(), sort_order=0, client_mutation_id=None,
                         quantity_display_mode="exact"):
    """Insert validated canonical content in the caller's writer transaction.

    The caller authorizes the list and resolves destinations, once for a normal
    create or once for an entire batch. No commit or broadcast happens here.
    """
    if not db.in_transaction:
        raise RuntimeError("Shopping item inserts require a writer transaction")
    if quantity_display_mode not in ("exact", "kitchen"):
        raise ValueError("Invalid quantity display mode")
    existing = creation_replay(db, "shopping_item", shopping_list_id, client_mutation_id)
    if existing is not None:
        return existing["id"]
    cursor = db.execute(
        """INSERT INTO shopping_items
           (shopping_list_id, section_id, name, quantity_value, quantity_unit,
            quantity_text, note, sort_order, client_mutation_id, created_by_user_id, updated_at, quantity_display_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (shopping_list_id, section_id, clean_item_text(name, 500, required=True), quantity_value,
         normalize_quantity_unit(clean_item_text(quantity_unit, 40)), validate_item_amount(quantity_value, quantity_text),
         plain_item_text(note, 2000), sort_order, client_mutation_id, user_id, now_iso(), quantity_display_mode),
    )
    item_id = int(cursor.lastrowid)
    db.executemany(
        """INSERT INTO shopping_item_stores
           (shopping_item_id, shopping_store_id, shopping_list_id, sort_order) VALUES (?, ?, ?, ?)""",
        [(item_id, store_id, shopping_list_id, index) for index, store_id in enumerate(store_ids)],
    )
    return item_id


def item_recipe_sources(db, item_id, user_id):
    return item_recipe_sources_for_items(db, [item_id], user_id)[item_id]


def item_recipe_sources_for_items(db, item_ids, user_id):
    # Metadata intentionally belongs to the Shopping boundary. Live Recipe IDs
    # are separately gated; a private source must not become a navigation leak.
    result = {item_id: ([], 0) for item_id in item_ids}
    permissions = {}
    for offset in range(0, len(item_ids), 400):
        chunk = item_ids[offset:offset + 400]
        placeholders = ",".join("?" for _ in chunk)
        rows = db.execute(
            f"""SELECT * FROM (
                SELECT source.*, recipe.cookbook_id,
                       COUNT(*) OVER (PARTITION BY source.shopping_item_id) AS source_count,
                       ROW_NUMBER() OVER (PARTITION BY source.shopping_item_id ORDER BY source.id DESC) AS source_position
                FROM shopping_item_recipe_sources source
                LEFT JOIN recipes recipe ON recipe.id = source.recipe_id
                WHERE source.shopping_item_id IN ({placeholders})
            ) WHERE source_position <= 50 ORDER BY shopping_item_id, id""", chunk,
        ).fetchall()
        for row in rows:
            book_id = row["cookbook_id"]
            if book_id is not None and book_id not in permissions:
                permissions[book_id] = resolve_entity_access(db, "cookbook", book_id, user_id).can_view
            item = {key: row[key] for key in ("source_revision", "recipe_title", "ingredient_client_key", "ingredient_name",
                    "quantity_value", "quantity_unit", "quantity_text", "note", "base_servings", "servings")}
            item["recipe_id"] = row["recipe_id"] if permissions.get(book_id, False) else None
            item["quantity_unit"] = normalize_quantity_unit(item["quantity_unit"])
            sources, _ = result[row["shopping_item_id"]]
            sources.append(item)
            result[row["shopping_item_id"]] = sources, row["source_count"]
    return result
