"""Provider-neutral BrainDump candidate capabilities, routing and normalization.

Extraction only suggests targets. Normalization never creates a container or
grants access; confirmation must independently validate the current permission.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Callable

from services.entity_access import resolve_entity_access
from services.module_visibility import module_preferences_payload
from services.quantity_units import normalize_quantity_unit


EXTRACTION_MODULES = ("tasks", "shopping")
MAX_CONTEXT_LISTS = 40
MAX_CONTEXT_CHILDREN = 16
EXPLICIT_ROUTE_FIELDS = ("container", "section", "stores")
SHOPPING_TARGET_FIELDS = ("shopping_list_id", "shopping_section_id", "shopping_store_ids",
                         "shopping_list_name", "shopping_section_name", "shopping_store_name", "shopping_store_names")


def is_shopping_candidate(candidate: dict) -> bool:
    return (
        candidate.get("module_id") == "shopping"
        or candidate.get("kind") in ("shopping", "shopping_item")
        or any(candidate.get(field) not in (None, [], "") for field in SHOPPING_TARGET_FIELDS)
    )


def enabled_candidate_modules(db, user_id: int, requested_modules: list[str] | None) -> list[str]:
    user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if user is None:
        return []
    disabled = set(module_preferences_payload(user)["disabled_modules"])
    requested = set(requested_modules if requested_modules is not None else ["tasks"])
    return [module for module in EXTRACTION_MODULES if module in requested and module not in disabled]


def load_shopping_context(db, user_id: int) -> list[dict]:
    """Return bounded editable metadata; never read item or preference data."""
    lists = []
    # Preselect only possible access sources so a large number of unrelated
    # private lists cannot cause an unbounded series of permission queries.
    # The canonical resolver below still decides whether each target is usable.
    rows = db.execute(
        """SELECT l.id, l.name FROM shopping_lists l
           JOIN entity_access a ON a.entity_type = 'shopping_list' AND a.entity_id = l.id
           WHERE a.owner_user_id = ?
              OR a.owner_household_id IN (SELECT id FROM households WHERE owner_user_id = ?)
              OR a.owner_household_id IN (SELECT household_id FROM household_members WHERE user_id = ? AND status = 'accepted')
              OR (a.owner_household_id IS NULL AND EXISTS (
                  SELECT 1 FROM entity_access_grants g
                  WHERE g.entity_access_id = a.id AND g.user_id = ? AND g.status = 'accepted'
              ))
           ORDER BY l.sort_order, l.id LIMIT ?""",
        (user_id, user_id, user_id, user_id, MAX_CONTEXT_LISTS),
    )
    for row in rows:
        list_id = int(row["id"])
        if not resolve_entity_access(db, "shopping_list", list_id, user_id).can_edit_content:
            continue
        lists.append({
            "id": list_id,
            "name": str(row["name"]),
            "sections": [dict(child) for child in db.execute(
                "SELECT id, name FROM shopping_sections WHERE shopping_list_id = ? ORDER BY sort_order, id LIMIT ?",
                (list_id, MAX_CONTEXT_CHILDREN),
            )],
            "stores": [dict(child) for child in db.execute(
                "SELECT id, name FROM shopping_stores WHERE shopping_list_id = ? AND active = 1 ORDER BY sort_order, id LIMIT ?",
                (list_id, MAX_CONTEXT_CHILDREN),
            )],
        })
        if len(lists) >= MAX_CONTEXT_LISTS:
            break
    return lists


def candidate_context_payload(context: dict | None) -> dict:
    """Expose the opt-in protocol separately from the legacy workspace data."""
    if not (context or {}).get("typed_candidates"):
        return {}
    modules = (context or {}).get("supported_modules", [])
    return {
        "supported_modules": list(modules),
        "shopping_lists": [
            {
                "id": row["id"], "name": str(row.get("name") or "")[:200],
                "sections": [{"id": child["id"], "name": str(child.get("name") or "")[:200]}
                             for child in row.get("sections", [])[:MAX_CONTEXT_CHILDREN]],
                "stores": [{"id": child["id"], "name": str(child.get("name") or "")[:120]}
                           for child in row.get("stores", [])[:MAX_CONTEXT_CHILDREN]],
            }
            for row in (context or {}).get("shopping_lists", [])[:MAX_CONTEXT_LISTS]
        ] if "shopping" in modules else [],
        "candidate_contract": {
            "module_id": list(modules),
            "shopping": ["title", "shopping_list_id", "shopping_section_id", "shopping_store_ids", "quantity_value", "quantity_unit"],
            "explicit_route_fields": list(EXPLICIT_ROUTE_FIELDS),
            "rules": [
                "Every candidate must use an available module_id from supported_modules.",
                "Return explicit_route_fields for each candidate: container, section and/or stores only when the user explicitly selected that destination (including explicitly no section or no store); [] when routing was semantically inferred. Never mark a merely inferred route explicit.",
                "Shopping IDs are only from shopping_lists and its nested sections/stores, never project or workspace IDs.",
                "Apply the same semantic taxonomy rules to Shopping: compare each item's meaning with the sections of every shopping list, even when no list or section name was spoken.",
                "A uniquely fitting section is evidence for its containing shopping list; return both that list ID and section ID instead of leaving them null merely because the list name was not spoken.",
                "An unknown or ambiguous shopping target stays null; do not create or arbitrarily choose a list.",
                "Do not turn unavailable shopping candidates into task candidates.",
                "Task scheduling fields and location reminders apply only to module_id=tasks.",
            ],
        },
    }


def _name_key(value) -> str:
    return " ".join(str(value or "").casefold().split())


def _positive_id(value) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str):
        raw = value.strip()
        if len(raw) <= 19 and re.fullmatch(r"[0-9]+", raw):
            target_id = int(raw)
            return target_id if 0 < target_id <= 9223372036854775807 else None
    return None


def _resolve_reference(raw_id, raw_name, choices: list[dict]) -> dict | None:
    if raw_id is not None:
        target_id = _positive_id(raw_id)
        matches = [row for row in choices if row.get("id") == target_id] if target_id else []
    else:
        name = _name_key(raw_name)
        matches = [row for row in choices if _name_key(row.get("name")) == name] if name else []
    return matches[0] if len(matches) == 1 else None


def _shopping_store_references(candidate: dict) -> list[tuple]:
    store_ids = candidate.get("shopping_store_ids")
    if isinstance(store_ids, list):
        return [(store_id, None) for store_id in store_ids[:50]]
    names = candidate.get("shopping_store_names")
    if not isinstance(names, list):
        names = [candidate.get("shopping_store_name")]
    return [(None, name) for name in names[:50] if name not in (None, "")]


def _infer_shopping_parent(candidate: dict, lists: list[dict]) -> dict | None:
    """Recover a missing parent only from mutually consistent known children.

    The model supplies semantic matching; this boundary resolves the structural
    implication of an authorized section/store reference. The number or names
    of available lists alone never supplies a default destination.
    """
    if candidate.get("shopping_list_id") is not None or candidate.get("shopping_list_name") not in (None, ""):
        return None
    hints = []
    section_id, section_name = candidate.get("shopping_section_id"), candidate.get("shopping_section_name")
    if section_id is not None or section_name not in (None, ""):
        hints.append(("sections", section_id, section_name))
    hints.extend(("stores", raw_id, name) for raw_id, name in _shopping_store_references(candidate))
    possible = None
    for collection, raw_id, name in hints:
        owners = {row["id"] for row in lists if _resolve_reference(raw_id, name, row.get(collection, [])) is not None}
        if not owners:
            return None
        possible = owners if possible is None else possible & owners
        if not possible:
            return None
    if possible is None or len(possible) != 1:
        return None
    return next((row for row in lists if row["id"] in possible), None)


def _normalize_shopping_candidate(candidate: dict, title: str, context: dict) -> dict:
    lists = context.get("shopping_lists", [])
    target = _resolve_reference(candidate.get("shopping_list_id"), candidate.get("shopping_list_name"), lists)
    if target is None:
        target = _infer_shopping_parent(candidate, lists)
    sections = target.get("sections", []) if target else []
    section = _resolve_reference(candidate.get("shopping_section_id"), candidate.get("shopping_section_name"), sections)
    stores = target.get("stores", []) if target else []
    store_ids = []
    for raw_id, name in _shopping_store_references(candidate):
        store = _resolve_reference(raw_id, name, stores)
        if store and store["id"] not in store_ids:
            store_ids.append(store["id"])
    quantity = candidate.get("quantity_value")
    try:
        quantity = float(quantity) if quantity is not None and not isinstance(quantity, bool) else None
    except (TypeError, ValueError, OverflowError):
        quantity = None
    if quantity is not None and (not math.isfinite(quantity) or quantity < 0):
        quantity = None
    unit = candidate.get("quantity_unit")
    unit = normalize_quantity_unit(unit.strip()[:40]) if isinstance(unit, str) else None
    return {
        "module_id": "shopping", "title": title[:500],
        "shopping_list_id": target["id"] if target else None,
        "shopping_section_id": section["id"] if section else None,
        "shopping_store_ids": store_ids,
        "quantity_value": quantity, "quantity_unit": unit,
    }


def _dedupe_scope(candidate: dict) -> tuple:
    module = candidate.get("module_id")
    if module == "shopping":
        return (module, candidate.get("shopping_list_id"), candidate.get("shopping_section_id"),
                tuple(sorted(candidate.get("shopping_store_ids", []))), candidate.get("quantity_value"), candidate.get("quantity_unit"))
    if module == "tasks":
        return (module, candidate.get("project_name"), candidate.get("section_name"))
    return ()  # Preserve legacy task-only title deduplication.


def _item_key(value: str) -> str:
    return "".join(character for character in value.casefold() if character.isalnum())


def _keys_equivalent(left: str, right: str) -> bool:
    return left == right or (min(len(left), len(right)) >= 4 and abs(len(left) - len(right)) <= 3
                             and (left.startswith(right) or right.startswith(left)))


def _route_values(candidate: dict) -> tuple:
    if candidate.get("module_id") == "shopping":
        return (candidate.get("shopping_list_id"), candidate.get("shopping_section_id"),
                tuple(sorted(candidate.get("shopping_store_ids") or [])))
    return (_name_key(candidate.get("project_name")) or None, _name_key(candidate.get("section_name")) or None, ())


def _present_route_fields(candidate: dict) -> set[str]:
    return {field for field, value in zip(EXPLICIT_ROUTE_FIELDS, _route_values(candidate)) if value not in (None, "", ())}


def _provided_explicit_fields(value) -> set[str] | None:
    if isinstance(value, list) and len(value) <= len(EXPLICIT_ROUTE_FIELDS) and all(isinstance(field, str) and field in EXPLICIT_ROUTE_FIELDS for field in value):
        return set(value)
    return None


def can_apply_learned_route(candidate: dict, target: dict) -> bool:
    """Learning may fill or correct inference, but cannot replace spoken targets.

    Old/internal candidates without provenance are treated conservatively when
    they already carry a destination. Only normalized explicit [] opts a resolved
    inferred destination into historical corrections.
    """
    explicit = _provided_explicit_fields(candidate.get("explicit_route_fields"))
    if explicit is None:
        explicit = _present_route_fields(candidate)
    if not explicit:
        return True
    if candidate.get("module_id", "tasks") != target.get("module_id", "tasks"):
        return False
    current_container, current_section, current_stores = _route_values(candidate)
    container, section, stores = _route_values(target)
    if current_container != container:
        return False  # An explicit child also fixes its inherited container.
    if "section" in explicit and current_section != section:
        return False
    if "stores" in explicit and current_stores != stores:
        return False
    return True


def _mention_key(value: str) -> str:
    return " ".join(re.findall(r"\w+", unicodedata.normalize("NFKC", value).casefold(), flags=re.UNICODE))


def _explicit_route_fields(raw: dict, candidate: dict, context: dict, transcript_key: str) -> list[str]:
    supplied = _provided_explicit_fields(raw.get("explicit_route_fields"))
    explicit = supplied if supplied is not None else _present_route_fields(candidate)
    # Missing provenance cannot distinguish an inferred empty route from an
    # explicitly cleared one. Protect supplied fields, including null/[], while
    # a valid explicit [] still opts inferred routes into historical corrections.
    if supplied is None:
        if any(field in raw for field in ("shopping_list_id", "shopping_list_name", "project_name", "projectName", "project")):
            explicit.add("container")
        if any(field in raw for field in ("shopping_section_id", "shopping_section_name", "section_name", "sectionName", "section")):
            explicit.add("section")
        if any(field in raw for field in ("shopping_store_ids", "shopping_store_names", "shopping_store_name")):
            explicit.add("stores")

    def mentioned(name) -> bool:
        if not isinstance(name, str) or not name.strip():
            return False
        key = _mention_key(name[:200])
        return bool(key and f" {key} " in transcript_key)

    if candidate.get("module_id") == "shopping":
        target = next((row for row in context.get("shopping_lists", []) if row["id"] == candidate.get("shopping_list_id")), None)
        section = next((row for row in (target or {}).get("sections", []) if row["id"] == candidate.get("shopping_section_id")), None)
        stores = [row for row in (target or {}).get("stores", []) if row["id"] in candidate.get("shopping_store_ids", [])]
        if mentioned((target or {}).get("name")) or mentioned(raw.get("shopping_list_name")):
            explicit.add("container")
        if mentioned((section or {}).get("name")) or mentioned(raw.get("shopping_section_name")):
            explicit.add("section")
        store_names = raw.get("shopping_store_names")
        if not isinstance(store_names, list):
            store_names = [raw.get("shopping_store_name")]
        if any(mentioned(row.get("name")) for row in stores) or any(mentioned(name) for name in store_names[:50]):
            explicit.add("stores")
    else:
        if any(mentioned(name) for name in (candidate.get("project_name"), raw.get("project_name"), raw.get("projectName"), raw.get("project"))):
            explicit.add("container")
        if any(mentioned(name) for name in (candidate.get("section_name"), raw.get("section_name"), raw.get("sectionName"), raw.get("section"))):
            explicit.add("section")
    return [field for field in EXPLICIT_ROUTE_FIELDS if field in explicit]


def normalize_candidates(candidates: list, context: dict | None, normalize_task: Callable[[dict, str], dict], *, transcript: str = "") -> list[dict]:
    context = context or {}
    typed = bool(context.get("typed_candidates"))
    available = context.get("supported_modules", ["tasks"])
    transcript_key = f" {_mention_key(transcript[:50000])} "
    result, seen = [], []
    for raw in candidates:
        candidate = {"title": raw} if isinstance(raw, str) else raw
        if not isinstance(candidate, dict):
            continue
        title = str(candidate.get("title") or candidate.get("task") or candidate.get("text") or candidate.get("item") or candidate.get("name") or "").strip(" .,:;!?-–—\t\n\r")
        if not title:
            continue
        title = title[:1].upper() + title[1:]
        module = candidate.get("module_id", "tasks")
        if module not in available or module not in EXTRACTION_MODULES:
            continue
        if module == "tasks" and is_shopping_candidate(candidate):
            # Contradictory provider data must not become an ordinary task after
            # its shopping target fields are discarded.
            continue
        if module == "shopping":
            if not typed:
                continue
            item = _normalize_shopping_candidate(candidate, title, context)
        else:
            item = normalize_task(candidate, title)
            if typed:
                item["module_id"] = "tasks"
        if typed:
            item["explicit_route_fields"] = _explicit_route_fields(candidate, item, context, transcript_key)
        scope, key = _dedupe_scope(item), _item_key(item["title"])
        duplicate = next((index for index, (old_scope, old_key) in enumerate(seen)
                          if scope == old_scope and _keys_equivalent(key, old_key)), None)
        if key and duplicate is None:
            seen.append((scope, key))
            result.append(item)
        elif key and typed:
            # Repeated wording may add an explicit destination to an earlier
            # inference. Deduplication must retain that stronger protection.
            explicit = set(result[duplicate]["explicit_route_fields"]) | set(item["explicit_route_fields"])
            result[duplicate]["explicit_route_fields"] = [field for field in EXPLICIT_ROUTE_FIELDS if field in explicit]
    return result
