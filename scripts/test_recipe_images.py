#!/usr/bin/env python3
"""Bounded recipe image normalization and inherited private-image access."""
import base64
import contextlib
import io
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix="nia-recipe-image-test-") as temporary:
        os.environ["NIA_TODO_DATA_DIR"] = temporary
        sys.path.insert(0, str(ROOT / "api"))
        from db import get_db
        from migrate import run_migrations
        from routers.auth import require_auth
        from routers import recipe_images
        from services import images
        from services.recipe_images import MAX_RECIPE_IMAGE_BYTES, normalize_recipe_image
        from services.entity_access import register_personal_entity

        output = io.BytesIO()
        image = Image.new("RGB", (1700, 850), "#6366f1")
        exif = Image.Exif()
        exif[0x010E] = "Private metadata must not be copied"
        image.save(output, "PNG", exif=exif)
        uri = "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()
        normalized = normalize_recipe_image(uri)
        decoded = Image.open(io.BytesIO(normalized["content"]))
        assert decoded.format == "WEBP" and decoded.size == (1280, 640)
        assert not decoded.getexif() and normalized["media_type"] == "image/webp"
        assert normalize_recipe_image(uri)["content_hash"] == normalized["content_hash"]
        assert normalize_recipe_image(None) is None
        for invalid in ("https://example.com/private-image", "data:image/svg+xml;base64,PHN2Zz4=",
                        "data:image/png;base64,!!!!", "data:image/png;base64," + base64.b64encode(b"broken").decode(),
                        "data:image/png;base64," + base64.b64encode(b"x" * (MAX_RECIPE_IMAGE_BYTES + 1)).decode()):
            try:
                normalize_recipe_image(invalid)
            except ValueError:
                pass
            else:
                raise AssertionError("Invalid or oversized image accepted")

        class HugeHeader:
            size = (10000, 10000)
            format = "PNG"
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def verify(self): raise AssertionError("Reject oversized pixels before decoding")
        with patch.object(images.Image, "open", return_value=HugeHeader()):
            try:
                normalize_recipe_image(uri)
            except ValueError:
                pass
            else:
                raise AssertionError("Image pixel budget was bypassed")

        with contextlib.redirect_stdout(io.StringIO()):
            run_migrations()
        with get_db() as db:
            owner, recipient, stranger = [db.execute("INSERT INTO users (username) VALUES (?)", (name,)).lastrowid
                                          for name in ("image-owner", "image-recipient", "image-stranger")]
            book = db.execute("INSERT INTO cookbooks (name) VALUES ('Private cookbook')").lastrowid
            register_personal_entity(db, "cookbook", book, owner)
            recipe = db.execute("INSERT INTO recipes (cookbook_id,title,client_mutation_id) VALUES (?, 'Photo', 'image-fixture')", (book,)).lastrowid
            db.execute("INSERT INTO recipe_images (recipe_id,content_hash,content,media_type) VALUES (?,?,?,?)",
                       (recipe, normalized["content_hash"], normalized["content"], normalized["media_type"]))
            access = db.execute("SELECT id FROM entity_access WHERE entity_type='cookbook' AND entity_id=?", (book,)).fetchone()[0]
            db.execute("INSERT INTO entity_access_grants (entity_access_id,user_id,invited_by_user_id,status) VALUES (?,?,?,'pending')", (access, recipient, owner))
            db.commit()
        actor = {"id": owner}
        app = FastAPI()
        app.include_router(recipe_images.router)
        app.dependency_overrides[require_auth] = lambda: actor["id"]
        path = f"/api/recipes/recipes/{recipe}/image?v={normalized['content_hash']}"
        with TestClient(app) as client:
            response = client.get(path)
            assert response.status_code == 200 and response.content == normalized["content"]
            assert response.headers["content-type"] == "image/webp"
            assert response.headers["cache-control"] == "private, no-store"
            assert client.get(path.replace(normalized["content_hash"], "0" * 64)).status_code == 404
            for user in (stranger, recipient):
                actor["id"] = user
                response = client.get(path)
                assert response.status_code == 404 and normalized["content"] not in response.content
            with get_db() as db:
                db.execute("UPDATE entity_access_grants SET status='accepted' WHERE entity_access_id=? AND user_id=?", (access, recipient))
                db.commit()
            actor["id"] = recipient
            assert client.get(path).status_code == 200
            with get_db() as db:
                db.execute("UPDATE entity_access_grants SET status='removed' WHERE entity_access_id=? AND user_id=?", (access, recipient))
                db.commit()
            assert client.get(path).status_code == 404
            actor["id"] = owner
            with get_db() as db:
                db.execute("DELETE FROM cookbooks WHERE id=?", (book,))
                db.commit()
                assert db.execute("SELECT COUNT(*) FROM recipe_images").fetchone()[0] == 0
            assert client.get(path).status_code == 404
        print("✅ Recipe image normalization, pixel limits, inherited grants, revocation and cascade passed")


if __name__ == "__main__":
    main()
