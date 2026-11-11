"""Trusted metadata for the application's shareable container types."""

from dataclasses import dataclass
from types import MappingProxyType


@dataclass(frozen=True)
class EntityType:
    table: str
    module_id: str
    email_copy_key: str
    name_column: str = "name"
    color_column: str = "color"


ENTITY_TYPES = MappingProxyType({
    "project": EntityType("projects", "tasks", "entity_type_project"),
    "shopping_list": EntityType("shopping_lists", "shopping", "entity_type_shopping_list"),
    "cookbook": EntityType("cookbooks", "recipes", "entity_type_cookbook"),
})


def get_entity_metadata(db, entity_type: str, entity_id: int):
    """Look up display metadata using identifiers from the trusted registry."""
    spec = ENTITY_TYPES.get(entity_type)
    if spec is None:
        return None
    return db.execute(
        f"SELECT id, {spec.name_column} AS entity_name, {spec.color_column} AS entity_color "
        f"FROM {spec.table} WHERE id = ?",
        (entity_id,),
    ).fetchone()
