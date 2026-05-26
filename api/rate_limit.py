"""In-memory rate limiting for login and API abuse prevention."""

from typing import Dict, Tuple
import time
from fastapi import Request, HTTPException, status, WebSocket

from services.instance_config import forwarded_client_ip, get_forwarded_client_ip


class RateLimiter:
    def __init__(self):
        self.login_attempts: Dict[str, list] = {}  # ip -> [timestamps]
        self.password_reset_attempts: Dict[str, list] = {}  # ip/identifier -> [timestamps]
        self.api_requests: Dict[str, list] = {}    # ip -> [timestamps]
        self.ws_connections: Dict[str, int] = {}   # ip -> count

    def check_login(self, ip: str) -> bool:
        now = time.time()
        window = 15 * 60  # 15 minutes
        max_attempts = 5

        if ip not in self.login_attempts:
            self.login_attempts[ip] = []

        # Remove old entries
        self.login_attempts[ip] = [t for t in self.login_attempts[ip] if now - t < window]

        if len(self.login_attempts[ip]) >= max_attempts:
            return False

        self.login_attempts[ip].append(now)
        return True

    def check_password_reset(self, key: str) -> bool:
        now = time.time()
        window = 60 * 60  # 1 hour
        max_attempts = 5

        if key not in self.password_reset_attempts:
            self.password_reset_attempts[key] = []
        self.password_reset_attempts[key] = [t for t in self.password_reset_attempts[key] if now - t < window]
        if len(self.password_reset_attempts[key]) >= max_attempts:
            return False
        self.password_reset_attempts[key].append(now)
        return True

    def check_api(self, ip: str) -> Tuple[bool, int]:
        now = time.time()
        window = 60  # 1 minute
        max_requests = 300

        if ip not in self.api_requests:
            self.api_requests[ip] = []

        self.api_requests[ip] = [t for t in self.api_requests[ip] if now - t < window]

        if len(self.api_requests[ip]) >= max_requests:
            retry_after = int(window - (now - self.api_requests[ip][0]))
            return False, max(retry_after, 1)

        self.api_requests[ip].append(now)
        return True, 0

    def record_successful_login(self, ip: str):
        """Reset login attempts after successful login"""
        if ip in self.login_attempts:
            del self.login_attempts[ip]

    def check_ws(self, ip: str) -> bool:
        max_ws = 10
        if ip not in self.ws_connections:
            self.ws_connections[ip] = 0
        return self.ws_connections[ip] < max_ws

    def ws_connect(self, ip: str):
        if ip not in self.ws_connections:
            self.ws_connections[ip] = 0
        self.ws_connections[ip] += 1

    def ws_disconnect(self, ip: str):
        if ip in self.ws_connections and self.ws_connections[ip] > 0:
            self.ws_connections[ip] -= 1


rate_limiter = RateLimiter()


def get_client_ip(request: Request) -> str:
    """Get real client IP, trusting X-Forwarded-For only from configured proxies."""
    forwarded = get_forwarded_client_ip(request)
    if forwarded:
        return forwarded
    return request.client.host if request.client else "unknown"


def get_client_ip_ws(websocket: WebSocket) -> str:
    """Get real client IP from WebSocket, trusting proxy headers only from configured proxies."""
    client_host = websocket.client.host if websocket.client else None
    forwarded = forwarded_client_ip(client_host, websocket.headers.get("X-Forwarded-For"))
    if forwarded:
        return forwarded
    real_ip = forwarded_client_ip(client_host, websocket.headers.get("X-Real-IP"))
    if real_ip:
        return real_ip
    return client_host or "unknown"


def require_login_rate_limit(request: Request):
    ip = get_client_ip(request)
    if not rate_limiter.check_login(ip):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "rateLimit.login", "message": "Too many login attempts. Please try again in 15 minutes."}
        )


def require_password_reset_rate_limit(request: Request):
    ip = get_client_ip(request)
    if not rate_limiter.check_password_reset(f"ip:{ip}"):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "rateLimit.passwordReset", "message": "Too many requests. Please try again later."}
        )


def require_api_rate_limit(request: Request):
    ip = get_client_ip(request)
    allowed, retry_after = rate_limiter.check_api(ip)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "rateLimit.api", "message": "Too many requests. Please slow down."},
            headers={"Retry-After": str(retry_after)}
        )
