"""Validated recipe aggregates; children inherit their cookbook's boundary."""

import json
import math
from urllib.parse import urlsplit
from typing import Annotated

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from services.entity_access import resolve_entity_access
from services.quantity_units import normalize_quantity_unit

ClientKey = Annotated[str, Field(min_length=1, max_length=200)]
Servings = Annotated[float, Field(gt=0, le=100000, allow_inf_nan=False, strict=True)]
Minutes = Annotated[int, Field(ge=0, le=100000, strict=True)]
Revision = Annotated[int, Field(gt=0, le=9223372036854775807, strict=True)]


def _required(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("Value cannot be blank")
    return value


class Ingredient(BaseModel):
    client_key: ClientKey
    name: str = Field(min_length=1, max_length=500)
    quantity_value: float | None = Field(default=None, gt=0, allow_inf_nan=False, strict=True)
    quantity_unit: str | None = Field(default=None, max_length=40)
    quantity_text: str | None = Field(default=None, max_length=500)
    note: str = Field(default="", max_length=2000)

    @field_validator("client_key", "name")
    @classmethod
    def required(cls, value):
        return _required(value)

    @field_validator("quantity_unit", "quantity_text")
    @classmethod
    def optional_text(cls, value):
        return value.strip() or None if value is not None else None

    @field_validator("note")
    @classmethod
    def trim_note(cls, value):
        return value.strip()

    @model_validator(mode="after")
    def amount_contract(self):
        if self.quantity_value is not None and self.quantity_text:
            raise ValueError("Numeric and free quantities are mutually exclusive")
        self.quantity_unit = normalize_quantity_unit(self.quantity_unit)
        return self


class IngredientGroup(BaseModel):
    client_key: ClientKey
    name: str = Field(default="", max_length=200)
    ingredients: list[Ingredient] = Field(default_factory=list, max_length=500)

    @field_validator("client_key")
    @classmethod
    def required_key(cls, value):
        return _required(value)

    @field_validator("name")
    @classmethod
    def trim_name(cls, value):
        return value.strip()


class RecipeStepIngredient(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ingredient_client_key: ClientKey
    show_quantity: bool = Field(default=True, strict=True)
    quantity_value: float | None = Field(default=None, gt=0, allow_inf_nan=False, strict=True)
    quantity_text: str | None = Field(default=None, max_length=500)

    @field_validator("ingredient_client_key")
    @classmethod
    def required_key(cls, value):
        return _required(value)

    @field_validator("quantity_value", mode="before")
    @classmethod
    def finite_quantity(cls, value):
        if isinstance(value, float) and not math.isfinite(value):
            raise HTTPException(422, "Step quantity must be finite")
        return value

    @field_validator("quantity_text")
    @classmethod
    def optional_text(cls, value):
        return value.strip() or None if value is not None else None

    @model_validator(mode="after")
    def quantity_contract(self):
        if self.quantity_value is not None and self.quantity_text is not None:
            raise ValueError("Numeric and free step quantities are mutually exclusive")
        if not self.show_quantity and (self.quantity_value is not None or self.quantity_text is not None):
            raise ValueError("Explicit step quantities require show_quantity")
        return self


class RecipeStep(BaseModel):
    client_key: ClientKey
    text: str = Field(min_length=1, max_length=8000)
    ingredients: list[RecipeStepIngredient] = Field(default_factory=list, max_length=500)

    @field_validator("client_key", "text")
    @classmethod
    def required(cls, value):
        return _required(value)

    @model_validator(mode="after")
    def unique_ingredients(self):
        keys = [item.ingredient_client_key for item in self.ingredients]
        if len(keys) != len(set(keys)):
            raise ValueError("Duplicate step ingredient client_key")
        return self


class RecipePayload(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    base_servings: Servings | None = None
    prep_minutes: Minutes | None = None
    cook_minutes: Minutes | None = None
    tags: list[Annotated[str, Field(min_length=1, max_length=80)]] | None = Field(default=None, max_length=40)
    ingredient_groups: list[IngredientGroup] | None = Field(default=None, max_length=50)
    steps: list[RecipeStep] | None = Field(default=None, max_length=100)
    image_data: str | None = Field(default=None, max_length=430000)
    source_url: str = Field(default="", max_length=2048)
    source_name: str = Field(default="", max_length=200)
    source_author: str = Field(default="", max_length=500)
    source_yield: str = Field(default="", max_length=500)
    client_mutation_id: ClientKey

    @field_validator("source_url", "source_name", "source_author", "source_yield")
    @classmethod
    def source_text(cls, value, info):
        value = value.strip()
        if info.field_name == "source_url" and value:
            try:
                parsed = urlsplit(value)
                valid = parsed.scheme.lower() in {"http", "https"} and parsed.hostname and not parsed.username and not parsed.password
                parsed.port
            except ValueError:
                valid = False
            if not valid or any(ord(char) < 33 or ord(char) == 127 for char in value):
                raise ValueError("Invalid recipe source URL")
        return value

    @field_validator("title", "client_mutation_id")
    @classmethod
    def required(cls, value):
        return _required(value) if value is not None else None

    @field_validator("description")
    @classmethod
    def trim_description(cls, value):
        return value.strip() if value is not None else None

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, values):
        if values is None:
            return None
        result, seen = [], set()
        for value in values:
            name = _required(value)
            key = " ".join(name.casefold().split())
            if key not in seen:
                result.append(name)
                seen.add(key)
        return result

    @model_validator(mode="after")
    def aggregate_contract(self):
        for field in ("title", "description", "base_servings", "tags", "ingredient_groups", "steps"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(field + " cannot be null")
        groups = self.ingredient_groups or []
        ingredients = [ingredient for group in groups for ingredient in group.ingredients]
        if len(ingredients) > 500:
            raise ValueError("Too many ingredients")
        for collection in (groups, ingredients, self.steps or []):
            keys = [item.client_key for item in collection]
            if len(keys) != len(set(keys)):
                raise ValueError("Duplicate child client_key")
        if len(json.dumps(self.model_dump(exclude_unset=True), ensure_ascii=False, allow_nan=False).encode("utf-8")) > 512 * 1024:
            raise ValueError("Recipe aggregate exceeds 512 KiB")
        return self


class RecipeCreate(RecipePayload):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000)
    base_servings: Servings = 1
    tags: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(default_factory=list, max_length=40)
    ingredient_groups: list[IngredientGroup] = Field(default_factory=list, max_length=50)
    steps: list[RecipeStep] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def ingredient_references(self):
        ingredients = {ingredient.client_key: ingredient for group in self.ingredient_groups for ingredient in group.ingredients}
        for step in self.steps:
            for link in step.ingredients:
                ingredient = ingredients.get(link.ingredient_client_key)
                if ingredient is None:
                    raise ValueError("Step ingredient does not belong to this recipe")
                if link.quantity_value is not None and (ingredient.quantity_value is None or link.quantity_value > ingredient.quantity_value):
                    raise ValueError("Step quantity exceeds the numeric ingredient total")
        return self


class RecipePatch(RecipePayload):
    expected_revision: Revision


def merge_recipe_patch(current: dict, patch: RecipePatch) -> dict:
    """Preserve omitted legacy links and prune only inherited deleted targets.

    Explicit links are validated against the final aggregate by RecipeCreate;
    they must never be silently removed, even if their target was just deleted.
    """
    changes = patch.model_dump(exclude_unset=True)
    result = {**current, **changes}
    ingredient_keys = {ingredient["client_key"] for group in result["ingredient_groups"] for ingredient in group["ingredients"]}
    old_steps = {step["client_key"]: step for step in current["steps"]}
    result["steps"] = [dict(step) for step in result["steps"]]
    for step in result["steps"]:
        old_links = {link["ingredient_client_key"]: link for link in old_steps.get(step["client_key"], {}).get("ingredients", [])}
        if "steps" not in changes or "ingredients" not in step:
            inherited = old_links.values()
            step["ingredients"] = [dict(link) for link in inherited if link["ingredient_client_key"] in ingredient_keys]
        else:
            links = []
            for link in step["ingredients"]:
                link = dict(link)
                if "quantity_value" not in link and "quantity_text" not in link:
                    previous = {} if link.get("show_quantity") is False else old_links.get(link["ingredient_client_key"], {})
                    link.update({field: previous.get(field) for field in ("quantity_value", "quantity_text")})
                links.append(link)
            step["ingredients"] = links
    return result


def get_authorized_recipe_row(db, recipe_id: int, user_id: int, *, edit: bool = False):
    row = db.execute("SELECT * FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
    if row is None:
        return None
    access = resolve_entity_access(db, "cookbook", row["cookbook_id"], user_id)
    return row if (access.can_edit_content if edit else access.can_view) else None


def _project_recipes(db, rows, *, can_edit: bool) -> list[dict]:
    if not rows:
        return []
    if len(rows) > 400:
        return [recipe for offset in range(0, len(rows), 400) for recipe in _project_recipes(db, rows[offset:offset + 400], can_edit=can_edit)]
    ids = [row["id"] for row in rows]
    placeholders = ",".join("?" for _ in ids)
    groups, ingredients, steps, tags, step_ingredients = {}, {}, {}, {}, {}
    for row in db.execute(f"SELECT * FROM recipe_ingredients WHERE recipe_id IN ({placeholders}) ORDER BY sort_order, id", ids):
        ingredient = {key: row[key] for key in ("id", "client_key", "name", "quantity_value", "quantity_unit", "quantity_text", "note")}
        ingredient["quantity_unit"] = normalize_quantity_unit(ingredient["quantity_unit"])
        ingredients.setdefault(row["group_id"], []).append(ingredient)
    for row in db.execute(f"SELECT * FROM recipe_ingredient_groups WHERE recipe_id IN ({placeholders}) ORDER BY sort_order, id", ids):
        groups.setdefault(row["recipe_id"], []).append({"id": row["id"], "client_key": row["client_key"], "name": row["name"], "ingredients": ingredients.get(row["id"], [])})
    for row in db.execute(
        f"""SELECT link.step_id, ingredient.client_key, link.show_quantity, link.quantity_value, link.quantity_text
            FROM recipe_step_ingredients link
            JOIN recipe_ingredients ingredient ON ingredient.id = link.ingredient_id AND ingredient.recipe_id = link.recipe_id
            WHERE link.recipe_id IN ({placeholders}) ORDER BY link.step_id, link.sort_order, link.ingredient_id""", ids,
    ):
        step_ingredients.setdefault(row["step_id"], []).append({"ingredient_client_key": row["client_key"], "show_quantity": bool(row["show_quantity"]),
                                                             "quantity_value": row["quantity_value"], "quantity_text": row["quantity_text"]})
    for row in db.execute(f"SELECT * FROM recipe_steps WHERE recipe_id IN ({placeholders}) ORDER BY sort_order, id", ids):
        steps.setdefault(row["recipe_id"], []).append({**{key: row[key] for key in ("id", "client_key", "text")}, "ingredients": step_ingredients.get(row["id"], [])})
    for row in db.execute(f"SELECT * FROM recipe_tags WHERE recipe_id IN ({placeholders}) ORDER BY sort_order", ids):
        tags.setdefault(row["recipe_id"], []).append(row["name"])
    images = {row["recipe_id"]: row["content_hash"] for row in db.execute(f"SELECT recipe_id, content_hash FROM recipe_images WHERE recipe_id IN ({placeholders})", ids)}
    return [{**dict(row), "can_edit": can_edit, "ingredient_groups": groups.get(row["id"], []),
             "steps": steps.get(row["id"], []), "tags": tags.get(row["id"], []),
             "image_version": images.get(row["id"]),
             "image_url": f"/api/recipes/recipes/{row['id']}/image?v={images[row['id']]}" if row["id"] in images else None} for row in rows]


def get_recipe_view(db, recipe_id: int, user_id: int) -> dict | None:
    row = get_authorized_recipe_row(db, recipe_id, user_id)
    if row is None:
        return None
    access = resolve_entity_access(db, "cookbook", row["cookbook_id"], user_id)
    return _project_recipes(db, [row], can_edit=access.can_edit_content)[0]


def get_cookbook_recipes(db, cookbook_id: int, user_id: int) -> list[dict]:
    access = resolve_entity_access(db, "cookbook", cookbook_id, user_id)
    if not access.can_view:
        return []
    return _project_recipes(db, db.execute("SELECT * FROM recipes WHERE cookbook_id = ? ORDER BY id", (cookbook_id,)).fetchall(), can_edit=access.can_edit_content)


def _sync_children(db, table: str, recipe_id: int, rows: list[dict], fields: tuple[str, ...]):
    existing = {row["client_key"]: row["id"] for row in db.execute(f"SELECT id, client_key FROM {table} WHERE recipe_id = ?", (recipe_id,))}
    resolved = {}
    for position, row in enumerate(rows):
        values = [row.get(field) for field in fields]
        if row["client_key"] in existing:
            child_id = existing[row["client_key"]]
            db.execute(f"UPDATE {table} SET " + ", ".join(field + " = ?" for field in (*fields, "sort_order")) + " WHERE id = ? AND recipe_id = ?", (*values, position, child_id, recipe_id))
        else:
            child_id = db.execute(f"INSERT INTO {table} (recipe_id, client_key, " + ", ".join((*fields, "sort_order")) + ") VALUES (" + ",".join("?" for _ in range(len(fields) + 3)) + ")", (recipe_id, row["client_key"], *values, position)).lastrowid
        resolved[row["client_key"]] = child_id
    return existing, resolved


def write_recipe_children(db, recipe_id: int, content: RecipeCreate):
    group_rows = [group.model_dump() for group in content.ingredient_groups]
    old_groups, group_ids = _sync_children(db, "recipe_ingredient_groups", recipe_id, group_rows, ("name",))
    ingredient_rows = [{**ingredient.model_dump(), "group_id": group_ids[group.client_key]} for group in content.ingredient_groups for ingredient in group.ingredients]
    old_ingredients, ingredient_ids = _sync_children(db, "recipe_ingredients", recipe_id, ingredient_rows, ("group_id", "name", "quantity_value", "quantity_unit", "quantity_text", "note"))
    old_steps, step_ids = _sync_children(db, "recipe_steps", recipe_id, [step.model_dump() for step in content.steps], ("text",))
    for table, old, new in (("recipe_ingredients", old_ingredients, ingredient_ids), ("recipe_ingredient_groups", old_groups, group_ids), ("recipe_steps", old_steps, step_ids)):
        for key in old.keys() - new.keys():
            db.execute(f"DELETE FROM {table} WHERE id = ? AND recipe_id = ?", (old[key], recipe_id))
    db.execute("DELETE FROM recipe_step_ingredients WHERE recipe_id = ?", (recipe_id,))
    db.executemany(
        """INSERT INTO recipe_step_ingredients (recipe_id, step_id, ingredient_id, show_quantity, sort_order, quantity_value, quantity_text)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        [(recipe_id, step_ids[step.client_key], ingredient_ids[link.ingredient_client_key], int(link.show_quantity), position, link.quantity_value, link.quantity_text)
         for step in content.steps for position, link in enumerate(step.ingredients)],
    )
    db.execute("DELETE FROM recipe_tags WHERE recipe_id = ?", (recipe_id,))
    db.executemany("INSERT INTO recipe_tags (recipe_id, name, name_key, sort_order) VALUES (?, ?, ?, ?)", [(recipe_id, name, " ".join(name.casefold().split()), position) for position, name in enumerate(content.tags)])
