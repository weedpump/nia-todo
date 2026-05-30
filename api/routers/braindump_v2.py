"""BrainDump v2 text/session/live-debug endpoints."""

from __future__ import annotations

import asyncio
import json
import os
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

OPENCLAW_CHAT_URL = "http://127.0.0.1:18789/v1/chat/completions"
BRAINDUMP_STT_PROVIDER = os.getenv("NIA_TODO_STT_PROVIDER", "whisper_cpp_remote")
BRAINDUMP_STT_URL = os.getenv("NIA_TODO_STT_URL", "http://127.0.0.1:8766/inference")
BRAINDUMP_STT_TOKEN = os.getenv("NIA_TODO_STT_TOKEN")
BRAINDUMP_STT_LANGUAGE = os.getenv("NIA_TODO_STT_LANGUAGE", "de")
BRAINDUMP_STT_TIMEOUT_SECONDS = float(os.getenv("NIA_TODO_STT_TIMEOUT_SECONDS", "60"))
WHISPER_MODELS = {
    "base": Path("/opt/whisper.cpp/models/ggml-base.bin"),
    "small": Path("/opt/whisper.cpp/models/ggml-small.bin"),
}
SHOPPING_PROJECT_NAME = None  # kind=shopping is resolved to the user's configured shopping list later.

BRAINDUMP_EXTRACTOR_PROMPT = """You are the BrainDump extractor for nia-todo.
Your job is to turn a messy spoken thought stream into useful action items and route them into the user's existing todo structure.
This is not dictation. It is interpretation and lightweight planning.

Return ONLY compact valid JSON in exactly this form:
{"candidates":[{"title":"...","project_name":null,"section_name":null,"deadline":null,"reminder":null,"kind":"todo"}]}

Core behavior:
- Detect the user's intent, not the surface words.
- Convert spoken thoughts into concrete, useful todos.
- Split unrelated items into separate candidates.
- Merge trivial wording variants into one sensible task.
- Keep the natural language of the user/transcript.
- Do not force German or English.
- If the transcript is ambiguous, prefer the safest useful interpretation.
- If the user corrects themselves, the latest correction wins.
- If the user negates or removes an item, exclude it.
- Ignore filler, self-talk, meta talk, thanks, and system discussion.
- Use the provided workspace context. It contains the user's current projects and sections.
- Do not assume built-in project names. There is no universal "shopping list".
- If an existing project or section clearly fits, set project_name and/or section_name to the exact existing name.
- If no existing project/section clearly fits, leave it null. Do not invent names.
- Prefer context-aware routing over generic categories. Example: if project "Stamps" exists and the user talks about stamp albums, route there.
- If sections like "Fruit", "Vegetables", "Dairy" exist, route individual matching items to the right section.

Task types:
- todo: normal actionable task.
- shopping: anything that is about buying/obtaining items. This is an internal semantic signal, not a project name.
- reminder: explicit reminder or timed follow-up.
- appointment: calendar-like event/action.
- note: useful captured note that is not yet actionable.

Shopping rules:
- Detect shopping intent even if the user says it indirectly.
- Output shopping items individually.
- Do not copy the whole spoken sentence as a shopping task.
- Set kind="shopping" for shopping items.
- If workspace context contains a clearly matching project/section for shopping items, use it.
- If no matching project/section exists, leave project_name and section_name null.

Time rules:
- Detect relative and absolute times, including phrases like tomorrow, tonight, this evening, morgen, übermorgen Abend, demain, mañana, etc.
- deadline and reminder must be ISO-8601 datetime strings when possible, e.g. "2026-05-29T19:00:00+02:00".
- reminder is a date/time field: never output raw natural-language phrases like "übermorgen Abend" as reminder. Use ISO datetime or null.
- If a specific or inferable time is mentioned, include it in deadline and/or reminder.
- For appointments, create a concrete task like "Go to the dentist" / "Zum Zahnarzt gehen".

Quality rules:
- Prefer useful and concise titles.
- Do not transcribe the audio.
- Do not invent extra items.
- Do not over-summarize a list into one mega task.
- Do not lose items just because the sentence is messy.
- Do not output anything outside JSON.

Examples without workspace context:
Transcript: "I need potatoes, strawberries, chips, actually no chips, but coconut milk."
JSON: {"candidates":[{"title":"potatoes","project_name":null,"section_name":null,"deadline":null,"reminder":null,"kind":"shopping"},{"title":"strawberries","project_name":null,"section_name":null,"deadline":null,"reminder":null,"kind":"shopping"},{"title":"coconut milk","project_name":null,"section_name":null,"deadline":null,"reminder":null,"kind":"shopping"}]}
Transcript: "Ich muss duschen. Erinnere mich morgen daran, dass ich um 15 Uhr zum Zahnarzt muss. Ach ja, wir müssen noch Honig kaufen."
JSON: {"candidates":[{"title":"Duschen","project_name":null,"section_name":null,"deadline":null,"reminder":null,"kind":"todo"},{"title":"Zum Zahnarzt gehen","project_name":null,"section_name":null,"deadline":"morgen 15:00","reminder":"morgen 15:00","kind":"todo"},{"title":"Honig","project_name":null,"section_name":null,"deadline":null,"reminder":null,"kind":"shopping"}]}
"""



LIST_VERB_RE = re.compile(r"\b(muss|soll|erinnere|erinnern|vorbereiten|aufräumen|entsorgen|bestellen|machen|erledigen|kaufen|besorgen|einkaufen)\b", re.IGNORECASE)
SHOPPING_INTENT_RE = re.compile(r"\b(kaufen|besorgen|einkaufen|einkaufsliste|shopping list|brauche|brauchen|bräuchte|bräuchten|benötige|benötigen|holen|buy|need|needs|get|purchase|comprar|compro|necesito|acheter|achète|acheterai|courses)\b", re.IGNORECASE)


def _clean_title(value: str) -> str:
    value = re.sub(r"^(ich brauche|ich benötige|bitte|noch)\s+", "", value.strip(), flags=re.IGNORECASE)
    value = re.sub(r"\b(meiner|meine|der)\s+(marm|mam)\b", lambda m: f"{m.group(1)} Mama", value, flags=re.IGNORECASE)
    value = re.sub(r"\bMarm\b", "Mama", value)
    value = value.strip(" .,:;!?-–—\t\n\r")
    return value[:1].upper() + value[1:] if value else ""


def _clean_shopping_title(value: str) -> str:
    value = re.sub(r"\b(kaufen|besorgen|einkaufen|holen|buy|need|needs|get|purchase|comprar|compro|necesito|acheter|achète)\b", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\b(nicht|not)\b", "", value, flags=re.IGNORECASE)
    value = re.sub(r"^(wir müssen|ich muss|muss|bitte|noch|also we|we|i|je|nous|yo)\s+", "", value.strip(), flags=re.IGNORECASE)
    value = re.sub(r"^(die|der|das|den|ein|eine|einen|the|el|la|los|las|le|les)\s+", "", value.strip(), flags=re.IGNORECASE)
    return _clean_title(value)


def _split_plain_enumeration(text: str) -> list[dict]:
    source = text.strip().strip(" .!?;:")
    if not source or "," not in source:
        return []
    if LIST_VERB_RE.search(source):
        return []
    parts = [p.strip() for p in re.split(r",|\s+und\s+|\s+oder\s+|\s+and\s+|\s+y\s+|\s+e\s+|\s+et\s+|\s*&\s*", source, flags=re.IGNORECASE)]
    items = [_clean_title(part) for part in parts]
    items = [item for item in items if 1 < len(item) <= 80]
    if len(items) < 2:
        return []
    return [{"title": item, "project_name": SHOPPING_PROJECT_NAME, "section_name": None, "deadline": None, "reminder": None, "kind": "shopping"} for item in items]

NEGATED_ITEM_RE = re.compile(r"(?:doch\s+)?keine?n?\s+([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß -]{1,40})|(?:no|not|pas|sin)\s+([A-Za-zÀ-ÿÄÖÜäöüß][A-Za-zÀ-ÿÄÖÜäöüß -]{1,40})|([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß -]{1,40})\s+(?:brauchen wir nicht|lass(?:t)? (?:die|das|den)? ?weg|nicht|not)", re.IGNORECASE)
NON_SHOPPING_TASK_RE = re.compile(r"\b(zahnarzt|arzt|termin|duschen|marm|mom|mama|gehen|erinner|nachmittag|abend|morgen)\b", re.IGNORECASE)
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


def _parse_relative_temporal(value: str) -> str | None:
    clean = re.sub(r"\s+", " ", str(value or "").strip().lower())
    if not clean:
        return None
    try:
        parsed = datetime.fromisoformat(clean.replace("Z", "+00:00"))
        return parsed.isoformat(timespec="minutes")
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
    return target.isoformat(timespec="minutes")


def _normalize_temporal_field(value, *, require_time: bool = False) -> str | None:
    if value in (None, ""):
        return None
    parsed = _parse_relative_temporal(str(value))
    if not parsed:
        return None
    if require_time and "T" not in parsed:
        return None
    return parsed


def _negated_items(text: str) -> set[str]:
    result = set()
    for match in NEGATED_ITEM_RE.finditer(text):
        item = _clean_shopping_title(match.group(1) or match.group(2) or match.group(3) or "")
        if item:
            result.add(_item_key(item))
    return result


def _split_shopping_phrase(value: str) -> list[str]:
    value = re.sub(r"(?:nee|nein)?\s*(?:doch\s+)?keine?n?\s+[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß -]{1,40}", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\b(ich|wir)\s+(?:brauche|brauchen|bräuchte|bräuchten|benötige|benötigen)\b", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\b(muss|müssen|noch|bitte|auch|dafür|aber|ach ?ja|also|we|i|wir|ich|yo|nous|je)\b", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"\b(morgen|heute|tomorrow|today|mañana|demain|hoy)\b", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"\b(?:auf|in|für|zu)\s+(?:der|die|das)?\s*(?:einkaufsliste|shopping list)\b.*$", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\b(kaufen|besorgen|einkaufen|einkaufsliste|holen|buy|need|needs|get|purchase|comprar|compro|necesito|acheter|achète)\b", "", value, flags=re.IGNORECASE)
    parts = [p.strip() for p in re.split(r",|\s+und\s+|\s+oder\s+|\s+and\s+|\s+y\s+|\s+e\s+|\s+et\s+|\s*&\s*", value, flags=re.IGNORECASE)]
    result = []
    for part in parts:
        cleaned = _clean_shopping_title(part)
        if not (1 < len(cleaned) <= 80) or _is_filler_only(cleaned):
            continue
        if re.search(r"\b(keine|kein|no|not|pas|sin|brauchen|muss|müssen|zahnarzt|morgen|abend|nachmittag|marm|mom|weg|lasst)\b", cleaned, re.IGNORECASE):
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
        if is_shopping and not is_plain_list:
            match = re.search(r"(?:^|,|und|ach ?ja)\s*([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß -]{1,60}?)\s+(?:muss|müssen)?\s*(?:ich|wir)?\s*(?:noch\s+)?(?:kaufen|besorgen|einkaufen|holen|buy|need|needs|get|purchase|comprar|compro|necesito|acheter|achète)\b", chunk, re.IGNORECASE)
            if match:
                phrase = match.group(1)
            else:
                match = re.search(r"(?:^|,|und|aber)\s*([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß -]{1,60}?)\s+(?:bräuchte|bräuchten|brauche|brauchen|benötige|benötigen)\s+(?:ich|wir)?\b", chunk, re.IGNORECASE)
                if match:
                    phrase = match.group(1)
                elif re.search(r"\b(?:brauche|brauchen|bräuchte|bräuchten|benötige|benötigen)\b", chunk, re.IGNORECASE):
                    phrase = re.split(r"\b(?:brauche|brauchen|bräuchte|bräuchten|benötige|benötigen)\b", chunk, flags=re.IGNORECASE)[-1]
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


def _route_shopping_candidate(candidate: dict, workspace_context: dict | None) -> dict:
    if candidate.get("kind") != "shopping":
        return candidate
    project = _find_shopping_project(workspace_context)
    if not project:
        return candidate
    routed = dict(candidate)
    if not routed.get("project_name"):
        routed["project_name"] = project.get("name")
    if not routed.get("section_name"):
        title = str(routed.get("title") or "")
        sections = [str(section) for section in project.get("sections") or []]
        section_rules = [
            (r"milch|hafermilch|joghurt|käse|kaese|dairy|leche|lait", r"milch|dairy|lácteos|lacteos|lait"),
            (r"banane|banana|apfel|erdbeer|kartoffel|obst|gemüse|gemuese|fruit|fruta|verdura", r"obst|gemüse|gemuese|fruit|fruta|verdura|vegetable"),
        ]
        for title_pattern, section_pattern in section_rules:
            if not re.search(title_pattern, title, re.IGNORECASE):
                continue
            for section in sections:
                if re.search(section_pattern, section, re.IGNORECASE):
                    routed["section_name"] = section
                    return routed
    return routed


def _normalize_braindump_json(parsed: dict, transcript: str, workspace_context: dict | None = None) -> dict:
    candidates = parsed.get("candidates") if isinstance(parsed, dict) else None
    if not isinstance(candidates, list):
        candidates = []
    negated = _negated_items(transcript)
    normalized = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        title = str(candidate.get("title") or "").strip()
        if not title:
            continue
        title = _clean_title(title)
        if _is_filler_only(title):
            continue
        if len(title) > 30 and (',' in title or ' und ' in title.lower() or ' or ' in title.lower()):
            continue
        project_name = candidate.get("project_name")
        kind = candidate.get("kind") or "todo"
        if SHOPPING_INTENT_RE.search(title) or kind == "shopping":
            # kind=shopping is a semantic signal. Keep project/section names
            # when the LLM mapped them to explicit workspace context.
            kind = "shopping"
            title = _clean_shopping_title(title)
            key = _item_key(title)
            if not key or key in negated:
                continue
        deadline = _normalize_temporal_field(candidate.get("deadline"))
        reminder = _normalize_temporal_field(candidate.get("reminder"), require_time=True)
        if deadline and candidate.get("reminder") and not reminder:
            reminder = deadline
        normalized.append(_route_shopping_candidate({
            "title": title,
            "project_name": project_name,
            "section_name": candidate.get("section_name"),
            "deadline": deadline,
            "reminder": reminder,
            "kind": kind,
        }, workspace_context))
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
        if _item_key(item["title"]) not in existing:
            normalized.append(_route_shopping_candidate(item, workspace_context))
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



def _run(cmd: list[str]) -> tuple[float, subprocess.CompletedProcess[str]]:
    started = time.perf_counter()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    elapsed_ms = (time.perf_counter() - started) * 1000
    return elapsed_ms, proc


def _load_openclaw_token() -> str | None:
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


def _transcribe_remote_whisper(audio: bytes, filename: str, content_type: str) -> tuple[float, str]:
    if not BRAINDUMP_STT_URL:
        raise RuntimeError("NIA_TODO_STT_URL is not configured")
    fields = {
        "response_format": "json",
        "temperature": "0.0",
        "temperature_inc": "0.0",
        "language": BRAINDUMP_STT_LANGUAGE,
    }
    body, multipart_type = _build_multipart_form_data(fields, {"file": (filename, audio, content_type)})
    headers = {"Content-Type": multipart_type}
    if BRAINDUMP_STT_TOKEN:
        headers["Authorization"] = f"Bearer {BRAINDUMP_STT_TOKEN}"
    req = urllib.request.Request(BRAINDUMP_STT_URL, data=body, headers=headers, method="POST")
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=BRAINDUMP_STT_TIMEOUT_SECONDS) as response:
            response_body = response.read()
            response_type = response.headers.get("content-type", "")
    except Exception as exc:
        raise RuntimeError(f"remote STT request failed: {exc}") from exc
    elapsed_ms = (time.perf_counter() - started) * 1000
    return elapsed_ms, _extract_transcript_from_stt_response(response_body, response_type)



def _load_braindump_workspace_context(db, user_id: int) -> dict:
    """Return a compact routing context for the BrainDump LLM.

    The extractor must not know hard-coded project names. It gets the user's
    actual structure and may choose exact names from it when the fit is clear.
    """
    projects = db.execute(
        """
        SELECT p.id, p.name, COALESCE(p.is_inbox, 0) AS is_inbox,
               p.parent_id, p.workspace_id, w.name AS workspace_name
        FROM projects p
        LEFT JOIN workspaces w ON w.id = p.workspace_id
        WHERE p.user_id = ?
        ORDER BY COALESCE(p.is_inbox, 0) DESC, p.sort_order, p.id
        LIMIT 80
        """,
        (user_id,),
    ).fetchall()
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
            LIMIT 240
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
        return "Workspace context: no projects or sections provided. Leave project_name and section_name null unless the transcript explicitly names them."
    lines = ["Workspace context: choose project_name/section_name only from these exact existing names when clearly appropriate:"]
    for project in projects:
        label = project.get("name") or ""
        workspace = project.get("workspace")
        if workspace:
            label = f"{label} (workspace: {workspace})"
        sections = project.get("sections") or []
        if sections:
            label += "; sections: " + ", ".join(str(section) for section in sections)
        lines.append(f"- {label}")
    return "\n".join(lines)


def _name_key(value: str | None) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def _resolve_project_id(db, user_id: int, project_name: str | None) -> int | None:
    if not project_name:
        return get_user_inbox_project_id(db, user_id)
    rows = db.execute(
        """
        SELECT p.id, p.name
        FROM projects p
        LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ? AND pm.status = 'accepted'
        WHERE p.user_id = ? OR pm.id IS NOT NULL
        """,
        (user_id, user_id),
    ).fetchall()
    matches = [row for row in rows if _name_key(row["name"]) == _name_key(project_name)]
    if len(matches) != 1:
        raise HTTPException(422, f"BrainDump project not found: {project_name}")
    return matches[0]["id"]


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
        project_id = _resolve_project_id(db, user_id, candidate.project_name)
        section_id = _resolve_section_id(db, project_id, candidate.section_name)
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


def _extract_with_openclaw(text: str, segment_id: int, workspace_context: dict | None = None) -> tuple[float, dict, dict | None, str]:
    token = _load_openclaw_token()
    if not token:
        raise RuntimeError("OpenClaw gateway token not found")
    current_datetime = datetime.now().astimezone().isoformat(timespec="minutes")
    user_content = f"Instructions:\n{BRAINDUMP_EXTRACTOR_PROMPT}\n\nCurrent datetime: {current_datetime}\n\n{_format_workspace_context(workspace_context)}\n\nTranscript:\n{text}"
    payload = {
        "model": "openclaw/braindump",
        "messages": [
            {"role": "system", "content": BRAINDUMP_EXTRACTOR_PROMPT},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0,
        "stream": False,
        "max_tokens": 500,
        "user": f"nia-todo-live-braindump-{segment_id}-{int(time.time() * 1000)}",
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        OPENCLAW_CHAT_URL,
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    started = time.perf_counter()
    with urllib.request.urlopen(req, timeout=180) as response:
        result = json.loads(response.read().decode("utf-8"))
    elapsed_ms = (time.perf_counter() - started) * 1000
    content = result["choices"][0]["message"]["content"]
    parsed = _normalize_braindump_json(json.loads(content), text, workspace_context)
    return elapsed_ms, parsed, result.get("usage"), json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))


def require_braindump_access(user_id: int):
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


@router.post("/live/audio-segment")
async def process_live_audio_segment(
    request: Request,
    segment_id: int = Query(...),
    audio_start_ms: int = Query(0),
    audio_end_ms: int = Query(0),
    model: str = Query("base"),
    user_id: int = Depends(require_auth),
):
    """Process one live BrainDump audio window and return timing diagnostics."""
    require_braindump_access(user_id)
    stt_provider = BRAINDUMP_STT_PROVIDER.strip().lower()
    if stt_provider not in {"whisper_cpp_remote", "local_whisper_cpp"}:
        raise HTTPException(500, f"Unsupported BrainDump STT provider: {BRAINDUMP_STT_PROVIDER}")
    if stt_provider == "local_whisper_cpp" and model not in WHISPER_MODELS:
        raise HTTPException(400, "Unsupported BrainDump STT model")
    received_at = time.perf_counter()
    with get_db() as db:
        workspace_context = _load_braindump_workspace_context(db, user_id)
    content_type = request.headers.get("content-type", "")
    suffix = ".webm" if "webm" in content_type else ".ogg" if "ogg" in content_type else ".audio"
    audio_bytes = await request.body()
    try:
        if len(audio_bytes) < 1200:
            raise RuntimeError("audio segment too small")

        def process_bytes():
            if stt_provider == "whisper_cpp_remote":
                stt_ms, transcript = _transcribe_remote_whisper(audio_bytes, f"segment-{segment_id}{suffix}", content_type or "application/octet-stream")
                llm_ms, parsed, usage, raw_json = _extract_with_openclaw(transcript, segment_id, workspace_context)
                return 0.0, stt_ms, transcript, llm_ms, parsed, usage, raw_json
            with tempfile.TemporaryDirectory(prefix="nia-braindump-live-") as tmp:
                tmpdir = Path(tmp)
                raw_path = tmpdir / f"segment-{segment_id}{suffix}"
                wav_path = tmpdir / f"segment-{segment_id}.wav"
                raw_path.write_bytes(audio_bytes)
                convert_ms = _convert_audio_to_wav(raw_path, wav_path)
                stt_ms, transcript = _transcribe_wav(wav_path, model)
                llm_ms, parsed, usage, raw_json = _extract_with_openclaw(transcript, segment_id, workspace_context)
                return convert_ms, stt_ms, transcript, llm_ms, parsed, usage, raw_json

        convert_ms, stt_ms, transcript, llm_ms, parsed, usage, raw_json = await asyncio.to_thread(process_bytes)
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
