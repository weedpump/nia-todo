"""Authenticated image reads inherit the current cookbook access boundary."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response

from db import get_db
from routers.auth import require_auth
from services.recipe_content import get_authorized_recipe_row

router = APIRouter(prefix="/api/recipes")


@router.get("/recipes/{recipe_id}/image")
def get_recipe_image(recipe_id: Annotated[int, Path(gt=0, le=9223372036854775807)],
                     v: Annotated[str | None, Query(max_length=64)] = None,
                     user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN")
        if get_authorized_recipe_row(db, recipe_id, user_id) is None:
            raise HTTPException(404, "Recipe image not found")
        row = db.execute(
            "SELECT recipe.cookbook_id, image.content, image.content_hash, image.media_type "
            "FROM recipes recipe JOIN recipe_images image ON image.recipe_id = recipe.id "
            "WHERE recipe.id = ?", (recipe_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(404, "Recipe image not found")
        # A stale version must not populate an older cache slot with newer bytes.
        if v is not None and v != row["content_hash"]:
            raise HTTPException(404, "Recipe image not found")
        return Response(content=bytes(row["content"]), media_type=row["media_type"], headers={
            "Cache-Control": "private, no-store", "Vary": "Authorization, Cookie, X-Session-Token",
            "X-Content-Type-Options": "nosniff",
        })
