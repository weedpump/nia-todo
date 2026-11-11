"""BrainDump adapter for the one account-local routing evidence service."""

from __future__ import annotations
import uuid
from typing import Literal
from pydantic import BaseModel, Field
from services.braindump_candidates import enabled_candidate_modules
from services.routing_matcher import routing_tokens, suggest_route, suggest_task_route
from services.routing_memory import (
    routing_catalog_entries,
    routing_lookup_entries,
    routing_state,
    reset_routing_memory,
    legacy_feedback,
    record_route_choice,
    record_task_route_choice,
    suggest_module,
    default_task_workspace,
    task_workspace_id,
)
from services.sharing import can_manage_todos

# Stable compatibility names; the policy itself lives in the common registry.
BRAINDUMP_LEARNING_MIN_TOKEN_LENGTH = 3
BRAINDUMP_LEARNING_MAX_TOKENS = 12
BRAINDUMP_LEARNING_APPLY_MIN_SCORE = 2
BRAINDUMP_LEARNING_APPLY_MIN_MARGIN = 2
BRAINDUMP_LEARNING_OVERRIDE_MIN_SCORE = 4
BRAINDUMP_LEARNING_OVERRIDE_MIN_MARGIN = 3
_learning_tokens = routing_tokens


class BrainDumpRouteFeedback(BaseModel):
    original_module_id: Literal["tasks", "shopping"] | None = None
    original_shopping_list_id: int | None = Field(default=None, gt=0)
    original_shopping_section_id: int | None = Field(default=None, gt=0)
    original_shopping_store_ids: list[int] = Field(default_factory=list, max_length=50)
    original_project_id: int | None = Field(default=None, gt=0)
    original_section_id: int | None = Field(default=None, gt=0)
    original_project_name: str | None = Field(default=None, max_length=200)
    original_section_name: str | None = Field(default=None, max_length=200)
    original_route_present: bool = False


def learning_enabled_for_user(db, user_id):
    row = db.execute(
        "SELECT braindump_learning_enabled FROM users WHERE id=?", (user_id,)
    ).fetchone()
    return bool(row and row[0])


def module_learning_row_count(db, user_id):
    return routing_state(db, user_id)["learned_routes"]


def reset_module_learning(db, user_id):
    return reset_routing_memory(db, user_id)


def record_confirmed_route(
    db,
    user_id,
    title,
    module_id,
    *,
    workspace_id=None,
    project_id=None,
    task_section_id=None,
    shopping_list_id=None,
    shopping_section_id=None,
    shopping_store_ids=None,
    feedback=None,
    corrected=False,
):
    """Compatibility feedback learns actual corrections, never plain acceptance."""
    if feedback is None or not feedback.original_route_present:
        return
    fields = []
    if feedback.original_module_id not in (None, module_id):
        fields.append("module")
    if module_id == "shopping":
        if feedback.original_module_id == "shopping":
            if feedback.original_shopping_list_id != shopping_list_id:
                fields.append("list")
            if feedback.original_shopping_section_id != shopping_section_id:
                fields.append("section")
            if sorted(feedback.original_shopping_store_ids) != sorted(
                shopping_store_ids or []
            ):
                fields.append("stores")
        if fields:
            record_route_choice(
                db,
                user_id,
                title,
                shopping_list_id,
                shopping_section_id,
                shopping_store_ids or [],
                legacy_feedback(db, user_id, "bd-compat:" + uuid.uuid4().hex, fields),
            )
    elif project_id is not None:
        if feedback.original_module_id == "tasks":
            if (
                feedback.original_project_id is not None
                and feedback.original_project_id != project_id
            ):
                fields.append("list")
            if (
                feedback.original_section_id != task_section_id
                and feedback.original_project_id == project_id
            ):
                fields.append("section")
        if corrected and not fields:
            fields.extend(["list", "section"])
        if fields:
            record_task_route_choice(
                db,
                user_id,
                title,
                project_id,
                task_section_id,
                legacy_feedback(db, user_id, "bd-compat:" + uuid.uuid4().hex, fields),
            )


def _explicit(candidate):
    fields = candidate.get("explicit_route_fields")
    if isinstance(fields, list) and all(
        field in ("container", "section", "stores") for field in fields
    ):
        return set(fields)
    if candidate.get("module_id", "tasks") == "shopping":
        return {
            field
            for field, value in (
                ("container", candidate.get("shopping_list_id")),
                ("section", candidate.get("shopping_section_id")),
                ("stores", candidate.get("shopping_store_ids")),
            )
            if value
        }
    return {
        field
        for field, value in (
            ("container", candidate.get("project_id") or candidate.get("project_name")),
            ("section", candidate.get("section_id") or candidate.get("section_name")),
        )
        if value
    }


def _task_target(db, user_id, candidate, workspace_id):
    project_id = candidate.get("project_id")
    if project_id is not None:
        row = db.execute(
            "SELECT id,name FROM projects WHERE id=?", (project_id,)
        ).fetchone()
        if (
            row is None
            or not can_manage_todos(db, project_id, user_id)
            or task_workspace_id(db, user_id, project_id) != workspace_id
        ):
            return None, None
    else:
        rows = [
            row
            for row in db.execute("SELECT id,name FROM projects")
            if can_manage_todos(db, row["id"], user_id)
            and task_workspace_id(db, user_id, row["id"]) == workspace_id
            and str(row["name"]).casefold().strip()
            == str(candidate.get("project_name") or "").casefold().strip()
        ]
        project_id = rows[0]["id"] if len(rows) == 1 else None
    section_id = candidate.get("section_id")
    if (
        section_id is not None
        and not db.execute(
            "SELECT 1 FROM sections WHERE id=? AND project_id=?",
            (section_id, project_id),
        ).fetchone()
    ):
        section_id = None
    if section_id is None and project_id is not None and candidate.get("section_name"):
        rows = db.execute(
            "SELECT id,name FROM sections WHERE project_id=?", (project_id,)
        ).fetchall()
        matches = [
            row["id"]
            for row in rows
            if str(row["name"]).casefold().strip()
            == str(candidate["section_name"]).casefold().strip()
        ]
        section_id = matches[0] if len(matches) == 1 else None
    return project_id, section_id


def apply_module_routes(db, user_id, workspace_id, parsed, context):
    requested = (context or {}).get("supported_modules", ["tasks"])
    if not any(
        isinstance(candidate, dict) and candidate.get("module_id", "tasks") in requested
        for candidate in parsed.get("candidates", [])
    ):
        return parsed
    if not learning_enabled_for_user(db, user_id):
        return parsed
    modules = enabled_candidate_modules(db, user_id, requested)
    scope = (
        default_task_workspace(db, user_id) if workspace_id is None else workspace_id
    )
    shopping = routing_catalog_entries(db, user_id) if "shopping" in modules else []
    tasks = (
        routing_catalog_entries(db, user_id, module_id="tasks")
        if "tasks" in modules
        else []
    )
    result = []
    for candidate in parsed.get("candidates", []):
        if not isinstance(candidate, dict):
            result.append(candidate)
            continue
        current = candidate.get("module_id", "tasks")
        explicit = _explicit(candidate)
        preferred = suggest_module(
            db, user_id, candidate.get("title", ""), scope, modules
        )
        destination = current
        has_task_details = any(
            candidate.get(field) not in (None, "", {}, [])
            for field in (
                "deadline",
                "reminder",
                "recurring_rule",
                "location_reminder",
                "notes",
                "description",
            )
        )
        has_shopping_details = candidate.get("quantity_value") is not None or bool(
            candidate.get("quantity_unit")
            or candidate.get("quantity_text")
            or candidate.get("note")
        )
        if (
            preferred
            and preferred != current
            and not explicit
            and not (has_task_details if current == "tasks" else has_shopping_details)
        ):
            destination = preferred
        if destination not in modules:
            result.append(candidate)
            continue
        item = (
            dict(candidate)
            if destination == current
            else {
                "title": candidate["title"],
                "module_id": destination,
                "explicit_route_fields": [],
            }
        )
        applied = ["module"] if destination != current else []
        if destination == "shopping":
            shopping_lookup = routing_lookup_entries(
                db, user_id, item["title"], "shopping", shopping
            )
            container = item.get("shopping_list_id")
            route = suggest_route(
                shopping_lookup, item["title"], container if explicit else None
            )
            if route is None and container is not None:
                route = suggest_route(shopping_lookup, item["title"], container)
            if destination != current:
                item.update(
                    shopping_list_id=None,
                    shopping_section_id=None,
                    shopping_store_ids=[],
                    quantity_value=None,
                    quantity_unit=None,
                )
            if route:
                same = container == route["shopping_list_id"]
                if "list" in route["memory_fields"] and not explicit:
                    item["shopping_list_id"] = route["shopping_list_id"]
                    applied.append("list")
                    if not same:
                        item.update(shopping_section_id=None, shopping_store_ids=[])
                for field, key in (
                    ("section", "shopping_section_id"),
                    ("stores", "shopping_store_ids"),
                ):
                    if field in route["memory_fields"] and field not in explicit:
                        item[key] = (
                            route["section_id"]
                            if field == "section"
                            else route["store_ids"]
                        )
                        applied.append(field)
        else:
            tasks_lookup = routing_lookup_entries(
                db, user_id, item["title"], "tasks", tasks
            )
            project_id, section_id = _task_target(db, user_id, item, scope)
            route = suggest_task_route(
                tasks_lookup, item["title"], scope, project_id if explicit else None
            )
            if route is None and project_id is not None:
                route = suggest_task_route(
                    tasks_lookup, item["title"], scope, project_id
                )
            if destination != current:
                item.update(
                    project_id=None,
                    section_id=None,
                    project_name=None,
                    section_name=None,
                    deadline=None,
                    reminder=None,
                    recurring_rule=None,
                    location_reminder=None,
                )
            if route:
                if "list" in route["memory_fields"] and not explicit:
                    if project_id != route["project_id"]:
                        section_id = None
                    project_id = route["project_id"]
                    applied.append("list")
                if "section" in route["memory_fields"] and "section" not in explicit:
                    section_id = route["section_id"]
                    applied.append("section")
                if project_id is not None:
                    item.update(
                        project_id=project_id,
                        section_id=section_id,
                        project_name=db.execute(
                            "SELECT name FROM projects WHERE id=?", (project_id,)
                        ).fetchone()[0],
                        section_name=(
                            db.execute(
                                "SELECT name FROM sections WHERE id=?", (section_id,)
                            ).fetchone()[0]
                            if section_id is not None
                            else None
                        ),
                    )
        if applied:
            item["memory_route_fields"] = applied
        result.append(item)
    return {**parsed, "candidates": result}
