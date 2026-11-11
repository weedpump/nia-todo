"""Durable create identities, independent of content lifetime.

Recipes/cookbooks keep their existing richer receipts. These minimal receipts
cover Tasks and Shopping without storing user content or old access snapshots.
Callers authorize the current boundary and hold the writer transaction; insert
triggers register every actual create atomically, including shared batch paths.
"""

from types import MappingProxyType

from fastapi import HTTPException

_TABLES = MappingProxyType({
    "todo": "todos",
    "shopping_list": "shopping_lists",
    "shopping_section": "shopping_sections",
    "shopping_store": "shopping_stores",
    "shopping_item": "shopping_items",
})
_LIST_CHILDREN = frozenset({"shopping_section", "shopping_store", "shopping_item"})


def creation_replay(db, entity_type: str, scope_id: int, client_mutation_id: str | None):
    """Return current content or a content-free tombstone for this identity.

    Todo/list scopes are the authenticated creation actor; Shopping children use
    their authorized parent list. The caller must recheck live entity access
    before returning the row. Missing parents are never authorized by receipts.
    """
    table = _TABLES[entity_type]
    if not db.in_transaction:
        raise RuntimeError("Creation replay requires the writer transaction")
    if not client_mutation_id:
        return None
    receipt = db.execute(
        """SELECT entity_id FROM creation_receipts
           WHERE entity_type=? AND scope_id=? AND client_mutation_id=?""",
        (entity_type, scope_id, client_mutation_id),
    ).fetchone()
    if receipt is None:
        return None
    row = db.execute(f"SELECT * FROM {table} WHERE id=?", (receipt["entity_id"],)).fetchone()
    if row is None:
        detail = {"code": "sync.creationDeleted", "entity_type": entity_type, "id": receipt["entity_id"]}
        if entity_type in _LIST_CHILDREN:
            detail["shopping_list_id"] = scope_id
        raise HTTPException(410, detail)
    if entity_type in _LIST_CHILDREN and row["shopping_list_id"] != scope_id:
        raise HTTPException(404, "Shopping entity not found")
    return row
