"""In-memory rate limiting for login and API abuse prevention."""

from typing import Dict, Optional, Tuple
import time
from fastapi import Request, HTTPException, status, WebSocket

from db import get_db
from services.instance_config import forwarded_client_ip, get_forwarded_client_ip


class RateLimiter:
    def __init__(self):
        self.login_attempts: Dict[str, list] = {}  # ip -> [timestamps]
        self.login_identity_attempts: Dict[str, list] = {}  # identity -> [timestamps]
        self.login_ip_identity_attempts: Dict[str, list] = {}  # ip|identity -> [timestamps]
        self.password_reset_attempts: Dict[str, list] = {}  # ip/identifier -> [timestamps]
        self.api_requests: Dict[str, list] = {}    # ip -> [timestamps]
        self.ws_connections: Dict[str, int] = {}   # ip -> count

    @staticmethod
    def _normalize_login_identity(identity: str) -> str:
        return identity.strip().casefold()

    def prune_expired(self) -> None:
        now = time.time()
        for counter, window in ((self.login_attempts, 900), (self.login_identity_attempts, 900), (self.login_ip_identity_attempts, 900), (self.password_reset_attempts, 3600), (self.api_requests, 60)):
            for key, timestamps in list(counter.items()):
                active = [timestamp for timestamp in timestamps if now - timestamp < window]
                if active:
                    counter[key] = active
                else:
                    del counter[key]
        for key, count in list(self.ws_connections.items()):
            if count <= 0:
                del self.ws_connections[key]

    def _login_counter_keys(self, ip: str, identity: Optional[str] = None):
        keys = [("ip", ip)]
        if identity:
            normalized = self._normalize_login_identity(identity)
            keys.extend([("identity", normalized), ("ip_identity", f"{ip}|{normalized}")])
        return keys

    def check_login(self, ip: str, identity: Optional[str] = None) -> bool:
        cutoff = int(time.time()) - 15 * 60
        with get_db() as db:
            db.execute("DELETE FROM login_rate_limit_attempts WHERE attempted_at < ?", (cutoff,))
            for bucket, key in self._login_counter_keys(ip, identity):
                count = db.execute("SELECT COUNT(*) FROM login_rate_limit_attempts WHERE bucket = ? AND bucket_key = ? AND attempted_at >= ?", (bucket, key, cutoff)).fetchone()[0]
                if count >= 5:
                    db.commit()
                    return False
            db.commit()
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

    def record_failed_login(self, ip: str, identity: Optional[str] = None, db=None):
        """Persist a failed login using the caller transaction when available."""
        rows = [(bucket, key, int(time.time())) for bucket, key in self._login_counter_keys(ip, identity)]
        if db is not None:
            db.executemany("INSERT INTO login_rate_limit_attempts(bucket, bucket_key, attempted_at) VALUES (?, ?, ?)", rows)
            return
        with get_db() as own_db:
            own_db.executemany("INSERT INTO login_rate_limit_attempts(bucket, bucket_key, attempted_at) VALUES (?, ?, ?)", rows)
            own_db.commit()

    def record_successful_login(self, ip: str, identity: Optional[str] = None, db=None):
        """Clear only the successful account's counters in the active transaction."""
        if not identity:
            return
        normalized = self._normalize_login_identity(identity)
        def clear(connection):
            connection.execute("DELETE FROM login_rate_limit_attempts WHERE bucket = 'identity' AND bucket_key = ?", (normalized,))
            connection.execute("DELETE FROM login_rate_limit_attempts WHERE bucket = 'ip_identity' AND bucket_key = ?", (f"{ip}|{normalized}",))
        if db is not None:
            clear(db)
            return
        with get_db() as own_db:
            clear(own_db)
            own_db.commit()

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


def require_login_rate_limit(request: Request, identity: Optional[str] = None):
    ip = get_client_ip(request)
    if not rate_limiter.check_login(ip, identity):
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
