#!/usr/bin/env python3
"""Regression tests for bcrypt password length validation."""

import bcrypt
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from services.auth import verify_user_credentials  # noqa: E402
from services.utils import validate_password  # noqa: E402


class FakeDatabase:
    def __init__(self, password_hash: str):
        self.password_hash = password_hash

    def execute(self, *_args):
        return self

    def fetchone(self):
        return {
            "id": 1,
            "username": "user",
            "display_name": "User",
            "email": "user@example.invalid",
            "email_verified_at": "2026-01-01",
            "email_trust_source": "test",
            "avatar_url": None,
            "password_hash": self.password_hash,
            "is_admin": 0,
            "token_version": 1,
            "braindump_enabled": 0,
            "braindump_learning_enabled": 1,
        }


def test_password_validation_rejects_more_than_72_utf8_bytes() -> None:
    password = "Aa1!" + ("x" * 69)
    assert len(password.encode()) == 73
    assert validate_password(password) == "validation.password.tooLong"


def test_login_rejects_overlong_password_without_bcrypt_error() -> None:
    password_hash = bcrypt.hashpw(b"ValidPass1!", bcrypt.gensalt()).decode()
    result = verify_user_credentials(FakeDatabase(password_hash), "user", "Aa1!" + ("x" * 69))
    assert result is None


if __name__ == "__main__":
    test_password_validation_rejects_more_than_72_utf8_bytes()
    test_login_rejects_overlong_password_without_bcrypt_error()
    print("✅ Bcrypt password length regression tests passed")
