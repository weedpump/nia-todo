"""Account-local routing evidence shared by Tasks, Shopping and BrainDump.

Suggestions never write. Confirmed explicit choices are recorded in the same
writer transaction as their content, with an account reset epoch and receipts
so delayed/offline requests cannot recreate forgotten memory or learn twice.
Historical BrainDump counters are imported as honest token observations into
this same store. There is no separate runtime learning or prediction engine.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from services.entity_access import resolve_entity_access
from services.sharing import can_manage_todos, get_project_access_flags
from services.routing_matcher import (
    RULES,
    normalize_route_name,
    routing_tokens,
    routing_lookup_names,
    match_field,
    prepare_route_matcher,
    task_routing_entries,
    suggest_route,
    suggest_task_route,
)

MAX_ENTRIES = 2000
HISTORY_LIMIT = 20
RANK_DECAY = 0.9
AGE_HALF_LIFE_DAYS = 180
CORRECTION_WEIGHT = 3
MIN_WINNER_FRACTION = 0.70
MIN_CONFLICT_MARGIN = 1.0
MIN_USABLE_SCORE = 0.5


class RoutingFeedback(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: str = Field(min_length=1, max_length=200)
    generation: int = Field(ge=0, strict=True)
    fields: list[Literal["module", "list", "section", "stores"]] = Field(
        default_factory=list, max_length=4
    )

    @field_validator("event_id")
    @classmethod
    def nonblank_event(cls, value):
        if not value.strip():
            raise ValueError("Routing event ID cannot be blank")
        return value.strip()

    @field_validator("fields")
    @classmethod
    def unique_fields(cls, value):
        return sorted(set(value))


def normalize_item_name(value: str) -> str:
    """No fuzzy matching, stemming or minimum word length; works for short CJK."""
    return normalize_route_name(value)


def _account_state(db, user_id: int) -> tuple[bool, int]:
    try:
        row = db.execute(
            "SELECT braindump_learning_enabled, routing_memory_generation FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        return (
            bool(row and row["braindump_learning_enabled"]),
            int(row["routing_memory_generation"]) if row else 0,
        )
    except sqlite3.OperationalError:
        # Older standalone Tasks fixtures/compatibility databases have no epoch.
        row = db.execute(
            "SELECT braindump_learning_enabled FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        return bool(row and row["braindump_learning_enabled"]), 0


def task_workspace_id(db, user_id: int, project_id: int) -> int | None:
    """The actor's visible project placement, including inherited sharing."""
    project = db.execute(
        "SELECT id,workspace_id FROM projects WHERE id=?", (project_id,)
    ).fetchone()
    if project is None or not can_manage_todos(db, project_id, user_id):
        return None
    flags = get_project_access_flags(db, project_id, user_id)
    owner, member = flags["ownership"] or {}, flags["direct_member"]
    if flags["can_manage"] and owner.get("owner_user_id") == user_id:
        workspace = project["workspace_id"]
    elif member and member["workspace_id"] is not None:
        workspace = member["workspace_id"]
    else:
        default = db.execute(
            "SELECT id FROM workspaces WHERE user_id=? ORDER BY is_default DESC,id LIMIT 1",
            (user_id,),
        ).fetchone()
        workspace = default[0] if default else None
    if (
        workspace is not None
        and not db.execute(
            "SELECT 1 FROM workspaces WHERE id=? AND user_id=?", (workspace, user_id)
        ).fetchone()
    ):
        return None
    return workspace


def _resolve_history(observations, valid_choice, now):
    """Return only a reliable winner; scores are evidence, not probabilities."""
    buckets = {}
    history = sorted(observations, key=lambda row: row["id"], reverse=True)[
        :HISTORY_LIMIT
    ]
    for rank, observation in enumerate(history):
        try:
            value = json.loads(observation["value_json"])
            if isinstance(value, list) and all(type(item) is int for item in value):
                value = sorted(set(value))
            key = json.dumps(value, sort_keys=True, separators=(",", ":"))
            usable = valid_choice(value)
        except (ValueError, TypeError):
            value, key, usable = None, f"invalid:{observation['id']}", False
        try:
            observed = datetime.fromisoformat(
                observation["observed_at"].replace("Z", "+00:00")
            )
            observed = (
                observed.replace(tzinfo=timezone.utc)
                if observed.tzinfo is None
                else observed
            )
            age_days = max(0, (now - observed).total_seconds() / 86400)
        except (ValueError, TypeError, AttributeError):
            age_days = 1000000
        support = (
            int(observation["support_count"])
            if "support_count" in observation.keys()
            else 1
        )
        score = (
            support
            * observation["weight"]
            * (RANK_DECAY**rank)
            * (0.5 ** (age_days / AGE_HALF_LIFE_DAYS))
        )
        # Unavailable targets are not competing preferences. Keep the raw
        # observation/history marker, but do not let a deleted section or an
        # inactive store permanently outweigh a newly chosen usable target.
        if not usable:
            continue
        bucket = buckets.setdefault(
            key, {"value": value, "score": 0, "support": 0, "usable": usable}
        )
        bucket["score"] += score
        bucket["support"] += support
    choices = sorted(buckets.values(), key=lambda row: row["score"], reverse=True)
    winner = (
        choices[0]
        if choices
        else {"value": None, "score": 0, "support": 0, "usable": False}
    )
    total = sum(row["score"] for row in choices)
    margin = winner["score"] - (choices[1]["score"] if len(choices) > 1 else 0)
    conflicts = len(choices) > 1
    reliable = bool(
        winner["usable"]
        and winner["score"] >= MIN_USABLE_SCORE
        and (
            not conflicts
            or (
                winner["support"] >= 2
                and total > 0
                and winner["score"] / total >= MIN_WINNER_FRACTION
                and margin >= MIN_CONFLICT_MARGIN
            )
        )
    )
    evidence = {
        "support": winner["support"],
        "observations": len(history),
        "conflicts": conflicts,
        "reliable": reliable,
        "score": round(winner["score"], 6),
        "margin": round(margin, 6),
        "_targets": choices,
    }
    return winner["value"] if reliable else None, evidence


def _entry_history(db, user_id, module_id, entry_ids, fields):
    """Only selected authorized IDs, with enough per-entry tail for any group."""
    observations = []
    ordered_ids = sorted(set(entry_ids))
    for start in range(0, len(ordered_ids), 128):
        batch = ordered_ids[start : start + 128]
        id_placeholders = ",".join("?" for _ in batch)
        field_placeholders = ",".join("?" for _ in fields)
        observations.extend(db.execute(
            f"""SELECT * FROM (
                SELECT observation.*, entry.name_key,
                    ROW_NUMBER() OVER (PARTITION BY observation.entry_id, observation.field
                        ORDER BY observation.id DESC) AS history_rank
                FROM routing_memory_observations observation
                JOIN routing_memory_entries entry ON entry.id=observation.entry_id
                WHERE observation.user_id=? AND entry.user_id=? AND entry.module_id=?
                AND observation.entry_id IN ({id_placeholders})
                AND observation.field IN ({field_placeholders})
            ) WHERE history_rank <= ? ORDER BY id DESC""",
            (user_id, user_id, module_id, *batch, *fields, HISTORY_LIMIT),
        ).fetchall())
    observations.sort(key=lambda row: row["id"], reverse=True)
    return observations


def routing_entries(
    db,
    user_id: int,
    *,
    name_key: str | None = None,
    module_id="shopping",
    name_keys=None,
    key_kind=None,
) -> list[dict]:
    if not _account_state(db, user_id)[0]:
        return []
    try:
        keys = (
            [normalize_item_name(name_key)]
            if name_key is not None
            else (
                list(dict.fromkeys(normalize_item_name(key) for key in name_keys))
                if name_keys is not None
                else None
            )
        )
        if keys == []:
            return []
        placeholders = ",".join("?" for _ in keys) if keys is not None else ""
        condition = f" AND name_key IN ({placeholders})" if keys is not None else ""
        if key_kind is not None:
            condition += " AND key_kind=?"
        limit = " LIMIT ?" if keys is None else ""
        args = (
            user_id,
            module_id,
            *(keys or []),
            *([key_kind] if key_kind is not None else []),
            *([MAX_ENTRIES] if keys is None else []),
        )
        rows = db.execute(
            f"""SELECT * FROM routing_memory_entries WHERE user_id = ? AND module_id=?{condition}
                              ORDER BY list_sequence DESC, update_sequence DESC, id DESC{limit}""",
            args,
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    # Validate once per list, against the same canonical entity-access boundary
    # used by content writes. Never return inaccessible destination identifiers.
    targets, scopes = {}, {}
    target_column = "project_id" if module_id == "tasks" else "shopping_list_id"

    def authorized(row):
        list_id = row[target_column]
        if list_id not in targets:
            allowed = (
                can_manage_todos(db, list_id, user_id)
                if module_id == "tasks"
                else resolve_entity_access(db, "shopping_list", list_id, user_id).can_edit_content
            )
            if not allowed:
                targets[list_id] = None
            elif module_id == "tasks":
                targets[list_id] = (
                    {r[0] for r in db.execute("SELECT id FROM sections WHERE project_id=?", (list_id,))},
                    set(),
                )
                scopes[list_id] = task_workspace_id(db, user_id, list_id)
            else:
                targets[list_id] = (
                    {r[0] for r in db.execute("SELECT id FROM shopping_sections WHERE shopping_list_id=?", (list_id,))},
                    {r[0] for r in db.execute("SELECT id FROM shopping_stores WHERE shopping_list_id=? AND active=1", (list_id,))},
                )
        return targets[list_id] is not None and not (
            module_id == "tasks" and row["workspace_id"] is not None
            and row["workspace_id"] != scopes[list_id]
        )

    def group_key(row):
        return (row["name_key"], row["key_kind"],
                scopes[row["project_id"]] if module_id == "tasks" else None)

    def target_key(row):
        return (*group_key(row), row[target_column])

    authorized_rows = [row for row in rows if authorized(row)]
    if not authorized_rows:
        return []
    selected_groups = {group_key(row) for row in authorized_rows}
    # A recent row is not necessarily the preferred target. Resolve the complete
    # authorized competition for each selected name, not just its catalog slice.
    history_rows = {row["id"]: row for row in authorized_rows}
    if keys is None:
        names = sorted({row["name_key"] for row in authorized_rows})
        for start in range(0, len(names), 128):
            batch = names[start : start + 128]
            name_placeholders = ",".join("?" for _ in batch)
            for row in db.execute(
                f"SELECT * FROM routing_memory_entries WHERE user_id=? AND module_id=? AND name_key IN ({name_placeholders})",
                (user_id, module_id, *batch),
            ):
                if authorized(row) and group_key(row) in selected_groups:
                    history_rows[row["id"]] = row
    list_history = {}
    for observation in _entry_history(db, user_id, module_id, history_rows, ("list",)):
        list_history.setdefault(group_key(history_rows[observation["entry_id"]]), []).append(observation)
    allowed_lists = {}
    for row in history_rows.values():
        allowed_lists.setdefault(group_key(row), set()).add(row[target_column])
    now = datetime.now(timezone.utc)
    list_choices = {
        key: _resolve_history(history, lambda value: type(value) is int and value in allowed_lists[key], now)
        for key, history in list_history.items()
    }
    # Preserve the catalog bound while including a reliable older winning target.
    # An evicted losing target remains available to focused server-side recall.
    for key, (winner, evidence) in list_choices.items():
        if not evidence["reliable"] or any(
            group_key(row) == key and row[target_column] == winner for row in authorized_rows
        ):
            continue
        winners = [row for row in history_rows.values()
                   if group_key(row) == key and row[target_column] == winner]
        replacement = max(winners, key=lambda row: (row["update_sequence"], row["id"]))
        index = next(i for i in range(len(authorized_rows) - 1, -1, -1)
                     if group_key(authorized_rows[i]) == key)
        authorized_rows[index] = replacement
        # Null/current workspace aliases are one logical target, never extra
        # catalog entries; keep their child observations together as well.
        selected_ids = {row["id"] for row in authorized_rows}
        authorized_rows.extend(row for row in winners if row["id"] not in selected_ids)
    child_history = {}
    selected_by_id = {row["id"]: row for row in authorized_rows}
    for observation in _entry_history(db, user_id, module_id, selected_by_id, ("section", "stores")):
        child_history.setdefault(
            (target_key(selected_by_id[observation["entry_id"]]), observation["field"]), []
        ).append(observation)
    logical_rows = {}
    for row in authorized_rows:
        logical_rows.setdefault(target_key(row), []).append(row)
    result = []
    for siblings in logical_rows.values():
        row = max(siblings, key=lambda row: (row["update_sequence"], row["id"]))
        list_id = row["project_id"] if module_id == "tasks" else row["shopping_list_id"]
        target = targets[list_id]
        list_value, list_evidence = list_choices.get(
            group_key(row), _resolve_history([], lambda _: False, now)
        )
        section_history = child_history.get((target_key(row), "section"), [])
        store_history = child_history.get((target_key(row), "stores"), [])
        section, section_evidence = _resolve_history(
            section_history,
            lambda value: value is None or (type(value) is int and value in target[0]),
            now,
        )
        stores, store_evidence = _resolve_history(
            store_history,
            lambda value: isinstance(value, list)
            and all(type(store) is int and store in target[1] for store in value),
            now,
        )
        preferred = bool(list_evidence["reliable"] and list_value == list_id)
        history_fields = ["list"] if group_key(row) in list_history else []
        history_fields += [
            field
            for field, history in (
                ("section", section_history),
                ("stores", store_history),
            )
            if history
        ]
        public_list_evidence = {
            key: value for key, value in list_evidence.items() if key != "_targets"
        }
        own_evidence = next(
            (
                choice
                for choice in list_evidence["_targets"]
                if choice["value"] == list_id
            ),
            {},
        )
        public_list_evidence.update(
            target_score=round(own_evidence.get("score", 0), 6),
            target_support=own_evidence.get("support", 0),
        )
        entry = {
            "name_key": row["name_key"],
            "key_kind": row["key_kind"],
            "module_id": module_id,
            "shopping_list_id": list_id,
            "list_known": preferred,
            "preferred": preferred,
            "section_id": section,
            "section_known": section_evidence["reliable"],
            "store_ids": stores if store_evidence["reliable"] else [],
            "stores_known": store_evidence["reliable"],
            "evidence": {
                "list": public_list_evidence,
                "section": {
                    key: value
                    for key, value in section_evidence.items()
                    if key != "_targets"
                },
                "stores": {
                    key: value
                    for key, value in store_evidence.items()
                    if key != "_targets"
                },
            },
            "history_fields": history_fields,
            "updated_at": row["updated_at"],
            "legacy_hits": sum(sibling["legacy_hits"] for sibling in siblings),
        }
        if module_id == "tasks":
            entry.update(
                project_id=entry.pop("shopping_list_id"),
                project_known=preferred,
                workspace_id=scopes[list_id],
            )
            entry.pop("store_ids")
            entry.pop("stores_known")
        result.append(entry)
    result.sort(key=lambda row: not row["preferred"])
    return result


def _entry_identity(row):
    return (
        row["name_key"],
        row["key_kind"],
        row.get("workspace_id"),
        row.get("project_id", row.get("shopping_list_id")),
    )


def routing_catalog_entries(db, user_id, module_id="shopping"):
    """One explicitly bounded model corpus exported to every consumer."""
    rows = [
        *routing_entries(db, user_id, module_id=module_id),
        *routing_entries(db, user_id, module_id=module_id, key_kind="exact"),
    ]
    catalog = {_entry_identity(row): row for row in rows}
    return list(catalog.values())[: RULES["max_model_entries"]]


def routing_lookup_entries(db, user_id, name, module_id="shopping", catalog=None):
    """Older literal recalls augment exact/phrase matching, never corpus weights."""
    base = (
        routing_catalog_entries(db, user_id, module_id) if catalog is None else catalog
    )
    keys = routing_lookup_names(name)
    focused = []
    # Keep SQL parameter counts bounded while retaining every derived name.
    for start in range(0, len(keys), 128):
        focused.extend(
            routing_entries(
                db, user_id, module_id=module_id, name_keys=keys[start : start + 128]
            )
        )
    result = {_entry_identity(row): row for row in base}
    for row in focused:
        identity = _entry_identity(row)
        if identity not in result:
            result[identity] = {**row, "inference_direct_only": True}
    return list(result.values())


def routing_state(db, user_id: int) -> dict:
    enabled, generation = _account_state(db, user_id)
    try:
        count = int(
            db.execute(
                "SELECT COUNT(*) FROM routing_memory_entries WHERE user_id = ?",
                (user_id,),
            ).fetchone()[0]
        )
    except sqlite3.OperationalError:
        count = 0
    try:
        revision = int(
            db.execute(
                "SELECT COALESCE(MAX(id),0) FROM routing_memory_events WHERE user_id = ?",
                (user_id,),
            ).fetchone()[0]
        )
    except sqlite3.OperationalError:
        revision = 0
    return {
        "enabled": enabled,
        "generation": generation,
        "learned_routes": count,
        "revision": revision,
        "entries": routing_catalog_entries(db, user_id),
        "task_entries": routing_catalog_entries(db, user_id, module_id="tasks"),
    }


def default_task_workspace(db, user_id):
    row = db.execute(
        "SELECT id FROM workspaces WHERE user_id=? ORDER BY is_default DESC,id LIMIT 1",
        (user_id,),
    ).fetchone()
    return row[0] if row else None


def _module_history(db, user_id, name_key, key_kind, workspace_id):
    scope = (
        default_task_workspace(db, user_id) if workspace_id is None else workspace_id
    )
    rows = db.execute(
        """SELECT observation.*,entry.name_key,entry.module_id,entry.workspace_id,entry.project_id,entry.shopping_list_id
        FROM routing_memory_observations observation JOIN routing_memory_entries entry ON entry.id=observation.entry_id
        WHERE observation.user_id=? AND entry.user_id=? AND entry.name_key=? AND entry.key_kind=? AND observation.field='module'
        ORDER BY observation.id DESC""",
        (user_id, user_id, name_key, key_kind),
    ).fetchall()
    result = []
    for row in rows:
        if row["module_id"] == "shopping":
            allowed = resolve_entity_access(
                db, "shopping_list", row["shopping_list_id"], user_id
            ).can_edit_content
        else:
            actual_scope = task_workspace_id(db, user_id, row["project_id"])
            allowed = (
                can_manage_todos(db, row["project_id"], user_id)
                and actual_scope == scope
                and row["workspace_id"] in (None, actual_scope)
            )
        if allowed:
            result.append(row)
    return result


def resolve_module_choice(db, user_id, name_key, key_kind="exact", workspace_id=None):
    return _resolve_history(
        _module_history(db, user_id, name_key, key_kind, workspace_id),
        lambda value: value in ("tasks", "shopping"),
        datetime.now(timezone.utc),
    )


def _module_entries(
    db, user_id, name, workspace_id=None, modules=("tasks", "shopping")
):
    """Project authorized module observations into the same generic matcher DTO."""
    scope = (
        default_task_workspace(db, user_id) if workspace_id is None else workspace_id
    )
    allowed = set()
    catalog_keys = set()
    for module_id in ("tasks", "shopping"):
        for row in routing_lookup_entries(db, user_id, name, module_id):
            if module_id == "tasks" and row.get("workspace_id") != scope:
                continue
            container = row.get("project_id", row.get("shopping_list_id"))
            allowed.add((module_id, row["name_key"], row["key_kind"], container))
            if not row.get("inference_direct_only", False):
                catalog_keys.add((row["name_key"], row["key_kind"]))
    names = sorted({key for _module, key, _kind, _target in allowed})
    histories, access = {}, {}
    selected_keys = {(key, kind) for _module, key, kind, _target in allowed}
    for start in range(0, len(names), 128):
        batch = names[start : start + 128]
        placeholders = ",".join("?" for _ in batch)
        rows = db.execute(
            f"""SELECT * FROM (
                SELECT observation.*,entry.name_key,entry.key_kind,entry.module_id,
                    entry.workspace_id,entry.project_id,entry.shopping_list_id,
                    ROW_NUMBER() OVER (PARTITION BY observation.entry_id ORDER BY observation.id DESC) AS history_rank
                FROM routing_memory_observations observation JOIN routing_memory_entries entry ON entry.id=observation.entry_id
                WHERE observation.user_id=? AND entry.user_id=? AND observation.field='module'
                AND entry.name_key IN ({placeholders})
            ) WHERE history_rank <= ? ORDER BY id DESC""",
            (user_id, user_id, *batch, HISTORY_LIMIT),
        )
        for row in rows:
            if (row["name_key"], row["key_kind"]) not in selected_keys:
                continue
            target = row["project_id"] if row["module_id"] == "tasks" else row["shopping_list_id"]
            identity = (row["module_id"], target)
            if identity not in access:
                access[identity] = (
                    can_manage_todos(db, target, user_id)
                    and task_workspace_id(db, user_id, target) == scope
                    if row["module_id"] == "tasks"
                    else resolve_entity_access(db, "shopping_list", target, user_id).can_edit_content
                )
            if not access[identity] or (
                row["module_id"] == "tasks" and row["workspace_id"] not in (None, scope)
            ):
                continue
            histories.setdefault((row["name_key"], row["key_kind"]), []).append(row)
    now = datetime.now(timezone.utc)
    entries = []
    for (key, kind), history in histories.items():
        value, evidence = _resolve_history(history, lambda value: value in modules, now)
        entries.append(
            {
                "name_key": key,
                "key_kind": kind,
                "module_known": evidence["reliable"],
                "module_value": value,
                "inference_direct_only": (key, kind) not in catalog_keys,
                "history_fields": ["module"],
                "evidence": {
                    "module": {
                        key: value
                        for key, value in evidence.items()
                        if key != "_targets"
                    }
                },
            }
        )
    return entries


def suggest_module(db, user_id, name, workspace_id=None, modules=("tasks", "shopping")):
    decision = match_field(
        _module_entries(db, user_id, name, workspace_id, modules), name, "module"
    )
    return decision["value"] if decision["status"] == "value" else None


def _legacy_feedback_targets(
    db, user_id, name, module_id, container_id, chosen_fields, entries, workspace_id
):
    """Feedback follows the same applied evidence, never an unrelated base token."""
    if module_id == "tasks":
        entries = task_routing_entries(entries, workspace_id)
    prepared = prepare_route_matcher(entries)
    module_prepared = prepare_route_matcher(_module_entries(db, user_id, name, workspace_id))
    module_decision = module_prepared.match_field(name, "module")

    def imported_sources(decision):
        if decision["match_kind"] == "typo":
            return set()
        sources = decision["source_keys"]
        return (
            {source["name_key"] for source in sources}
            if sources and all(source["key_kind"] == "token" for source in sources)
            else set()
        )

    module_names = imported_sources(module_decision)
    list_names = (
        imported_sources(prepared.match_field(name, "list"))
        if "list" in chosen_fields
        else set()
    )
    targets = {}
    fields = chosen_fields | ({"module"} if "list" in chosen_fields else set())
    for field in fields:
        if field == "module":
            names = module_names
        else:
            decision = prepared.match_field(name, field, None if field == "list" else container_id)
            if decision["match_kind"] == "typo":
                continue
            names = imported_sources(decision)
            if not names and not decision["source_keys"] and field != "list":
                names = list_names
            if (
                not names
                and not decision["source_keys"]
                and module_decision["status"] == "value"
                and module_decision["value"] != module_id
            ):
                names = module_names
        for token in names:
            targets.setdefault(token, set()).add(field)
    return targets


def reset_routing_memory(db, user_id: int) -> int:
    """Caller holds a writer transaction; preserve the existing all-memory reset."""
    deleted = 0
    for table in (
        "routing_memory_observations",
        "routing_memory_entries",
        "routing_memory_events",
    ):
        if not db.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
        ).fetchone():
            continue
        deleted_rows = db.execute(
            f"DELETE FROM {table} WHERE user_id = ?", (user_id,)
        ).rowcount
        if table not in ("routing_memory_events", "routing_memory_observations"):
            deleted += max(0, deleted_rows)
    if any(
        row[1] == "routing_memory_generation"
        for row in db.execute("PRAGMA table_info(users)")
    ):
        db.execute(
            "UPDATE users SET routing_memory_generation = routing_memory_generation + 1 WHERE id = ?",
            (user_id,),
        )
    return deleted


def set_routing_enabled(db, user_id: int, enabled: bool) -> dict:
    previous_enabled, _ = _account_state(db, user_id)
    db.execute(
        "UPDATE users SET braindump_learning_enabled = ? WHERE id = ?",
        (int(enabled), user_id),
    )
    if not enabled:
        reset_routing_memory(db, user_id)
    elif not previous_enabled:
        db.execute(
            "UPDATE users SET routing_memory_generation = routing_memory_generation + 1 WHERE id = ?",
            (user_id,),
        )
    return routing_state(db, user_id)


def record_entity_route_choice(
    db,
    user_id: int,
    name: str,
    module_id: str,
    container_id: int,
    section_id: int | None,
    store_ids: list[int],
    feedback: RoutingFeedback | None,
    *,
    event_key: str | None = None,
    key_kind="exact",
    propagate_tokens=True,
    context_workspace_id=None,
    learn_module=True,
) -> bool:
    if feedback is None or not feedback.fields:
        return False
    if not db.in_transaction:
        raise RuntimeError("Routing memory requires the content writer transaction")
    enabled, generation = _account_state(db, user_id)
    if not enabled or generation != feedback.generation:
        return False
    name_key = normalize_item_name(name)
    task = module_id == "tasks"
    allowed = (
        can_manage_todos(db, container_id, user_id)
        if task
        else resolve_entity_access(
            db, "shopping_list", container_id, user_id
        ).can_edit_content
    )
    if not name_key or not allowed:
        return False
    workspace_id = task_workspace_id(db, user_id, container_id) if task else None
    context_scope = (
        context_workspace_id if context_workspace_id is not None else workspace_id
    )
    target_column, section_column = (
        ("project_id", "task_section_id")
        if task
        else ("shopping_list_id", "section_id")
    )
    chosen_fields = set(feedback.fields)
    if not learn_module:
        chosen_fields.discard("module")
    if task:
        chosen_fields.discard("stores")
    if (
        "section" in chosen_fields
        and section_id is not None
        and not db.execute(
            f"SELECT 1 FROM {'sections' if task else 'shopping_sections'} WHERE id = ? AND {'project_id' if task else 'shopping_list_id'} = ?",
            (section_id, container_id),
        ).fetchone()
    ):
        chosen_fields.remove("section")
    stores = sorted(set(store_ids))
    if "stores" in chosen_fields and any(
        not db.execute(
            "SELECT 1 FROM shopping_stores WHERE id = ? AND shopping_list_id = ? AND active = 1",
            (store, container_id),
        ).fetchone()
        for store in stores
    ):
        # An existing item's inactive store associations may be retained by the
        # editor. Do not turn that into an explicit empty-store choice, nor lose
        # independent valid list/section feedback from the same confirmation.
        chosen_fields.remove("stores")
    if not chosen_fields:
        return False
    all_prior = (
        routing_entries(db, user_id, module_id=module_id, name_key=name_key)
        if key_kind == "token"
        else routing_lookup_entries(db, user_id, name, module_id)
    )
    propagation = (
        _legacy_feedback_targets(
            db,
            user_id,
            name,
            module_id,
            container_id,
            chosen_fields,
            all_prior,
            context_scope,
        )
        if key_kind == "exact" and propagate_tokens
        else {}
    )
    prior_choices = [
        entry
        for entry in all_prior
        if entry["name_key"] == name_key
        if entry["key_kind"] == key_kind
        and (not task or entry["workspace_id"] == workspace_id)
    ]
    prior_entry = next(
        (entry for entry in prior_choices if entry[target_column] == container_id), None
    )
    prior_list = next(
        (entry[target_column] for entry in prior_choices if entry["preferred"]), None
    )
    weights = {}
    for field in chosen_fields:
        if field == "module":
            continue
        if field == "list":
            known, previous, chosen = prior_list is not None, prior_list, container_id
        elif field == "section":
            known, previous, chosen = (
                bool(prior_entry and prior_entry["section_known"]),
                prior_entry["section_id"] if prior_entry else None,
                section_id,
            )
        else:
            known, previous, chosen = (
                bool(prior_entry and prior_entry["stores_known"]),
                prior_entry["store_ids"] if prior_entry else [],
                stores,
            )
        weights[field] = CORRECTION_WEIGHT if known and previous != chosen else 1
    now = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    event_id = event_key or feedback.event_id
    receipt = db.execute(
        """INSERT OR IGNORE INTO routing_memory_events (user_id,event_id,generation,created_at)
                             VALUES (?,?,?,?)""",
        (user_id, event_id, generation, now),
    )
    if not receipt.rowcount:
        return False
    if key_kind == "exact":
        _retire_corrected_legacy(
            db,
            user_id,
            name,
            module_id,
            container_id,
            section_id,
            stores,
            chosen_fields,
            all_prior,
            context_scope,
        )
    sequence = receipt.lastrowid
    db.execute(
        f"""INSERT OR IGNORE INTO routing_memory_entries (user_id,module_id,key_kind,workspace_id,name_key,{target_column},updated_at)
                  VALUES (?,?,?,?,?,?,?)""",
        (user_id, module_id, key_kind, workspace_id, name_key, container_id, now),
    )
    fields = {"updated_at": now, "update_sequence": sequence}
    if "list" in chosen_fields:
        fields.update(list_known=1, list_sequence=sequence)
    if "section" in chosen_fields:
        fields.update(section_known=1, **{section_column: section_id})
    if "stores" in chosen_fields:
        fields.update(
            stores_known=1, store_ids_json=json.dumps(stores, separators=(",", ":"))
        )
    assignments = ",".join(f"{key} = ?" for key in fields)
    identity = (user_id, module_id, key_kind, workspace_id, name_key, container_id)
    where = f"user_id=? AND module_id=? AND key_kind=? AND workspace_id IS ? AND name_key=? AND {target_column}=?"
    db.execute(
        f"UPDATE routing_memory_entries SET {assignments} WHERE {where}",
        (*fields.values(), *identity),
    )
    entry_id = db.execute(
        f"SELECT id FROM routing_memory_entries WHERE {where}", identity
    ).fetchone()[0]
    values = {
        "list": container_id,
        "section": section_id,
        "stores": stores,
        "module": module_id,
    }
    observed_fields = chosen_fields | (
        {"module"} if "list" in chosen_fields and learn_module else set()
    )
    if "module" in observed_fields:
        previous_module, evidence = resolve_module_choice(
            db, user_id, name_key, key_kind, context_scope
        )
        weights["module"] = (
            CORRECTION_WEIGHT
            if evidence["reliable"] and previous_module != module_id
            else 1
        )
    for field in observed_fields:
        db.execute(
            """INSERT INTO routing_memory_observations
            (user_id,entry_id,event_id,field,value_json,weight,observed_at) VALUES (?,?,?,?,?,?,?)""",
            (
                user_id,
                entry_id,
                sequence,
                field,
                json.dumps(values[field], separators=(",", ":")),
                weights[field],
                now,
            ),
        )
        if field == "list":
            db.execute(
                """DELETE FROM routing_memory_observations WHERE user_id = ? AND field = 'list'
                AND entry_id IN (SELECT id FROM routing_memory_entries WHERE user_id = ? AND name_key = ? AND module_id=? AND key_kind=? AND workspace_id IS ?)
                AND id NOT IN (SELECT observation.id FROM routing_memory_observations observation
                    JOIN routing_memory_entries entry ON entry.id = observation.entry_id
                    WHERE observation.user_id = ? AND entry.user_id = ? AND entry.name_key = ? AND entry.module_id=? AND entry.key_kind=? AND entry.workspace_id IS ? AND observation.field = 'list'
                    ORDER BY observation.id DESC LIMIT ?)""",
                (
                    user_id,
                    user_id,
                    name_key,
                    module_id,
                    key_kind,
                    workspace_id,
                    user_id,
                    user_id,
                    name_key,
                    module_id,
                    key_kind,
                    workspace_id,
                    HISTORY_LIMIT,
                ),
            )
        else:
            db.execute(
                """DELETE FROM routing_memory_observations WHERE user_id = ? AND entry_id = ? AND field = ?
                AND id NOT IN (SELECT id FROM routing_memory_observations WHERE user_id = ? AND entry_id = ? AND field = ?
                    ORDER BY id DESC LIMIT ?)""",
                (user_id, entry_id, field, user_id, entry_id, field, HISTORY_LIMIT),
            )
    db.execute(
        """DELETE FROM routing_memory_entries WHERE user_id = ? AND id IN
                  (SELECT id FROM routing_memory_entries WHERE user_id = ? AND key_kind='exact' ORDER BY update_sequence DESC,id DESC LIMIT -1 OFFSET ?)""",
        (user_id, user_id, MAX_ENTRIES),
    )
    if key_kind == "exact" and propagate_tokens:
        for token, token_fields in propagation.items():
            if db.execute(
                "SELECT 1 FROM routing_memory_entries WHERE user_id=? AND key_kind='token' AND name_key=?",
                (user_id, token),
            ).fetchone():
                token_event = (
                    "token:"
                    + hashlib.sha256(
                        json.dumps(
                            [
                                event_id,
                                token,
                                module_id,
                                workspace_id,
                                container_id,
                                sorted(token_fields),
                            ],
                            separators=(",", ":"),
                        ).encode()
                    ).hexdigest()
                )
                record_entity_route_choice(
                    db,
                    user_id,
                    token,
                    module_id,
                    container_id,
                    section_id,
                    stores,
                    feedback.model_copy(update={"fields": sorted(token_fields)}),
                    event_key=token_event,
                    key_kind="token",
                    propagate_tokens=False,
                    learn_module="module" in token_fields,
                )
    return True


def record_route_choice(
    db,
    user_id,
    name,
    shopping_list_id,
    section_id,
    store_ids,
    feedback,
    *,
    event_key=None,
    context_workspace_id=None,
):
    return record_entity_route_choice(
        db,
        user_id,
        name,
        "shopping",
        shopping_list_id,
        section_id,
        store_ids,
        feedback,
        event_key=event_key,
        context_workspace_id=context_workspace_id,
    )


def record_task_route_choice(
    db, user_id, name, project_id, section_id, feedback, *, event_key=None
):
    if project_id is None:
        return False
    return record_entity_route_choice(
        db,
        user_id,
        name,
        "tasks",
        project_id,
        section_id,
        [],
        feedback,
        event_key=event_key,
    )


def _retire_legacy_field(
    db, user_id, module_id, tokens, field, workspace_id, container_id=None
):
    if not tokens:
        return
    scope = (
        default_task_workspace(db, user_id) if workspace_id is None else workspace_id
    )
    rows = db.execute(
        "SELECT * FROM routing_memory_entries WHERE user_id=? AND module_id=? AND key_kind='token'",
        (user_id, module_id),
    ).fetchall()
    for row in rows:
        if row["name_key"] not in tokens:
            continue
        target = row["project_id"] if module_id == "tasks" else row["shopping_list_id"]
        if container_id is not None and target != container_id:
            continue
        if module_id == "tasks":
            if (
                not can_manage_todos(db, target, user_id)
                or task_workspace_id(db, user_id, target) != scope
                or row["workspace_id"] not in (None, scope)
            ):
                continue
        elif not resolve_entity_access(
            db, "shopping_list", target, user_id
        ).can_edit_content:
            continue
        db.execute(
            "DELETE FROM routing_memory_observations WHERE user_id=? AND entry_id=? AND field=? AND origin='legacy'",
            (user_id, row["id"], field),
        )


def _retire_corrected_legacy(
    db,
    user_id,
    name,
    module_id,
    container_id,
    section_id,
    stores,
    chosen_fields,
    entries,
    workspace_id,
):
    if module_id == "tasks":
        entries = task_routing_entries(entries, workspace_id)
    prepared = prepare_route_matcher(entries)
    values = {"list": container_id, "section": section_id, "stores": stores}
    for field in chosen_fields & {"list", "section", "stores"}:
        decision = prepared.match_field(name, field, None if field == "list" else container_id)
        sources = decision["source_keys"]
        if (
            decision["status"] != "value"
            or decision["match_kind"] == "typo"
            or decision["value"] == values[field]
            or not sources
            or any(source["key_kind"] != "token" for source in sources)
        ):
            continue
        _retire_legacy_field(
            db,
            user_id,
            module_id,
            {source["name_key"] for source in sources},
            field,
            workspace_id,
            None if field == "list" else container_id,
        )
    if chosen_fields & {"module", "list"}:
        module_prepared = prepare_route_matcher(_module_entries(db, user_id, name, workspace_id))
        decision = module_prepared.match_field(name, "module")
        sources = decision["source_keys"]
        if (
            decision["status"] == "value"
            and decision["match_kind"] != "typo"
            and decision["value"] != module_id
            and sources
            and all(source["key_kind"] == "token" for source in sources)
        ):
            _retire_legacy_field(
                db,
                user_id,
                decision["value"],
                {source["name_key"] for source in sources},
                "module",
                workspace_id,
            )


def legacy_feedback(
    db, user_id: int, event_id: str, fields: list[str]
) -> RoutingFeedback | None:
    """Unversioned clients may teach only before the first forget/opt-out fence.

    A delayed legacy write carries no captured generation. After a reset there
    is no safe way to distinguish that old intent from a new deliberate choice;
    preserve its content, but require versioned feedback to learn again.
    """
    _enabled, generation = _account_state(db, user_id)
    if generation != 0:
        return None
    return RoutingFeedback(event_id=event_id, generation=0, fields=fields)


def recipe_event_key(
    operation_id: str,
    name: str,
    list_id: int,
    section_id: int | None,
    store_ids: list[int],
    feedback: RoutingFeedback,
) -> str:
    identity = [
        operation_id,
        normalize_item_name(name),
        list_id,
        section_id,
        sorted(set(store_ids)),
        feedback.fields,
    ]
    return (
        "recipe:"
        + hashlib.sha256(
            json.dumps(identity, ensure_ascii=False, separators=(",", ":")).encode()
        ).hexdigest()
    )
