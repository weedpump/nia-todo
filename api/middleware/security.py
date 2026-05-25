"""nia-todo: Security middleware (CSRF, Security Headers, Rate Limiting)"""

import secrets
from typing import Optional
from urllib.parse import urlparse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response
from fastapi import Request, Header, HTTPException

from rate_limit import rate_limiter, get_client_ip

CSRF_COOKIE_NAME = "csrf_token"
CSRF_COOKIE_MAX_AGE_SECONDS = 86400 * 30
BUILT_IN_NATIVE_HOSTS = {"tauri.localhost"}


def is_built_in_native_origin(origin: Optional[str]) -> bool:
    if not origin:
        return False
    parsed = urlparse(origin)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    return parsed.hostname.lower() in BUILT_IN_NATIVE_HOSTS


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add security headers to all responses."""
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
            "font-src 'self'; connect-src 'self' wss:;"
        )
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
        return response


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Apply API rate limiting to all requests except login/setup/WS endpoints."""
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        skip_paths = {
            "/api/login", "/api/admin/login",
            "/api/setup/admin", "/api/setup/first-user", "/api/setup/status",
            "/ws", "/", "/setup", "/admin", "/sw.js", "/favicon.ico"
        }
        if path in skip_paths or path.startswith("/static/") or not path.startswith("/api/"):
            return await call_next(request)
        ip = get_client_ip(request)
        allowed, retry_after = rate_limiter.check_api(ip)
        if not allowed:
            return Response(
                content='{"detail":"Too many requests. Please slow down."}',
                status_code=429,
                headers={"Retry-After": str(retry_after), "Content-Type": "application/json"}
            )
        return await call_next(request)


class CSRFProtectionMiddleware(BaseHTTPMiddleware):
    """Validate CSRF token for all state-changing requests."""
    SKIP_PATHS = {
        "/api/login", "/api/admin/login",
        "/api/setup/admin", "/api/setup/first-user", "/api/setup/status",
        "/api/password-setup/complete", "/api/password-setup/request", "/api/password-setup/resend",
        "/api/2fa/challenge/verify", "/api/2fa/passkey/options", "/api/2fa/passkey/verify",
    }

    async def dispatch(self, request: Request, call_next):
        method = request.method.upper()
        path = request.url.path

        if method not in ("POST", "PUT", "PATCH", "DELETE"):
            return await call_next(request)
        if not path.startswith("/api/"):
            return await call_next(request)
        if path in self.SKIP_PATHS:
            return await call_next(request)

        auth = request.headers.get("Authorization", "")
        if auth.startswith("ApiKey "):
            return await call_next(request)
        if is_built_in_native_origin(request.headers.get("Origin")) and (auth.startswith("Bearer ") or request.headers.get("X-Session-Token")):
            return await call_next(request)

        cookie_token = request.cookies.get(CSRF_COOKIE_NAME)
        header_token = request.headers.get("X-CSRF-Token")

        if not cookie_token or not header_token:
            return Response(
                content='{"detail":"CSRF token missing"}',
                status_code=403,
                headers={"Content-Type": "application/json"}
            )

        if not secrets.compare_digest(cookie_token, header_token):
            return Response(
                content='{"detail":"CSRF token mismatch"}',
                status_code=403,
                headers={"Content-Type": "application/json"}
            )

        return await call_next(request)


def generate_csrf_token() -> str:
    return secrets.token_urlsafe(32)


def set_csrf_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        CSRF_COOKIE_NAME,
        token,
        httponly=True,
        samesite="lax",
        max_age=CSRF_COOKIE_MAX_AGE_SECONDS,
        path="/",
    )


def get_csrf_cookie(request: Request) -> Optional[str]:
    return request.cookies.get(CSRF_COOKIE_NAME)


def require_csrf(
    request: Request,
    x_csrf_token: Optional[str] = Header(None, alias="X-CSRF-Token"),
    authorization: Optional[str] = Header(None),
) -> None:
    if authorization and authorization.startswith("ApiKey "):
        return
    cookie_token = get_csrf_cookie(request)
    if not cookie_token or not x_csrf_token:
        raise HTTPException(403, "CSRF token missing")
    if not secrets.compare_digest(cookie_token, x_csrf_token):
        raise HTTPException(403, "CSRF token mismatch")
