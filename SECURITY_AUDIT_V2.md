# nia-todo v0.4.0-dev Security Audit (DEEP DIVE)

**Scope:** API (`api/main.py`, `api/db.py`, `api/rate_limit.py`, `api/migrate.py`), Frontend (`web/static/app.js`, `web/*.html`), Migrations, `release.sh`  
**Date:** 2026-05-16  
**Auditor:** Subagent Nia (Security Review)  

---

## 🔴 CRITICAL

### C-1: SQL Injection in `update_todo` (Stored / Union-based) — ✅ FIXED

- **STATUS:** ✅ FIXED in commit `0a719d7`
- **SEVERITY:** Critical
- **FILE:** `api/main.py` (~line 1010-1040)
- **ISSUE:** The `update_todo` endpoint builds a dynamic SQL `UPDATE` using an f-string:
  ```python
  set_clause = ", ".join(f"{k}=:{k}" for k in updates)
  db.execute(f"UPDATE todos SET {set_clause} WHERE id = :id", {**updates, "id": todo_id})
  ```
  The keys in `updates` come directly from the client (`data.model_dump(exclude_unset=True)`) without key validation.
- **FIX:** Column whitelist added:
  ```python
  allowed_cols = {"title","description","priority","project_id","section_id","due_date","status","completed_at","updated_at"}
  safe_updates = {k:v for k,v in updates.items() if k in allowed_cols}
  ```

### C-2: SQL Injection in `update_project` (Stored / Union-based) — ✅ FIXED

- **STATUS:** ✅ FIXED in commit `0a719d7`
- **SEVERITY:** Critical
- **FILE:** `api/main.py` (~line 1090-1120)
- **ISSUE:** Same pattern as C-1. Dynamic `SET` clause built via f-string with keys from client input.
- **FIX:** Column whitelist added:
  ```python
  allowed_cols = {"name", "color", "sort_order", "parent_id", "updated_at"}
  safe_updates = {k: v for k, v in updates.items() if k in allowed_cols}
  ```

### C-3: XSS (Stored + Reflected) in `admin.html` via `renderUsers()` — ✅ FIXED

- **STATUS:** ✅ FIXED in commit `0a719d7`
- **SEVERITY:** Critical
- **FILE:** `web/admin.html` (~line 260-290 in `<script>`)
- **ISSUE:** `escapeHtml()` only escapes `& < > "` but not single quotes (`'`), which are used as attribute delimiters in `onclick="deleteUser(${u.id}, '${escapeHtml(u.username)}')"`.
- **FIX:** Added `escapeHtmlAttr()` helper that escapes single quotes to `&#39;`:
  ```javascript
  function escapeHtmlAttr(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  ```

---

## 🟠 HIGH

### H-1: Missing CSRF Protection on All State-Changing Endpoints

- **SEVERITY:** High
- **FILE:** `api/main.py` (all POST/PUT/PATCH/DELETE endpoints)
- **ISSUE:** No CSRF tokens are implemented anywhere. The API relies solely on the `Authorization: Bearer` header or `X-Session-Token`. While this provides some protection, endpoints that also accept cookies (or if the app is ever used in a cookie-auth scenario) are vulnerable to CSRF. More critically, **the admin endpoints** (`/api/admin/*`) and **setup endpoints** (`/api/setup/*`) have no CSRF tokens.
- **IMPACT:** If an attacker can trick an authenticated user or admin into visiting a malicious page, they can perform actions on behalf of the victim (create/delete users, change passwords, delete todos).
- **FIX:** Implement Double-Submit Cookie CSRF tokens for all state-changing requests. Include the token in the `X-CSRF-Token` header and validate it server-side against a cookie value. Alternatively, require custom request headers for API calls that browsers cannot send cross-origin without CORS preflight.

### H-2: Insecure CORS Configuration — `allow_credentials=True` + Wildcard Headers

- **SEVERITY:** High
- **FILE:** `api/main.py` (~lines 18-27)
- **ISSUE:**
  ```python
  app.add_middleware(
      CORSMiddleware,
      allow_origins=["https://todo.kneidl-home.de", "https://todo-dev.kneidl-home.de"],
      allow_credentials=True,
      allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allow_headers=["*"],
  )
  ```
  While `allow_origins` is not `"*"`, `allow_headers=["*"]` with `allow_credentials=True` is overly permissive. If a DNS hijacking or subdomain takeover occurs on the allowed domains, the attacker can read authenticated responses.
- **IMPACT:** If an attacker gains control over either allowed origin (or exploits a subdomain XSS), they can make authenticated cross-origin requests and read the JWT tokens/API responses.
- **FIX:** Explicitly list required headers instead of wildcard. Add `expose_headers` only for what is needed. Consider validating the `Origin` header server-side for sensitive endpoints.

### H-3: WebSocket Authentication Bypass — Unauthenticated Connections Accepted

- **SEVERITY:** High
- **FILE:** `api/main.py` (~lines 400-470)
- **ISSUE:** The WebSocket endpoint `/ws` accepts connections before authentication:
  ```python
  await manager.connect(websocket)
  ```
  The `token` is checked from `query_params`, and if valid, `ws_user_id` is set. But if no token is provided, the connection remains open and enters the `while True` loop. Although `sync_request` checks `ws_user_id`, the connection itself is established and maintained, consuming resources and potentially allowing information leakage through error messages or timing.
- **IMPACT:** DoS via WebSocket connection exhaustion (each connection spawns a coroutine). Unauthenticated users can hold connections open indefinitely. If future message types forget to check `ws_user_id`, data leakage occurs.
- **FIX:** Close the WebSocket immediately if no valid token is provided within a short timeout (e.g., 5 seconds). Reject connections without a token at the handshake level if possible.

### H-4: No Input Validation on `username` — Arbitrary Length & Characters

- **SEVERITY:** High
- **FILE:** `api/main.py` (setup_first_user, create_user)
- **ISSUE:** Usernames are accepted without any validation beyond uniqueness. There are no checks for:
  - Maximum length (could be 1MB, causing DB issues)
  - Allowed character set (HTML tags, null bytes, control characters accepted)
  - Minimum length
  - Leading/trailing whitespace
- **IMPACT:** Username injection into frontend (XSS via username if any display point forgets escaping), database bloat, potential LDAP/SSRF injection if usernames are ever used in external systems. The `admin.html` XSS (C-3) becomes directly exploitable via crafted usernames.
- **FIX:**
  ```python
  import re
  def validate_username(username: str) -> Optional[str]:
      if not username or len(username) < 3 or len(username) > 32:
          return "Username must be 3-32 characters"
      if not re.match(r'^[a-zA-Z0-9_\-]+$', username):
          return "Username may only contain letters, numbers, underscores, and hyphens"
      return None
  ```

### H-5: No Request Body Size Limits — DoS via Large Payloads

- **SEVERITY:** High
- **FILE:** `api/main.py` (all endpoints)
- **ISSUE:** FastAPI does not have explicit body size limits configured. An attacker can send extremely large JSON payloads (e.g., 1GB `username` or `description`), causing memory exhaustion and denial of service.
- **IMPACT:** Server crashes or becomes unresponsive. SQLite database may lock or corrupt under memory pressure.
- **FIX:** Set a maximum request body size in the ASGI server configuration (e.g., `limit_max_request_body_size` in Uvicorn/Starlette). Add Pydantic `max_length` validators to all string fields:
  ```python
  username: str = Field(..., min_length=3, max_length=32, pattern=r'^[a-zA-Z0-9_\-]+$')
  title: str = Field(..., max_length=500)
  description: str = Field(default="", max_length=10000)
  ```

### H-6: Missing `Strict-Transport-Security` (HSTS) Header

- **SEVERITY:** High
- **FILE:** `api/main.py` (~lines 60-75)
- **ISSUE:** The `SecurityHeadersMiddleware` sets CSP, X-Frame-Options, X-Content-Type-Options, and Referrer-Policy, but omits `Strict-Transport-Security`.
- **IMPACT:** If the app is ever accessed over HTTP (or via a downgrade attack), the browser will not enforce HTTPS. Man-in-the-middle attackers can intercept traffic and steal JWT tokens.
- **FIX:**
  ```python
  response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload"
  ```

---

## 🟡 MEDIUM

### M-1: Path Traversal in SPA Static File Route

- **SEVERITY:** Medium
- **FILE:** `api/main.py` (~lines 1270-1285)
- **ISSUE:**
  ```python
  @app.get("/{path:path}")
  def spa(path: str):
      f = (WEB_DIR / path).resolve()
      try:
          f.relative_to(WEB_DIR.resolve())
      except ValueError:
          return FileResponse(str(WEB_DIR / "index.html"))
      if f.exists() and f.is_file():
          return FileResponse(str(f))
      return FileResponse(str(WEB_DIR / "index.html"))
  ```
  While `resolve()` and `relative_to()` provide some protection, this is a known fragile pattern. On some systems, `resolve()` follows symlinks, and race conditions exist between the check and the file read. Also, if `path` is empty or resolves to a directory, `f.is_file()` returns False, but no explicit directory traversal block exists.
- **IMPACT:** Potential information disclosure if symlink traversal or path normalization differences exist on the host OS.
- **FIX:** Use a whitelist-based approach or sanitize `path` explicitly:
  ```python
  from pathlib import PurePath
  safe_path = PurePath(path).name  # Only allow single-level filenames
  f = WEB_DIR / safe_path
  ```
  Alternatively, remove the catch-all `/{path:path}` route entirely if not strictly needed.

### M-2: XSS via `innerHTML` in `renderVersionInfo()` and Other DOM Points

- **SEVERITY:** Medium
- **FILE:** `web/static/app.js` (~line 1800-1810)
- **ISSUE:** `renderVersionInfo()` uses `innerHTML`:
  ```javascript
  el.innerHTML = `<span class="version-text">${APP_VERSION}</span>`;
  ```
  While `APP_VERSION` is a constant in this case, any future change that makes it dynamic (e.g., from server response) would be an XSS vector. More importantly, the pattern of using `innerHTML` is repeated in `renderStats()`, `renderTodos()`, `renderSectionHeader()`, etc.
- **IMPACT:** If any data flowing into these `innerHTML` templates is not properly escaped (e.g., todo titles, project names from the server), stored XSS is possible.
- **FIX:** The project already has `escapeHtml()` and `escapeHtmlAttr()` helpers — ensure they are used **everywhere** data is interpolated into HTML. Prefer `textContent` over `innerHTML` where possible. Use a templating engine or DOM API (`document.createElement`) instead of string concatenation for dynamic content.

### M-3: WebSocket Token in Query Parameters — Log Leakage

- **SEVERITY:** Medium
- **FILE:** `web/static/app.js` (~line 420-430), `api/main.py`
- **ISSUE:** The JWT token is passed as a query parameter in the WebSocket URL:
  ```javascript
  const wsUrl = token ? WS_URL + '?token=' + encodeURIComponent(token) : WS_URL;
  ```
  Query parameters are often logged by proxies, reverse proxies (Traefik), and browser history.
- **IMPACT:** JWT tokens may be leaked in access logs, allowing token replay attacks.
- **FIX:** Use the WebSocket subprotocol header (`Sec-WebSocket-Protocol`) or send the token in the first WebSocket message (which the app already supports via the `auth` message type). Remove the query parameter approach entirely.

### M-4: No Input Sanitization on Todo/Project Text Fields

- **SEVERITY:** Medium
- **FILE:** `api/main.py` (all create/update endpoints for todos, projects, sections)
- **ISSUE:** The API accepts and stores raw strings for `title`, `description`, `name`, etc. There is no server-side sanitization (e.g., stripping HTML tags, null bytes, or excessive whitespace).
- **IMPACT:** If the frontend ever fails to escape these values (or if data is consumed by another client), stored XSS occurs. Additionally, null bytes (`\x00`) in SQLite text can cause truncation or unexpected behavior in some tools.
- **FIX:** Strip or reject HTML tags server-side:
  ```python
  import bleach
  title = bleach.clean(data.title, tags=[], strip=True)
  ```
  Or use a simple regex to strip `<>` characters from text fields.

### M-5: `audit_log` Silent Failure + No Retention Policy

- **SEVERITY:** Medium
- **FILE:** `api/main.py` (~lines 250-260)
- **ISSUE:**
  ```python
  def log_audit(db, event_type, user_id=None, ip_address=None, details=None):
      try:
          db.execute("INSERT INTO audit_log ...")
          db.commit()
      except Exception:
          pass  # Don't fail the request if audit logging fails
  ```
  Audit logging failures are silently swallowed. There is no mechanism to alert administrators of audit log failures (e.g., disk full). Additionally, there is no retention policy for the `audit_log` table — it will grow indefinitely.
- **IMPACT:** Security events may be lost without anyone noticing. Database size grows unbounded.
- **FIX:** Log audit failures to stderr/syslog. Implement a scheduled cleanup job for audit logs older than 90 days.

### M-6: In-Memory Rate Limiting Not Shared Across Workers

- **SEVERITY:** Medium
- **FILE:** `api/rate_limit.py`
- **ISSUE:** The `RateLimiter` class stores all state in Python dictionaries (`login_attempts`, `api_requests`, `ws_connections`). If the app is ever run with multiple workers (e.g., Gunicorn with multiple Uvicorn workers), each worker has its own independent rate limit state.
- **IMPACT:** Rate limits are easily bypassed by distributing requests across workers. A 5-attempt login limit becomes 5×N attempts with N workers.
- **FIX:** Use a shared store for rate limiting state (Redis, or at minimum a SQLite table with proper locking). For single-worker deployments, document this limitation clearly.

### M-7: `release.sh` — Potential Command Injection via `VERSION`

- **SEVERITY:** Medium
- **FILE:** `release.sh`
- **ISSUE:** The release script uses the `VERSION` argument directly in `sed` commands without validation:
  ```bash
  sed -i "s/const APP_VERSION = 'v[^']*';/const APP_VERSION = '${TAG}';/" web/static/app.js
  ```
  If `VERSION` contains single quotes or sed metacharacters, the sed command will fail or behave unexpectedly.
- **IMPACT:** Build process corruption, potential arbitrary command execution if malicious input reaches the release script.
- **FIX:** Validate `VERSION` with a regex before use:
  ```bash
  if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "Invalid version format"
      exit 1
  fi
  ```
  Use a safer replacement mechanism (e.g., Python script) instead of sed for variable substitution.

### M-8: No Account Lockout After Failed Logins

- **SEVERITY:** Medium
- **FILE:** `api/main.py` (login, admin_login)
- **ISSUE:** After 5 failed login attempts within 15 minutes, the IP is rate-limited. However, there is **no account-level lockout**. An attacker can bypass IP-based rate limiting by using a botnet, Tor, or proxy rotation. The targeted account itself never gets locked.
- **IMPACT:** Credential stuffing attacks against specific high-value accounts (admin) are still feasible.
- **FIX:** Implement account-level lockout: after N failed attempts for a specific username, lock the account for M minutes regardless of IP. Store failed attempt counts in the database keyed by username.

### M-9: API Key Leaked in Frontend LocalStorage on XSS

- **SEVERITY:** Medium
- **FILE:** `web/static/app.js` (localStorage usage)
- **ISSUE:** JWT tokens and API keys are stored in `localStorage`. If any XSS vulnerability exists in the app (e.g., via a malicious todo title if escaping fails), the attacker can steal these tokens:
  ```javascript
  localStorage.getItem('jwt_token')
  localStorage.getItem('admin_jwt_token')
  ```
- **IMPACT:** Complete account takeover if XSS is exploited.
- **FIX:** Use `httpOnly` cookies for authentication instead of localStorage. This prevents JavaScript from accessing the tokens, mitigating the impact of XSS. Shorten JWT expiry (currently 1 day) and implement refresh tokens.

### M-10: Missing `X-XSS-Protection` and `Permissions-Policy` Headers

- **SEVERITY:** Medium
- **FILE:** `api/main.py` (SecurityHeadersMiddleware)
- **ISSUE:** The security headers middleware omits:
  - `X-XSS-Protection: 1; mode=block` (legacy but still useful for older browsers)
  - `Permissions-Policy` (prevents browser features from being abused, e.g., camera, microphone, geolocation)
- **IMPACT:** Slightly increased attack surface for browser-based attacks.
- **FIX:** Add the missing headers:
  ```python
  response.headers["X-XSS-Protection"] = "1; mode=block"
  response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
  ```

---

## 🟢 LOW

### L-1: Information Disclosure via Error Responses

- **SEVERITY:** Low
- **FILE:** `api/main.py` (throughout)
- **ISSUE:** FastAPI's default exception handler returns detailed error messages including validation errors. While the app disables docs (`docs_url=None`), unhandled exceptions still return stack traces in debug mode. The `admin.html` frontend displays raw error messages from the server directly in the UI.
- **IMPACT:** Minor information leakage about internal structure.
- **FIX:** Add a global exception handler that returns generic error messages for 500 errors:
  ```python
  @app.exception_handler(Exception)
  async def generic_exception_handler(request, exc):
      return JSONResponse({"detail": "Internal server error"}, status_code=500)
  ```

### L-2: Version Number Disclosure

- **SEVERITY:** Low
- **FILE:** `web/static/app.js`, `web/sw.js`, `api/main.py`
- **ISSUE:** The application version (`v0.4.0`, `v0.4.1-dev`) is exposed in:
  - JavaScript constants (`APP_VERSION`, `SW_VERSION`)
  - HTML title
  - FastAPI app metadata (`version="0.4.0"`)
- **IMPACT:** Attackers can quickly identify if the app is running a vulnerable version.
- **FIX:** Remove version strings from publicly accessible responses. Use a build hash instead of semantic version for client-side cache busting.

### L-3: No HTTPS Redirect / HTTP Allowed

- **SEVERITY:** Low
- **FILE:** `api/main.py`
- **ISSUE:** There is no middleware to redirect HTTP requests to HTTPS. The app relies on the reverse proxy (Traefik) for this, but if accessed directly over HTTP, the connection is accepted.
- **IMPACT:** Credential exposure if a user accidentally accesses the HTTP endpoint.
- **FIX:** Add a middleware that checks `X-Forwarded-Proto` and redirects to HTTPS if the request came over HTTP.

### L-4: Weak Password Regex — Overly Broad Special Characters

- **SEVERITY:** Low
- **FILE:** `api/main.py` (~line 85)
- **ISSUE:**
  ```python
  if not re.search(r'[!@#$%^&*()_+\-=\[\]{};\':"\\|,.<>/?]', password):
  ```
  The regex includes many special characters but also contains an unescaped single quote inside the character class (`\'`), which may cause regex parsing issues in some Python versions. The character class is overly broad and may accept whitespace or control characters as "special".
- **IMPACT:** Minor password policy inconsistency.
- **FIX:** Use a cleaner, well-tested regex or a dedicated password validation library (e.g., `zxcvbn`).

### L-5: `change_admin_password.py` Hardcodes DB Path

- **SEVERITY:** Low
- **FILE:** `api/change_admin_password.py`
- **ISSUE:** The script hardcodes `nia-todo-dev.db` instead of respecting the `NIA_TODO_DB` environment variable used by the main app.
- **IMPACT:** Could accidentally modify the wrong database if the environment variable is set differently.
- **FIX:**
  ```python
  DB_NAME = os.getenv('NIA_TODO_DB', 'nia-todo-dev.db')
  DB_PATH = Path(__file__).parent / "data" / DB_NAME
  ```

### L-6: No Normalization of Usernames

- **SEVERITY:** Low
- **FILE:** `api/main.py`
- **ISSUE:** Usernames are case-sensitive and not normalized. "Admin", "admin", and "ADMIN" are three different accounts. This can lead to impersonation or confusion.
- **IMPACT:** Social engineering / user confusion.
- **FIX:** Store usernames in lowercase and always compare lowercase:
  ```python
  username = data.username.lower().strip()
  ```

### L-7: `get_client_ip` Trusts Internal IP Ranges That May Be Spoofed

- **SEVERITY:** Low
- **FILE:** `api/rate_limit.py` (~lines 70-100)
- **ISSUE:** The IP check relies on `request.client.host` being accurate. If the app is behind multiple proxies or if the direct client IP is spoofed, rate limiting can be bypassed or applied to the wrong IP.
- **IMPACT:** Rate limiting may be ineffective in complex network topologies.
- **FIX:** Allow configuring a trusted proxy count or header (e.g., `X-Real-IP`) via environment variables.

### L-8: Missing `Secure` and `SameSite` Cookie Attributes

- **SEVERITY:** Low
- **FILE:** N/A (no cookies used currently)
- **ISSUE:** The application does not use cookies for authentication currently. If cookies are ever introduced (e.g., for `httpOnly` JWT storage as recommended in M-9), they must have `Secure`, `HttpOnly`, and `SameSite=Strict` attributes.
- **IMPACT:** Future vulnerability if cookies are added without these flags.
- **FIX:** Document this requirement for future authentication changes.

### L-9: `setup.html` Inline Event Handlers Violate CSP

- **SEVERITY:** Low
- **FILE:** `web/setup.html`, `web/index.html`, `web/admin.html`
- **ISSUE:** The CSP header allows `'unsafe-inline'` for scripts:
  ```
  script-src 'self' 'unsafe-inline'
  ```
  This is necessary because the HTML files use inline `onclick="..."` handlers and inline `<script>` tags. However, `'unsafe-inline'` significantly weakens the CSP against XSS.
- **IMPACT:** CSP cannot effectively block injected scripts from XSS payloads.
- **FIX:** Move all JavaScript to `app.js` (external file). Use `addEventListener` instead of inline event handlers. Then remove `'unsafe-inline'` from the CSP and add a nonce or hash-based approach.

### L-10: Service Worker Caches API Responses Indefinitely

- **SEVERITY:** Low
- **FILE:** `web/sw.js`
- **ISSUE:** The service worker caches API responses (`/api/*`) without any expiration logic:
  ```javascript
  caches.open(API_CACHE).then((cache) => cache.put(event.request, clone));
  ```
  API responses (which contain user data) are stored in the browser cache indefinitely. On a shared computer, another user could potentially access cached data.
- **IMPACT:** Data leakage on shared devices. Stale data served when offline.
- **FIX:** Do not cache API responses in the Service Worker, or implement cache expiration (e.g., max-age of 5 minutes). For a personal todo app, API caching may not be necessary at all.

### L-11: Database Backup in `release.sh` Has No Retention Limit

- **SEVERITY:** Low
- **FILE:** `release.sh`
- **ISSUE:** Database backups are created on every release but never cleaned up:
  ```bash
  BACKUP_DIR="~/projects/nia-todo/api/data/backups"
  ```
- **IMPACT:** Disk space exhaustion over time.
- **FIX:** Add cleanup logic to keep only the last N backups (e.g., 10):
  ```bash
  ls -t "$BACKUP_DIR"/*.db | tail -n +11 | xargs -r rm
  ```

---

## 📊 Zusammenfassung

| Schweregrad | Anzahl |
|-------------|--------|
| 🔴 Critical | 3 |
| 🟠 High | 6 |
| 🟡 Medium | 10 |
| 🟢 Low | 11 |
| **Gesamt** | **30** |

### Empfohlene Priorisierung

1. **Sofort (heute):** Fix C-1, C-2 (SQL Injection) und C-3 (XSS in admin.html) — diese sind direkt ausnutzbar und können zu vollständiger Kompromittierung führen.
2. **Diese Woche:** H-1 (CSRF), H-2 (CORS), H-3 (WS Auth), H-4 (Username Validation), H-5 (Body Limits), H-6 (HSTS)
3. **Nächster Sprint:** M-1 bis M-11 (Pfad-Traversal, XSS-Patterns, WS-Token-Leakage, Input-Sanitization, Audit-Log, Rate-Limit-Shared-State, Release-Script, Account-Lockout, localStorage, Security-Headers)
4. **Backlog:** L-1 bis L-11 (Information Disclosure, Version-Hiding, HTTPS-Redirect, Passwort-Regex, etc.)

### Gesamtbeurteilung

Das Projekt nia-todo hat eine **solide Grundlage** mit JWT-Authentifizierung, bcrypt-Passwort-Hashing, rudimentärem Rate-Limiting und einem Content-Security-Policy-Header. Allerdings gibt es **drei kritische Schwachstellen** (zwei SQL-Injections und eine XSS-Lücke im Admin-Bereich), die sofort behoben werden müssen.

Die Architektur ist für einen Selfhosted-Single-User/Small-Team-Use-Case geeignet, sollte aber vor einer Exposition ins Internet oder einer Erweiterung auf mehrere Benutzer härten erfahren. Die fehlende CSRF-Protection, die unsichere CORS-Konfiguration und die fehlende Eingabevalidierung sind die nächsten Prioritäten.

**Empfehlung:** 🔴 **Nicht produktiv einsetzen**, bis C-1, C-2 und C-3 behoben sind.

---

*Audit erstellt von Nia (Subagent) am 2026-05-16. Alle Zeilennummern beziehen sich auf den Stand des Dev-Branches zum Zeitpunkt des Audits.*
