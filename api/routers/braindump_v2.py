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

BRAINDUMP_EXTRACTOR_PROMPT = """Du bist der nia-todo BrainDump-Extractor.
Antworte ausschließlich mit kompaktem gültigem JSON in dieser Form:
{"candidates":[{"title":"...","deadline":null,"reminder":null}]}

Harte Regeln:
- Schreibe ALLE Titel auf Deutsch. Niemals ins Englische übersetzen.
- Fasse nicht zusammen.
- Wenn der Nutzer mehrere Dinge aufzählt, mache daraus mehrere einzelne Todo-Kandidaten.
- Komma-/und-Listen wie "Kartoffeln, Erdbeeren und Salat" sind einzelne Einträge: "Kartoffeln", "Erdbeeren", "Salat".
- Kein Sammel-Todo wie "Kartoffeln, Erdbeeren und Salat kaufen".
- Kein Markdown, keine Erklärung, kein Text außerhalb JSON.
- Nur stabile, konkrete Todos aufnehmen.

Transkript:
"""

SHOPPING_VERBS_RE = re.compile(r"\b(kaufen|besorgen|einkaufen|buy|purchase|get)\b", re.IGNORECASE)
LIST_VERB_RE = re.compile(r"\b(muss|soll|erinnere|erinnern|vorbereiten|aufräumen|entsorgen|bestellen|machen|erledigen)\b", re.IGNORECASE)


def _clean_list_item(value: str) -> str:
    value = re.sub(r"\b(buy|purchase|get)\b", "", value, flags=re.IGNORECASE)
    value = SHOPPING_VERBS_RE.sub("", value)
    value = re.sub(r"^(ich brauche|ich benötige|bitte|noch)\s+", "", value.strip(), flags=re.IGNORECASE)
    value = value.strip(" .,:;!?-–—\t\n\r")
    return value[:1].upper() + value[1:] if value else ""


def _split_plain_enumeration(text: str) -> list[dict]:
    source = text.strip().strip(" .!?;:")
    if not source or "," not in source:
        return []
    # Do not split normal sentences with task verbs; this override is only for dictated item lists.
    if LIST_VERB_RE.search(source):
        return []
    source = SHOPPING_VERBS_RE.sub("", source)
    parts = [p.strip() for p in re.split(r",|\s+und\s+|\s+oder\s+|\s*&\s*", source, flags=re.IGNORECASE)]
    items = [_clean_list_item(part) for part in parts]
    items = [item for item in items if 1 < len(item) <= 80]
    if len(items) < 2:
        return []
    return [{"title": item, "deadline": None, "reminder": None} for item in items]


def _normalize_braindump_json(parsed: dict, transcript: str) -> dict:
    list_candidates = _split_plain_enumeration(transcript)
    if list_candidates:
        return {"candidates": list_candidates}
    candidates = parsed.get("candidates") if isinstance(parsed, dict) else None
    if not isinstance(candidates, list):
        return {"candidates": []}
    normalized = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        title = str(candidate.get("title") or "").strip()
        if not title:
            continue
        normalized.append({
            "title": title,
            "deadline": candidate.get("deadline"),
            "reminder": candidate.get("reminder"),
        })
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
        "-l", "de",
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


def _extract_with_openclaw(text: str, segment_id: int) -> tuple[float, dict, dict | None, str]:
    token = _load_openclaw_token()
    if not token:
        raise RuntimeError("OpenClaw gateway token not found")
    payload = {
        "model": "openclaw/braindump",
        "messages": [{"role": "user", "content": "Fragment:\n" + text}],
        "temperature": 0,
        "stream": False,
        "max_tokens": 160,
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
                llm_ms, parsed, usage, raw_json = _extract_with_openclaw(transcript, segment_id)
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
