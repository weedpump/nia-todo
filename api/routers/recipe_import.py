"""Authenticated, bounded recipe import previews; saving uses normal recipes API."""
from collections import deque
import threading
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from routers.auth import require_auth
from services.public_fetch import PublicFetchError
from services.recipe_import import import_recipe

router = APIRouter(prefix="/api/recipes")
_slots = threading.BoundedSemaphore(2)
_rate_lock = threading.Lock()
_attempts: dict[int, deque[float]] = {}


class RecipeImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(min_length=1, max_length=2048)
    include_image: bool = Field(default=True, strict=True)


def _admit(user_id: int):
    now = time.monotonic()
    with _rate_lock:
        for actor in list(_attempts):
            while _attempts[actor] and _attempts[actor][0] <= now - 60:
                _attempts[actor].popleft()
            if not _attempts[actor]:
                del _attempts[actor]
        history = _attempts.setdefault(user_id, deque())
        if len(history) >= 6:
            raise HTTPException(429, {"code": "recipe.import.rateLimited"}, headers={"Retry-After": "60"})
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
