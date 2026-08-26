#!/usr/bin/env python3
"""Regression checks for immutable runtime code ownership."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
dockerfile = (ROOT / "packaging" / "Dockerfile").read_text()
installer = (ROOT / "packaging" / "install.sh").read_text()
compose = (ROOT / "packaging" / "docker-compose.yml").read_text()

assert "chown -R nia-todo:nia-todo /data" in dockerfile
assert "chown -R nia-todo:nia-todo /app /data" not in dockerfile
assert 'chown -R root:root "${APP_DIR}"' in installer
assert 'chown -R "${USER_NAME}:${GROUP_NAME}" "${DATA_DIR}"' in installer
assert 'chmod -R go-w "${APP_DIR}"' in installer
assert "read_only: true" in compose
assert "cap_drop:" in compose and "- ALL" in compose
assert "no-new-privileges:true" in compose

print("✅ Runtime code ownership hardening checks passed")
