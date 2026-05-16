"""In-memory rate limiting for login and API abuse prevention."""

from typing import Dict, Tuple
import time
from fastapi import Request, HTTPException, status, WebSocket


class RateLimiter:
    def __init__(self):
        self.login_attempts: Dict[str, list] = {}  # ip -> [timestamps]
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

    def check_api(self, ip: str) -> Tuple[bool, int]:
        now = time.time()
        window = 60  # 1 minute
        max_requests = 100

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
    """Get real client IP, handling proxies safely.
    
    Only trusts X-Forwarded-For from known internal proxies (Traefik).
    """
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        # Trust X-Forwarded-From from internal proxy (Traefik on same host)
        client_host = request.client.host if request.client else "unknown"
        if client_host.startswith(("10.", "192.168.", "127.", "::1", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.", "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.")):
            # Proxy is internal, trust first X-Forwarded-For entry
            return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def get_client_ip_ws(websocket: WebSocket) -> str:
    """Get real client IP from WebSocket, handling proxies safely."""
    forwarded = websocket.headers.get("X-Forwarded-For")
    if forwarded:
        client_host = websocket.client.host if websocket.client else "unknown"
        if client_host.startswith(("10.", "192.168.", "127.", "::1", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.", "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.")):
            return forwarded.split(",")[0].strip()
    return websocket.client.host if websocket.client else "unknown"


def require_login_rate_limit(request: Request):
    ip = get_client_ip(request)
    if not rate_limiter.check_login(ip):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Zu viele Login-Versuche. Bitte in 15 Minuten erneut versuchen."
        )


def require_api_rate_limit(request: Request):
    ip = get_client_ip(request)
    allowed, retry_after = rate_limiter.check_api(ip)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Zu viele Anfragen. Bitte langsamer machen.",
            headers={"Retry-After": str(retry_after)}
        )
