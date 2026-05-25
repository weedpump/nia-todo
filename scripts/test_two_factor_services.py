#!/usr/bin/env python3
"""2FA service/security regression tests (serial, temp DB)."""

import json
import sqlite3
import tempfile
import time
from pathlib import Path

import bcrypt
import jwt as pyjwt
from fastapi import Response

BASE = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(BASE / "api"))

import db as db_module
import migrate
from fastapi import HTTPException

import services.two_factor as two_factor_module
from services.auth import USER_JWT_EXPIRY_DAYS, create_jwt_token, decode_jwt_token, get_current_user, get_jwt_secret
from routers.auth import me, require_recent_mfa_for_account_security
from routers.two_factor import ReauthRequest, reauth, regenerate_recovery_codes, require_2fa_status_auth
from services.webauthn import ANDROID_PACKAGE_NAME, ANDROID_PASSKEY_ORIGINS, ANDROID_RELEASE_CERT_SHA256, relying_party_for_request, verify_client_data
from services.two_factor import (
    clear_recovery_codes_if_no_primary_factor,
    create_challenge,
    create_mfa_action_grant,
    create_recovery_codes,
    create_trusted_device,
    EMAIL_CODE_TTL_SECONDS,
    bcrypt_hash,
    generate_totp_secret,
    get_valid_challenge,
    get_valid_trusted_device_id,
    list_user_device_sessions,
    mark_challenge_consumed,
    record_challenge_failure,
    revoke_device_session,
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
        assert mark_challenge_consumed(conn, row["id"])
        assert not mark_challenge_consumed(conn, row["id"])

        # A recovery code is one-time-use and is removed after successful verification.
        challenge2 = create_challenge(conn, user_id)
        row2 = get_valid_challenge(conn, challenge2["challenge_token"])
        assert verify_challenge_method(conn, row2, "recovery_code", recovery_codes[0])
        hashes = json.loads(conn.execute("SELECT two_factor_recovery_hashes FROM users WHERE id = ?", (user_id,)).fetchone()[0])
        assert len(hashes) == 9
        assert not verify_challenge_method(conn, row2, "recovery_code", recovery_codes[0])

        # Recovery codes are backup factors only: if no TOTP/passkey remains, they are cleared and 2FA is disabled.
        backup_only_user_id = create_user(conn, username="backup_only", email="backup-only@example.invalid")
        conn.execute("UPDATE users SET two_factor_enabled = 1 WHERE id = ?", (backup_only_user_id,))
        backup_codes = create_recovery_codes(conn, backup_only_user_id)
        assert backup_codes and user_mfa_state(conn, backup_only_user_id)["has_recovery_codes"]
        assert clear_recovery_codes_if_no_primary_factor(conn, backup_only_user_id)
        backup_state = user_mfa_state(conn, backup_only_user_id)
        assert not backup_state["enabled"] and not backup_state["has_recovery_codes"]
        try:
            regenerate_recovery_codes(user_id=backup_only_user_id)
            raise AssertionError("Recovery Codes must require a primary TOTP/passkey factor")
        except HTTPException as exc:
            assert exc.status_code == 400

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
        bucket_hash = two_factor_module.sha256_hex(f"reauth:{email_user_id}:{int(two_factor_module.utc_ts() // two_factor_module.REAUTH_MAX_AGE_SECONDS)}:0")
        conn.execute(
            """INSERT INTO two_factor_challenges (user_id, token_hash, methods, expires_at, email_code_hash, email_code_expires_at, reauth_counter, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))""",
            (email_user_id, bucket_hash, json.dumps(["email"]), two_factor_module.utc_ts() + 600, bcrypt_hash("123456"), two_factor_module.utc_ts() + EMAIL_CODE_TTL_SECONDS),
        )
        reauth_bucket = conn.execute("SELECT * FROM two_factor_challenges WHERE token_hash = ?", (bucket_hash,)).fetchone()
        assert verify_challenge_method(conn, reauth_bucket, "email", "123456")
        email_user = conn.execute("SELECT id, username, is_admin, token_version FROM users WHERE id = ?", (email_user_id,)).fetchone()
        email_token = create_jwt_token(dict(email_user), conn, mfa_login_verified=True)
        reauth_response = reauth(ReauthRequest(method="email", code="123456"), authorization=f"Bearer {email_token}")
        assert reauth_response["access_token"]
        used_reauth_bucket = conn.execute("SELECT email_code_hash, email_code_expires_at, consumed_at FROM two_factor_challenges WHERE token_hash = ?", (bucket_hash,)).fetchone()
        assert used_reauth_bucket["email_code_hash"] is None and used_reauth_bucket["email_code_expires_at"] is None and used_reauth_bucket["consumed_at"]
        try:
            reauth(ReauthRequest(method="email", code="123456"), authorization=f"Bearer {email_token}")
            raise AssertionError("email reauth code must not mint multiple grants after success")
        except HTTPException as exc:
            assert exc.status_code == 401

        # Five failed attempts lock a challenge until expiry.
        challenge3 = create_challenge(conn, user_id)
        row3 = get_valid_challenge(conn, challenge3["challenge_token"])
        for _ in range(5):
            record_challenge_failure(conn, row3["id"])
        assert get_valid_challenge(conn, challenge3["challenge_token"]) is None

        # Device sessions back JWTs so individual device revocation invalidates only that session.
        user = conn.execute("SELECT id, username, is_admin, token_version FROM users WHERE id = ?", (user_id,)).fetchone()
        trusted_device_token, trusted_device_id = create_trusted_device(conn, user_id, "Test Browser", return_id=True)
        session_token = create_jwt_token(dict(user), conn, mfa_login_verified=True, create_session=True, trusted_device_id=trusted_device_id, user_agent="Test Browser", ip_address="127.0.0.1")
        session_payload = conn.execute("SELECT id FROM user_sessions WHERE user_id = ? AND trusted_device_id = ? AND revoked_at IS NULL", (user_id, trusted_device_id)).fetchone()
        assert session_payload is not None
        device_sessions = list_user_device_sessions(conn, user_id, current_session_id=session_payload["id"], current_trusted_token=trusted_device_token)
        assert len(device_sessions) == 1 and device_sessions[0]["current_device"] and device_sessions[0]["trusted"]
        conn.commit()
        assert get_current_user(session_token) == user_id
        revoked = revoke_device_session(conn, user_id, session_payload["id"])
        conn.commit()
        assert revoked and get_current_user(session_token) is None
        assert conn.execute("SELECT revoked_at FROM trusted_devices WHERE id = ?", (trusted_device_id,)).fetchone()["revoked_at"]
        assert revoke_device_session(conn, user_id, session_payload["id"]) is None

        # Trusted-cookie logins must bind the new JWT session to the trusted-device row.
        remembered_token, remembered_device_id = create_trusted_device(conn, user_id, "Remembered Browser", return_id=True)
        valid_trusted_device = get_valid_trusted_device_id(conn, user_id, remembered_token)
        assert valid_trusted_device and valid_trusted_device[0] == remembered_device_id
        remembered_session_token = create_jwt_token(
            dict(user),
            conn,
            mfa_login_verified=True,
            create_session=True,
            trusted_device_id=valid_trusted_device[0],
            user_agent="Remembered Browser",
            ip_address="127.0.0.2",
        )
        remembered_session = conn.execute(
            "SELECT id, trusted_device_id FROM user_sessions WHERE user_id = ? AND trusted_device_id = ? AND revoked_at IS NULL",
            (user_id, remembered_device_id),
        ).fetchone()
        assert remembered_session and remembered_session["trusted_device_id"] == remembered_device_id
        conn.commit()
        assert get_current_user(remembered_session_token) == user_id

        # /api/me JWT refresh extends the backing DB session expiry too.
        refresh_session_token = create_jwt_token(dict(user), conn, mfa_login_verified=True, create_session=True, user_agent="Refresh Browser", ip_address="127.0.0.3")
        refresh_payload = decode_jwt_token(refresh_session_token, conn)
        refresh_session_id = refresh_payload["sid"]
        old_exp = int(time.time()) + 60
        conn.execute("UPDATE user_sessions SET expires_at = ?, last_used_at = datetime('now', '-10 minutes') WHERE id = ?", (old_exp, refresh_session_id))
        secret_key = get_jwt_secret(conn)
        near_exp_payload = dict(refresh_payload)
        near_exp_payload["iat"] = int(time.time()) - 10
        near_exp_payload["exp"] = old_exp
        near_exp_token = pyjwt.encode(near_exp_payload, secret_key, algorithm="HS256")
        conn.commit()
        me_response = me(Response(), authorization=f"Bearer {near_exp_token}")
        assert me_response.get("access_token"), "near-expiry /api/me should refresh JWT"
        refreshed_session = conn.execute("SELECT expires_at, last_used_at FROM user_sessions WHERE id = ?", (refresh_session_id,)).fetchone()
        assert refreshed_session and int(refreshed_session["expires_at"]) >= int(time.time()) + (USER_JWT_EXPIRY_DAYS * 86400) - 5

        # Session last_used_at is updated with throttling when stale.
        stale_session_token = create_jwt_token(dict(user), conn, mfa_login_verified=True, create_session=True, user_agent="Stale Browser", ip_address="127.0.0.4")
        stale_payload = decode_jwt_token(stale_session_token, conn)
        stale_session_id = stale_payload["sid"]
        conn.execute("UPDATE user_sessions SET last_used_at = datetime('now', '-10 minutes') WHERE id = ?", (stale_session_id,))
        conn.commit()
        assert get_current_user(stale_session_token) == user_id
        stale_last_used = conn.execute("SELECT strftime('%s', last_used_at) AS ts FROM user_sessions WHERE id = ?", (stale_session_id,)).fetchone()["ts"]
        assert int(stale_last_used) >= int(time.time()) - 60

        # Enabling global MFA invalidates old non-MFA JWTs for normal API auth.
        old_token = create_jwt_token(dict(user), conn, mfa_verified=False)
        set_two_factor_required(conn, True)
        conn.commit()
        assert get_current_user(old_token) is None
        assert require_2fa_status_auth(authorization=f"Bearer {old_token}") == user_id

        # Trusted-device login is sufficient for normal app access, but must not satisfy recent-MFA gates.
        trusted_login_token = create_jwt_token(dict(user), conn, mfa_login_verified=True)
        assert get_current_user(trusted_login_token) == user_id
        totp_reauth = reauth(ReauthRequest(method="totp", code=code), authorization=f"Bearer {trusted_login_token}")
        assert totp_reauth["access_token"]
        try:
            reauth(ReauthRequest(method="totp", code=code), authorization=f"Bearer {trusted_login_token}")
            raise AssertionError("same TOTP timestep must not mint multiple reauth grants")
        except HTTPException as exc:
            assert exc.status_code == 401
        try:
            require_recent_mfa_for_account_security(authorization=f"Bearer {trusted_login_token}")
            raise AssertionError("trusted-device login must not authorize sensitive actions")
        except HTTPException as exc:
            assert exc.status_code == 403
        grant = create_mfa_action_grant(conn, user_id)
        conn.commit()
        fresh_mfa_token = create_jwt_token(dict(user), conn, mfa_grant=grant)
        assert require_recent_mfa_for_account_security(authorization=f"Bearer {fresh_mfa_token}") == user_id
        try:
            require_recent_mfa_for_account_security(authorization=f"Bearer {fresh_mfa_token}")
            raise AssertionError("MFA action grant must be single-use")
        except HTTPException as exc:
            assert exc.status_code == 403

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
        android_origin = next(iter(ANDROID_PASSKEY_ORIGINS))
        verify_client_data(
            json.dumps({"type": "webauthn.get", "challenge": "abc", "origin": android_origin}).encode(),
            "webauthn.get",
            "abc",
            "https://todo.example.invalid",
        )
        assert ANDROID_PACKAGE_NAME == "de.tobiaskneidl.nia_todo"
        assert ANDROID_RELEASE_CERT_SHA256 == "90:0E:26:CD:40:B8:BF:42:A6:5B:98:02:8A:A5:43:9F:6A:72:74:15:55:FE:26:C4:85:B8:34:E3:B1:97:E0:58"
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
        try:
            verify_client_data(
                json.dumps({"type": "webauthn.get", "challenge": "abc", "origin": "android:apk-key-hash:evil"}).encode(),
                "webauthn.get",
                "abc",
                "https://todo.example.invalid",
            )
            raise AssertionError("wrong Android WebAuthn origin should fail")
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
