"""BrainDump v2 session-domain prototype.

Phase 1 deliberately works on text segments only. Real microphone/STT input should
feed this same session model later instead of creating a second code path.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import re
import time
import uuid
from typing import Optional


SESSION_TTL_SECONDS = 30 * 60
TAIL_CONTEXT_SEGMENTS = 2


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip())


def _normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9äöüß]+", " ", value.lower()).strip()


@dataclass
class TranscriptSegment:
    id: int
    text: str
    final: bool
    created_at: str = field(default_factory=_now_iso)


@dataclass
class BrainDumpCandidate:
    id: str
    title: str
    notes: str = ""
    project_id: Optional[int] = None
    project_name: Optional[str] = None
    section_id: Optional[int] = None
    section_name: Optional[str] = None
    deadline: Optional[str] = None
    reminder: Optional[str] = None
    confidence: float = 0.65
    status: str = "draft"
    source_segment_ids: list[int] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    created_at: str = field(default_factory=_now_iso)
    updated_at: str = field(default_factory=_now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "notes": self.notes,
            "project_id": self.project_id,
            "project_name": self.project_name,
            "section_id": self.section_id,
            "section_name": self.section_name,
            "deadline": self.deadline,
            "reminder": self.reminder,
            "confidence": self.confidence,
            "status": self.status,
            "source_segment_ids": list(self.source_segment_ids),
            "warnings": list(self.warnings),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass
class BrainDumpSession:
    id: str
    user_id: int
    status: str = "listening"
    transcript_segments: list[TranscriptSegment] = field(default_factory=list)
    committed_candidates: list[BrainDumpCandidate] = field(default_factory=list)
    draft_candidates: list[BrainDumpCandidate] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)
    last_processed_segment_id: int = 0
    created_at: str = field(default_factory=_now_iso)
    updated_at: str = field(default_factory=_now_iso)
    expires_at: float = field(default_factory=lambda: time.time() + SESSION_TTL_SECONDS)

    def touch(self):
        self.updated_at = _now_iso()
        self.expires_at = time.time() + SESSION_TTL_SECONDS

    def to_dict(self) -> dict:
        candidates = [*self.draft_candidates, *self.committed_candidates]
        return {
            "session_id": self.id,
            "status": self.status,
            "transcript_segments": [segment.__dict__ for segment in self.transcript_segments],
            "last_processed_segment_id": self.last_processed_segment_id,
            "candidates": [candidate.to_dict() for candidate in candidates],
            "events": list(self.events),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


_sessions: dict[str, BrainDumpSession] = {}


def reset_sessions_for_tests():
    _sessions.clear()


def cleanup_expired_sessions(now: Optional[float] = None):
    current = now or time.time()
    for session_id in [sid for sid, session in _sessions.items() if session.expires_at < current]:
        del _sessions[session_id]


def ensure_braindump_enabled(db, user_id: int):
    row = db.execute("SELECT COALESCE(braindump_enabled, 0) AS enabled FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        raise PermissionError("user_not_found")
    if not row["enabled"]:
        raise PermissionError("braindump_not_enabled")


def create_session(user_id: int) -> BrainDumpSession:
    cleanup_expired_sessions()
    session = BrainDumpSession(id=uuid.uuid4().hex, user_id=user_id)
    session.events.append({"type": "session_started", "created_at": _now_iso()})
    _sessions[session.id] = session
    return session


def get_session(session_id: str, user_id: int) -> BrainDumpSession:
    cleanup_expired_sessions()
    session = _sessions.get(session_id)
    if not session or session.user_id != user_id:
        raise KeyError("session_not_found")
    return session


def append_text_segment(session_id: str, user_id: int, text: str, final: bool = True) -> BrainDumpSession:
    session = get_session(session_id, user_id)
    if session.status not in {"listening", "processing"}:
        raise ValueError("session_not_accepting_segments")
    clean = _clean_text(text)
    if not clean:
        return session
    segment = TranscriptSegment(id=len(session.transcript_segments) + 1, text=clean, final=final)
    session.transcript_segments.append(segment)
    session.status = "processing"
    session.events.append({"type": "segment_added", "segment_id": segment.id, "created_at": _now_iso()})
    _process_new_segments(session)
    session.status = "listening"
    session.touch()
    return session


def finalize_session(session_id: str, user_id: int) -> BrainDumpSession:
    session = get_session(session_id, user_id)
    session.status = "finalizing"
    _process_open_tail(session)
    for candidate in [*session.draft_candidates, *session.committed_candidates]:
        candidate.status = "final"
        candidate.updated_at = _now_iso()
    session.committed_candidates = _dedupe_candidates([*session.draft_candidates, *session.committed_candidates])
    session.draft_candidates = []
    session.status = "ready"
    session.events.append({
        "type": "session_finalized",
        "processed_tail_only": True,
        "last_processed_segment_id": session.last_processed_segment_id,
        "created_at": _now_iso(),
    })
    session.touch()
    return session


def _process_new_segments(session: BrainDumpSession):
    new_segments = [segment for segment in session.transcript_segments if segment.id > session.last_processed_segment_id]
    if not new_segments:
        return
    candidates = []
    for segment in new_segments:
        candidates.extend(_extract_candidates(segment.text, [segment.id], status="stable" if segment.final else "draft"))
        if segment.final:
            session.last_processed_segment_id = segment.id
    session.committed_candidates = _dedupe_candidates([*candidates, *session.committed_candidates])
    session.events.append({
        "type": "candidates_updated",
        "source": "incremental",
        "segment_ids": [segment.id for segment in new_segments],
        "created_at": _now_iso(),
    })


def _process_open_tail(session: BrainDumpSession):
    tail_segments = session.transcript_segments[-TAIL_CONTEXT_SEGMENTS:]
    unprocessed = [segment for segment in tail_segments if segment.id > session.last_processed_segment_id or not segment.final]
    if not unprocessed:
        session.events.append({"type": "tail_skipped", "reason": "no_unprocessed_tail", "created_at": _now_iso()})
        return
    text = " ".join(segment.text for segment in unprocessed)
    tail_candidates = _extract_candidates(text, [segment.id for segment in unprocessed], status="final")
    session.draft_candidates = _dedupe_candidates([*tail_candidates, *session.draft_candidates])
    finalized_segment_ids = [segment.id for segment in unprocessed if segment.final]
    if finalized_segment_ids:
        session.last_processed_segment_id = max(session.last_processed_segment_id, max(finalized_segment_ids))
    session.events.append({
        "type": "candidates_updated",
        "source": "tail_only_finalize",
        "segment_ids": [segment.id for segment in unprocessed],
        "created_at": _now_iso(),
    })


def _extract_candidates(text: str, segment_ids: list[int], status: str) -> list[BrainDumpCandidate]:
    parts = _split_candidate_phrases(text)
    candidates = []
    for part in parts:
        title = _candidate_title(part)
        if not title:
            continue
        deadline = _extract_temporal_value(part, ["bis", "deadline", "fertig bis"])
        reminder = _extract_temporal_value(part, ["erinnere", "erinnerung", "denken an", "muss daran denken"])
        warnings = []
        confidence = 0.72
        if len(title) < 4:
            confidence = 0.45
            warnings.append("short_candidate")
        candidates.append(BrainDumpCandidate(
            id=uuid.uuid4().hex,
            title=title,
            deadline=deadline,
            reminder=reminder,
            confidence=confidence,
            status=status,
            source_segment_ids=list(segment_ids),
            warnings=warnings,
        ))
    return candidates


def _split_candidate_phrases(text: str) -> list[str]:
    normalized = _clean_text(text)
    if not normalized:
        return []
    # Split primarily on sentence/list boundaries. Keep "und" inside titles to
    # avoid accidentally breaking natural German task names too aggressively.
    parts = re.split(r"(?:[.;\n]+|\s+-\s+|\s+und dann\s+|\s+außerdem\s+|\s+danach\s+)", normalized, flags=re.IGNORECASE)
    return [_clean_text(part) for part in parts if _clean_text(part)]


def _candidate_title(phrase: str) -> str:
    text = _clean_text(phrase)
    reminder_prefix = re.match(r"^erinnere\s+(?:mich|uns)?\s*(?:bitte)?\s*(?:heute|morgen|übermorgen|am\s+\w+|um\s+\d{1,2}(?::\d{2})?)?\s*(.+)$", text, flags=re.IGNORECASE)
    if reminder_prefix:
        text = reminder_prefix.group(1)
    text = re.sub(r"^(ich muss|ich sollte|bitte|todo:?|aufgabe:?|erinnere mich daran,?)\s+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(bis|deadline)\b\s+.+$", "", text, flags=re.IGNORECASE).strip(" ,")
    text = re.sub(r"\b(erinnere|erinnerung|muss daran denken)\b\s+.+$", "", text, flags=re.IGNORECASE).strip(" ,")
    return text[:180]


def _extract_temporal_value(phrase: str, markers: list[str]) -> Optional[str]:
    lower = phrase.lower()
    for marker in markers:
        idx = lower.find(marker)
        if idx >= 0:
            value = _clean_text(phrase[idx + len(marker):].strip(" :,"))
            return value[:80] or None
    return None


def _dedupe_candidates(candidates: list[BrainDumpCandidate]) -> list[BrainDumpCandidate]:
    seen: set[str] = set()
    result: list[BrainDumpCandidate] = []
    for candidate in candidates:
        key = _normalize(candidate.title)
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(candidate)
    return result
