#!/usr/bin/env python3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from errors import validation_api_error  # noqa: E402

CASES = {
    "validation.email.required": ("validation.emailRequired", "Email is required", {}),
    "validation.email.tooLong": ("validation.emailTooLong", "Email address is too long", {}),
    "validation.email.invalid": ("validation.invalidEmail", "Please enter a valid email address", {}),
    "validation.password.tooLong": ("validation.passwordTooLong", "Password must not exceed 72 bytes", {"max": 72}),
    "validation.password.tooShort.8": ("validation.passwordTooShort8", "Password must be at least 8 characters long", {"min": 8}),
    "validation.password.tooShort.12": ("validation.passwordTooShort12", "Password must be at least 12 characters long", {"min": 12}),
    "validation.password.uppercase": ("validation.passwordUppercase", "Password must contain at least one uppercase letter", {}),
    "validation.password.lowercase": ("validation.passwordLowercase", "Password must contain at least one lowercase letter", {}),
    "validation.password.digit": ("validation.passwordDigit", "Password must contain at least one digit", {}),
    "validation.password.special": ("validation.passwordSpecial", "Password must contain at least one special character", {}),
}

for internal_key, (code, detail, params) in CASES.items():
    error = validation_api_error(internal_key)
    if error.status_code != 400:
        raise AssertionError(f"{internal_key}: expected status 400, got {error.status_code}")
    if error.error_code != code:
        raise AssertionError(f"{internal_key}: expected code {code}, got {error.error_code}")
    if error.detail != detail:
        raise AssertionError(f"{internal_key}: expected detail {detail!r}, got {error.detail!r}")
    if error.error_params != params:
        raise AssertionError(f"{internal_key}: expected params {params}, got {error.error_params}")
    if error.error_code.startswith("validation.validation."):
        raise AssertionError(f"{internal_key}: duplicated validation prefix")

print("✅ API validation error contract mapping passed")
