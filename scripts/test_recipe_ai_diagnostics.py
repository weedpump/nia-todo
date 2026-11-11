"""Recipe rejection diagnostics contain categories, never submitted content."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from routers import recipe_import as router
from routers.auth import require_auth
from services.recipe_ai import RecipeAIError


class DiagnosticsTests(unittest.TestCase):
    def test_fixed_reason_and_duration_without_sensitive_values(self):
        app = FastAPI()
        app.include_router(router.router)
        app.dependency_overrides[require_auth] = lambda: 42
        secret = "DO_NOT_LOG_RECIPE_CONTENT_OR_KEYS"
        config = {"llm_api_key": secret, "llm_base_url": "https://private.invalid/" + secret}
        for reason in ("schema", secret):
            with self.subTest(reason=reason):
                error = RecipeAIError("recipe.ai.invalidResponse")
                error.reason = reason
                router._attempts.clear()
                with TestClient(app) as client, \
                     patch.object(router, "require_braindump_ai_access", return_value=config), \
                     patch.object(router, "build_recipe_preview", side_effect=error), \
                     self.assertLogs("routers.recipe_import", level="WARNING") as captured:
                    response = client.post("/api/recipes/ai-preview", json={"text": secret})
                self.assertEqual(response.status_code, 502)
                self.assertEqual(response.json()["detail"]["code"], "recipe.ai.invalidResponse")
                log = "\n".join(captured.output)
                self.assertNotIn(secret, log)
                self.assertNotIn("private.invalid", log)
                self.assertIn("mode=text", log)
                self.assertIn("reason=" + (reason if reason == "schema" else "unknown"), log)
                self.assertRegex(log, r"status=502 elapsed_ms=\d+")


if __name__ == "__main__":
    unittest.main()
