"""Atomic recipe-to-list transfer, amount merging and durable acknowledgements."""

import hashlib
import json
import math
import unicodedata
from decimal import Decimal, InvalidOperation, localcontext
from typing import Annotated

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from db import now_iso
from services.quantity_units import convert_quantity, normalize_quantity_unit
from services.routing_memory import RoutingFeedback, record_route_choice, recipe_event_key
from services.recipe_content import get_authorized_recipe_row, get_recipe_view
from services.shopping_items import (
    clean_item_text, insert_shopping_item, list_item_targets, require_list_access, validate_item_target,
)

EntityId = Annotated[int, Field(gt=0, le=9223372036854775807, strict=True)]
MutationId = Annotated[str, Field(min_length=1, max_length=200)]


class TransferIngredient(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ingredient_client_key: MutationId
    section_id: EntityId | None = None
    store_ids: list[EntityId] = Field(default_factory=list, max_length=50)
    merge_group: MutationId | None = None
    routing_feedback: RoutingFeedback | None = None

    @field_validator("ingredient_client_key", "merge_group")
    @classmethod
    def nonblank_key(cls, value):
        if value is None:
            return None
        if not value.strip():
            raise ValueError("Ingredient key cannot be blank")
        return value.strip()

    @field_validator("store_ids")
    @classmethod
    def canonical_stores(cls, values):
        return sorted(set(values))


class RecipeShoppingTransfer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    shopping_list_id: EntityId
    servings: float = Field(gt=0, le=100000, allow_inf_nan=False, strict=True)
    expected_revision: int = Field(ge=0, le=9223372036854775807, strict=True)
    source_mutation_id: MutationId | None = None
    client_mutation_id: MutationId
    ingredients: list[TransferIngredient] = Field(min_length=1, max_length=500)

    @field_validator("servings", mode="before")
    @classmethod
    def finite_servings(cls, value):
        # JSON decoders may accept NaN/Infinity. Avoid including those invalid
        # JSON numbers in FastAPI's validation-error response itself.
        if isinstance(value, float) and not math.isfinite(value):
            raise HTTPException(422, "Servings must be finite")
        return value

    @field_validator("source_mutation_id", "client_mutation_id")
    @classmethod
    def nonblank_mutation(cls, value):
        if value is not None and not value.strip():
            raise ValueError("Mutation ID cannot be blank")
        return value.strip() if value is not None else None

    @model_validator(mode="after")
    def selection_contract(self):
        keys = [item.ingredient_client_key for item in self.ingredients]
        if len(keys) != len(set(keys)):
            raise ValueError("Ingredient keys must be unique")
        if self.source_mutation_id is None and self.expected_revision == 0:
            raise ValueError("A positive source revision is required")
        return self


def normalized_ingredient_name(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def _confirmed_routing_choices(ingredients, selected, shopping_list_id):
    """One item can have several real transfer routes, but memory is per field.

    A disagreement between explicitly chosen source destinations is not evidence
    for either choice. Keep independently agreed fields; never let source order
    choose which of conflicting destinations will be proposed next time.
    """
    values, observations = {}, {}
    for ingredient in ingredients:
        target = selected.get(ingredient["client_key"])
        feedback = target.routing_feedback if target else None
        if feedback is None or not feedback.fields:
            continue
        name = clean_item_text(ingredient["name"], 500, required=True)
        name_key = normalized_ingredient_name(name)
        chosen = {"module":"shopping","list": shopping_list_id, "section": target.section_id, "stores": tuple(sorted(set(target.store_ids)))}
        per_field = values.setdefault((name_key, feedback.generation), {})
        for field in feedback.fields:
            per_field.setdefault(field, set()).add(chosen[field])
        # Keep epochs separate: an old pending source cannot borrow the current
        # generation from another source to recreate forgotten choices.
        observation = observations.setdefault((name_key, feedback.generation),
            {"name": name, "feedback": feedback, "fields": set()})
        observation["fields"].update(feedback.fields)
    result = []
    for (name_key, generation), observation in observations.items():
        per_field = values[(name_key, generation)]
        fields = sorted(field for field in observation["fields"] if len(per_field[field]) == 1)
        if not fields:
            continue
        section_id = next(iter(per_field["section"])) if "section" in fields else None
        store_ids = list(next(iter(per_field["stores"]))) if "stores" in fields else []
        result.append((observation["name"], section_id, store_ids,
                       observation["feedback"].model_copy(update={"fields": fields})))
    return result


def _finite_quantity(value):
    try:
        result = float(value)
    except (ValueError, OverflowError):
        raise HTTPException(422, "Scaled quantity is outside the supported range") from None
    if not math.isfinite(result) or result < 0 or (value > 0 and result == 0):
        raise HTTPException(422, "Scaled quantity is outside the supported range")
    return result


def _source_revision(db, recipe, actor_id, payload):
    expected = payload.expected_revision
    if payload.source_mutation_id is not None:
        receipt = db.execute(
            """SELECT target_recipe_id, applied_revision, operation FROM recipe_mutation_receipts
               WHERE user_id = ? AND client_mutation_id = ?""", (actor_id, payload.source_mutation_id),
        ).fetchone()
        if receipt is None or receipt["target_recipe_id"] != recipe["id"] or receipt["operation"] not in ("create", "update"):
            raise HTTPException(409, {"code": "recipe.sourceMutationUnavailable"})
        expected = receipt["applied_revision"]
    if recipe["revision"] != expected:
        raise HTTPException(409, {"code": "recipe.revisionConflict", "current": get_recipe_view(db, recipe["id"], actor_id)})
    return expected


def _route_key(name, note, section_id, store_ids):
    return normalized_ingredient_name(name), note or "", section_id, tuple(sorted(store_ids))


def _merge_groups(ingredients, selected):
    """Validate request-local equivalence, preserving every original source.

    Explicit groups override only note differences. Names, quantities, units
    and authorized destinations must still agree. Truncated display notes are
    never sufficient evidence to match a pre-existing Shopping item.
    """
    groups = {}
    for ingredient in ingredients:
        target = selected.get(ingredient["client_key"])
        if target is not None and target.merge_group is not None:
            groups.setdefault(target.merge_group, []).append((ingredient, target))
    result = {}
    for group_id, members in groups.items():
        first, first_target = members[0]
        first_name = normalized_ingredient_name(clean_item_text(first["name"], 500, required=True))
        notes = []
        for ingredient, target in members:
            if (ingredient["quantity_value"] is None or ingredient["quantity_text"]
                    or normalized_ingredient_name(clean_item_text(ingredient["name"], 500, required=True)) != first_name
                    or target.section_id != first_target.section_id or target.store_ids != first_target.store_ids
                    or convert_quantity(Decimal(1), ingredient["quantity_unit"], first["quantity_unit"]) is None):
                raise HTTPException(422, "Merge group ingredients must have matching names, numeric compatible amounts and destinations")
            note = ingredient["note"]
            if note and note not in notes:
                notes.append(note)
        note = "\n".join(notes)
        truncated = len(note) > 2000
        result[group_id] = {"note": note[:1999] + "…" if truncated else note, "match_existing": not truncated, "candidates": []}
    return result


def apply_recipe_shopping_transfer(db, recipe_id, actor_id, payload):
    """Return receipt fields and whether a new batch was applied; never commit.

    Destination authorization precedes replay. Existing actor receipts remain
    valid after source edits/deletion, while never re-exposing source details.
    """
    if not db.in_transaction:
        raise RuntimeError("Recipe transfer requires a writer transaction")
    require_list_access(db, payload.shopping_list_id, actor_id, write=True)
    request_data = payload.model_dump()
    # Absent new capabilities must retain pre-66 durable receipt fingerprints.
    for ingredient in request_data["ingredients"]:
        if ingredient["merge_group"] is None:
            del ingredient["merge_group"]
        if ingredient["routing_feedback"] is None:
            del ingredient["routing_feedback"]
    request_hash = hashlib.sha256(json.dumps(
        {"recipe_id": recipe_id, **request_data}, sort_keys=True, ensure_ascii=False, allow_nan=False,
    ).encode()).hexdigest()
    receipt = db.execute(
        "SELECT * FROM recipe_shopping_transfers WHERE user_id = ? AND client_mutation_id = ?",
        (actor_id, payload.client_mutation_id),
    ).fetchone()
    if receipt is not None:
        if receipt["request_hash"] != request_hash or receipt["target_shopping_list_id"] != payload.shopping_list_id:
            raise HTTPException(409, {"code": "recipe.transferMutationReused"})
        return {key: receipt[key] for key in ("created_count", "merged_count", "client_mutation_id", "source_revision")}, False

    recipe = get_authorized_recipe_row(db, recipe_id, actor_id)
    if recipe is None:
        raise HTTPException(404, "Recipe not found")
    source_revision = _source_revision(db, recipe, actor_id, payload)
    ingredients = db.execute(
        """SELECT ingredient.* FROM recipe_ingredients ingredient
           JOIN recipe_ingredient_groups group_row ON group_row.id = ingredient.group_id AND group_row.recipe_id = ingredient.recipe_id
           WHERE ingredient.recipe_id = ? ORDER BY group_row.sort_order, group_row.id, ingredient.sort_order, ingredient.id""", (recipe_id,),
    ).fetchall()
    selected = {item.ingredient_client_key: item for item in payload.ingredients}
    if not set(selected).issubset({row["client_key"] for row in ingredients}):
        raise HTTPException(422, "Selected ingredient does not belong to the source recipe")
    targets = list_item_targets(db, payload.shopping_list_id)
    for item in selected.values():
        validate_item_target(targets, item.section_id, item.store_ids, active_only=True)
    groups = _merge_groups(ingredients, selected)
    routing_choices = _confirmed_routing_choices(ingredients, selected, payload.shopping_list_id)

    assignments = {}
    for row in db.execute(
        """SELECT assignment.shopping_item_id, assignment.shopping_store_id FROM shopping_item_stores assignment
           JOIN shopping_items item ON item.id = assignment.shopping_item_id AND item.shopping_list_id = assignment.shopping_list_id
           WHERE item.shopping_list_id = ? AND item.completed = 0""", (payload.shopping_list_id,),
    ):
        assignments.setdefault(row["shopping_item_id"], []).append(row["shopping_store_id"])
    buckets = {}
    for row in db.execute("SELECT * FROM shopping_items WHERE shopping_list_id = ? AND completed = 0 ORDER BY sort_order, id", (payload.shopping_list_id,)):
        if row["quantity_value"] is not None and not row["quantity_text"]:
            key = _route_key(row["name"], row["note"], row["section_id"], assignments.get(row["id"], []))
            buckets.setdefault(key, []).append(dict(row))
    max_order = db.execute("SELECT MAX(sort_order) FROM shopping_items WHERE shopping_list_id = ?", (payload.shopping_list_id,)).fetchone()[0]
    next_order = min(9223372036854775807, max(0, max_order or 0) + 1)
    transfer_id = db.execute(
        """INSERT INTO recipe_shopping_transfers
           (user_id, client_mutation_id, request_hash, shopping_list_id, target_shopping_list_id, source_recipe_id,
            source_revision, created_count, merged_count) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)""",
        (actor_id, payload.client_mutation_id, request_hash, payload.shopping_list_id, payload.shopping_list_id, recipe_id, source_revision),
    ).lastrowid
    created_count = merged_count = 0
    try:
        for ingredient in ingredients:
            target = selected.get(ingredient["client_key"])
            if target is None:
                continue
            with localcontext() as context:
                context.prec = 80
                # Divide last so exact half units stay exact (1.5 * 1 / 3).
                amount = (Decimal(str(ingredient["quantity_value"])) * Decimal(str(payload.servings))
                          / Decimal(str(recipe["base_servings"]))) if ingredient["quantity_value"] is not None else None
            name = clean_item_text(ingredient["name"], 500, required=True)
            unit = normalize_quantity_unit(ingredient["quantity_unit"])
            scaled = _finite_quantity(amount) if amount is not None else None
            group = groups.get(target.merge_group)
            note = group["note"] if group is not None else ingredient["note"]
            key = _route_key(name, note, target.section_id, target.store_ids)
            merged = None
            # Free and unmeasured ingredients always create their own row.
            if amount is not None and not ingredient["quantity_text"]:
                candidates = (group["candidates"] or (buckets.get(key, []) if group["match_existing"] else [])) if group is not None else buckets.get(key, [])
                for candidate in candidates:
                    converted = convert_quantity(amount, unit, candidate["quantity_unit"])
                    if converted is not None:
                        total = Decimal(str(candidate["quantity_value"])) + converted
                        combined = _finite_quantity(total)
                        db.execute("UPDATE shopping_items SET quantity_value = ?, quantity_display_mode = 'kitchen', updated_at = ? WHERE id = ?",
                                   (combined, now_iso(), candidate["id"]))
                        candidate["quantity_value"] = combined
                        if group is not None and not group["candidates"]:
                            group["candidates"].append(candidate)
                        merged = candidate["id"]
                        merged_count += 1
                        break
            if merged is None:
                merged = insert_shopping_item(db, payload.shopping_list_id, actor_id, name=name,
                    section_id=target.section_id, quantity_value=scaled, quantity_unit=unit,
                    quantity_text=ingredient["quantity_text"], note=note, store_ids=target.store_ids, sort_order=next_order,
                    quantity_display_mode="kitchen")
                next_order = min(9223372036854775807, next_order + 1)
                created_count += 1
                if amount is not None and not ingredient["quantity_text"]:
                    candidate = {"id": merged, "quantity_value": scaled, "quantity_unit": unit}
                    if group is None or group["match_existing"]:
                        buckets.setdefault(key, []).append(candidate)
                    if group is not None:
                        group["candidates"].append(candidate)
            db.execute(
                """INSERT INTO shopping_item_recipe_sources
                   (shopping_item_id, transfer_id, recipe_id, source_revision, recipe_title, ingredient_client_key,
                    ingredient_name, quantity_value, quantity_unit, quantity_text, note, base_servings, servings)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (merged, transfer_id, recipe_id, source_revision, recipe["title"], ingredient["client_key"], ingredient["name"],
                 scaled, unit, ingredient["quantity_text"], ingredient["note"], recipe["base_servings"], payload.servings),
            )
    except (InvalidOperation, OverflowError, ZeroDivisionError):
        raise HTTPException(422, "Scaled quantity is outside the supported range") from None
    for name, section_id, store_ids, feedback in routing_choices:
        record_route_choice(db, actor_id, name, payload.shopping_list_id, section_id, store_ids, feedback,
                            event_key=recipe_event_key(payload.client_mutation_id, name, payload.shopping_list_id,
                                                      section_id, store_ids, feedback))
    db.execute("UPDATE recipe_shopping_transfers SET created_count = ?, merged_count = ? WHERE id = ?", (created_count, merged_count, transfer_id))
    return {"created_count": created_count, "merged_count": merged_count,
            "client_mutation_id": payload.client_mutation_id, "source_revision": source_revision}, True
