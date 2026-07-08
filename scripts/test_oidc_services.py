#!/usr/bin/env python3
"""Focused tests for generic OIDC config and local identity mapping."""

import contextlib
import hashlib
import io
import json
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
from starlette.responses import Response  # noqa: E402
from services.auth import decode_jwt_token  # noqa: E402
from services.oidc_config import get_oidc_config, normalize_oidc_config_update  # noqa: E402
from services import oidc as oidc_service  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from services.oidc import cleanup_oidc_login_states, complete_user_oidc_login, consume_state, sanitize_oidc_redirect_after, validate_id_token, create_native_handoff, consume_native_handoff  # noqa: E402
from routers.oidc import _completion_html, _json_for_script, _native_redirect_html, oidc_native_exchange, NativeOidcExchangeRequest  # noqa: E402


def assert_true(value, message):
    if not value:
        raise AssertionError(message)


class FakeClient:
    host = "127.0.0.1"


class FakeRequest:
    client = FakeClient()
    cookies = {}
    headers = {"user-agent": "OIDC Test"}


def main():
    with contextlib.redirect_stdout(io.StringIO()):
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
    try:
        normalize_oidc_config_update({
            "enabled": True,
            "issuer_url": "http://id.example.org",
            "client_id": "nia-todo",
            "public_client": True,
        })
        raise AssertionError("plain HTTP OIDC issuer should be rejected")
    except HTTPException as exc:
        assert_true(exc.status_code == 400, "plain HTTP OIDC issuer should return bad request")
    loopback_config = normalize_oidc_config_update({
        "enabled": True,
        "issuer_url": "http://127.0.0.1:8080/",
        "client_id": "nia-todo",
        "public_client": True,
    })
    assert_true(loopback_config["issuer_url"] == "http://127.0.0.1:8080", "loopback HTTP issuer should be allowed for local development")
    with get_db() as db:
        db.execute("UPDATE app_config SET value = ? WHERE key = 'public_base_url'", ("http://todo.example.org",))
        db.commit()
    try:
        normalize_oidc_config_update({
            "enabled": True,
            "issuer_url": "https://id.example.org",
            "client_id": "nia-todo",
            "public_client": True,
        })
        raise AssertionError("plain HTTP public base URL should be rejected for OIDC")
    except HTTPException as exc:
        assert_true(exc.status_code == 400, "plain HTTP OIDC redirect URI should return bad request")
    with get_db() as db:
        db.execute("UPDATE app_config SET value = ? WHERE key = 'public_base_url'", ("https://todo.example.org",))
        db.commit()

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

    assert_true(sanitize_oidc_redirect_after("/projects?x=1#top") == "/projects?x=1#top", "relative redirect_after should be kept")
    assert_true(sanitize_oidc_redirect_after("https://evil.example/") == "/", "absolute redirect_after should be rejected")
    assert_true(sanitize_oidc_redirect_after("//evil.example/") == "/", "protocol-relative redirect_after should be rejected")
    assert_true(sanitize_oidc_redirect_after("/\\evil") == "/", "backslash redirect_after should be rejected")
    script_json = _json_for_script({"value": "</script>\u2028\u2029"})
    assert_true("<\\/script>" in script_json, "script JSON should escape closing script tags")
    assert_true("\u2028" not in script_json and "\u2029" not in script_json, "script JSON should not contain raw JS line separators")
    assert_true("\\u2028" in script_json and "\\u2029" in script_json, "script JSON should escape JS line separators")

    with get_db() as db:
        db.execute(
            """INSERT INTO oidc_login_states (state_hash, nonce, code_verifier, purpose, redirect_after, expires_at)
               VALUES ('expired-state', 'n', 'v', 'user_login', '/', 1)"""
        )
        db.execute(
            """INSERT INTO oidc_login_states (state_hash, nonce, code_verifier, purpose, redirect_after, expires_at, consumed_at)
               VALUES ('consumed-state', 'n', 'v', 'user_login', '/', 9999999999, datetime('now'))"""
        )
        state_value = "state-once"
        db.execute(
            """INSERT INTO oidc_login_states (state_hash, nonce, code_verifier, purpose, redirect_after, expires_at)
               VALUES (?, 'nonce-once', 'verifier-once', 'user_login', '/', 9999999999)""",
            (hashlib.sha256(state_value.encode()).hexdigest(),),
        )
        db.commit()
    claimed_state = consume_state(state_value)
    assert_true(claimed_state["nonce"] == "nonce-once", "OIDC state should be claimed once")
    try:
        consume_state(state_value)
        raise AssertionError("OIDC state replay should be rejected")
    except HTTPException as exc:
        assert_true(exc.status_code == 400, "OIDC state replay should return a bad request")

    assert_true(cleanup_oidc_login_states() >= 3, "OIDC state cleanup should remove expired and consumed states")
    with get_db() as db:
        remaining = db.execute("SELECT COUNT(*) AS count FROM oidc_login_states WHERE state_hash IN ('expired-state', 'consumed-state')").fetchone()["count"]
        assert_true(remaining == 0, "OIDC state cleanup should not leave old state rows")

    native_code = create_native_handoff(
        kind="user",
        payload={"access_token": "native-jwt", "csrf_token": "native-csrf", "user": {"id": 42}},
        redirect_after="/projects?native=1",
    )
    native_handoff = consume_native_handoff(native_code)
    assert_true(native_handoff["kind"] == "user", "native OIDC handoff should keep its kind")
    assert_true(native_handoff["payload"]["access_token"] == "native-jwt", "native OIDC handoff should return payload once")
    assert_true(native_handoff["redirect_after"] == "/projects?native=1", "native OIDC handoff should keep safe redirect target")
    try:
        consume_native_handoff(native_code)
        raise AssertionError("native OIDC handoff replay should be rejected")
    except HTTPException as exc:
        assert_true(exc.status_code == 400, "native OIDC handoff replay should return bad request")
    with get_db() as db:
        stored_payload = db.execute("SELECT payload_json FROM oidc_native_handoffs WHERE code_hash = ?", (hashlib.sha256(native_code.encode()).hexdigest(),)).fetchone()["payload_json"]
        assert_true(stored_payload == "{}", "native OIDC handoff payload should be cleared after consumption")
        kind_sql = db.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'oidc_native_handoffs'").fetchone()["sql"]
        assert_true("'admin'" not in kind_sql and "'admin_link'" not in kind_sql, "native OIDC handoff table must not allow admin kinds")
    for invalid_native_kind in ("admin", "admin_link"):
        try:
            create_native_handoff(kind=invalid_native_kind, payload={}, redirect_after="/admin")
            raise AssertionError(f"native OIDC handoff should reject {invalid_native_kind}")
        except HTTPException as exc:
            assert_true(exc.status_code == 400, f"native OIDC handoff should reject {invalid_native_kind} with bad request")
    auth_session_source = (BASE / "web/static/js/features/auth-session.js").read_text()
    native_callback_block = auth_session_source.split("async function handleNativeOidcCallback", 1)[1].split("function bindNativeOidcListener", 1)[0]
    assert_true("admin_jwt_token" not in native_callback_block and "nia_admin_oidc_link_result" not in native_callback_block, "native OIDC callback must not prepare admin/admin-link handling")
    security_source = (BASE / "api/middleware/security.py").read_text()
    assert_true('"/api/oidc/native/exchange"' in security_source, "native OIDC exchange must be CSRF-exempt before a CSRF cookie exists")
    exchange_code = create_native_handoff(kind="user", payload={"csrf_token": "exchange-csrf"}, redirect_after="/inbox")
    exchange_response = oidc_native_exchange(NativeOidcExchangeRequest(code=exchange_code))
    exchange_body = json.loads(exchange_response.body.decode())
    assert_true(exchange_body["redirect_after"] == "/inbox", "native exchange should return redirect target")
    assert_true("set-cookie" in exchange_response.headers, "native exchange should set CSRF cookie on the returned response")
    native_redirect_html = _native_redirect_html("test-code", "user", "/inbox").body.decode()
    assert_true("window.close()" not in native_redirect_html, "native OIDC return page must not rely on browser tab auto-close")
    assert_true("data-i18n" in native_redirect_html and "Zurück zu nia-todo" in native_redirect_html and "Returning to nia-todo" in native_redirect_html, "native OIDC return page should include German and English UI copy")
    assert_true("After nia-todo opens" in native_redirect_html and "nia-todo://oidc/callback" in native_redirect_html, "native OIDC return page should keep a manual open fallback")
    assert_true("login-box" in native_redirect_html and "login-logo" in native_redirect_html and "/static/icons/icon-192.png" in native_redirect_html, "native OIDC return page should use nia-todo login branding and app icon")
    assert_true("btn btn-primary" in native_redirect_html and "--bg-primary" in native_redirect_html and "--accent" in native_redirect_html, "native OIDC return page should use nia-todo button classes and design tokens")
    assert_true("return-page" in native_redirect_html and "100dvh" in native_redirect_html and "overflow: hidden" in native_redirect_html and "place-items: center" in native_redirect_html, "native OIDC return page should be centered and non-scrollable on mobile")
    assert_true("window.addEventListener('load'" in native_redirect_html and "900" in native_redirect_html, "native OIDC return page should render before launching the app callback")

    calls = []
    original_post = oidc_service.requests.post

    class FakeResponse:
        def __init__(self, payload=None):
            self.payload = payload or {"id_token": "fake"}

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload

    def fake_post(url, data=None, auth=None, timeout=None):
        calls.append({"url": url, "data": dict(data or {}), "auth": auth, "timeout": timeout})
        return FakeResponse()

    class FakeSigningKey:
        key = "fake-key"

    class FakeJwkClient:
        def __init__(self, uri):
            self.uri = uri

        def get_signing_key_from_jwt(self, token):
            return FakeSigningKey()

    original_get = oidc_service.requests.get

    def fake_discovery_get_with_plain_http_endpoint(url, timeout=None):
        return FakeResponse({
            "issuer": "https://id.example.org",
            "authorization_endpoint": "http://id.example.org/authorize",
            "token_endpoint": "https://id.example.org/token",
            "jwks_uri": "https://id.example.org/jwks",
            "response_types_supported": ["code"],
        })

    try:
        oidc_service.requests.get = fake_discovery_get_with_plain_http_endpoint
        try:
            oidc_service.discover_provider({"issuer_url": "https://id.example.org"})
            raise AssertionError("plain HTTP discovery endpoint should be rejected")
        except HTTPException as exc:
            assert_true(exc.status_code == 400 and "authorization_endpoint" in str(exc.detail), "plain HTTP discovery endpoint should return a validation error")
    finally:
        oidc_service.requests.get = original_get

    original_jwk_client = oidc_service.pyjwt.PyJWKClient
    original_decode = oidc_service.pyjwt.decode
    decode_calls = []

    def fake_decode(token, key, algorithms=None, audience=None, issuer=None, options=None):
        decode_calls.append({"options": options, "audience": audience, "issuer": issuer})
        return {"iss": issuer, "aud": [audience, "other-client"], "azp": audience, "sub": "sub-1", "nonce": "nonce-1", "exp": 9999999999, "iat": 1}

    try:
        oidc_service.pyjwt.PyJWKClient = FakeJwkClient
        oidc_service.pyjwt.decode = fake_decode
        claims = validate_id_token(
            "id-token",
            {"jwks_uri": "https://id.example.org/jwks", "id_token_signing_alg_values_supported": ["RS256"]},
            {"client_id": "nia-todo", "issuer_url": "https://id.example.org"},
            "nonce-1",
        )
        assert_true(claims["sub"] == "sub-1", "valid ID token claims should be returned")
        assert_true(decode_calls[-1]["options"] == {"require": ["exp", "iat", "iss", "aud", "sub"]}, "ID token validation should require core OIDC claims")

        def fake_decode_bad_azp(token, key, algorithms=None, audience=None, issuer=None, options=None):
            return {"iss": issuer, "aud": audience, "azp": "other-client", "sub": "sub-1", "nonce": "nonce-1", "exp": 9999999999, "iat": 1}

        oidc_service.pyjwt.decode = fake_decode_bad_azp
        try:
            validate_id_token(
                "id-token",
                {"jwks_uri": "https://id.example.org/jwks"},
                {"client_id": "nia-todo", "issuer_url": "https://id.example.org"},
                "nonce-1",
            )
            raise AssertionError("ID token with wrong azp should be rejected")
        except HTTPException as exc:
            assert_true(exc.status_code == 400 and "authorized party" in str(exc.detail), "wrong azp should return a validation error")
    finally:
        oidc_service.pyjwt.PyJWKClient = original_jwk_client
        oidc_service.pyjwt.decode = original_decode

    userinfo_payload = {"sub": "sub-1", "email": "attacker@example.org", "email_verified": True}

    def fake_userinfo_get(url, headers=None, timeout=None):
        return FakeResponse(userinfo_payload)

    try:
        oidc_service.requests.get = fake_userinfo_get
        try:
            oidc_service.enrich_claims_from_userinfo(
                {"sub": "sub-1", "email": "victim@example.org"},
                {"access_token": "access"},
                {"userinfo_endpoint": "https://id.example.org/userinfo"},
            )
            raise AssertionError("conflicting UserInfo email should be rejected")
        except HTTPException as exc:
            assert_true(exc.status_code == 400 and "email" in str(exc.detail), "conflicting UserInfo email should return a validation error")
        userinfo_payload = {"sub": "sub-1", "email": "attacker@example.org"}
        merged = oidc_service.enrich_claims_from_userinfo(
            {"sub": "sub-1", "email_verified": True},
            {"access_token": "access"},
            {"userinfo_endpoint": "https://id.example.org/userinfo"},
        )
        assert_true(merged["email"] == "attacker@example.org", "UserInfo email should be used when ID token omits email")
        assert_true(merged["email_verified"] is False, "ID-token email_verified must not transfer to UserInfo email")
        userinfo_payload = {"email": "attacker@example.org", "email_verified": True}
        try:
            oidc_service.enrich_claims_from_userinfo(
                {"sub": "sub-1"},
                {"access_token": "access"},
                {"userinfo_endpoint": "https://id.example.org/userinfo"},
            )
            raise AssertionError("UserInfo without sub should be rejected")
        except HTTPException as exc:
            assert_true(exc.status_code == 400 and "subject" in str(exc.detail), "missing UserInfo subject should return a validation error")
    finally:
        oidc_service.requests.get = original_get

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
    error_html = _completion_html("error", {"error": "No verified local user matches this OIDC email", "kind": "user"}, "/")
    error_body = error_html.body.decode()
    assert_true("nia_oidc_error" in error_body and "location.replace" in error_body, "OIDC errors should redirect back to the app with a sessionStorage notice")
    assert_true("No verified local user matches this OIDC email" in error_body, "OIDC error message should be carried to the app notice")

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
        db.execute("UPDATE app_config SET value = 'true' WHERE key = 'two_factor_required'")
        db.commit()

    login = complete_user_oidc_login(
        {"iss": "https://id.example.org", "sub": "sub-1", "email": "user@example.org", "email_verified": True},
        FakeRequest(),
        Response(),
    )
    with get_db() as db:
        payload = decode_jwt_token(login["access_token"], db)
    assert_true(payload.get("mfa_login_at"), "OIDC login should satisfy app-access MFA like passwordless passkey login")
    assert_true(not payload.get("mfa_grant"), "OIDC login must not mint a sensitive-action reauth grant")

    print("OIDC service tests passed")


if __name__ == "__main__":
    main()
