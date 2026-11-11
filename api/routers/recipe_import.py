"""Authenticated, bounded recipe import previews; saving uses normal recipes API."""
from collections import deque
import logging
import threading
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from routers.auth import require_auth
from services.public_fetch import PublicFetchError
from services.recipe_import import import_recipe
from services.ai_access import require_braindump_ai_access
from services.recipe_ai import RecipeAIError, build_recipe_preview, prepare_input

router = APIRouter(prefix="/api/recipes")
_slots = threading.BoundedSemaphore(2)
_rate_lock = threading.Lock()
_attempts: dict[int, deque[float]] = {}
_logger = logging.getLogger(__name__)
_AI_LOG_REASONS = RecipeAIError.REASONS


class RecipeImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(min_length=1, max_length=2048)
    include_image: bool = Field(default=True, strict=True)


def _admit(user_id: int, *, error_prefix: str = "recipe.import"):
    now = time.monotonic()
    with _rate_lock:
        for actor in list(_attempts):
            while _attempts[actor] and _attempts[actor][0] <= now - 60:
                _attempts[actor].popleft()
            if not _attempts[actor]:
                del _attempts[actor]
        history = _attempts.setdefault(user_id, deque())
        if len(history) >= 6:
            raise HTTPException(429, {"code": error_prefix + ".rateLimited"}, headers={"Retry-After": "60"})
        history.append(now)


@router.post("/import-preview")
def preview_recipe_import(data: RecipeImportRequest, user_id: int = Depends(require_auth)):
    _admit(user_id)
    if not _slots.acquire(blocking=False):
        raise HTTPException(429, {"code": "recipe.import.busy"}, headers={"Retry-After": "5"})
    try:
        return import_recipe(data.url, include_image=data.include_image)
    except PublicFetchError as error:
        raise HTTPException(422, {"code": error.code}) from None
    finally:
        _slots.release()


class RecipeAIRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str | None = Field(default=None, max_length=32000)
    draft: dict | None = None

    @model_validator(mode="after")
    def exactly_one_source(self):
        if (self.text is None) == (self.draft is None):
            raise ValueError("Supply text or draft")
        return self


def _require_recipe_ai_access(user_id: int):
    try:
        return require_braindump_ai_access(user_id)
    except HTTPException as error:
        if error.status_code == 403:
            raise HTTPException(403, {"code": "recipe.ai.unavailable"}) from None
        raise


@router.post("/ai-preview")
def preview_recipe_ai(data: RecipeAIRequest, user_id: int = Depends(require_auth)):
    config = _require_recipe_ai_access(user_id)
    try:
        # Validate before occupying the bounded provider slots or recording a
        # successful admission; malformed drafts never reach the model.
        prepare_input(text=data.text, draft=data.draft)
    except RecipeAIError as error:
        raise HTTPException(422, {"code": error.code}) from None
    _admit(user_id, error_prefix="recipe.ai")
    if not _slots.acquire(blocking=False):
        raise HTTPException(429, {"code": "recipe.ai.busy"}, headers={"Retry-After": "5"})
    started = time.monotonic()
    try:
        result = build_recipe_preview(config=config, text=data.text, draft=data.draft, check_access=lambda: _require_recipe_ai_access(user_id))
        # A permission revocation during a slow inference wins over its reply.
        _require_recipe_ai_access(user_id)
        return result
    except RecipeAIError as error:
        status = 503 if error.code == "recipe.ai.notConfigured" else 502 if error.code in {"recipe.ai.failed", "recipe.ai.invalidResponse"} else 422
        reason = getattr(error, "reason", "unknown")
        if not isinstance(reason, str) or reason not in _AI_LOG_REASONS:
            reason = "unknown"
        # Record diagnostics, never model output, recipe text, URLs, identifiers
        # or exception messages (provider errors can contain credentials).
        _logger.warning("Recipe BrainDump preview rejected mode=%s reason=%s status=%d elapsed_ms=%d",
                        "refine" if data.draft is not None else "text", reason, status,
                        max(0, int((time.monotonic() - started) * 1000)))
        raise HTTPException(status, {"code": error.code}) from None
    finally:
        _slots.release()
