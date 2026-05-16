"""nia-todo: FastAPI backend"""

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Header, Depends, Request, status
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import Response
from pydantic import BaseModel, Field
from typing import Optional, List
from pathlib import Path
import json
import asyncio
import secrets
import string
import time
import sqlite3
import base64
from datetime import datetime, timezone, timedelta

import bcrypt
import jwt as pyjwt

# ─── Web Push (VAPID) ───────────────────────────────────────────────────────
from py_vapid import Vapid
from pywebpush import webpush, WebPushException
from cryptography.hazmat.primitives import serialization

from db import init_db, get_db, row_to_dict, now_iso
from migrate import run_migrations
from rate_limit import rate_limiter, require_login_rate_limit, require_api_rate_limit, get_client_ip, get_client_ip_ws

# ─── CSRF Protection ──────────────────────────────────────────────────────────

def generate_csrf_token() -> str:
    """Generate a random CSRF token."""
    return secrets.token_urlsafe(32)

def set_csrf_cookie(response: Response, token: str):
    """Set CSRF token in a secure cookie."""
    response.set_cookie(
        key="csrf_token",
        value=token,
        httponly=False,  # Must be readable by JS for double-submit
        secure=True,     # Only over HTTPS
        samesite="lax",  # CSRF protection
        max_age=86400,   # 24 hours
    )

def get_csrf_from_cookie(request: Request) -> Optional[str]:
    return request.cookies.get("csrf_token")

def require_csrf(request: Request):
    """Dependency: validate CSRF token for state-changing requests.
    
    Exempt: API-Key auth, login/setup endpoints, GET requests.
    """
    method = request.method
    path = request.url.path
    
    # Skip for safe methods
    if method in ("GET", "HEAD", "OPTIONS"):
        return
    
    # Skip login/setup endpoints
    exempt_paths = {
        "/api/login", "/api/admin/login",
        "/api/setup/admin", "/api/setup/first-user", "/api/setup/status",
    }
    if path in exempt_paths:
        return
    
    # Skip if using API-Key auth
    auth = request.headers.get("Authorization", "")
    if auth.startswith("ApiKey "):
        return
    
    # Validate CSRF double-submit
    cookie_token = get_csrf_from_cookie(request)
    header_token = request.headers.get("X-CSRF-Token")
    
    if not cookie_token or not header_token:
        raise HTTPException(
            status_code=403,
            detail="CSRF token missing. Please include X-CSRF-Token header."
        )
    
    if not secrets.compare_digest(cookie_token, header_token):
        raise HTTPException(
            status_code=403,
            detail="CSRF token mismatch."
        )

# Migrationen beim Import ausführen (vor App-Start)
run_migrations()

app = FastAPI(title="nia-todo", version="0.4.0", docs_url=None, redoc_url=None, openapi_url=None)

# ─── CORS ─────────────────────────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://todo.kneidl-home.de",
        "https://todo-dev.kneidl-home.de",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Session-Token", "X-Admin-Token", "X-Requested-With"],
)

# ─── Rate Limiting Middleware ───────────────────────────────────────────────────

from starlette.middleware.base import BaseHTTPMiddleware

class RateLimitMiddleware(BaseHTTPMiddleware):
    """Apply API rate limiting to all requests except login/setup/WS endpoints."""
    async def dispatch(self, request: Request, call_next):
        # Skip rate limiting for non-API routes and login/setup endpoints
        path = request.url.path
        skip_paths = {
            "/api/login", "/api/admin/login",
            "/api/setup/admin", "/api/setup/first-user", "/api/setup/status",
            "/ws", "/", "/setup", "/admin", "/sw.js", "/favicon.ico"
        }
        if path in skip_paths or path.startswith("/static/") or not path.startswith("/api/"):
            return await call_next(request)
        # Check general API rate limit
        ip = get_client_ip(request)
        allowed, retry_after = rate_limiter.check_api(ip)
        if not allowed:
            return Response(
                content='{"detail":"Zu viele Anfragen. Bitte langsamer machen."}',
                status_code=429,
                headers={"Retry-After": str(retry_after), "Content-Type": "application/json"}
            )
        return await call_next(request)

app.add_middleware(RateLimitMiddleware)

# ─── Security Headers Middleware ─────────────────────────────────────────────

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add security headers to all responses."""
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' wss:;"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
        return response

class CSRFProtectionMiddleware(BaseHTTPMiddleware):
    """Validate CSRF token for all state-changing requests (POST/PUT/PATCH/DELETE).

    Skipped for:
    - Login/setup endpoints (these SET the CSRF token)
    - API key authentication (stateless)
    - Non-API routes (static files, pages, WS)
    """
    SKIP_PATHS = {
        "/api/login", "/api/admin/login",
        "/api/setup/admin", "/api/setup/first-user", "/api/setup/status",
    }

    async def dispatch(self, request: Request, call_next):
        method = request.method.upper()
        path = request.url.path

        # Only validate state-changing methods
        if method not in ("POST", "PUT", "PATCH", "DELETE"):
            return await call_next(request)

        # Skip non-API routes
        if not path.startswith("/api/"):
            return await call_next(request)

        # Skip login/setup endpoints
        if path in self.SKIP_PATHS:
            return await call_next(request)

        # Skip API key auth (stateless)
        auth = request.headers.get("Authorization", "")
        if auth.startswith("ApiKey "):
            return await call_next(request)
        elif auth.startswith("Bearer "):
            token = auth[7:]
            if token.startswith("nt_"):
                return await call_next(request)

        # Double-Submit Cookie Pattern
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

app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(CSRFProtectionMiddleware)

# ─── CSRF Protection ──────────────────────────────────────────────────────────

CSRF_COOKIE_NAME = "csrf_token"

def generate_csrf_token() -> str:
    """Generate a secure random CSRF token."""
    return secrets.token_urlsafe(32)

def set_csrf_cookie(response: Response, token: str) -> None:
    """Set the CSRF token as a SameSite=Lax HttpOnly cookie."""
    response.set_cookie(
        CSRF_COOKIE_NAME,
        token,
        httponly=True,
        samesite="lax",
        max_age=86400 * 7,  # 7 Tage
        path="/",
    )

def get_csrf_cookie(request: Request) -> Optional[str]:
    """Read the CSRF token from the request cookie."""
    return request.cookies.get(CSRF_COOKIE_NAME)

def require_csrf(
    request: Request,
    x_csrf_token: Optional[str] = Header(None, alias="X-CSRF-Token"),
    authorization: Optional[str] = Header(None),
) -> None:
    """
    Dependency: Validate CSRF token for state-changing requests.
    
    Skipped for:
    - API key authentication (Authorization: ApiKey ...)
    - Login/setup endpoints (handled by not including this dependency)
    """
    # API-Key Auth: stateless, kein CSRF nötig
    if authorization and authorization.startswith("ApiKey "):
        return
    
    # Double-Submit Cookie Pattern: Cookie + Header müssen matchen
    cookie_token = get_csrf_cookie(request)
    if not cookie_token or not x_csrf_token:
        raise HTTPException(403, "CSRF token missing")
    if not secrets.compare_digest(cookie_token, x_csrf_token):
        raise HTTPException(403, "CSRF token mismatch")

# ─── Auth / Session Helpers ───────────────────────────────────────────────────

# In-memory session store: token -> user_id (legacy fallback)
sessions = {}

# ─── Password Validation ──────────────────────────────────────────────────────

import re

def sanitize_text(text: str) -> str:
    """Strip HTML tags, remove null bytes, and trim whitespace from text input."""
    if text is None:
        return None
    text = str(text).strip().replace('\x00', '')
    text = re.sub(r'<[^>]+>', '', text)
    return text

def validate_password(password: str, min_length: int = 8) -> str:
    """Validates password meets security requirements. Returns error message or empty string if valid."""
    if len(password) < min_length:
        return f"Passwort muss mindestens {min_length} Zeichen lang sein"
    if not re.search(r'[A-Z]', password):
        return "Passwort muss mindestens einen Großbuchstaben enthalten"
    if not re.search(r'[a-z]', password):
        return "Passwort muss mindestens einen Kleinbuchstaben enthalten"
    if not re.search(r'\d', password):
        return "Passwort muss mindestens eine Ziffer enthalten"
    if not re.search(r'[!@#$%^&*()_+\-=\[\]{};\':"\\|,.<>\/?]', password):
        return "Passwort muss mindestens ein Sonderzeichen enthalten"
    return ""

def validate_admin_password(password: str) -> str:
    """Admin passwords require at least 12 characters."""
    return validate_password(password, min_length=12)

# ─── JWT Configuration ──────────────────────────────────────────────────────────

JWT_ALGORITHM = "HS256"
JWT_EXPIRY_DAYS = 1

def get_jwt_secret(db) -> str:
    """Get or create JWT secret from admin_config."""
    try:
        row = db.execute("SELECT jwt_secret FROM admin_config WHERE id = 1").fetchone()
        if row and row['jwt_secret']:
            return row['jwt_secret']
    except sqlite3.OperationalError:
        # Column doesn't exist yet, add it
        db.execute("ALTER TABLE admin_config ADD COLUMN jwt_secret TEXT")
        db.commit()
    # Generate new secret
    secret = secrets.token_urlsafe(32)
    db.execute(
        """INSERT INTO admin_config (id, jwt_secret, created_at)
           VALUES (1, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET jwt_secret = excluded.jwt_secret""",
        (secret,)
    )
    db.commit()
    return secret

def create_jwt_token(user: dict, db) -> str:
    """Create a JWT token with user info and token_version."""
    secret = get_jwt_secret(db)
    now = int(time.time())
    payload = {
        "user_id": user['id'],
        "username": user['username'],
        "token_version": user.get('token_version', 1),
        "is_admin": bool(user.get('is_admin', False)),
        "iat": now,
        "exp": now + (JWT_EXPIRY_DAYS * 86400)
    }
    return pyjwt.encode(payload, secret, algorithm=JWT_ALGORITHM)

def decode_jwt_token(token: str, db) -> Optional[dict]:
    """Decode and validate a JWT token."""
    if not token:
        return None
    try:
        secret = get_jwt_secret(db)
        payload = pyjwt.decode(token, secret, algorithms=[JWT_ALGORITHM])
        
        # Verify token_version matches DB
        user_id = payload.get('user_id')
        db_version = db.execute(
            "SELECT token_version FROM users WHERE id = ?",
            (user_id,)
        ).fetchone()
        
        if not db_version:
            return None
        if db_version['token_version'] != payload.get('token_version'):
            return None  # Token revoked
            
        return payload
    except pyjwt.ExpiredSignatureError:
        return None
    except pyjwt.InvalidTokenError:
        return None

def get_current_user(token: Optional[str] = None) -> Optional[int]:
    """Extract user_id from JWT token, API key, or legacy session fallback."""
    if not token:
        return None
    # Legacy session fallback
    legacy_user = sessions.get(token)
    if legacy_user:
        return legacy_user
    # JWT
    with get_db() as db:
        payload = decode_jwt_token(token, db)
        if payload:
            return payload.get('user_id')
        # API key
        if token.startswith("nt_"):
            prefix = token[3:11]  # "nt_" + 8 chars prefix
            cur = db.execute(
                "SELECT id, key_hash, user_id FROM api_keys WHERE key_prefix = ? AND revoked_at IS NULL",
                (prefix,)
            ).fetchall()
            for row in cur:
                if bcrypt.checkpw(token.encode(), row['key_hash'].encode()):
                    # Update last_used_at
                    db.execute(
                        "UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?",
                        (row['id'],)
                    )
                    db.commit()
                    return row['user_id']
    return None

def require_auth(authorization: Optional[str] = Header(None), x_session_token: Optional[str] = Header(None)) -> int:
    """Dependency: validate JWT or API key from Authorization header, or legacy X-Session-Token."""
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    elif authorization and authorization.startswith("ApiKey "):
        token = authorization[7:]
    elif x_session_token:
        token = x_session_token
    
    user_id = get_current_user(token)
    if not user_id:
        raise HTTPException(401, "Not authenticated")
    return user_id

def verify_user_credentials(db, username: str, password: str) -> Optional[dict]:
    row = db.execute(
        "SELECT id, username, display_name, password_hash, is_admin, token_version FROM users WHERE username = ?",
        (username,)
    ).fetchone()
    if not row:
        return None
    stored_hash = row['password_hash']
    if bcrypt.checkpw(password.encode(), stored_hash.encode()):
        return dict(row)
    return None

# ─── Audit Log Helper ────────────────────────────────────────────────────────

def log_audit(db, event_type: str, user_id: int = None, ip_address: str = None, details: str = None):
    """Log security-relevant events to audit_log table."""
    try:
        db.execute(
            """INSERT INTO audit_log (event_type, user_id, ip_address, details, created_at)
               VALUES (?, ?, ?, ?, datetime('now'))""",
            (event_type, user_id, ip_address, details)
        )
        db.commit()
    except Exception:
        pass  # Don't fail the request if audit logging fails

# ─── API Key Helpers ──────────────────────────────────────────────────────────

API_KEY_ALPHABET = string.ascii_letters + string.digits
API_KEY_LENGTH = 32  # after "nt_" prefix

def generate_api_key() -> str:
    """Generate a random API key: nt_ + 32 alphanumeric chars."""
    random_part = ''.join(secrets.choice(API_KEY_ALPHABET) for _ in range(API_KEY_LENGTH))
    return f"nt_{random_part}"

def hash_api_key(key: str) -> str:
    """Hash an API key with bcrypt."""
    return bcrypt.hashpw(key.encode(), bcrypt.gensalt()).decode()

def get_api_key_prefix(key: str) -> str:
    """Get the 8-char prefix after 'nt_' for quick lookup."""
    return key[3:11]  # e.g. "a3f9x2k8" from "nt_a3f9x2k8m..."

class CreateApiKeyRequest(BaseModel):
    name: Optional[str] = "API Key"

class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    sort_order: Optional[int] = None
    parent_id: Optional[int] = None

class SectionCreate(BaseModel):
    name: str
    sort_order: int = 0

class SectionUpdate(BaseModel):
    name: Optional[str] = None
    sort_order: Optional[int] = None

class LoginRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=32, pattern=r'^[a-zA-Z0-9_\-]+$')
    password: str = Field(..., min_length=1)

class UserResponse(BaseModel):
    id: int
    username: str
    display_name: str

class TodoCreate(BaseModel):
    title: str
    description: str = ""
    priority: int = Field(default=3, ge=1, le=4)
    project_id: Optional[int] = None
    section_id: Optional[int] = None
    due_date: Optional[str] = None
    remind_at: Optional[str] = None

class TodoUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[int] = None
    status: Optional[str] = None
    project_id: Optional[int] = None
    section_id: Optional[int] = None
    due_date: Optional[str] = None
    remind_at: Optional[str] = None

class ProjectCreate(BaseModel):
    name: str
    color: str = "#6366f1"
    sort_order: int = 0
    parent_id: Optional[int] = None

class PushSubscription(BaseModel):
    endpoint: str
    keys: dict  # { p256dh: str, auth: str }

class PushTestRequest(BaseModel):
    title: str = "🔔 Test-Benachrichtigung"
    body: str = "Push Notifications sind aktiviert! ✅"

# ─── Helper ────────────────────────────────────────────────────────────────────

def fetch_todo(db, todo_id: int) -> Optional[dict]:
    row = db.execute(
        """SELECT t.*, p.name as project_name, s.name as section_name
           FROM todos t
           LEFT JOIN projects p ON t.project_id = p.id
           LEFT JOIN sections s ON t.section_id = s.id
           WHERE t.id = ?""",
        (todo_id,)
    ).fetchone()
    if not row:
        return None
    d = row_to_dict(row)
    # reminders
    rem_rows = db.execute(
        "SELECT id, remind_at, sent_at FROM reminders WHERE todo_id = ? ORDER BY remind_at",
        (todo_id,)
    ).fetchall()
    d['reminders'] = [dict(r) for r in rem_rows]
    return d

# ─── WebSocket ConnectionManager ─────────────────────────────────────────────────

class ConnectionManager:
    def __init__(self):
        # user_id -> list of websockets
        self.connections: dict[int, list[WebSocket]] = {}
        # websocket -> user_id mapping
        self.ws_users: dict[WebSocket, int] = {}

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        # Don't add to connections yet - wait for auth

    def disconnect(self, websocket: WebSocket):
        user_id = self.ws_users.pop(websocket, None)
        if user_id and user_id in self.connections:
            if websocket in self.connections[user_id]:
                self.connections[user_id].remove(websocket)
            if not self.connections[user_id]:
                del self.connections[user_id]

    def register_auth(self, websocket: WebSocket, user_id: int):
        self.ws_users[websocket] = user_id
        if user_id not in self.connections:
            self.connections[user_id] = []
        self.connections[user_id].append(websocket)

    async def send_personal_message(self, message: dict, websocket: WebSocket):
        await websocket.send_json(message)

    async def broadcast_to_user(self, user_id: int, message: dict):
        """Send message only to connections of a specific user."""
        if user_id not in self.connections:
            return
        for connection in self.connections[user_id][:]:  # copy to allow removal
            try:
                await connection.send_json(message)
            except:
                pass

    async def broadcast(self, message: dict):
        """Broadcast to all authenticated connections (legacy)."""
        for user_id, connections in list(self.connections.items()):
            for connection in connections[:]:
                try:
                    await connection.send_json(message)
                except:
                    pass

manager = ConnectionManager()

# ─── WebSocket Endpoint ────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    ip = get_client_ip_ws(websocket)
    if not rate_limiter.check_ws(ip):
        await websocket.close(code=1008, reason="Too many connections")
        return
    rate_limiter.ws_connect(ip)
    try:
        await manager.connect(websocket)
        ws_user_id = None

        # Token kommt nur noch über auth Message, nicht mehr via query params
        ws_user_id = None

        try:
            data = await asyncio.wait_for(websocket.receive_json(), timeout=5.0)
        except asyncio.TimeoutError:
            await websocket.close(code=1008)
            return

        msg_type = data.get("type", "")
        if msg_type == "auth":
            token = data.get("token")
            user_id = get_current_user(token)
            if user_id:
                ws_user_id = user_id
                manager.register_auth(websocket, user_id)
                await manager.send_personal_message({"type": "auth_ok", "user_id": user_id}, websocket)
            else:
                await websocket.close(code=1008)
                return
        else:
            await websocket.close(code=1008)
            return

        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type", "")

            if msg_type == "auth":
                token = data.get("token")
                user_id = get_current_user(token)
                if user_id:
                    ws_user_id = user_id
                    manager.register_auth(websocket, user_id)  # Register for user-specific broadcasts
                    await manager.send_personal_message({"type": "auth_ok", "user_id": user_id}, websocket)
                else:
                    await manager.send_personal_message({"type": "auth_fail"}, websocket)
            elif msg_type == "ping":
                await manager.send_personal_message({"type": "pong", "ts": now_iso()}, websocket)
            elif msg_type == "sync_request":
                if not ws_user_id:
                    await manager.send_personal_message({"type": "error", "message": "Not authenticated"}, websocket)
                    continue
                # Client requested full sync -> send user's todos + projects
                with get_db() as db:
                    todos_rows = db.execute("""
                        SELECT t.*, p.name as project_name, s.name as section_name FROM todos t
                        LEFT JOIN projects p ON t.project_id = p.id
                        LEFT JOIN sections s ON t.section_id = s.id
                        WHERE t.user_id = ? AND t.status != 'archived'
                        ORDER BY CASE t.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, t.priority, t.due_date IS NULL, t.due_date
                    """, (ws_user_id,)).fetchall()
                    todos_out = []
                    for r in todos_rows:
                        d = row_to_dict(r)
                        # Add reminders
                        rem_rows = db.execute(
                            "SELECT id, remind_at, sent_at FROM reminders WHERE todo_id = ? ORDER BY remind_at",
                            (d['id'],)
                        ).fetchall()
                        d['reminders'] = [dict(r) for r in rem_rows]
                        d['labels'] = []
                        todos_out.append(d)
                    projects_rows = db.execute("SELECT * FROM projects WHERE user_id = ? ORDER BY sort_order, id", (ws_user_id,)).fetchall()
                    sections_rows = db.execute("SELECT * FROM sections WHERE user_id = ?", (ws_user_id,)).fetchall()
                    await manager.send_personal_message({
                        "type": "sync_response",
                        "todos": todos_out,
                        "projects": [dict(r) for r in projects_rows],
                        "sections": [dict(r) for r in sections_rows]
                    }, websocket)
    except WebSocketDisconnect:
        manager.disconnect(websocket)
        rate_limiter.ws_disconnect(ip)
    except Exception as e:
        print(f"[WS] Error: {e}")
        manager.disconnect(websocket)
        rate_limiter.ws_disconnect(ip)

async def broadcast_change(event_type: str, payload: dict, user_id: int):
    """Broadcast change only to the user who owns the data."""
    await manager.broadcast_to_user(user_id, {"type": event_type, "payload": payload})

# ─── VAPID / Push Notification Helpers ───────────────────────────────────────

VAPID_KEYS_PATH = Path(__file__).parent / "data" / "vapid_keys.json"
VAPID_CLAIMS = {"sub": "mailto:nia-todo@kneidl-home.de"}

def get_vapid_keys() -> tuple[str, str]:
    """Load or generate VAPID key pair (private_b64url, public_b64url).
    
    Returns raw base64url-encoded EC P-256 keys (32-byte private scalar,
    65-byte uncompressed public point). This is the format pywebpush expects.
    """
    if VAPID_KEYS_PATH.exists():
        try:
            data = json.loads(VAPID_KEYS_PATH.read_text())
            priv = data.get("private_b64url") or data.get("private_pem")
            pub = data.get("public_b64url")
            if priv and pub:
                # Validate by loading
                Vapid.from_string(private_key=priv)
                return priv, pub
        except Exception:
            pass  # Regenerate on any error
    # Generate new keys
    v = Vapid()
    v.generate_keys()
    # Raw 32-byte private scalar
    priv_raw = v.private_key.private_numbers().private_value.to_bytes(32, "big")
    priv_b64url = base64.urlsafe_b64encode(priv_raw).decode().rstrip("=")
    # Raw 65-byte uncompressed public point
    pub_raw = v.public_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint
    )
    pub_b64url = base64.urlsafe_b64encode(pub_raw).decode().rstrip("=")
    VAPID_KEYS_PATH.parent.mkdir(parents=True, exist_ok=True)
    VAPID_KEYS_PATH.write_text(json.dumps({"private_b64url": priv_b64url, "public_b64url": pub_b64url}))
    return priv_b64url, pub_b64url

def get_vapid_private_key() -> str:
    """Return VAPID private key in base64url format for pywebpush."""
    return get_vapid_keys()[0]

def get_vapid_public_key() -> str:
    return get_vapid_keys()[1]

async def send_push_notification(user_id: int, title: str, body: str, tag: str, url: str = "/", todo_id: int = None) -> bool:
    """Send push notification to all subscriptions of a user. Returns True if at least one was sent."""
    priv_key = get_vapid_private_key()
    payload = json.dumps({"title": title, "body": body, "tag": tag, "url": url, "todoId": todo_id})

    with get_db() as db:
        subs = db.execute(
            "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?",
            (user_id,)
        ).fetchall()

    if not subs:
        print(f"[PUSH] No subscriptions for user {user_id}")
        return False

    success = False
    for sub in subs:
        subscription_info = {
            "endpoint": sub["endpoint"],
            "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}
        }
        try:
            webpush(
                subscription_info=subscription_info,
                data=payload,
                vapid_private_key=priv_key,
                vapid_claims=VAPID_CLAIMS,
                ttl=3600,
            )
            success = True
        except WebPushException as e:
            # Remove expired/invalid subscriptions
            if e.response and e.response.status_code in (404, 410):
                try:
                    with get_db() as db:
                        db.execute("DELETE FROM push_subscriptions WHERE id = ?", (sub["id"],))
                        db.commit()
                        print(f"[PUSH] Removed expired subscription {sub['id']}")
                except Exception:
                    pass
            else:
                print(f"[PUSH] Failed for user {user_id}: {e}")
        except Exception as e:
            print(f"[PUSH] Error for user {user_id}: {e}")
    
    return success

async def check_and_send_reminders():
    """Background task: check for due reminders and send push notifications."""
    try:
        with get_db() as db:
            rows = db.execute("""
                SELECT r.id, r.todo_id, r.remind_at, t.user_id, t.title, t.status
                FROM reminders r
                JOIN todos t ON r.todo_id = t.id
                WHERE datetime(r.remind_at) <= datetime('now')
                  AND r.sent_at IS NULL
                  AND t.status IN ('pending', 'in_progress')
                ORDER BY r.remind_at
            """).fetchall()

        for row in rows:
            success = await send_push_notification(
                user_id=row["user_id"],
                title="⏰ Erinnerung",
                body=row["title"],
                tag=f"reminder-{row['todo_id']}",
                url="/",
                todo_id=row["todo_id"]
            )
            if success:
                # Only mark as sent if push was delivered
                try:
                    with get_db() as db:
                        db.execute(
                            "UPDATE reminders SET sent_at = datetime('now') WHERE id = ?",
                            (row["id"],)
                        )
                        db.commit()
                except Exception as e:
                    print(f"[PUSH] Failed to mark reminder {row['id']} as sent: {e}")
    except Exception as e:
        print(f"[PUSH] Reminder check error: {e}")

async def reminder_background_task():
    """Run reminder check every 60 seconds."""
    print("[PUSH] Background reminder task started")
    while True:
        try:
            print("[PUSH] Checking reminders...")
            await check_and_send_reminders()
            print("[PUSH] Reminder check done")
        except Exception as e:
            print(f"[PUSH] Background task error: {e}")
        await asyncio.sleep(60)

# ─── Init DB on startup ─────────────────────────────────────────────────────

@app.on_event("startup")
async def on_startup():
    init_db()
    # Start background reminder loop after a short delay to ensure event loop is running
    async def delayed_start():
        await asyncio.sleep(2)
        print("[PUSH] Starting background reminder task...")
        asyncio.create_task(reminder_background_task())
    asyncio.create_task(delayed_start())

# ─── Auth Endpoints (JWT) ─────────────────────────────────────────────────────

@app.post("/api/login")
def login(data: LoginRequest, request: Request, response: Response, _: None = Depends(require_login_rate_limit)):
    ip = get_client_ip(request)
    with get_db() as db:
        user = verify_user_credentials(db, data.username, data.password)
        if not user:
            log_audit(db, "login_failed", ip_address=ip, details=f"username={data.username}")
            raise HTTPException(401, "Invalid credentials")
        rate_limiter.record_successful_login(ip)
        log_audit(db, "login_success", user_id=user['id'], ip_address=ip)
        # Generate JWT with versioned secrets
        token = create_jwt_token(user, db)
        # Generate and set CSRF token (Double-Submit Cookie)
        csrf_token = generate_csrf_token()
        set_csrf_cookie(response, csrf_token)
        return {
            "access_token": token,
            "token_type": "bearer",
            "user": {
                "id": user['id'],
                "username": user['username'],
                "display_name": user['display_name'],
                "is_admin": bool(user.get('is_admin', False))
            },
            "csrf_token": csrf_token
        }

@app.post("/api/logout")
def logout(authorization: Optional[str] = Header(None), x_session_token: Optional[str] = Header(None), request: Request = None):
    """Logout: invalidate all tokens by incrementing token_version."""
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    elif x_session_token:
        token = x_session_token
    
    with get_db() as db:
        payload = decode_jwt_token(token, db)
        if payload:
            user_id = payload.get('user_id')
            db.execute(
                "UPDATE users SET token_version = token_version + 1 WHERE id = ?",
                (user_id,)
            )
            db.commit()
            ip = get_client_ip(request) if request else None
            log_audit(db, "logout", user_id=user_id, ip_address=ip)
        # Also remove legacy session
        if x_session_token and x_session_token in sessions:
            del sessions[x_session_token]
    
    return {"logged_out": True}

@app.get("/api/me")
def me(authorization: Optional[str] = Header(None), x_session_token: Optional[str] = Header(None)):
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    elif x_session_token:
        token = x_session_token
    
    with get_db() as db:
        payload = decode_jwt_token(token, db)
        if not payload:
            # Legacy fallback
            user_id = sessions.get(token) if token else None
            if not user_id:
                raise HTTPException(401, "Not authenticated")
        else:
            user_id = payload.get('user_id')
        
        user = db.execute(
            "SELECT id, username, display_name, is_admin FROM users WHERE id = ?",
            (user_id,)
        ).fetchone()
        if not user:
            raise HTTPException(404, "User not found")
        return dict(user)

# ─── Admin / Setup Endpoints (NO auth required for setup) ─────────────────────

class SetupStatusResponse(BaseModel):
    setup_complete: bool
    has_users: bool

class AdminSetupRequest(BaseModel):
    admin_password: str

class FirstUserRequest(BaseModel):
    username: str
    password: str
    display_name: str

class CreateUserRequest(BaseModel):
    username: str
    password: str
    display_name: str

class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str

class ChangeAdminPasswordRequest(BaseModel):
    old_password: str
    new_password: str

class ResetUserPasswordRequest(BaseModel):
    new_password: str

class AdminLoginRequest(BaseModel):
    password: str

@app.get("/api/setup/status")
def setup_status():
    with get_db() as db:
        config = db.execute("SELECT setup_complete FROM admin_config WHERE id = 1").fetchone()
        user_count = db.execute("SELECT COUNT(*) as c FROM users").fetchone()['c']
        return {
            "setup_complete": bool(config['setup_complete']) if config else False,
            "has_users": user_count > 0
        }

@app.post("/api/setup/admin")
def setup_admin(data: AdminSetupRequest, request: Request, _: None = Depends(require_login_rate_limit)):
    # Validate admin password
    error = validate_admin_password(data.admin_password)
    if error:
        raise HTTPException(400, error)
    
    with get_db() as db:
        # Check if already set up
        config = db.execute("SELECT setup_complete, admin_token_hash FROM admin_config WHERE id = 1").fetchone()
        if config and config['setup_complete']:
            raise HTTPException(400, "Setup already complete")
        if config and config['admin_token_hash']:
            raise HTTPException(400, "Admin password already set")
        
        # Hash admin password
        admin_hash = bcrypt.hashpw(data.admin_password.encode(), bcrypt.gensalt()).decode()
        
        # Insert or update admin config
        db.execute(
            """INSERT INTO admin_config (id, setup_complete, admin_token_hash, created_at)
               VALUES (1, 0, ?, datetime('now'))
               ON CONFLICT(id) DO UPDATE SET
               admin_token_hash = excluded.admin_token_hash""",
            (admin_hash,)
        )
        db.commit()
        return {"message": "Admin password set"}

@app.post("/api/setup/first-user")
def setup_first_user(data: FirstUserRequest, request: Request, _: None = Depends(require_login_rate_limit)):
    data.username = sanitize_text(data.username)
    data.display_name = sanitize_text(data.display_name)
    # Validate user password (min 8 chars)
    error = validate_password(data.password)
    if error:
        raise HTTPException(400, error)
    
    with get_db() as db:
        # Check if users exist
        user_count = db.execute("SELECT COUNT(*) as c FROM users").fetchone()['c']
        if user_count > 0:
            raise HTTPException(400, "Users already exist. Use /api/admin/users")
        
        # Create first user as admin
        password_hash = bcrypt.hashpw(data.password.encode(), bcrypt.gensalt()).decode()
        c = db.execute(
            "INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, 1)",
            (data.username, data.display_name, password_hash)
        )
        user_id = c.lastrowid
        
        # Assign all unassigned data to this user
        db.execute("UPDATE projects SET user_id = ? WHERE user_id IS NULL", (user_id,))
        db.execute("UPDATE todos SET user_id = ? WHERE user_id IS NULL", (user_id,))
        db.execute("UPDATE sections SET user_id = ? WHERE user_id IS NULL", (user_id,))
        
        # Mark setup as complete
        db.execute("UPDATE admin_config SET setup_complete = 1 WHERE id = 1")
        db.commit()
        
        return {
            "message": "First user created",
            "user": {
                "id": user_id,
                "username": data.username,
                "display_name": data.display_name
            }
        }

# ─── Admin Endpoints (require admin JWT via Authorization: Bearer header) ─────

def get_admin_jwt_secret() -> str:
    """Get or create JWT secret for admin tokens (shared with user JWTs)."""
    with get_db() as db:
        return get_jwt_secret(db)

def create_admin_jwt_token(db) -> str:
    """Create a JWT token for admin with admin_token_version."""
    secret = get_jwt_secret(db)
    now = int(time.time())
    config = db.execute("SELECT admin_token_version FROM admin_config WHERE id = 1").fetchone()
    admin_version = config["admin_token_version"] if config else 1
    payload = {
        "sub": "admin",
        "role": "admin",
        "admin_version": admin_version,
        "iat": now,
        "exp": now + (JWT_EXPIRY_DAYS * 86400)
    }
    return pyjwt.encode(payload, secret, algorithm=JWT_ALGORITHM)

def verify_admin_token(authorization: Optional[str] = Header(None)) -> bool:
    """Verify admin JWT token and check admin_token_version."""
    if not authorization or not authorization.startswith("Bearer "):
        return False
    token = authorization[7:]
    try:
        secret = get_admin_jwt_secret()
        payload = pyjwt.decode(token, secret, algorithms=[JWT_ALGORITHM])
        if payload.get("role") != "admin":
            return False
        if payload.get("sub") != "admin":
            return False
        
        # Check admin_token_version
        with get_db() as db:
            config = db.execute("SELECT admin_token_version FROM admin_config WHERE id = 1").fetchone()
            if not config:
                return False
            if payload.get("admin_version") != config["admin_token_version"]:
                return False
        return True
    except pyjwt.ExpiredSignatureError:
        return False
    except pyjwt.InvalidTokenError:
        return False
    except Exception:
        return False

def require_admin(authorization: Optional[str] = Header(None)):
    if not verify_admin_token(authorization):
        raise HTTPException(status_code=403, detail="Admin-Authentifizierung erforderlich")
    return True

@app.post("/api/admin/login")
def admin_login(data: AdminLoginRequest, request: Request, response: Response, _: None = Depends(require_login_rate_limit)):
    """Admin login with password, returns JWT token."""
    ip = get_client_ip(request)
    with get_db() as db:
        config = db.execute("SELECT admin_token_hash, setup_complete FROM admin_config WHERE id = 1").fetchone()
        if not config:
            raise HTTPException(400, "Setup erforderlich")
        if not config["admin_token_hash"]:
            raise HTTPException(400, "Setup erforderlich")
        if not config["setup_complete"]:
            raise HTTPException(400, "Setup erforderlich")
        
        if not bcrypt.checkpw(data.password.encode(), config["admin_token_hash"].encode()):
            raise HTTPException(401, "Falsches Admin-Passwort")
        
        token = create_admin_jwt_token(db)
        # Generate and set CSRF token (Double-Submit Cookie)
        csrf_token = generate_csrf_token()
        set_csrf_cookie(response, csrf_token)
        rate_limiter.record_successful_login(ip)
        return {
            "access_token": token,
            "token_type": "bearer",
            "admin": True,
            "csrf_token": csrf_token
        }

@app.post("/api/admin/logout")
def admin_logout(authorization: Optional[str] = Header(None), _: bool = Depends(require_admin)):
    """Admin logout: invalidate all admin JWTs by incrementing admin_token_version."""
    with get_db() as db:
        db.execute(
            "UPDATE admin_config SET admin_token_version = admin_token_version + 1 WHERE id = 1"
        )
        db.commit()
    return {"message": "Admin abgemeldet. Alle Admin-Sessions ungültig."}

@app.post("/api/admin/users")
def create_user(data: CreateUserRequest, _: bool = Depends(require_admin)):
    data.username = sanitize_text(data.username)
    data.display_name = sanitize_text(data.display_name)
    # Validate user password (min 8 chars)
    error = validate_password(data.password)
    if error:
        raise HTTPException(400, error)
    
    with get_db() as db:
        # Check if username exists
        existing = db.execute("SELECT id FROM users WHERE username = ?", (data.username,)).fetchone()
        if existing:
            raise HTTPException(409, "Username already exists")
        
        password_hash = bcrypt.hashpw(data.password.encode(), bcrypt.gensalt()).decode()
        c = db.execute(
            "INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, 0)",
            (data.username, data.display_name, password_hash)
        )
        user_id = c.lastrowid
        db.commit()
        log_audit(db, "user_created", user_id=user_id, details=f"username={data.username}")
        return {
            "id": user_id,
            "username": data.username,
            "display_name": data.display_name,
            "created_at": now_iso()
        }

@app.get("/api/admin/users")
def list_users(_: bool = Depends(require_admin)):
    with get_db() as db:
        rows = db.execute(
            "SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY id"
        ).fetchall()
        return {"users": [dict(r) for r in rows]}

@app.delete("/api/admin/users/{user_id}")
def delete_user(user_id: int, _: bool = Depends(require_admin)):
    with get_db() as db:
        # Prevent deleting yourself - need to check who the admin is
        # For simplicity, prevent deleting user id 1 (first admin)
        user = db.execute("SELECT is_admin FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            raise HTTPException(404, "User not found")
        if user['is_admin']:
            raise HTTPException(400, "Cannot delete admin user")

        db.execute("DELETE FROM api_keys WHERE user_id = ?", (user_id,))
        db.execute("DELETE FROM reminders WHERE todo_id IN (SELECT id FROM todos WHERE user_id = ?)", (user_id,))
        db.execute("DELETE FROM sections WHERE user_id = ?", (user_id,))
        db.execute("DELETE FROM todos WHERE user_id = ?", (user_id,))
        db.execute("DELETE FROM projects WHERE user_id = ? AND id != 1", (user_id,))
        db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        db.commit()
        return {"deleted": user_id}

# ─── Password Change Endpoints ────────────────────────────────────────────────

@app.post("/api/me/change-password")
def change_own_password(data: ChangePasswordRequest, user_id: int = Depends(require_auth)):
    """User changes their own password. Invalidates all existing JWTs."""
    # Validate new password strength
    error = validate_password(data.new_password)
    if error:
        raise HTTPException(400, error)

    with get_db() as db:
        # Get user's current password hash
        row = db.execute(
            "SELECT password_hash FROM users WHERE id = ?",
            (user_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "User not found")

        # Verify old password
        if not bcrypt.checkpw(data.old_password.encode(), row['password_hash'].encode()):
            raise HTTPException(401, "Altes Passwort ist falsch")

        # Hash new password
        new_hash = bcrypt.hashpw(data.new_password.encode(), bcrypt.gensalt()).decode()

        # Update password and increment token_version (invalidates all JWTs)
        db.execute(
            "UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?",
            (new_hash, user_id)
        )
        db.commit()

    return {"message": "Passwort geändert. Bitte melde dich erneut an."}

@app.post("/api/admin/change-password")
def change_admin_password(data: ChangeAdminPasswordRequest, _: bool = Depends(require_admin)):
    """Admin changes the admin password (admin_config.admin_token_hash)."""
    # Validate new password strength
    error = validate_admin_password(data.new_password)
    if error:
        raise HTTPException(400, error)

    with get_db() as db:
        # Get current admin hash
        config = db.execute("SELECT admin_token_hash FROM admin_config WHERE id = 1").fetchone()
        if not config or not config['admin_token_hash']:
            raise HTTPException(500, "Admin-Konfiguration nicht gefunden")

        # Verify old password
        if not bcrypt.checkpw(data.old_password.encode(), config['admin_token_hash'].encode()):
            raise HTTPException(401, "Altes Admin-Passwort ist falsch")

        # Hash new admin password
        new_hash = bcrypt.hashpw(data.new_password.encode(), bcrypt.gensalt()).decode()

        db.execute(
            "UPDATE admin_config SET admin_token_hash = ?, admin_token_version = admin_token_version + 1 WHERE id = 1",
            (new_hash,)
        )
        db.commit()

    return {"message": "Admin-Passwort geändert. Bitte melde dich erneut an."}

@app.post("/api/admin/users/{user_id}/change-password")
def admin_change_user_password(user_id: int, data: ResetUserPasswordRequest, _: bool = Depends(require_admin)):
    """Admin changes any user's password. Invalidates that user's sessions."""
    # Validate new password strength
    error = validate_password(data.new_password)
    if error:
        raise HTTPException(400, error)

    with get_db() as db:
        # Check user exists
        user = db.execute(
            "SELECT id FROM users WHERE id = ?",
            (user_id,)
        ).fetchone()
        if not user:
            raise HTTPException(404, "User not found")

        # Hash new password and increment token_version
        new_hash = bcrypt.hashpw(data.new_password.encode(), bcrypt.gensalt()).decode()
        db.execute(
            "UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?",
            (new_hash, user_id)
        )
        db.commit()

    return {"message": "Passwort geändert. Der Benutzer muss sich erneut anmelden."}

# ─── API Key Endpoints ──────────────────────────────────────────────────────────

@app.get("/api/me/api-keys")
def list_api_keys(user_id: int = Depends(require_auth)):
    """List user's API keys (metadata only, no full keys)."""
    with get_db() as db:
        rows = db.execute("""
            SELECT id, name, key_prefix, created_at, last_used_at, revoked_at
            FROM api_keys
            WHERE user_id = ?
            ORDER BY created_at DESC
        """, (user_id,)).fetchall()
        return {"api_keys": [dict(r) for r in rows]}

@app.post("/api/me/api-keys")
def create_api_key(data: CreateApiKeyRequest, user_id: int = Depends(require_auth)):
    """Create a new API key. Full key is returned ONLY ONCE."""
    name = sanitize_text(data.name) or "API Key"
    with get_db() as db:
        # Generate key
        full_key = generate_api_key()
        key_hash = hash_api_key(full_key)
        key_prefix = get_api_key_prefix(full_key)

        c = db.execute(
            """INSERT INTO api_keys (user_id, name, key_hash, key_prefix, created_at)
               VALUES (?, ?, ?, ?, datetime('now'))""",
            (user_id, name, key_hash, key_prefix)
        )
        db.commit()

        return {
            "id": c.lastrowid,
            "name": name,
            "prefix": f"nt_{key_prefix}",
            "key": full_key,  # ONLY shown once
            "created_at": now_iso()
        }

@app.delete("/api/me/api-keys/{key_id}")
def revoke_api_key(key_id: int, user_id: int = Depends(require_auth)):
    """Revoke (soft-delete) an API key by setting revoked_at."""
    with get_db() as db:
        key = db.execute(
            "SELECT id FROM api_keys WHERE id = ? AND user_id = ?",
            (key_id, user_id)
        ).fetchone()
        if not key:
            raise HTTPException(404, "API key not found")

        db.execute(
            "UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?",
            (key_id,)
        )
        db.commit()
        return {"revoked": key_id}

# ─── Todos ────────────────────────────────────────────────────────────────────

@app.get("/api/todos")
def list_todos(status: Optional[str] = None, project_id: Optional[int] = None, section_id: Optional[int] = None, user_id: int = Depends(require_auth)):
    with get_db() as db:
        sql = """
            SELECT t.*, p.name as project_name, s.name as section_name FROM todos t
            LEFT JOIN projects p ON t.project_id = p.id
            LEFT JOIN sections s ON t.section_id = s.id
            WHERE t.user_id = ? AND t.status != 'archived'
        """
        params = [user_id]
        if status:
            sql += " AND t.status = ?"
            params.append(status)
        if project_id is not None:
            sql += " AND t.project_id = ?"
            params.append(project_id)
        if section_id is not None:
            sql += " AND t.section_id = ?"
            params.append(section_id)
        sql += " ORDER BY CASE t.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, t.priority, t.due_date IS NULL, t.due_date"
        rows = db.execute(sql, params).fetchall()
        result = []
        for r in rows:
            d = row_to_dict(r)
            tid = d['id']
            d['labels'] = []
            result.append(d)
        return {"todos": result}

@app.post("/api/todos")
async def create_todo(data: TodoCreate, user_id: int = Depends(require_auth)):
    data.title = sanitize_text(data.title)
    data.description = sanitize_text(data.description)
    with get_db() as db:
        c = db.execute(
            "INSERT INTO todos (title, description, priority, project_id, section_id, due_date, updated_at, user_id) VALUES (?,?,?,?,?,?,?,?)",
            (data.title, data.description, data.priority, data.project_id, data.section_id, data.due_date, now_iso(), user_id)
        )
        todo_id = c.lastrowid
        if data.remind_at:
            db.execute("INSERT INTO reminders (todo_id, remind_at, user_id) VALUES (?,?,?)", (todo_id, data.remind_at, user_id))
        db.commit()
        todo = fetch_todo(db, todo_id)
        await broadcast_change("todo_create", todo, user_id)
        return todo

@app.get("/api/todos/{todo_id}")
def get_todo(todo_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        d = fetch_todo(db, todo_id)
        if not d:
            raise HTTPException(404, "Todo not found")
        if d.get('user_id') != user_id:
            raise HTTPException(403, "Not authorized")
        return d

@app.patch("/api/todos/{todo_id}")
async def update_todo(todo_id: int, data: TodoUpdate, user_id: int = Depends(require_auth)):
    if data.title is not None:
        data.title = sanitize_text(data.title)
    if data.description is not None:
        data.description = sanitize_text(data.description)
    with get_db() as db:
        existing = fetch_todo(db, todo_id)
        if not existing:
            raise HTTPException(404, "Todo not found")
        if existing.get('user_id') != user_id:
            raise HTTPException(403, "Not authorized")
        updates = {}
        dumped = data.model_dump(exclude_unset=True)
        for f in ["title","description","priority","project_id","section_id","due_date","status"]:
            if f in dumped:
                updates[f] = dumped[f]
        if updates:
            updates['updated_at'] = now_iso()
            if data.status == 'done' and existing['status'] != 'done':
                updates['completed_at'] = now_iso()
            elif data.status != 'done' and existing['status'] == 'done':
                updates['completed_at'] = None
            # Whitelist allowed columns to prevent SQL injection
            allowed_cols = {"title","description","priority","project_id","section_id","due_date","status","completed_at","updated_at"}
            safe_updates = {k:v for k,v in updates.items() if k in allowed_cols}
            set_clause = ", ".join(f"{k}=:{k}" for k in safe_updates)
            db.execute(f"UPDATE todos SET {set_clause} WHERE id = :id", {**safe_updates, "id": todo_id})
        if data.remind_at is not None:
            db.execute("DELETE FROM reminders WHERE todo_id = ?", (todo_id,))
            if data.remind_at:
                db.execute("INSERT INTO reminders (todo_id, remind_at, user_id) VALUES (?,?,?)", (todo_id, data.remind_at, user_id))
        db.commit()
        todo = fetch_todo(db, todo_id)
        await broadcast_change("todo_update", todo, user_id)
        return todo

@app.delete("/api/todos/{todo_id}")
async def delete_todo(todo_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        existing = fetch_todo(db, todo_id)
        if not existing:
            raise HTTPException(404, "Todo not found")
        if existing.get('user_id') != user_id:
            raise HTTPException(403, "Not authorized")
        db.execute("DELETE FROM todos WHERE id = ?", (todo_id,))
        db.commit()
        await broadcast_change("todo_delete", {"id": todo_id}, user_id)
        return {"deleted": todo_id}

# ─── Projects ────────────────────────────────────────────────────────────────

@app.get("/api/projects")
def list_projects(user_id: int = Depends(require_auth)):
    with get_db() as db:
        rows = db.execute("SELECT * FROM projects WHERE user_id = ? ORDER BY parent_id, sort_order, id", (user_id,)).fetchall()
        return {"projects": [dict(r) for r in rows]}

@app.post("/api/projects")
async def create_project(data: ProjectCreate, user_id: int = Depends(require_auth)):
    data.name = sanitize_text(data.name)
    with get_db() as db:
        # Validate parent_id: cannot be self and must exist and belong to user
        if data.parent_id is not None:
            parent = db.execute("SELECT * FROM projects WHERE id = ? AND user_id = ?", (data.parent_id, user_id)).fetchone()
            if not parent:
                raise HTTPException(404, "Parent project not found")
        
        c = db.execute(
            "INSERT INTO projects (name, color, sort_order, parent_id, updated_at, user_id) VALUES (?,?,?,?,?,?)",
            (data.name, data.color, data.sort_order, data.parent_id, now_iso(), user_id)
        )
        db.commit()
        row = db.execute("SELECT * FROM projects WHERE id = ?", (c.lastrowid,)).fetchone()
        proj = dict(row)
        await broadcast_change("project_create", proj, user_id)
        return proj

@app.patch("/api/projects/{project_id}")
async def update_project(project_id: int, data: ProjectUpdate, user_id: int = Depends(require_auth)):
    if data.name is not None:
        data.name = sanitize_text(data.name)
    with get_db() as db:
        existing = db.execute("SELECT * FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id)).fetchone()
        if not existing:
            raise HTTPException(404, "Project not found")
        
        # Validate parent_id update: prevent circular dependencies
        if data.parent_id is not None:
            if data.parent_id == project_id:
                raise HTTPException(400, "Project cannot be its own parent")
            # Check if target parent is a descendant of this project (would create cycle)
            current_check = data.parent_id
            while current_check is not None:
                ancestor = db.execute("SELECT parent_id FROM projects WHERE id = ? AND user_id = ?", (current_check, user_id)).fetchone()
                if ancestor and ancestor['parent_id'] == project_id:
                    raise HTTPException(400, "Circular dependency: target parent is a descendant of this project")
                current_check = ancestor['parent_id'] if ancestor else None
        
        updates = {}
        for f in ["name","color","sort_order","parent_id"]:
            v = getattr(data, f)
            if v is not None:
                updates[f] = v
        if updates:
            updates['updated_at'] = now_iso()
            # Whitelist allowed columns to prevent SQL injection
            allowed_cols = {"name", "color", "sort_order", "parent_id", "updated_at"}
            safe_updates = {k: v for k, v in updates.items() if k in allowed_cols}
            set_clause = ", ".join(f"{k}=:{k}" for k in safe_updates)
            db.execute(f"UPDATE projects SET {set_clause} WHERE id = :id", {**safe_updates, "id": project_id})
            db.commit()
        row = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        proj = dict(row)
        await broadcast_change("project_update", proj, user_id)
        return proj

@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: int, user_id: int = Depends(require_auth)):
    if project_id == 1:
        raise HTTPException(400, "Inbox cannot be deleted")
    with get_db() as db:
        # Check ownership
        proj = db.execute("SELECT * FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id)).fetchone()
        if not proj:
            raise HTTPException(404, "Project not found")
        # Find all descendant project IDs (recursive)
        to_delete = []
        queue = [project_id]
        while queue:
            pid = queue.pop(0)
            to_delete.append(pid)
            children = db.execute("SELECT id FROM projects WHERE parent_id = ? AND user_id = ?", (pid, user_id)).fetchall()
            for child in children:
                queue.append(child['id'])
        
        # Move all todos from all projects to inbox
        for pid in to_delete:
            db.execute("UPDATE todos SET project_id = 1, section_id = NULL WHERE project_id = ? AND user_id = ?", (pid, user_id))
        
        # Delete sections and projects (order matters for FK constraints)
        for pid in to_delete:
            db.execute("DELETE FROM sections WHERE project_id = ?", (pid,))
        for pid in reversed(to_delete):  # Children first
            db.execute("DELETE FROM projects WHERE id = ?", (pid,))
        
        db.commit()
        await broadcast_change("project_delete", {"id": project_id}, user_id)
        return {"deleted": project_id}

# ─── Sections ───────────────────────────────────────────────────────────────

@app.get("/api/sections")
def list_all_sections(user_id: int = Depends(require_auth)):
    with get_db() as db:
        rows = db.execute(
            """
            SELECT s.* FROM sections s
            JOIN projects p ON s.project_id = p.id
            WHERE p.user_id = ?
            ORDER BY s.sort_order, s.id
            """,
            (user_id,)
        ).fetchall()
        return {"sections": [dict(r) for r in rows]}

@app.get("/api/projects/{project_id}/sections")
def list_sections(project_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        # Check ownership
        proj = db.execute("SELECT * FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id)).fetchone()
        if not proj:
            raise HTTPException(404, "Project not found")
        rows = db.execute(
            "SELECT * FROM sections WHERE project_id = ? ORDER BY sort_order, id",
            (project_id,)
        ).fetchall()
        return {"sections": [dict(r) for r in rows]}

@app.post("/api/projects/{project_id}/sections")
async def create_section(project_id: int, data: SectionCreate, user_id: int = Depends(require_auth)):
    data.name = sanitize_text(data.name)
    with get_db() as db:
        # Verify project exists and belongs to user
        proj = db.execute("SELECT id FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id)).fetchone()
        if not proj:
            raise HTTPException(404, "Project not found")
        c = db.execute(
            "INSERT INTO sections (project_id, name, sort_order, created_at, updated_at, user_id) VALUES (?,?,?,?,?,?)",
            (project_id, data.name, data.sort_order, now_iso(), now_iso(), user_id)
        )
        db.commit()
        row = db.execute("SELECT * FROM sections WHERE id = ?", (c.lastrowid,)).fetchone()
        section = dict(row)
        await broadcast_change("section_create", section, user_id)
        return section

@app.patch("/api/sections/{section_id}")
async def update_section(section_id: int, data: SectionUpdate, user_id: int = Depends(require_auth)):
    if data.name is not None:
        data.name = sanitize_text(data.name)
    with get_db() as db:
        existing = db.execute("""
            SELECT s.* FROM sections s
            JOIN projects p ON s.project_id = p.id
            WHERE s.id = ? AND p.user_id = ?
        """, (section_id, user_id)).fetchone()
        if not existing:
            raise HTTPException(404, "Section not found")
        updates = {}
        for f in ["name", "sort_order"]:
            v = getattr(data, f)
            if v is not None:
                updates[f] = v
        if updates:
            updates['updated_at'] = now_iso()
            set_clause = ", ".join(f"{k}=:{k}" for k in updates)
            db.execute(f"UPDATE sections SET {set_clause} WHERE id = :id", {**updates, "id": section_id})
            db.commit()
        row = db.execute("SELECT * FROM sections WHERE id = ?", (section_id,)).fetchone()
        section = dict(row)
        await broadcast_change("section_update", section, user_id)
        return section

@app.delete("/api/sections/{section_id}")
async def delete_section(section_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        existing = db.execute("""
            SELECT s.* FROM sections s
            JOIN projects p ON s.project_id = p.id
            WHERE s.id = ? AND p.user_id = ?
        """, (section_id, user_id)).fetchone()
        if not existing:
            raise HTTPException(404, "Section not found")
        # Move todos to unsorted (section_id = NULL)
        db.execute("UPDATE todos SET section_id = NULL WHERE section_id = ? AND user_id = ?", (section_id, user_id))
        db.execute("DELETE FROM sections WHERE id = ?", (section_id,))
        db.commit()
        await broadcast_change("section_delete", {"id": section_id}, user_id)
        return {"deleted": section_id}

# ─── Reminders ───────────────────────────────────────────────────────────────

@app.get("/api/reminders")
def list_reminders(due_only: bool = False, user_id: int = Depends(require_auth)):
    with get_db() as db:
        sql = """
            SELECT r.*, t.title, t.status FROM reminders r
            JOIN todos t ON r.todo_id = t.id
            WHERE t.user_id = ? AND t.status IN ('pending','in_progress')
        """
        params = [user_id]
        if due_only:
            sql += " AND r.remind_at <= datetime('now') AND r.sent_at IS NULL"
        sql += " ORDER BY r.remind_at"
        rows = db.execute(sql, params).fetchall()
        return {"reminders": [dict(r) for r in rows]}

@app.post("/api/reminders/{reminder_id}/sent")
def mark_reminder_sent(reminder_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        # Verify reminder belongs to user's todo
        reminder = db.execute("""
            SELECT r.* FROM reminders r
            JOIN todos t ON r.todo_id = t.id
            WHERE r.id = ? AND t.user_id = ?
        """, (reminder_id, user_id)).fetchone()
        if not reminder:
            raise HTTPException(404, "Reminder not found")
        db.execute("UPDATE reminders SET sent_at = ? WHERE id = ?", (now_iso(), reminder_id))
        db.commit()
        return {"sent": reminder_id}

# ─── Dashboard / Stats ───────────────────────────────────────────────────────

@app.get("/api/dashboard")
def dashboard(user_id: int = Depends(require_auth)):
    with get_db() as db:
        total = db.execute("SELECT COUNT(*) FROM todos WHERE user_id = ? AND status != 'archived'", (user_id,)).fetchone()[0]
        pending = db.execute("SELECT COUNT(*) FROM todos WHERE user_id = ? AND status = 'pending'", (user_id,)).fetchone()[0]
        inprog = db.execute("SELECT COUNT(*) FROM todos WHERE user_id = ? AND status = 'in_progress'", (user_id,)).fetchone()[0]
        done = db.execute("SELECT COUNT(*) FROM todos WHERE user_id = ? AND status = 'done'", (user_id,)).fetchone()[0]
        overdue = db.execute(
            "SELECT COUNT(*) FROM todos WHERE user_id = ? AND status IN ('pending','in_progress') AND due_date < date('now')", (user_id,)
        ).fetchone()[0]
        due_today = db.execute(
            "SELECT COUNT(*) FROM todos WHERE user_id = ? AND status IN ('pending','in_progress') AND date(due_date) = date('now')", (user_id,)
        ).fetchone()[0]
        return {
            "total": total,
            "pending": pending,
            "in_progress": inprog,
            "done": done,
            "overdue": overdue,
            "due_today": due_today
        }

# ─── Push Notification Endpoints ─────────────────────────────────────────────

@app.get("/api/push/vapid-public-key")
def get_vapid_public_key_endpoint():
    """Return the VAPID public key for the frontend to subscribe."""
    return {"public_key": get_vapid_public_key()}

@app.post("/api/push/subscribe")
def push_subscribe(data: PushSubscription, user_id: int = Depends(require_auth)):
    """Save a push subscription for the current user."""
    p256dh = data.keys.get("p256dh")
    auth = data.keys.get("auth")
    if not p256dh or not auth:
        raise HTTPException(400, "Missing p256dh or auth key")
    with get_db() as db:
        db.execute(
            """INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(user_id, endpoint) DO UPDATE SET
               p256dh = excluded.p256dh,
               auth = excluded.auth,
               created_at = datetime('now')""",
            (user_id, data.endpoint, p256dh, auth)
        )
        db.commit()
    return {"subscribed": True}

@app.post("/api/push/unsubscribe")
def push_unsubscribe(data: PushSubscription, user_id: int = Depends(require_auth)):
    """Remove a push subscription for the current user."""
    with get_db() as db:
        db.execute(
            "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?",
            (user_id, data.endpoint)
        )
        db.commit()
    return {"unsubscribed": True}

@app.post("/api/push/test")
async def push_test(data: PushTestRequest, user_id: int = Depends(require_auth)):
    """Send a test push notification to all subscriptions of the current user."""
    await send_push_notification(
        user_id=user_id,
        title=data.title,
        body=data.body,
        tag="test",
        url="/"
    )
    return {"sent": True}

# ─── Static frontend ──────────────────────────────────────────────────────────

WEB_DIR = Path(__file__).parent / "../web"
if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(WEB_DIR / "static")), name="static")

    @app.get("/")
    def index():
        return FileResponse(str(WEB_DIR / "index.html"))

    @app.get("/setup")
    def setup_page():
        return FileResponse(str(WEB_DIR / "setup.html"))

    @app.get("/admin")
    def admin_page():
        return FileResponse(str(WEB_DIR / "admin.html"))

    @app.get("/sw.js")
    @app.head("/sw.js")
    def sw_js():
        return FileResponse(str(WEB_DIR / "sw.js"))

    @app.get("/favicon.ico")
    @app.head("/favicon.ico")
    def favicon():
        if (WEB_DIR / "favicon.ico").exists():
            return FileResponse(str(WEB_DIR / "favicon.ico"))
        return FileResponse(str(WEB_DIR / "static" / "icons" / "icon-192.png"))

    @app.get("/{path:path}")
    def spa(path: str):
        # Only allow filenames (no subdirectories) to prevent path traversal
        from pathlib import PurePath
        filename = PurePath(path).name
        if not filename:
            return FileResponse(str(WEB_DIR / "index.html"))
        f = (WEB_DIR / filename).resolve()
        try:
            f.relative_to(WEB_DIR.resolve())
        except ValueError:
            return FileResponse(str(WEB_DIR / "index.html"))
        if f.exists() and f.is_file():
            return FileResponse(str(f))
        return FileResponse(str(WEB_DIR / "index.html"))
