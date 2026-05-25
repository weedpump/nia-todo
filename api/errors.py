"""Stable API error helpers for client-side i18n."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException


def error_detail(code: str, message: str, **params: Any) -> dict[str, Any]:
    """Return error detail compatible with legacy string format.
    
    For backward compatibility, the 'detail' field contains the message string
    directly, while structured data is provided in 'code' and 'params'.
    Clients can use either: detail (string) or code+message+params (structured).
    """
    detail: dict[str, Any] = {"code": code, "message": message}
    if params:
        detail["params"] = params
    # Backward compatibility: also expose message as plain string
    detail["detail"] = message
    return detail


def api_error(status_code: int, code: str, message: str, **params: Any) -> HTTPException:
    return HTTPException(status_code=status_code, detail=error_detail(code, message, **params))
