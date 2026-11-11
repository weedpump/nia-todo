#!/usr/bin/env python3
import json
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from errors import request_validation_error_handler, validation_api_error  # noqa: E402

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


class ValidationProbe(BaseModel):
    text: str = Field(strict=True)
    integer: int = Field(strict=True)
    number: float = Field(strict=True, allow_inf_nan=False, le=10000)
    flag: bool = Field(strict=True)
    names: list[str]


def validation_app(*, safe_errors):
    # No application import, database, service or filesystem fixture is needed.
    app = FastAPI()
    if safe_errors:
        app.add_exception_handler(RequestValidationError, request_validation_error_handler)

    @app.post("/validate")
    def validate(data: ValidationProbe):
        return data.model_dump()

    return app


def test_nonfinite_validation_inputs_and_standard_error_contract():
    valid = {"text": "Example", "integer": 2, "number": 1.25, "flag": True, "names": ["A", "B"]}
    with TestClient(validation_app(safe_errors=False), raise_server_exceptions=False) as standard, \
         TestClient(validation_app(safe_errors=True)) as safe:
        for token in ("NaN", "Infinity", "-Infinity"):
            invalid = float(token)
            for field in ("text", "integer", "number", "flag"):
                body = json.dumps({**valid, field: invalid})
                before = standard.post("/validate", content=body, headers={"Content-Type": "application/json"})
                after = safe.post("/validate", content=body, headers={"Content-Type": "application/json"})
                assert before.status_code == 500, (field, token, before.text)
                assert after.status_code == 422, (field, token, after.text)
                assert after.json()["detail"][0]["input"] == token
                json.dumps(after.json(), allow_nan=False)
            # Invalid scalar and container fields may retain an entire nested
            # input in one error, rather than an error per individual float.
            for value in ([invalid, {"more": invalid}], {"nested": [invalid, {"more": invalid}]}):
                body = json.dumps({**valid, "text": value})
                response = safe.post("/validate", content=body, headers={"Content-Type": "application/json"})
                assert response.status_code == 422
                expected = json.loads(json.dumps(value), parse_constant=lambda _: token)
                assert response.json()["detail"][0]["input"] == expected
                json.dumps(response.json(), allow_nan=False)
            response = safe.post("/validate", content=token, headers={"Content-Type": "application/json"})
            assert response.status_code == 422 and response.json()["detail"][0]["input"] == token

        ordinary_errors = [
            {**valid, "text": 3.5}, {**valid, "integer": 2.5}, {**valid, "number": "not a number"},
            {**valid, "flag": "yes"}, {**valid, "names": None}, {**valid, "number": 10001},
            {**valid, "text": {"nested": [3.5, {"more": 4.5}]}},
            {key: value for key, value in valid.items() if key != "text"},
        ]
        for data in ordinary_errors:
            original = standard.post("/validate", json=data)
            response = safe.post("/validate", json=data)
            assert original.status_code == response.status_code == 422
            assert response.content == original.content, (data, response.text, original.text)
        for data in (valid, {**valid, "number": -3.5, "integer": 0, "flag": False}):
            original = standard.post("/validate", json=data)
            response = safe.post("/validate", json=data)
            assert original.status_code == response.status_code == 200
            assert response.content == original.content


test_nonfinite_validation_inputs_and_standard_error_contract()
print("✅ Request validation rejects nonfinite inputs with 422 and preserves ordinary responses")
