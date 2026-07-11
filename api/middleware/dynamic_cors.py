"""DB-backed CORS middleware for selfhosted instance configuration."""

from starlette.datastructures import Headers
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response
from urllib.parse import urlparse

from fastapi import HTTPException

from services.instance_config import get_allowed_origins, is_same_request_origin, normalize_allowed_origins


class DynamicCORSMiddleware(BaseHTTPMiddleware):
    """Apply strict credentialed CORS from app_config.allowed_origins.

    Missing Origin is allowed for same-origin browser navigations, native apps,
    curl and server-to-server requests. Present but unknown Origin is rejected
    with 403 before it can reach API handlers.
    """

    allow_methods = "GET, POST, PUT, DELETE, PATCH, OPTIONS"
    allow_headers = "Authorization, Content-Type, X-Session-Token, X-Admin-Token, X-Requested-With, X-CSRF-Token, X-Nia-Client, X-Nia-Filename, X-File-Name, X-Filename"
    allow_header_names = {item.strip().lower() for item in allow_headers.split(",")}
    built_in_native_hosts = {"tauri.localhost"}
    built_in_native_custom_origins = {"tauri://localhost", "tauri://tauri.localhost"}

    async def dispatch(self, request, call_next):
        origin = request.headers.get("origin")
        is_preflight = request.method == "OPTIONS" and origin and request.headers.get("access-control-request-method")

        if origin and not self._is_allowed_origin(request, origin):
            return Response(
                content='{"detail":"Origin not allowed"}',
                status_code=403,
                headers={"Content-Type": "application/json", "Vary": "Origin"},
            )
        if is_preflight and not self._requested_headers_allowed(request.headers):
            return Response(
                content='{"detail":"CORS headers not allowed"}',
                status_code=403,
                headers={"Content-Type": "application/json", "Vary": "Origin"},
            )

        if is_preflight:
            response = Response(status_code=204)
        else:
            response = await call_next(request)

        if origin:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Credentials"] = "true"
            response.headers["Access-Control-Allow-Methods"] = self.allow_methods
            response.headers["Access-Control-Allow-Headers"] = self._requested_headers(request.headers)
            response.headers.add_vary_header("Origin")
        return response

    def _is_allowed_origin(self, request, origin: str) -> bool:
        if is_same_request_origin(request, origin):
            return True
        if self._same_host_behind_tls_proxy(request, origin):
            return True
        raw_origin = origin.strip().lower().rstrip("/")
        if raw_origin in self.built_in_native_custom_origins:
            return True
        try:
            normalized_origin = normalize_allowed_origins([origin])[0].lower()
        except Exception:
            return False
        parsed_origin = urlparse(normalized_origin)
        if parsed_origin.scheme in {"http", "https"} and parsed_origin.hostname in self.built_in_native_hosts:
            return True
        return normalized_origin in {item.lower() for item in get_allowed_origins()}

    def _same_host_behind_tls_proxy(self, request, origin: str) -> bool:
        """Allow browser same-host requests when TLS terminates before Uvicorn.

        Uvicorn runs with --no-proxy-headers so app-level Trusted Proxy logic is
        authoritative. Before Trusted Proxies are configured, same-origin browser
        requests may arrive as Origin=https://host while the ASGI request scheme
        is http. Treat this as same-origin only when the Origin host exactly
        matches the HTTP Host header; never trust X-Forwarded-* here.
        """
        raw_host = request.headers.get("host") or ""
        if not raw_host:
            return False
        try:
            origin_url = urlparse(origin)
            origin_norm = normalize_allowed_origins([origin])[0].lower()
            http_host_origin = normalize_allowed_origins([f"http://{raw_host}"])[0].lower()
            https_host_origin = normalize_allowed_origins([f"https://{raw_host}"])[0].lower()
        except (HTTPException, ValueError):
            return False
        if origin_url.scheme not in {"http", "https"}:
            return False
        return origin_norm in {http_host_origin, https_host_origin}

    def _requested_headers_allowed(self, headers: Headers) -> bool:
        requested = headers.get("access-control-request-headers")
        if not requested:
            return True
        return all(item.strip().lower() in self.allow_header_names for item in requested.split(",") if item.strip())

    def _requested_headers(self, headers: Headers) -> str:
        return self.allow_headers
