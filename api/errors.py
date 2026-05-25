"""Stable API error helpers for client-side i18n."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException


def error_detail(code: str, message: str, **params: Any) -> dict[str, Any]:
    detail: dict[str, Any] = {"code": code, "message": message}
    if params:
        detail["params"] = params
    return detail


def api_error(status_code: int, code: str, message: str, **params: Any) -> HTTPException:
    return HTTPException(status_code=status_code, detail=error_detail(code, message, **params))
