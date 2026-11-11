"""Recipient-private invitation projections shared by REST and reconnect sync."""

from services.entity_access import list_entity_access_invites
from services.entity_registry import get_entity_metadata


def get_entity_invites(db, user_id: int, entity_type: str | None = None, *, aliases: bool = False):
    result = []
    for invite in list_entity_access_invites(db, user_id, entity_type):
        metadata = get_entity_metadata(db, invite["entity_type"], invite["entity_id"])
        if metadata is None:
            continue
        item = {**invite, "entity_name": metadata["entity_name"], "entity_color": metadata["entity_color"]}
        if aliases:
            prefix = invite["entity_type"]
            item.update({
                f"{prefix}_id": invite["entity_id"],
                f"{prefix}_name": metadata["entity_name"],
                f"{prefix}_color": metadata["entity_color"],
            })
        result.append(item)
    return result
