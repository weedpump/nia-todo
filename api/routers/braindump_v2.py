"""BrainDump v2 text-session prototype endpoints."""

from fastapi import APIRouter, Depends, HTTPException
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


class TextSegmentRequest(BaseModel):
    text: str
    final: bool = True


def require_braindump_access(user_id: int):
    with get_db() as db:
        try:
            ensure_braindump_enabled(db, user_id)
        except PermissionError as exc:
            if str(exc) == "user_not_found":
                raise HTTPException(404, "User not found")
            raise HTTPException(403, "BrainDump is not enabled for this user")


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
