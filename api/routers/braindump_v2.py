"""BrainDump v2 text/session/live-debug endpoints."""

from __future__ import annotations

import asyncio
import ast
import json
import re
import subprocess
import tempfile
import time
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from db import get_db
from routers.auth import require_auth
from routers.todos import (
    TodoCreate,
    _validate_todo_dates,
    _validate_todo_status,
    _validate_todo_target,
    fetch_todo,
    get_user_inbox_project_id,
)
from urllib.parse import urlparse

from services.braindump_config import build_effective_system_prompt, get_braindump_config, llm_chat_url, parse_extra_headers
from services.braindump_v2 import (
    append_text_segment,
    create_session,
    ensure_braindump_enabled,
    finalize_session,
    get_session,
)
from services.utils import sanitize_text
from services.websocket import broadcast_change


router = APIRouter(prefix="/api/braindump/v2")

WHISPER_MODELS = {
    "base": Path("/opt/whisper.cpp/models/ggml-base.bin"),
    "small": Path("/opt/whisper.cpp/models/ggml-small.bin"),
}
SHOPPING_PROJECT_NAME = None  # kind=shopping is resolved to the user's configured shopping list later.

LIST_VERB_RE = re.compile(r"\b(muss|soll|erinnere|erinnern|vorbereiten|aufräumen|entsorgen|bestellen|machen|erledigen|kaufen|besorgen|einkaufen|teste|testen|test)\b", re.IGNORECASE)
SHOPPING_INTENT_RE = re.compile(r"\b(kaufen|besorgen|einkaufen|einkaufsliste|shopping list|brauche|brauchen|bräuchte|bräuchten|benötige|benötigen|ist leer|leer|holen|buy|need|needs|out of|get|purchase|comprar|compro|necesito|necesitamos|no queda|acheter|achète|acheterai|courses|il faut|manque)\b", re.IGNORECASE)


def _clean_title(value: str) -> str:
    value = re.sub(r"^(ich brauche|ich benötige|bitte|noch)\s+", "", value.strip(), flags=re.IGNORECASE)
    value = re.sub(r"\b(meiner|meine|der)\s+(marm|mam)\b", lambda m: f"{m.group(1)} Mama", value, flags=re.IGNORECASE)
    value = re.sub(r"\bMarm\b", "Mama", value)
    value = value.strip(" .,:;!?-–—\t\n\r")
    return value[:1].upper() + value[1:] if value else ""


def _clean_shopping_title(value: str) -> str:
    value = re.sub(r"\b(kaufen|besorgen|einkaufen|holen|setz(?:e)?|setze|pack(?:e)?|auf(?:\s+die)?(?:\s+einkaufsliste)?|liste|buy|need|needs|get|purchase|comprar|compro|necesito|necesitamos|acheter|achète|il faut|manque)\b", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\b(nicht|not)\b", "", value, flags=re.IGNORECASE)
    value = re.sub(r"^(wir müssen|ich muss|muss|bitte|noch|also we|we|i|je|nous|yo|but|pero|mais)\s+", "", value.strip(), flags=re.IGNORECASE)
    value = re.sub(r"^(die|der|das|den|ein|eine|einen|the|el|la|los|las|un|una|unos|unas|le|la|les|du|des|de|de la|de l)\s+", "", value.strip(), flags=re.IGNORECASE)
    return _clean_title(value)


def _split_plain_enumeration(text: str) -> list[dict]:
    source = text.strip().strip(" .!?;:")
    if not source or "," not in source:
        return []
    if LIST_VERB_RE.search(source) or SHOPPING_INTENT_RE.search(source):
        return []
    parts = [p.strip() for p in re.split(r",|\s+und\s+|\s+oder\s+|\s+and\s+|\s+y\s+|\s+e\s+|\s+et\s+|\s*&\s*", source, flags=re.IGNORECASE)]
    items = [_clean_title(part) for part in parts]
    items = [item for item in items if 1 < len(item) <= 80]
    if len(items) < 2:
        return []
    return [{"title": item, "project_name": SHOPPING_PROJECT_NAME, "section_name": None, "deadline": None, "reminder": None, "kind": "shopping"} for item in items]

NEGATED_ITEM_RE = re.compile(r"(?:doch\s+)?keine?n?\s+([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß -]{1,40})|(?:no|not|pas|sin)\s+([A-Za-zÀ-ÿÄÖÜäöüß][A-Za-zÀ-ÿÄÖÜäöüß -]{1,40})|([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß -]{1,40})\s+(?:brauchen wir nicht|lass(?:t)? (?:die|das|den)? ?weg|nicht)", re.IGNORECASE)
NON_SHOPPING_TASK_RE = re.compile(r"\b(zahnarzt|arzt|termin|duschen|marm|mom|mama|gehen|erinner|nachmittag|abend|morgen|teste|testen|test|danke|okay)\b", re.IGNORECASE)
FILLER_ONLY_RE = re.compile(
    r"^(?:äh+|ähm+|hm+|okay|ok|ja|jo|nein|nee|ne|no|non|pas|sin|doch|aber|also|ach ?ja|ach ?nee|bitte|danke)$",
    re.IGNORECASE,
)


def _is_filler_only(value: str) -> bool:
    clean = re.sub(r"[^A-Za-zÀ-ÿÄÖÜäöüß]+", "", value or "")
    return not clean or bool(FILLER_ONLY_RE.match(clean))


def _item_key(value: str) -> str:
    return re.sub(r"[^a-z0-9äöüß]+", "", value.lower())


def _candidate_key(candidate: dict) -> str:
    return _item_key(str(candidate.get("title") or ""))


def _keys_equivalent(left: str, right: str) -> bool:
    if left == right:
        return True
    if min(len(left), len(right)) < 4:
        return False
    return abs(len(left) - len(right)) <= 3 and (left.startswith(right) or right.startswith(left))


def _dedupe_normalized_candidates(candidates: list[dict]) -> list[dict]:
    result = []
    seen = []
    for candidate in candidates:
        key = _candidate_key(candidate)
        if not key or any(_keys_equivalent(key, existing) for existing in seen):
            continue
        seen.append(key)
        result.append(candidate)
    return result


def _parse_relative_temporal(value: str) -> tuple[str, bool] | None:
    raw = str(value or "").strip()
    clean = re.sub(r"\s+", " ", raw.lower())
    if not clean:
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", clean):
        try:
            parsed = datetime.fromisoformat(clean).astimezone()
            return parsed.isoformat(timespec="minutes"), False
        except ValueError:
            return None
    try:
        parsed = datetime.fromisoformat(clean.replace("Z", "+00:00"))
        return parsed.isoformat(timespec="minutes"), bool(re.search(r"[T ]\d{1,2}:\d{2}", raw))
    except ValueError:
        pass

    now = datetime.now().astimezone()
    days = None
    if "übermorgen" in clean or "uebermorgen" in clean or "day after tomorrow" in clean or "pasado mañana" in clean or "après-demain" in clean or "apres-demain" in clean:
        days = 2
    elif "morgen" in clean or "tomorrow" in clean or "mañana" in clean or "demain" in clean:
        days = 1
    elif "heute" in clean or "today" in clean or "hoy" in clean or "aujourd" in clean:
        days = 0
    if days is None:
        return None

    hour = 9
    minute = 0
    time_match = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(?:uhr|h)?\b", clean)
    if time_match:
        hour = int(time_match.group(1))
        minute = int(time_match.group(2) or 0)
    elif re.search(r"abend|evening|soir|noche", clean):
        hour = 19
    elif re.search(r"nachmittag|afternoon|tarde", clean):
        hour = 15
    elif re.search(r"mittag|noon|midi|mediod", clean):
        hour = 12
    elif re.search(r"morgen früh|früh|morning|matin|mañana", clean):
        hour = 9
    if hour > 23 or minute > 59:
        return None
    target = (now + timedelta(days=days)).replace(hour=hour, minute=minute, second=0, microsecond=0)
    return target.isoformat(timespec="minutes"), bool(time_match or re.search(r"abend|evening|soir|noche|nachmittag|afternoon|tarde|mittag|noon|midi|mediod|morgen früh|früh|morning|matin", clean))


def _temporal_has_explicit_time(value) -> bool:
    parsed_result = _parse_relative_temporal(str(value))
    return bool(parsed_result and parsed_result[1])


def _normalize_temporal_field(value, *, require_time: bool = False, transcript: str = "") -> str | None:
    if value in (None, ""):
        return None
    parsed_result = _parse_relative_temporal(str(value))
    if not parsed_result:
        return None
    parsed, has_explicit_time = parsed_result
    if re.search(r"abend|evening|soir|noche", transcript or "", re.IGNORECASE) and re.search(r"T23:59(?::00)?", parsed):
        parsed = re.sub(r"T23:59(?::00)?", "T19:00", parsed)
        has_explicit_time = True
    if require_time and not has_explicit_time:
        return None
    return parsed


def _negated_items(text: str) -> set[str]:
    result = set()
    for match in re.finditer(r"\b(?:but|aber|pero|mais)?\s*(?:not|no|sin|pas(?:\s+de)?)\s+([A-Za-zÀ-ÿÄÖÜäöüß][A-Za-zÀ-ÿÄÖÜäöüß -]{1,40})", text, re.IGNORECASE):
        item = _clean_shopping_title(match.group(1) or "")
        if item:
            result.add(_item_key(item))
    for match in NEGATED_ITEM_RE.finditer(text):
        item = _clean_shopping_title(match.group(1) or match.group(2) or match.group(3) or "")
        if item:
            result.add(_item_key(item))
    for match in re.finditer(r"\b(?:statt|anstatt|instead of)\s+([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß -]{1,40})", text, re.IGNORECASE):
        item = _clean_shopping_title(match.group(1) or "")
        if item:
            result.add(_item_key(item))
    return result


def _title_is_negated(title: str, text: str) -> bool:
    key = _item_key(title)
    if not key:
        return False
    if key in _negated_items(text):
        return True
    compact = re.sub(r"\s+", " ", text or "").strip()
    title_pattern = re.escape(str(title).strip())
    return bool(re.search(rf"\b{title_pattern}\b\s*(?:bitte\s*)?(?:nicht|weg|weglassen)", compact, re.IGNORECASE))


def _is_noise_candidate_title(title: str) -> bool:
    clean = re.sub(r"\s+", " ", str(title or "").strip().lower())
    if _is_filler_only(clean):
        return True
    return bool(re.fullmatch(r"(?:ähm?\s+)?(?:ja\s+)?(?:okay|ok)?\s*(?:danke)?\s*(?:ich\s+)?(?:teste|test)\s+(?:nur\s+)?(?:kurz|mal)?", clean))


def _split_shopping_phrase(value: str) -> list[str]:
    value = re.sub(r"(?:nee|nein)?\s*(?:doch\s+)?keine?n?\s+[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß -]{1,40}", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\b(?:but|aber|pero|mais)?\s*(?:not|no|sin|pas(?:\s+de)?)\s+[A-Za-zÀ-ÿÄÖÜäöüß][A-Za-zÀ-ÿÄÖÜäöüß -]{1,40}", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\b(ich|wir)\s+(?:brauche|brauchen|bräuchte|bräuchten|benötige|benötigen)\b", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\b(muss|müssen|noch|bitte|auch|danach|dafür|aber|ach ?ja|also|we|i|wir|ich|yo|nous|je|but|pero|mais)\b", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"\b(morgen|heute|tomorrow|today|mañana|demain|hoy)\b", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"\b\d{1,2}(?::\d{2})?\s*(?:uhr|h)?\b", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"\b(?:auf|in|für|zu)\s+(?:der|die|das)?\s*(?:einkaufsliste|shopping list)\b.*$", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\b(kaufen|besorgen|einkaufen|einkaufsliste|holen|setz(?:e)?|setze|pack(?:e)?|auf(?:\s+die)?(?:\s+einkaufsliste)?|liste|buy|need|needs|get|purchase|comprar|compro|necesito|necesitamos|acheter|achète|il faut|manque)\b", "", value, flags=re.IGNORECASE)
    parts = [p.strip() for p in re.split(r",|\s+und\s+|\s+oder\s+|\s+and\s+|\s+y\s+|\s+e\s+|\s+et\s+|\s*&\s*", value, flags=re.IGNORECASE)]
    result = []
    for part in parts:
        cleaned = _clean_shopping_title(part)
        if not (1 < len(cleaned) <= 80) or _is_filler_only(cleaned):
            continue
        if re.search(r"\b(keine|kein|nein|no|not|pas|sin|brauchen|muss|müssen|zahnarzt|morgen|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|abend|nachmittag|rechnung|zahlen|bezahlen|marm|mom|weg|lasst|reicht|statt)\b", cleaned, re.IGNORECASE):
            continue
        result.append(cleaned)
    return result


def _extract_shopping_candidates(text: str) -> list[dict]:
    negated = _negated_items(text)
    candidates = []
    seen = set()
    chunks = [chunk.strip() for chunk in re.split(r"[.!?;]+", text) if chunk.strip()]
    for chunk in chunks:
        is_plain_list = "," in chunk and not NON_SHOPPING_TASK_RE.search(chunk)
        is_shopping = bool(SHOPPING_INTENT_RE.search(chunk))
        if not is_plain_list and not is_shopping:
            continue
        phrase = chunk
        low_stock_match = re.search(r"(?:keine?n?\s+(.+?)\s+mehr|no queda\s+(.+)|out of\s+(.+)|(?:il manque|manque)\s+(.+)|(.+?)\s+(?:ist|sind|is|are)\s+(?:leer|empty|low))", chunk, re.IGNORECASE)
        if low_stock_match:
            phrase = next((group for group in low_stock_match.groups() if group), chunk)
        if is_shopping and not is_plain_list and phrase == chunk:
            match = re.search(r"(?:^|,|und|ach ?ja)\s*([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß -]{1,60}?)\s+(?:muss|müssen)?\s*(?:ich|wir)?\s*(?:noch\s+)?(?:kaufen|besorgen|einkaufen|holen|get|purchase|comprar|compro)\b", chunk, re.IGNORECASE)
            if match:
                phrase = match.group(1)
            else:
                match = re.search(r"(?:^|,|und|aber)\s*([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß -]{1,60}?)\s+(?:bräuchte|bräuchten|brauche|brauchen|benötige|benötigen)\s+(?:ich|wir)?\b", chunk, re.IGNORECASE)
                if match:
                    phrase = match.group(1)
                elif re.search(r"\b(?:brauche|brauchen|bräuchte|bräuchten|benötige|benötigen|need|needs|necesito|necesitamos)\b", chunk, re.IGNORECASE):
                    phrase = re.split(r"\b(?:brauche|brauchen|bräuchte|bräuchten|benötige|benötigen|need|needs|necesito|necesitamos)\b", chunk, flags=re.IGNORECASE)[-1]
                elif re.search(r"\b(?:buy|get|purchase|comprar|acheter|achète)\b", chunk, re.IGNORECASE):
                    phrase = re.split(r"\b(?:buy|get|purchase|comprar|acheter|achète)\b", chunk, flags=re.IGNORECASE)[-1]
        for item in _split_shopping_phrase(phrase):
            key = _item_key(item)
            if not key or key in negated or key in seen:
                continue
            seen.add(key)
            candidates.append({"title": item, "project_name": SHOPPING_PROJECT_NAME, "section_name": None, "deadline": None, "reminder": None, "kind": "shopping"})
    return candidates


def _find_shopping_project(workspace_context: dict | None) -> dict | None:
    projects = (workspace_context or {}).get("projects") or []
    for project in projects:
        name = str(project.get("name") or "")
        if re.search(r"einkauf|shopping|compras|courses", name, re.IGNORECASE):
            return project
    for project in projects:
        sections = " ".join(str(section) for section in project.get("sections") or [])
        if re.search(r"milch|dairy|lácteos|obst|fruit|fruta|gemüse|vegetable|verdura", sections, re.IGNORECASE):
            return project
    return None


def _route_workspace_candidate(candidate: dict, workspace_context: dict | None) -> dict:
    projects = (workspace_context or {}).get("projects") or []
    if not projects:
        return candidate
    routed = dict(candidate)
    project_name = str(routed.get("project_name") or "").strip()
    section_name = str(routed.get("section_name") or "").strip()
    project_names = {str(project.get("name") or "").lower(): project for project in projects}
    if project_name and project_name.lower() not in project_names:
        for project in projects:
            for section in project.get("sections") or []:
                section_str = str(section)
                if section_str.lower() == project_name.lower():
                    routed["project_name"] = project.get("name")
                    routed["section_name"] = section_str
                    return routed
    if project_name:
        project = project_names.get(project_name.lower())
        if project and section_name:
            known_sections = {str(section).lower() for section in project.get("sections") or []}
            if section_name.lower() not in known_sections:
                routed["section_name"] = None
                section_name = ""
        if project and not section_name:
            haystack = f"{routed.get('title') or ''} {project_name}"
            for section in project.get("sections") or []:
                section_str = str(section)
                if re.search(rf"\b{re.escape(section_str)}\b", haystack, re.IGNORECASE):
                    routed["section_name"] = section_str
                    return routed
    return routed


def _route_shopping_candidate(candidate: dict, workspace_context: dict | None) -> dict:
    if candidate.get("kind") != "shopping":
        return candidate
    project = _find_shopping_project(workspace_context)
    if not project:
        return candidate
    routed = dict(candidate)
    if not routed.get("project_name"):
        routed["project_name"] = project.get("name")
    title = str(routed.get("title") or "")
    sections = [str(section) for section in project.get("sections") or []]
    current_section = str(routed.get("section_name") or "").strip()
    if current_section and current_section.lower() not in {section.lower() for section in sections}:
        routed["section_name"] = None
    section_rules = [
        (r"milch|hafermilch|joghurt|käse|kaese|dairy|leche|lait", r"milch|dairy|lácteos|lacteos|lait"),
        (r"banane|banana|apfel|erdbeer|kartoffel|obst|gemüse|gemuese|fruit|fruta|verdura", r"obst|gemüse|gemuese|fruit|fruta|verdura|vegetable"),
        (r"tiefkühl|tiefkuehl|frozen", r"tiefkühl|tiefkuehl|frozen"),
        (r"cola|wasser|saft|bier|getränk|getraenk|drink", r"getränk|getraenk|drink"),
    ]
    for title_pattern, section_pattern in section_rules:
        if not re.search(title_pattern, title, re.IGNORECASE):
            continue
        for section in sections:
            if re.search(section_pattern, section, re.IGNORECASE):
                routed["section_name"] = section
                return routed
    return routed


def _normalize_llm_response_shape(parsed):
    if isinstance(parsed, list):
        return {"candidates": parsed}
    if not isinstance(parsed, dict):
        raise ValueError("LLM JSON response must be an object or array")
    if isinstance(parsed.get("candidates"), list):
        return parsed
    if any(parsed.get(key) for key in ("title", "task", "text", "item", "name")):
        return {"candidates": [parsed]}
    for key in ("todos", "tasks", "items", "todo_candidates"):
        if isinstance(parsed.get(key), list):
            result = dict(parsed)
            result["candidates"] = parsed[key]
            return result
    return parsed


def _strip_json_comments(value: str) -> str:
    value = re.sub(r"(?m)^\s*//.*$", "", value)
    value = re.sub(r"/\*.*?\*/", "", value, flags=re.DOTALL)
    return value


def _json_loads_lenient(value: str):
    attempts = [value]
    stripped = _strip_json_comments(value)
    if stripped != value:
        attempts.append(stripped)
    no_trailing_commas = re.sub(r",\s*([}\]])", r"\1", stripped)
    if no_trailing_commas not in attempts:
        attempts.append(no_trailing_commas)
    last_error = None
    for attempt in attempts:
        try:
            return json.loads(attempt)
        except json.JSONDecodeError as exc:
            last_error = exc
    try:
        return ast.literal_eval(no_trailing_commas)
    except (SyntaxError, ValueError) as exc:
        last_error = exc
    raise last_error or ValueError("invalid JSON")


def _extract_llm_message_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("content") or item.get("value")
                if text:
                    parts.append(str(text))
        return "\n".join(parts)
    return str(content or "")


def _parse_llm_json_content(content) -> dict:
    """Parse OpenAI-compatible LLM content, tolerating common local-model JSON variants."""
    raw = _extract_llm_message_text(content).strip()
    if not raw:
        raise ValueError("LLM response was empty")
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw, flags=re.IGNORECASE)
    candidates = [raw]
    if fenced:
        candidates.insert(0, fenced.group(1).strip())
    for open_char, close_char in (("{", "}"), ("[", "]")):
        first = raw.find(open_char)
        last = raw.rfind(close_char)
        if first != -1 and last > first:
            candidates.append(raw[first:last + 1])
    last_error = None
    for candidate in candidates:
        try:
            return _normalize_llm_response_shape(_json_loads_lenient(candidate))
        except (json.JSONDecodeError, ValueError) as exc:
            last_error = exc
            continue
    raise ValueError(f"Could not parse LLM JSON response: {last_error}")


def _normalize_braindump_json(parsed: dict, transcript: str, workspace_context: dict | None = None) -> dict:
    try:
        parsed = _normalize_llm_response_shape(parsed)
    except ValueError:
        parsed = {}
    candidates = parsed.get("candidates") if isinstance(parsed, dict) else None
    if not isinstance(candidates, list):
        candidates = []
    negated = _negated_items(transcript)
    normalized = []
    for candidate in candidates:
        if isinstance(candidate, str):
            candidate = {"title": candidate}
        if not isinstance(candidate, dict):
            continue
        title = str(candidate.get("title") or candidate.get("task") or candidate.get("text") or candidate.get("item") or candidate.get("name") or "").strip()
        if not title:
            continue
        title = _clean_title(title)
        if _is_filler_only(title) or _is_noise_candidate_title(title):
            continue
        if len(title) > 30 and (',' in title or ' und ' in title.lower() or ' or ' in title.lower()):
            continue
        project_name = candidate.get("project_name") or candidate.get("projectName")
        kind = str(candidate.get("kind") or candidate.get("type") or "todo").strip().lower()
        if kind in {"task", "action", "todo_item"}:
            kind = "todo"
        elif kind in {"grocery", "groceries", "buy", "purchase"}:
            kind = "shopping"
        if SHOPPING_INTENT_RE.search(title) or kind == "shopping":
            # kind=shopping is a semantic signal. Keep project/section names
            # when the LLM mapped them to explicit workspace context.
            kind = "shopping"
            title = _clean_shopping_title(title)
            key = _item_key(title)
            if not key or key in negated or _title_is_negated(title, transcript):
                continue
        deadline_source = candidate.get("deadline") or candidate.get("due") or candidate.get("due_date") or candidate.get("dueDate")
        reminder_source = candidate.get("reminder") or candidate.get("remind_at") or candidate.get("reminder_at") or candidate.get("remindAt") or candidate.get("reminderAt")
        deadline = _normalize_temporal_field(deadline_source, transcript=transcript)
        reminder = _normalize_temporal_field(reminder_source, require_time=True, transcript=transcript)
        if deadline and (reminder_source or kind == "reminder") and not reminder and _temporal_has_explicit_time(deadline_source):
            reminder = deadline
        normalized.append(_route_workspace_candidate(_route_shopping_candidate({
            "title": title,
            "project_name": project_name or candidate.get("project"),
            "section_name": candidate.get("section_name") or candidate.get("sectionName") or candidate.get("section"),
            "deadline": deadline,
            "reminder": reminder,
            "kind": kind,
        }, workspace_context), workspace_context))
    normalized = _dedupe_normalized_candidates(normalized)
    transcript_lower = transcript.lower().strip()
    if len(normalized) == 1:
        raw = normalized[0]["title"]
        if ("," in raw or " und " in raw.lower() or " or " in raw.lower() or raw.lower().startswith("buy ")) and len(raw) > 30:
            split = _split_plain_enumeration(transcript)
            if split:
                return {"candidates": split}
    if not normalized and ("," in transcript or " und " in transcript_lower):
        split = _split_plain_enumeration(transcript)
        if split:
            return {"candidates": split}
    # Deterministic safety net: do not let the LLM drop obvious shopping items
    # from raw list clauses like "Ich brauche Kartoffeln, Salat, Chips".
    shopping = _extract_shopping_candidates(transcript)
    existing = {_item_key(item.get("title", "")) for item in normalized if item.get("kind") == "shopping"}
    for item in shopping:
        if _title_is_negated(item["title"], transcript):
            continue
        if _item_key(item["title"]) not in existing:
            normalized.append(_route_workspace_candidate(_route_shopping_candidate(item, workspace_context), workspace_context))
            existing.add(_item_key(item["title"]))
    return {"candidates": _dedupe_normalized_candidates(normalized)}


class TextSegmentRequest(BaseModel):
    text: str
    final: bool = True


class BrainDumpTodoCandidate(BaseModel):
    title: str
    notes: str = ""
    project_name: str | None = None
    section_name: str | None = None
    deadline: str | None = None
    reminder: str | None = None
    kind: str = "todo"


class BrainDumpCreateTodosRequest(BaseModel):
    candidates: list[BrainDumpTodoCandidate]


class BrainDumpExtractRequest(BaseModel):
    transcript: str
    segment_id: int
    audio_start_ms: int = 0
    audio_end_ms: int = 0


def _run(cmd: list[str]) -> tuple[float, subprocess.CompletedProcess[str]]:
    started = time.perf_counter()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    elapsed_ms = (time.perf_counter() - started) * 1000
    return elapsed_ms, proc


def _load_local_openclaw_token() -> str | None:
    path = Path.home() / ".openclaw" / "openclaw.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text()).get("gateway", {}).get("auth", {}).get("token")
    except Exception:
        return None


def _convert_audio_to_wav(source: Path, target: Path) -> float:
    elapsed_ms, proc = _run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source),
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        str(target),
    ])
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "ffmpeg conversion failed")
    return elapsed_ms


def _transcribe_wav(wav: Path, model_name: str) -> tuple[float, str]:
    model = WHISPER_MODELS.get(model_name) or WHISPER_MODELS["base"]
    if not model.exists():
        raise RuntimeError(f"Whisper model missing: {model}")
    elapsed_ms, proc = _run([
        "whisper-cli",
        "-m", str(model),
        "-l", "auto",
        "-nt",
        "-np",
        "-mc", "0",
        "-t", "4",
        "-bo", "1",
        "-bs", "1",
        "-nf",
        str(wav),
    ])
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "whisper-cli failed")
    return elapsed_ms, " ".join(proc.stdout.split())


def _build_multipart_form_data(fields: dict[str, str], files: dict[str, tuple[str, bytes, str]]) -> tuple[bytes, str]:
    boundary = f"----nia-todo-braindump-{int(time.time() * 1000)}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        chunks.append(str(value).encode("utf-8"))
        chunks.append(b"\r\n")
    for name, (filename, content, content_type) in files.items():
        safe_filename = filename.replace('"', "")
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(
            f'Content-Disposition: form-data; name="{name}"; filename="{safe_filename}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n".encode("utf-8")
        )
        chunks.append(content)
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _extract_transcript_from_stt_response(body: bytes, content_type: str) -> str:
    text = body.decode("utf-8", errors="replace")
    if "json" not in content_type.lower():
        return " ".join(text.split())
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"STT returned invalid JSON: {exc}") from exc
    transcript = payload.get("text") if isinstance(payload, dict) else None
    if not isinstance(transcript, str):
        raise RuntimeError("STT response is missing text")
    return " ".join(transcript.split())


def _transcribe_remote_whisper(audio: bytes, filename: str, content_type: str, config: dict) -> tuple[float, str]:
    stt_url = str(config.get("stt_url") or "").strip()
    if not stt_url:
        raise RuntimeError("BrainDump STT URL is not configured")
    fields = {
        "response_format": "json",
        "temperature": "0.0",
        "temperature_inc": "0.0",
    }
    language = str(config.get("stt_language") or "").strip()
    if language:
        fields["language"] = language
    body, multipart_type = _build_multipart_form_data(fields, {"file": (filename, audio, content_type)})
    headers = {"Content-Type": multipart_type}
    stt_token = str(config.get("stt_token") or "").strip()
    if stt_token:
        headers["Authorization"] = f"Bearer {stt_token}"
    req = urllib.request.Request(stt_url, data=body, headers=headers, method="POST")
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=float(config.get("stt_timeout_seconds") or 60)) as response:
            response_body = response.read()
            response_type = response.headers.get("content-type", "")
    except Exception as exc:
        raise RuntimeError(f"remote STT request failed: {exc}") from exc
    elapsed_ms = (time.perf_counter() - started) * 1000
    return elapsed_ms, _extract_transcript_from_stt_response(response_body, response_type)



def _accessible_project_rows(db, user_id: int, *, limit: int | None = None):
    limit_sql = f"LIMIT {int(limit)}" if limit else ""
    return db.execute(
        f"""
        SELECT p.id, p.name, COALESCE(p.is_inbox, 0) AS is_inbox,
               p.parent_id, p.workspace_id, w.name AS workspace_name
        FROM projects p
        LEFT JOIN workspaces w ON w.id = p.workspace_id
        LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ? AND pm.status = 'accepted'
        WHERE p.user_id = ? OR pm.id IS NOT NULL
        ORDER BY COALESCE(p.is_inbox, 0) DESC, p.sort_order, p.id
        {limit_sql}
        """,
        (user_id, user_id),
    ).fetchall()


def _load_braindump_workspace_context(db, user_id: int) -> dict:
    """Return a compact routing context for the BrainDump LLM.

    The extractor must not know hard-coded project names. It gets the user's
    actual structure and may choose exact names from it when the fit is clear.
    """
    projects = _accessible_project_rows(db, user_id, limit=40)
    project_ids = [row["id"] for row in projects]
    sections_by_project: dict[int, list[str]] = {pid: [] for pid in project_ids}
    if project_ids:
        placeholders = ",".join("?" for _ in project_ids)
        sections = db.execute(
            f"""
            SELECT project_id, name
            FROM sections
            WHERE project_id IN ({placeholders})
            ORDER BY sort_order, id
            LIMIT 320
            """,
            project_ids,
        ).fetchall()
        for section in sections:
            sections_by_project.setdefault(section["project_id"], []).append(section["name"])
    return {
        "projects": [
            {
                "name": row["name"],
                "workspace": row["workspace_name"],
                "is_inbox": bool(row["is_inbox"]),
                "sections": sections_by_project.get(row["id"], []),
            }
            for row in projects
        ]
    }


def _format_workspace_context(context: dict | None) -> str:
    projects = (context or {}).get("projects") or []
    if not projects:
        return "Workspace: none. Use project_name=null and section_name=null unless explicitly obvious."
    lines = ["Workspace: use only these exact project/section names when clearly fitting:"]
    for project in projects[:40]:
        label = str(project.get("name") or "")[:80]
        sections = [str(section)[:60] for section in (project.get("sections") or [])[:8]]
        if sections:
            label += " | sections: " + ", ".join(sections)
        lines.append(f"- {label}")
    text = "\n".join(lines)
    if len(text) > 4000:
        return text[:3990].rstrip() + "\n- ..."
    return text


def _name_key(value: str | None) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def _resolve_project_id(db, user_id: int, project_name: str | None) -> int | None:
    if not project_name:
        return get_user_inbox_project_id(db, user_id)
    rows = _accessible_project_rows(db, user_id)
    matches = [row for row in rows if _name_key(row["name"]) == _name_key(project_name)]
    if len(matches) != 1:
        raise HTTPException(422, f"BrainDump project not found: {project_name}")
    return matches[0]["id"]


def _resolve_unique_section_target(db, user_id: int, section_name: str | None) -> tuple[int | None, int | None]:
    if not section_name:
        return None, None
    projects = _accessible_project_rows(db, user_id)
    project_ids = [row["id"] for row in projects]
    if not project_ids:
        return None, None
    placeholders = ",".join("?" for _ in project_ids)
    rows = db.execute(
        f"SELECT id, project_id, name FROM sections WHERE project_id IN ({placeholders})",
        project_ids,
    ).fetchall()
    matches = [row for row in rows if _name_key(row["name"]) == _name_key(section_name)]
    if len(matches) != 1:
        return None, None
    return matches[0]["project_id"], matches[0]["id"]


def _resolve_section_id(db, project_id: int | None, section_name: str | None) -> int | None:
    if not section_name:
        return None
    if project_id is None:
        raise HTTPException(422, "BrainDump section requires a project")
    rows = db.execute("SELECT id, name FROM sections WHERE project_id = ?", (project_id,)).fetchall()
    matches = [row for row in rows if _name_key(row["name"]) == _name_key(section_name)]
    if len(matches) != 1:
        raise HTTPException(422, f"BrainDump section not found: {section_name}")
    return matches[0]["id"]


def _create_todos_from_braindump_candidates(db, user_id: int, candidates: list[BrainDumpTodoCandidate]) -> list[dict]:
    if not candidates:
        raise HTTPException(422, "No BrainDump candidates selected")
    if len(candidates) > 50:
        raise HTTPException(422, "Too many BrainDump candidates")
    created = []
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    for candidate in candidates:
        title = sanitize_text(candidate.title)
        notes = sanitize_text(candidate.notes or "")
        if not title:
            raise HTTPException(422, "BrainDump candidate title is required")
        project_name = candidate.project_name
        section_name = candidate.section_name
        unique_section_project_id = None
        unique_section_id = None
        if section_name:
            unique_section_project_id, unique_section_id = _resolve_unique_section_target(db, user_id, section_name)
        if not project_name and unique_section_project_id:
            project_id = unique_section_project_id
            section_id = unique_section_id
        else:
            project_id = _resolve_project_id(db, user_id, project_name)
            section_id = _resolve_section_id(db, project_id, section_name)
        data = TodoCreate(
            title=title,
            description=notes,
            priority=3,
            status="pending",
            project_id=project_id,
            section_id=section_id,
            due_date=candidate.deadline,
            remind_at=candidate.reminder,
        )
        _validate_todo_dates(data)
        _validate_todo_status(data.status)
        _validate_todo_target(db, data.project_id, data.section_id, user_id)
        cursor = db.execute(
            """INSERT INTO todos
               (title, description, priority, is_pinned, status, project_id, section_id, due_date, completed_at, updated_at, user_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (data.title, data.description, data.priority, int(bool(data.is_pinned)), data.status, data.project_id, data.section_id, data.due_date, None, now, user_id),
        )
        todo_id = cursor.lastrowid
        if data.remind_at:
            db.execute("INSERT INTO reminders (todo_id, remind_at, user_id) VALUES (?,?,?)", (todo_id, data.remind_at, user_id))
        todo = fetch_todo(db, todo_id, user_id)
        if todo:
            created.append(todo)
    return created


def _is_local_openclaw_base_url(base_url: str) -> bool:
    parsed = urlparse(str(base_url or ""))
    return parsed.hostname in {"127.0.0.1", "localhost"} and parsed.port == 18789




def _post_llm_chat(payload: dict, headers: dict[str, str], config: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        llm_chat_url(config),
        data=body,
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=float(config.get("llm_timeout_seconds") or 180)) as response:
        return json.loads(response.read().decode("utf-8"))


def _llm_request_payload(payload: dict, config: dict) -> dict:
    provider = str(config.get("llm_provider") or "openai_compatible").strip().lower()
    if provider == "ollama":
        return {
            "model": payload["model"],
            "messages": payload["messages"],
            "stream": False,
            "options": {"temperature": payload.get("temperature", 0)},
        }
    return payload


def _llm_response_content(result: dict, config: dict) -> str:
    provider = str(config.get("llm_provider") or "openai_compatible").strip().lower()
    if provider == "ollama":
        return str(result.get("message", {}).get("content") or "")
    return result["choices"][0]["message"].get("content", "")

def _extract_with_llm(text: str, segment_id: int, workspace_context: dict | None = None, config: dict | None = None) -> tuple[float, dict, dict | None, str]:
    config = config or get_braindump_config(include_secrets=True)
    base_url = str(config.get("llm_base_url") or "").strip()
    token = str(config.get("llm_api_key") or "").strip()
    if not token and _is_local_openclaw_base_url(base_url):
        token = _load_local_openclaw_token() or ""
    system_prompt = build_effective_system_prompt(config)
    current_datetime = datetime.now().astimezone().isoformat(timespec="minutes")
    user_content = f"Current datetime: {current_datetime}\n\n{_format_workspace_context(workspace_context)}\n\nTranscript:\n{text}"
    model_name = str(config.get("llm_model") or "").strip()
    if not model_name:
        raise RuntimeError("BrainDump LLM model is not configured")
    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0,
        "stream": False,
        "max_tokens": 500,
        "user": f"nia-todo-live-braindump-{segment_id}-{int(time.time() * 1000)}",
    }
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    headers.update(parse_extra_headers(str(config.get("llm_extra_headers_json") or "")))
    request_payload = _llm_request_payload(payload, config)
    started = time.perf_counter()
    try:
        result = _post_llm_chat(request_payload, headers, config)
    except urllib.error.HTTPError as exc:
        if exc.code not in {400, 422} or "user" not in request_payload:
            raise
        request_payload = dict(request_payload)
        request_payload.pop("user", None)
        result = _post_llm_chat(request_payload, headers, config)
    elapsed_ms = (time.perf_counter() - started) * 1000
    content = _llm_response_content(result, config)
    parsed = _normalize_braindump_json(_parse_llm_json_content(content), text, workspace_context)
    return elapsed_ms, parsed, result.get("usage"), json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))


# Backward-compatible alias for older validation/probe scripts.
_extract_with_openclaw = _extract_with_llm


def require_braindump_access(user_id: int):
    config = get_braindump_config(include_secrets=True)
    if not config.get("enabled"):
        raise HTTPException(403, "BrainDump experimental feature is disabled")
    with get_db() as db:
        try:
            ensure_braindump_enabled(db, user_id)
        except PermissionError as exc:
            if str(exc) == "user_not_found":
                raise HTTPException(404, "User not found")
            raise HTTPException(403, "BrainDump is not enabled for this user")


@router.get("/access")
def get_braindump_access(user_id: int = Depends(require_auth)):
    try:
        require_braindump_access(user_id)
        enabled = True
    except HTTPException as exc:
        if exc.status_code == 403:
            enabled = False
        else:
            raise
    return {"enabled": enabled}


def _transcribe_live_audio_bytes(audio_bytes: bytes, content_type: str, segment_id: int, model: str, config: dict) -> tuple[float, float, str, str]:
    stt_provider = str(config.get("stt_provider") or "whisper_cpp_remote").strip().lower()
    if stt_provider not in {"whisper_cpp_remote", "local_whisper_cpp"}:
        raise RuntimeError(f"Unsupported BrainDump STT provider: {stt_provider}")
    if stt_provider == "local_whisper_cpp" and model not in WHISPER_MODELS:
        raise ValueError("Unsupported BrainDump STT model")
    if len(audio_bytes) < 1200:
        raise RuntimeError("audio segment too small")
    suffix = ".webm" if "webm" in content_type else ".ogg" if "ogg" in content_type else ".audio"
    if stt_provider == "whisper_cpp_remote":
        stt_ms, transcript = _transcribe_remote_whisper(audio_bytes, f"segment-{segment_id}{suffix}", content_type or "application/octet-stream", config)
        return 0.0, stt_ms, transcript, stt_provider
    with tempfile.TemporaryDirectory(prefix="nia-braindump-live-") as tmp:
        tmpdir = Path(tmp)
        raw_path = tmpdir / f"segment-{segment_id}{suffix}"
        wav_path = tmpdir / f"segment-{segment_id}.wav"
        raw_path.write_bytes(audio_bytes)
        convert_ms = _convert_audio_to_wav(raw_path, wav_path)
        stt_ms, transcript = _transcribe_wav(wav_path, model)
        return convert_ms, stt_ms, transcript, stt_provider


@router.post("/live/audio-segment/transcribe")
async def transcribe_live_audio_segment(
    request: Request,
    segment_id: int = Query(...),
    audio_start_ms: int = Query(0),
    audio_end_ms: int = Query(0),
    model: str = Query("base"),
    user_id: int = Depends(require_auth),
):
    """Transcribe one live BrainDump audio window. LLM extraction is a separate step."""
    require_braindump_access(user_id)
    config = get_braindump_config(include_secrets=True)
    received_at = time.perf_counter()
    content_type = request.headers.get("content-type", "")
    audio_bytes = await request.body()
    try:
        convert_ms, stt_ms, transcript, stt_provider = await asyncio.to_thread(
            _transcribe_live_audio_bytes, audio_bytes, content_type, segment_id, model, config
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(500, f"BrainDump transcription failed: {exc}")
    total_ms = (time.perf_counter() - received_at) * 1000
    return {
        "segment_id": segment_id,
        "audio_start_ms": audio_start_ms,
        "audio_end_ms": audio_end_ms,
        "model": model,
        "stt_provider": stt_provider,
        "transcript": transcript,
        "timing": {
            "convert_ms": round(convert_ms, 2),
            "stt_ms": round(stt_ms, 2),
            "total_ms": round(total_ms, 2),
        },
    }


@router.post("/live/text-segment/extract")
async def extract_live_text_segment(data: BrainDumpExtractRequest, user_id: int = Depends(require_auth)):
    """Extract BrainDump candidates from a transcript returned by the STT step."""
    require_braindump_access(user_id)
    transcript = sanitize_text(data.transcript)
    if not transcript:
        raise HTTPException(422, "BrainDump transcript is required")
    config = get_braindump_config(include_secrets=True)
    received_at = time.perf_counter()
    with get_db() as db:
        workspace_context = _load_braindump_workspace_context(db, user_id)
    try:
        llm_ms, parsed, usage, raw_json = await asyncio.to_thread(
            _extract_with_llm, transcript, data.segment_id, workspace_context, config
        )
    except Exception as exc:
        raise HTTPException(500, f"BrainDump extraction failed: {exc}")
    total_ms = (time.perf_counter() - received_at) * 1000
    return {
        "segment_id": data.segment_id,
        "audio_start_ms": data.audio_start_ms,
        "audio_end_ms": data.audio_end_ms,
        "transcript": transcript,
        "json": parsed,
        "raw_json": raw_json,
        "usage": usage,
        "timing": {
            "llm_ms": round(llm_ms, 2),
            "total_ms": round(total_ms, 2),
        },
    }


@router.post("/live/audio-segment")
async def process_live_audio_segment(
    request: Request,
    segment_id: int = Query(...),
    audio_start_ms: int = Query(0),
    audio_end_ms: int = Query(0),
    model: str = Query("base"),
    user_id: int = Depends(require_auth),
):
    """Backward-compatible combined live endpoint: transcribe, then extract."""
    require_braindump_access(user_id)
    config = get_braindump_config(include_secrets=True)
    received_at = time.perf_counter()
    content_type = request.headers.get("content-type", "")
    audio_bytes = await request.body()
    with get_db() as db:
        workspace_context = _load_braindump_workspace_context(db, user_id)
    try:
        convert_ms, stt_ms, transcript, stt_provider = await asyncio.to_thread(
            _transcribe_live_audio_bytes, audio_bytes, content_type, segment_id, model, config
        )
        llm_ms, parsed, usage, raw_json = await asyncio.to_thread(
            _extract_with_llm, transcript, segment_id, workspace_context, config
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(500, f"BrainDump live segment failed: {exc}")
    total_ms = (time.perf_counter() - received_at) * 1000
    return {
        "segment_id": segment_id,
        "audio_start_ms": audio_start_ms,
        "audio_end_ms": audio_end_ms,
        "model": model,
        "stt_provider": stt_provider,
        "transcript": transcript,
        "json": parsed,
        "raw_json": raw_json,
        "usage": usage,
        "timing": {
            "convert_ms": round(convert_ms, 2),
            "stt_ms": round(stt_ms, 2),
            "llm_ms": round(llm_ms, 2),
            "total_ms": round(total_ms, 2),
        },
    }


@router.post("/todos")
async def create_todos_from_braindump(data: BrainDumpCreateTodosRequest, user_id: int = Depends(require_auth)):
    """Create real todos from user-confirmed BrainDump candidates."""
    require_braindump_access(user_id)
    with get_db() as db:
        created = _create_todos_from_braindump_candidates(db, user_id, data.candidates)
        db.commit()
    for todo in created:
        await broadcast_change("todo_create", todo, user_id, todo.get("project_id"))
    return {"todos": created}


@router.post("/sessions")
def create_braindump_session(user_id: int = Depends(require_auth)):
    require_braindump_access(user_id)
    return create_session(user_id).to_dict()


@router.get("/sessions/{session_id}")
def get_braindump_session(session_id: str, user_id: int = Depends(require_auth)):
    require_braindump_access(user_id)
    try:
        return get_session(session_id, user_id).to_dict()
    except KeyError:
        raise HTTPException(404, "BrainDump session not found")


@router.post("/sessions/{session_id}/segments/text")
def add_braindump_text_segment(session_id: str, data: TextSegmentRequest, user_id: int = Depends(require_auth)):
    require_braindump_access(user_id)
    text = sanitize_text(data.text)
    try:
        return append_text_segment(session_id, user_id, text, data.final).to_dict()
    except KeyError:
        raise HTTPException(404, "BrainDump session not found")
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@router.post("/sessions/{session_id}/finalize")
def finalize_braindump_session(session_id: str, user_id: int = Depends(require_auth)):
    require_braindump_access(user_id)
    try:
        return finalize_session(session_id, user_id).to_dict()
    except KeyError:
        raise HTTPException(404, "BrainDump session not found")
