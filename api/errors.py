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


class APIError(Exception):
    """Custom exception for backward-compatible API errors.
    
    Response shape: {"detail": str, "code": str, "params": dict}
    """
    def __init__(self, status_code: int, code: str, message: str, **params: Any):
        self.status_code = status_code
        self.code = code
        self.message = message
        self.params = params
        super().__init__(message)


def api_error(status_code: int, code: str, message: str, **params: Any) -> HTTPException:
    """Create an HTTPException with backward-compatible error format.
    
    The detail field is a plain string for legacy clients.
    Code and params are included at top level for i18n-aware clients.
    """
    # Build response with flat structure
    response = {"detail": message, "code": code}
    if params:
        response["params"] = params
    return HTTPException(status_code=status_code, detail=response)
