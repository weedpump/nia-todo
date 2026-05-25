"""Stable API error helpers for client-side i18n."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from fastapi.requests import Request


class APIError(HTTPException):
    """Custom HTTPException with flat error structure for backward compatibility.
    
    Response shape: {"detail": str, "code": str, "params": dict}
    This avoids FastAPI's default nesting of detail field.
    """
    def __init__(self, status_code: int, code: str, message: str, **params: Any):
        # Store flat structure in detail for custom handler
        self.error_code = code
        self.error_params = params
        super().__init__(status_code=status_code, detail=message)


def api_error(status_code: int, code: str, message: str, **params: Any) -> APIError:
    """Create an APIError with backward-compatible flat error format.
    
    Legacy clients read 'detail' string.
    i18n-aware clients use 'code' + 'params' for localization.
    """
    return APIError(status_code=status_code, code=code, message=message, **params)


async def api_error_handler(request: Request, exc: APIError) -> JSONResponse:
    """Custom handler that returns flat error structure."""
    content = {
        "detail": exc.detail,
        "code": exc.error_code,
    }
    if exc.error_params:
        content["params"] = exc.error_params
    return JSONResponse(status_code=exc.status_code, content=content)
