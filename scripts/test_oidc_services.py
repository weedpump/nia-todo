#!/usr/bin/env python3
"""Focused tests for generic OIDC config and local identity mapping."""

import os
import sqlite3
import tempfile
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
os.environ["NIA_TODO_DATA_DIR"] = tempfile.mkdtemp(prefix="nia-todo-oidc-test-")
os.environ["NIA_TODO_DB"] = "test.db"

import sys
sys.path.insert(0, str(BASE / "api"))

from migrate import run_migrations  # noqa: E402
from db import get_db  # noqa: E402
from services.oidc_config import get_oidc_config, normalize_oidc_config_update  # noqa: E402
from services import oidc as oidc_service  # noqa: E402
from routers.oidc import _completion_html  # noqa: E402


def assert_true(value, message):
    if not value:
        raise AssertionError(message)


def main():
    run_migrations()
    with get_db() as db:
        db.execute("UPDATE app_config SET value = ? WHERE key = 'public_base_url'", ("https://todo.example.org",))
        db.commit()

    public_config = normalize_oidc_config_update({
        "enabled": True,
        "provider_name": "Pocket ID",
        "issuer_url": "https://id.example.org/",
        "client_id": "nia-todo",
        "public_client": True,
        "scopes": "profile",
    })
    assert_true(public_config["issuer_url"] == "https://id.example.org", "issuer URL should be normalized")
    assert_true(public_config["scopes"] == "openid profile email", "openid/email scopes should be enforced")

    secret_config = normalize_oidc_config_update({
        "enabled": True,
        "issuer_url": "https://id.example.org",
        "client_id": "nia-todo",
        "client_secret": "secret",
        "public_client": False,
        "token_auth_method": "client_secret_post",
    })
    assert_true(secret_config["client_secret"] == "secret", "confidential client secret should be kept")
    assert_true(secret_config["token_auth_method"] == "client_secret_post", "token endpoint auth method should be configurable")

    config = get_oidc_config()
    assert_true(config["redirect_uri"] == "https://todo.example.org/api/oidc/callback", "redirect URI should use public base URL")

    calls = []
    original_post = oidc_service.requests.post

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"id_token": "fake"}

    def fake_post(url, data=None, auth=None, timeout=None):
        calls.append({"url": url, "data": dict(data or {}), "auth": auth, "timeout": timeout})
        return FakeResponse()

    try:
        oidc_service.requests.post = fake_post
        oidc_service.exchange_code(
            "code",
            {"code_verifier": "verifier"},
            {"token_endpoint": "https://id.example.org/token", "token_endpoint_auth_methods_supported": ["client_secret_post"]},
            {"client_id": "nia-todo", "client_secret": "secret", "public_client": False, "token_auth_method": "auto"},
        )
        assert_true(calls[-1]["auth"] is None and calls[-1]["data"].get("client_secret") == "secret", "auto should use client_secret_post when basic is unsupported")
        oidc_service.exchange_code(
            "code",
            {"code_verifier": "verifier"},
            {"token_endpoint": "https://id.example.org/token", "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"]},
            {"client_id": "nia-todo", "client_secret": "secret", "public_client": False, "token_auth_method": "auto"},
        )
        assert_true(calls[-1]["auth"] == ("nia-todo", "secret") and "client_secret" not in calls[-1]["data"], "auto should prefer client_secret_basic when supported")
    finally:
        oidc_service.requests.post = original_post

    html_response = _completion_html("user", {"access_token": "jwt", "csrf_token": "csrf", "user": {"id": 1}}, "/")
    assert_true("set-cookie" in html_response.headers, "OIDC completion response should set CSRF cookie")

    with get_db() as db:
        db.execute(
            """INSERT INTO users (username, display_name, email, email_verified_at, password_hash, token_version)
               VALUES ('oidcuser', 'OIDC User', 'User@Example.org', datetime('now'), 'x', 1)"""
        )
        user_id = db.execute("SELECT id FROM users WHERE username = 'oidcuser'").fetchone()["id"]
        db.execute(
            """INSERT INTO user_oidc_identities (user_id, issuer, subject, email_at_link_time)
               VALUES (?, 'https://id.example.org', 'sub-1', 'user@example.org')""",
            (user_id,),
        )
        linked = db.execute(
            "SELECT user_id FROM user_oidc_identities WHERE issuer = 'https://id.example.org' AND subject = 'sub-1'"
        ).fetchone()
        assert_true(linked["user_id"] == user_id, "OIDC identity should link to local user")

    print("OIDC service tests passed")


if __name__ == "__main__":
    main()
