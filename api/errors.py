"""Stable API error helpers for client-side i18n."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException


def error_detail(code: str, message: str, **params: Any) -> dict[str, Any]:
    """Return error detail compatible with legacy string format.
    
    For backward compatibility, the response includes:
    - `detail`: plain string message (legacy clients)
    - `code`: error code for i18n lookup (new clients)
    - `message`: same as detail (explicit)
    - `params`: optional interpolation parameters
    
    HTTP response shape:
    {"detail": "message", "code": "...", "params": {...}}
    """
    result: dict[str, Any] = {"detail": message, "code": code}
    if params:
        result["params"] = params
    return result


def api_error(status_code: int, code: str, message: str, **params: Any) -> HTTPException:
    return HTTPException(status_code=status_code, detail=error_detail(code, message, **params))
