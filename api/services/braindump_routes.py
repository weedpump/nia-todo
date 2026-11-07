"""User-local BrainDump route feedback shared by confirmed Tasks and Shopping writes."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from services.entity_access import resolve_entity_access
from services.braindump_candidates import enabled_candidate_modules
from services.sharing import can_manage_todos

BRAINDUMP_LEARNING_MIN_TOKEN_LENGTH = 3
BRAINDUMP_LEARNING_MAX_TOKENS = 12
BRAINDUMP_LEARNING_APPLY_MIN_SCORE = 2
BRAINDUMP_LEARNING_APPLY_MIN_MARGIN = 2
BRAINDUMP_LEARNING_OVERRIDE_MIN_SCORE = 4
BRAINDUMP_LEARNING_OVERRIDE_MIN_MARGIN = 3

BRAINDUMP_LEARNING_STOPWORDS = {
    "aber", "alle", "alles", "also", "and", "auf", "aus", "bei", "bitte", "das", "den", "der", "die", "dies", "ein", "eine", "einen", "einer", "eines", "for", "für", "hab", "habe", "ich", "im", "in", "ist", "it", "mit", "nach", "noch", "oder", "of", "the", "to", "und", "vom", "von", "was", "wir", "zum", "zur",
    "add", "aufgabe", "besorgen", "brauche", "bring", "bringen", "buy", "erinnere", "erinnern", "holen", "kaufen", "mach", "machen", "need", "todo", "tun",
}


def _learning_tokens(title: str) -> list[str]:
    tokens = []
    seen = set()
    for token in re.findall(r"[\wäöüÄÖÜß]+", str(title or "").casefold(), flags=re.UNICODE):
        token = token.strip("_")
        if len(token) < BRAINDUMP_LEARNING_MIN_TOKEN_LENGTH or token.isdigit() or token in BRAINDUMP_LEARNING_STOPWORDS:
            continue
        if token in seen:
            continue
        seen.add(token)
        tokens.append(token)
        if len(tokens) >= BRAINDUMP_LEARNING_MAX_TOKENS:
            break
    return tokens


class BrainDumpRouteFeedback(BaseModel):
    original_module_id: Literal["tasks", "shopping"] | None = None
    original_shopping_list_id: int | None = Field(default=None, gt=0)
    original_shopping_section_id: int | None = Field(default=None, gt=0)
    original_shopping_store_ids: list[int] = Field(default_factory=list, max_length=50)
    original_project_name: str | None = Field(default=None, max_length=200)
    original_section_name: str | None = Field(default=None, max_length=200)
    original_route_present: bool = False


def learning_enabled_for_user(db, user_id: int) -> bool:
    row = db.execute("SELECT COALESCE(braindump_learning_enabled, 1) AS enabled FROM users WHERE id = ?", (user_id,)).fetchone()
    return bool(row and row["enabled"])


def module_learning_row_count(db, user_id: int) -> int:
    return int(db.execute("SELECT COUNT(*) AS count FROM braindump_module_route_learning WHERE user_id = ?", (user_id,)).fetchone()["count"])


def reset_module_learning(db, user_id: int) -> int:
    return int(db.execute("DELETE FROM braindump_module_route_learning WHERE user_id = ?", (user_id,)).rowcount or 0)


def record_confirmed_route(db, user_id: int, title: str, module_id: str, *,
                           workspace_id: int | None = None, project_id: int | None = None,
                           task_section_id: int | None = None, shopping_list_id: int | None = None,
                           shopping_section_id: int | None = None, shopping_store_ids: list[int] | None = None,
                           feedback: BrainDumpRouteFeedback | None = None, corrected: bool = False) -> None:
    """Called inside the entity's writer transaction, only after a new insert.

    Current route IDs are the caller's already validated write target. Feedback
    contains only the old suggestion; it can boost user-local correction scores
    but can never choose a target or grant access.
    """
    if feedback is None or not learning_enabled_for_user(db, user_id):
        return
    tokens = _learning_tokens(title)
    if not tokens:
        return
    stores = shopping_store_ids or []
    store_id = stores[0] if len(stores) == 1 else None
    if module_id == "shopping":
        if shopping_list_id is None:
            return
        corrected = corrected or bool(feedback.original_route_present and (
            feedback.original_module_id not in (None, "shopping")
            or feedback.original_shopping_list_id != shopping_list_id
            or feedback.original_shopping_section_id != shopping_section_id
            or sorted(feedback.original_shopping_store_ids) != sorted(stores)
        ))
        workspace_id, project_id, task_section_id = None, None, None
    elif module_id == "tasks":
        if project_id is None:
            return
        corrected = corrected or bool(feedback.original_route_present and feedback.original_module_id == "shopping")
        shopping_list_id, shopping_section_id, store_id = None, None, None
    else:
        raise ValueError("Unsupported BrainDump route module")
    route = (module_id, workspace_id, project_id, task_section_id, shopping_list_id, shopping_section_id, store_id)
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    for token in tokens:
        existing = db.execute(
            """SELECT id, hits FROM braindump_module_route_learning
               WHERE user_id = ? AND token = ? AND module_id = ? AND workspace_id IS ?
                 AND project_id IS ? AND task_section_id IS ? AND shopping_list_id IS ?
                 AND shopping_section_id IS ? AND shopping_store_id IS ?""",
            (user_id, token, *route),
        ).fetchone()
        hits = int(existing["hits"] if existing else 0) + 1
        if corrected:
            competing = db.execute(
                """SELECT COALESCE(MAX(hits), 0) AS hits FROM braindump_module_route_learning
                   WHERE user_id = ? AND token = ? AND id != ?""",
                (user_id, token, existing["id"] if existing else -1),
            ).fetchone()
            hits = max(hits, BRAINDUMP_LEARNING_OVERRIDE_MIN_SCORE,
                       int(competing["hits"]) + BRAINDUMP_LEARNING_OVERRIDE_MIN_MARGIN)
        if existing:
            db.execute("UPDATE braindump_module_route_learning SET hits = ?, last_used_at = ? WHERE id = ?", (hits, now, existing["id"]))
        else:
            db.execute(
                """INSERT INTO braindump_module_route_learning
                   (user_id, token, module_id, workspace_id, project_id, task_section_id,
                    shopping_list_id, shopping_section_id, shopping_store_id, hits, last_used_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (user_id, token, *route, hits, now),
            )


def _authorized_route(db, user_id: int, row, context: dict, modules: list[str]) -> dict | None:
    module = row["module_id"]
    if module not in modules:
        return None
    if module == "shopping":
        list_id = row["shopping_list_id"]
        if not resolve_entity_access(db, "shopping_list", list_id, user_id).can_edit_content:
            return None
        if not db.execute("SELECT 1 FROM shopping_lists WHERE id = ?", (list_id,)).fetchone():
            return None
        section_id, store_id = row["shopping_section_id"], row["shopping_store_id"]
        if section_id is not None and not db.execute("SELECT 1 FROM shopping_sections WHERE id = ? AND shopping_list_id = ?", (section_id, list_id)).fetchone():
            return None
        if store_id is not None and not db.execute("SELECT 1 FROM shopping_stores WHERE id = ? AND shopping_list_id = ? AND active = 1", (store_id, list_id)).fetchone():
            return None
        return {"module_id": "shopping", "shopping_list_id": list_id, "shopping_section_id": section_id,
                "shopping_store_ids": [store_id] if store_id is not None else []}
    project_id = row["project_id"]
    project = next((project for project in context.get("projects", []) if project.get("id") == project_id), None)
    if project is None or not can_manage_todos(db, project_id, user_id):
        return None
    project_name_key = " ".join(project["name"].casefold().split())
    if sum(" ".join(str(item.get("name") or "").casefold().split()) == project_name_key
           for item in context.get("projects", [])) != 1:
        # The compatible Tasks confirmation API routes by name. Do not turn an
        # exact learned ID into an ambiguous name that would save into Inbox.
        return None
    section_id = row["task_section_id"]
    section = (db.execute("SELECT name FROM sections WHERE id = ? AND project_id = ?", (section_id, project_id)).fetchone()
               if section_id is not None else None)
    if section_id is not None and section is None:
        return None
    if section is not None:
        section_name_key = " ".join(section["name"].casefold().split())
        if sum(" ".join(str(name).casefold().split()) == section_name_key for name in project.get("sections", [])) != 1:
            return None
    return {"module_id": "tasks", "project_name": project["name"], "section_name": section["name"] if section else None}


def apply_module_routes(db, user_id: int, workspace_id: int | None, parsed: dict, context: dict) -> dict:
    if not context.get("typed_candidates") or not learning_enabled_for_user(db, user_id):
        return parsed
    modules = enabled_candidate_modules(db, user_id, context.get("supported_modules", []))
    routed = []
    for candidate in parsed.get("candidates", []):
        if not isinstance(candidate, dict):
            routed.append(candidate)
            continue
        tokens = _learning_tokens(str(candidate.get("title") or ""))
        if not tokens:
            routed.append(candidate)
            continue
        placeholders = ",".join("?" for _ in tokens)
        rows = db.execute(
            f"""SELECT module_id, workspace_id, project_id, task_section_id,
                       shopping_list_id, shopping_section_id, shopping_store_id, SUM(hits) AS score
                FROM braindump_module_route_learning
                WHERE user_id = ? AND (workspace_id IS NULL OR workspace_id = ?) AND token IN ({placeholders})
                GROUP BY module_id, workspace_id, project_id, task_section_id,
                         shopping_list_id, shopping_section_id, shopping_store_id
                ORDER BY score DESC, MIN(id) ASC LIMIT 32""",
            (user_id, workspace_id, *tokens),
        ).fetchall()
        choices = []
        for row in rows:
            target = _authorized_route(db, user_id, row, context, modules)
            if target is not None:
                choices.append((target, int(row["score"])))
                if len(choices) >= 2:
                    break
        if not choices:
            routed.append(candidate)
            continue
        target, score = choices[0]
        margin = score - (choices[1][1] if len(choices) > 1 else 0)
        different_module = candidate.get("module_id") != target["module_id"]
        if different_module:
            has_task_details = candidate.get("module_id") == "tasks" and any(
                candidate.get(field) not in (None, "", {}, [])
                for field in ("deadline", "reminder", "recurring_rule", "location_reminder")
            )
            has_shopping_details = candidate.get("module_id") == "shopping" and (
                candidate.get("quantity_value") is not None or bool(candidate.get("quantity_unit"))
            )
            if has_task_details or has_shopping_details:
                # A learned type suggestion must never erase explicit content.
                # The preview may still offer a deliberate manual module switch.
                routed.append(candidate)
                continue
        if target["module_id"] == "shopping":
            conflicts = bool(
                (candidate.get("shopping_list_id") is not None and candidate["shopping_list_id"] != target["shopping_list_id"])
                or (candidate.get("shopping_section_id") is not None and candidate["shopping_section_id"] != target["shopping_section_id"])
                or (candidate.get("shopping_store_ids") and sorted(candidate["shopping_store_ids"]) != target["shopping_store_ids"])
            )
        else:
            conflicts = bool(
                (candidate.get("project_name") and candidate["project_name"] != target["project_name"])
                or (candidate.get("section_name") and candidate["section_name"] != target["section_name"])
            )
        override = score >= BRAINDUMP_LEARNING_OVERRIDE_MIN_SCORE and margin >= BRAINDUMP_LEARNING_OVERRIDE_MIN_MARGIN
        if score < BRAINDUMP_LEARNING_APPLY_MIN_SCORE or margin < BRAINDUMP_LEARNING_APPLY_MIN_MARGIN or ((different_module or conflicts) and not override):
            routed.append(candidate)
            continue
        if target["module_id"] == "shopping":
            item = {"module_id": "shopping", "title": candidate["title"], "quantity_value": candidate.get("quantity_value"),
                    "quantity_unit": candidate.get("quantity_unit"), **target}
        else:
            item = {"module_id": "tasks", "title": candidate["title"], "deadline": None, "reminder": None,
                    "recurring_rule": None, "location_reminder": None, **target}
            if not different_module:
                item = {**candidate, **target}
        routed.append(item)
    return {**parsed, "candidates": routed}
