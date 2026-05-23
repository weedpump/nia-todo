#!/usr/bin/env python3
"""2FA service/security regression tests (serial, temp DB)."""

import json
import sqlite3
import tempfile
from pathlib import Path

import bcrypt

BASE = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(BASE / "api"))

import db as db_module
import migrate
from fastapi import HTTPException

import services.two_factor as two_factor_module
from services.auth import create_jwt_token, get_current_user
from routers.two_factor import require_2fa_status_auth
from services.webauthn import relying_party_for_request, verify_client_data
from services.two_factor import (
    create_challenge,
    create_recovery_codes,
    EMAIL_CODE_TTL_SECONDS,
    bcrypt_hash,
    generate_totp_secret,
    get_valid_challenge,
    record_challenge_failure,
    set_two_factor_required,
    user_mfa_state,
    verify_challenge_method,
    verify_totp,
    _totp,
    utc_ts,
)


def with_temp_db():
    tmp = tempfile.TemporaryDirectory()
    path = Path(tmp.name) / "nia-todo-2fa-test.db"
    original_db = db_module.DB_PATH
    original_migrate_db = migrate.DB_PATH
    db_module.DB_PATH = path
    migrate.DB_PATH = path
    try:
        migrate.run_migrations()
        yield path
    finally:
        db_module.DB_PATH = original_db
        migrate.DB_PATH = original_migrate_db
        tmp.cleanup()


class FakeUrl:
    def __init__(self, value):
        from urllib.parse import urlparse
        self.value = value
        parsed = urlparse(value)
        self.hostname = parsed.hostname
        self.scheme = parsed.scheme
        self.netloc = parsed.netloc

    def __str__(self):
        return self.value


class FakeRequest:
    def __init__(self, url):
        self.url = FakeUrl(url)
        self.headers = {}


def create_user(conn, username="mfauser", password="Secret123!", email="mfa@example.invalid"):
    password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    cur = conn.execute(
        """INSERT INTO users (username, display_name, email, email_verified_at, email_trust_source, password_hash, token_version, created_at)
           VALUES (?, ?, ?, datetime('now'), 'test_verified', ?, 1, datetime('now'))""",
        (username, username, email, password_hash),
    )
    return cur.lastrowid


def main():
    for path in with_temp_db():
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        user_id = create_user(conn)

        secret = generate_totp_secret()
        code = _totp(secret, int(utc_ts() / 30))
        assert verify_totp(secret, code), "current TOTP code should verify"
        assert not verify_totp(secret, "000000" if code != "000000" else "111111"), "wrong TOTP should fail"

        conn.execute("UPDATE users SET two_factor_enabled = 1, two_factor_totp_secret = ? WHERE id = ?", (secret, user_id))
        recovery_codes = create_recovery_codes(conn, user_id)
        assert len(recovery_codes) == 10
        state = user_mfa_state(conn, user_id)
        assert state["enabled"] and state["has_totp"] and state["recovery_codes_remaining"] == 10

        challenge = create_challenge(conn, user_id, ip_address="127.0.0.1", user_agent="test")
        assert "totp" in challenge["methods"]
        assert "recovery_code" in challenge["methods"]
        row = get_valid_challenge(conn, challenge["challenge_token"])
        assert row is not None
        assert verify_challenge_method(conn, row, "totp", code)

        # A recovery code is one-time-use and is removed after successful verification.
        challenge2 = create_challenge(conn, user_id)
        row2 = get_valid_challenge(conn, challenge2["challenge_token"])
        assert verify_challenge_method(conn, row2, "recovery_code", recovery_codes[0])
        hashes = json.loads(conn.execute("SELECT two_factor_recovery_hashes FROM users WHERE id = ?", (user_id,)).fetchone()[0])
        assert len(hashes) == 9
        assert not verify_challenge_method(conn, row2, "recovery_code", recovery_codes[0])

        # Verified e-mail + working SMTP is a valid e-mail-code factor, not an enrollment dead-end.
        email_user_id = create_user(conn, username="emailmfa", email="emailmfa@example.invalid")
        sent_messages = []
        original_send_email = two_factor_module.send_email
        original_can_send = two_factor_module.can_send_email_links
        two_factor_module.can_send_email_links = lambda: True
        two_factor_module.send_email = lambda **kwargs: sent_messages.append(kwargs)
        try:
            email_challenge = create_challenge(conn, email_user_id)
        finally:
            two_factor_module.send_email = original_send_email
            two_factor_module.can_send_email_links = original_can_send
        assert email_challenge["methods"] == ["email"]
        assert sent_messages and "Authenticator oder Passkey" in sent_messages[0]["text"]
        email_row = get_valid_challenge(conn, email_challenge["challenge_token"])
        assert email_row is not None and email_row["email_code_hash"]

        # E-mail-only MFA also works for recent-MFA reauth buckets.
        bucket_hash = two_factor_module.sha256_hex(f"reauth:{email_user_id}:{int(two_factor_module.utc_ts() // two_factor_module.REAUTH_MAX_AGE_SECONDS)}")
        conn.execute(
            """INSERT INTO two_factor_challenges (user_id, token_hash, methods, expires_at, email_code_hash, email_code_expires_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, datetime('now'))""",
            (email_user_id, bucket_hash, json.dumps(["email"]), two_factor_module.utc_ts() + 600, bcrypt_hash("123456"), two_factor_module.utc_ts() + EMAIL_CODE_TTL_SECONDS),
        )
        reauth_bucket = conn.execute("SELECT * FROM two_factor_challenges WHERE token_hash = ?", (bucket_hash,)).fetchone()
        assert verify_challenge_method(conn, reauth_bucket, "email", "123456")

        # Five failed attempts lock a challenge until expiry.
        challenge3 = create_challenge(conn, user_id)
        row3 = get_valid_challenge(conn, challenge3["challenge_token"])
        for _ in range(5):
            record_challenge_failure(conn, row3["id"])
        assert get_valid_challenge(conn, challenge3["challenge_token"]) is None

        # Enabling global MFA invalidates old non-MFA JWTs for normal API auth.
        user = conn.execute("SELECT id, username, is_admin, token_version FROM users WHERE id = ?", (user_id,)).fetchone()
        old_token = create_jwt_token(dict(user), conn, mfa_verified=False)
        set_two_factor_required(conn, True)
        conn.commit()
        assert get_current_user(old_token) is None
        assert require_2fa_status_auth(authorization=f"Bearer {old_token}") == user_id

        # Passkeys use a pinned public_base_url RP/origin in production and do not silently bind to Host headers.
        conn.execute("INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES ('public_base_url', 'https://todo.example.invalid/app', datetime('now'))")
        conn.commit()
        rp = relying_party_for_request(FakeRequest("https://evil.example.invalid/api/me/passkeys/options"))
        assert rp.rp_id == "todo.example.invalid"
        assert rp.origin == "https://todo.example.invalid"
        conn.execute("INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES ('public_base_url', 'http://todo.example.invalid', datetime('now'))")
        conn.commit()
        try:
            relying_party_for_request(FakeRequest("http://todo.example.invalid/api/me/passkeys/options"))
            raise AssertionError("non-local public_base_url must require HTTPS for passkeys")
        except HTTPException as exc:
            assert exc.status_code == 400
        conn.execute("INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES ('public_base_url', 'https://todo.example.invalid/app', datetime('now'))")
        conn.commit()
        verify_client_data(
            json.dumps({"type": "webauthn.get", "challenge": "abc", "origin": "https://todo.example.invalid"}).encode(),
            "webauthn.get",
            "abc",
            "https://todo.example.invalid",
        )
        try:
            verify_client_data(
                json.dumps({"type": "webauthn.get", "challenge": "abc", "origin": "https://evil.example.invalid"}).encode(),
                "webauthn.get",
                "abc",
                "https://todo.example.invalid",
            )
            raise AssertionError("wrong WebAuthn origin should fail")
        except ValueError:
            pass

        conn.execute("DELETE FROM app_config WHERE key = 'public_base_url'")
        conn.commit()
        try:
            relying_party_for_request(FakeRequest("https://todo.example.invalid/api/me/passkeys/options"))
            raise AssertionError("non-local passkeys should require public_base_url")
        except HTTPException as exc:
            assert exc.status_code == 400

        conn.close()
    print("✅ 2FA service/security tests passed")


if __name__ == "__main__":
    main()
