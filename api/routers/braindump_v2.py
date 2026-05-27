"""BrainDump v2 text/session/live-debug endpoints."""

from __future__ import annotations

import asyncio
import json
import re
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from db import get_db
from routers.auth import require_auth
from services.braindump_v2 import (
    append_text_segment,
    create_session,
    ensure_braindump_enabled,
    finalize_session,
    get_session,
)
from services.utils import sanitize_text


router = APIRouter(prefix="/api/braindump/v2")

OPENCLAW_CHAT_URL = "http://127.0.0.1:18789/v1/chat/completions"
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
- Detect relative and absolute times, including phrases like tomorrow, tonight, this evening, morgen, heute Abend, demain, mañana, etc.
- If a specific time is mentioned, include it in deadline and/or reminder.
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
SHOPPING_INTENT_RE = re.compile(r"\b(kaufen|besorgen|einkaufen|brauche|brauchen|bräuchte|bräuchten|benötige|benötigen|holen|buy|need|needs|get|purchase|comprar|compro|necesito|acheter|achète|acheterai|courses)\b", re.IGNORECASE)


def _clean_title(value: str) -> str:
    value = re.sub(r"^(ich brauche|ich benötige|bitte|noch)\s+", "", value.strip(), flags=re.IGNORECASE)
    value = re.sub(r"\b(meiner|meine|der)\s+(marm|mam)\b", lambda m: f"{m.group(1)} Mama", value, flags=re.IGNORECASE)
    value = re.sub(r"\bMarm\b", "Mama", value)
    value = value.strip(" .,:;!?-–—\t\n\r")
    return value[:1].upper() + value[1:] if value else ""


def _clean_shopping_title(value: str) -> str:
    value = re.sub(r"\b(kaufen|besorgen|einkaufen|holen|buy|need|needs|get|purchase|comprar|compro|necesito|acheter|achète)\b", "", value, flags=re.IGNORECASE)
    value = re.sub(r"^(wir müssen|ich muss|muss|bitte|noch|also we|we|i|je|nous|yo)\s+", "", value.strip(), flags=re.IGNORECASE)
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

NEGATED_ITEM_RE = re.compile(r"(?:doch\s+)?keine?n?\s+([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß -]{1,40})|(?:no|not|pas|sin)\s+([A-Za-zÀ-ÿÄÖÜäöüß][A-Za-zÀ-ÿÄÖÜäöüß -]{1,40})|([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß -]{1,40})\s+(?:brauchen wir nicht|lass(?:t)? (?:die|das|den)? ?weg)", re.IGNORECASE)
NON_SHOPPING_TASK_RE = re.compile(r"\b(zahnarzt|arzt|termin|duschen|marm|mom|mama|gehen|erinner|nachmittag|abend|morgen)\b", re.IGNORECASE)


def _item_key(value: str) -> str:
    return re.sub(r"[^a-z0-9äöüß]+", "", value.lower())


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
    value = re.sub(r"\b(kaufen|besorgen|einkaufen|holen|buy|need|needs|get|purchase|comprar|compro|necesito|acheter|achète)\b", "", value, flags=re.IGNORECASE)
    parts = [p.strip() for p in re.split(r",|\s+und\s+|\s+oder\s+|\s+and\s+|\s+y\s+|\s+e\s+|\s+et\s+|\s*&\s*", value, flags=re.IGNORECASE)]
    result = []
    for part in parts:
        cleaned = _clean_shopping_title(part)
        if not (1 < len(cleaned) <= 80):
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

def _normalize_braindump_json(parsed: dict, transcript: str) -> dict:
    candidates = parsed.get("candidates") if isinstance(parsed, dict) else None
    if not isinstance(candidates, list):
        candidates = []
    normalized = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        title = str(candidate.get("title") or "").strip()
        if not title:
            continue
        title = _clean_title(title)
        if len(title) > 30 and (',' in title or ' und ' in title.lower() or ' or ' in title.lower()):
            continue
        project_name = candidate.get("project_name")
        kind = candidate.get("kind") or "todo"
        if SHOPPING_INTENT_RE.search(title) or kind == "shopping":
            # kind=shopping is a semantic signal. Keep project/section names
            # when the LLM mapped them to explicit workspace context.
            kind = "shopping"
            title = _clean_shopping_title(title)
        deadline = candidate.get("deadline")
        reminder = candidate.get("reminder")
        if deadline and reminder and re.search(r"\d", str(deadline)) and not re.search(r"\d", str(reminder)):
            reminder = deadline
        normalized.append({
            "title": title,
            "project_name": project_name,
            "section_name": candidate.get("section_name"),
            "deadline": deadline,
            "reminder": reminder,
            "kind": kind,
        })
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
            normalized.append(item)
            existing.add(_item_key(item["title"]))
    return {"candidates": normalized}


class TextSegmentRequest(BaseModel):
    text: str
    final: bool = True



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


def _extract_with_openclaw(text: str, segment_id: int, workspace_context: dict | None = None) -> tuple[float, dict, dict | None, str]:
    token = _load_openclaw_token()
    if not token:
        raise RuntimeError("OpenClaw gateway token not found")
    user_content = f"Instructions:\n{BRAINDUMP_EXTRACTOR_PROMPT}\n\n{_format_workspace_context(workspace_context)}\n\nTranscript:\n{text}"
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
    parsed = _normalize_braindump_json(json.loads(content), text)
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
    if model not in WHISPER_MODELS:
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
