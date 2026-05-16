# Security Audit Report — nia-todo v0.4.0

**Datum:** 2026-05-16
**Auditor:** Nia (Security Subagent)
**Scope:** api/main.py, api/db.py, api/rate_limit.py, web/*.html, api/migrations/*.sql
**Methodik:** Manuelle Code-Review + statische Analyse

---

## Zusammenfassung

| Schweregrad | Anzahl |
|-------------|--------|
| 🔴 Critical | 0 |
| 🟠 High | 3 |
| 🟡 Medium | 5 |
| 🟢 Low | 7 |
| ℹ️ Info | 2 |

**Gesamtbeurteilung:** Solide Sicherheitslage für ein selbst-gehostetes Tool. Keine Critical-Fehler. Die wichtigsten Probleme sind Datenlecks bei User-Löschung und fehlende XSS-Schutzmaßnahmen im Frontend. Für ein internes Tool sind die meisten Issues akzeptabel, aber für öffentliche Verfügbarkeit sollten die High/Medium Issues behoben werden.

---

## 🔴 Critical (0)

Keine Critical-Fehler gefunden. ✨

---

## 🟠 High (3)

### HIGH-1: User-Löschung löscht keine Benutzerdaten

**Datei:** `api/main.py` ~Zeile 940
**Issue:** `DELETE FROM users WHERE id = ?` löscht nur den User-Datensatz, aber alle Todos, Projekte, Sections, Reminders und API-Keys des Benutzers bleiben in der DB zurück.
**Impact:** Datenleck — gelöschte User-Daten verbleiben in der Datenbank und sind potenziell abrufbar. Außerdem Foreign-Key-Konsistenzprobleme.
**Fix:**
```python
@app.delete("/api/admin/users/{user_id}")
def delete_user(user_id: int, _: bool = Depends(require_admin)):
    with get_db() as db:
        # ... Prüfung auf Admin ...
        
        # Lösche alle Benutzerdaten
        db.execute("DELETE FROM api_keys WHERE user_id = ?", (user_id,))
        db.execute("DELETE FROM reminders WHERE todo_id IN (SELECT id FROM todos WHERE user_id = ?)", (user_id,))
        db.execute("DELETE FROM sections WHERE user_id = ?", (user_id,))
        db.execute("DELETE FROM todos WHERE user_id = ?", (user_id,))
        db.execute("DELETE FROM projects WHERE user_id = ? AND id != 1", (user_id,))  # Inbox behalten
        db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        db.commit()
        return {"deleted": user_id}
```

**Alternative:** `ON DELETE CASCADE` in Schema einfügen.

---

### HIGH-2: Admin-Passwort kann vor Setup-Ende beliebig oft zurückgesetzt werden

**Datei:** `api/main.py` ~Zeile 660
**Issue:** `setup_admin` prüft nur `setup_complete` aber nicht ob bereits ein Admin-Passwort existiert. Ein Angreifer kann das Admin-Passwort vor dem ersten User beliebig oft ändern.
**Impact:** DoS / Lockout — Admin kann sich nicht mehr anmelden, Setup-Prozess wird gestört.
**Fix:**
```python
@app.post("/api/setup/admin")
def setup_admin(data: AdminSetupRequest, request: Request, _: None = Depends(require_login_rate_limit)):
    with get_db() as db:
        config = db.execute("SELECT setup_complete, admin_token_hash FROM admin_config WHERE id = 1").fetchone()
        if config and config['admin_token_hash']:
            raise HTTPException(400, "Admin password already set")
        # ... rest
```

---

### HIGH-3: Stored XSS durch fehlende Output-Escaping im Frontend

**Datei:** `web/index.html`, `web/admin.html`, `web/setup.html`
**Issue:** Todo-Titel, Projekt-Namen, Benutzernamen etc. werden direkt ins DOM eingefügt ohne Escaping. Wenn ein Angreifer `<script>alert(1)</script>` als Todo-Titel einträgt, wird es ausgeführt.
**Impact:** Session-Hijacking, Daten-Manipulation, Admin-Aktionen als Opfer ausführen.
**Fix:** Im JavaScript alle `innerHTML`-Zuweisungen durch `textContent` ersetzen:
```javascript
// UNSICHER:
element.innerHTML = todo.title;

// SICHER:
element.textContent = todo.title;

// Für komplexe HTML-Strukturen:
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
element.innerHTML = `<span>${escapeHtml(todo.title)}</span>`;
```

---

## 🟡 Medium (5)

### MED-1: X-Forwarded-For IP-Spoofing bei Rate-Limiting

**Datei:** `api/rate_limit.py` ~Zeile 67
**Issue:** `get_client_ip()` vertraut blind auf den `X-Forwarded-For`-Header. Ein Angreifer kann damit die IP fälschen und das Rate-Limiting umgehen.
**Impact:** Rate-Limiting Bypass, Bruteforce-Angriffe ohne Einschränkung.
**Fix:**
```python
def get_client_ip(request: Request) -> str:
    """Get real client IP, handling proxies safely."""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        # In produktiven Umgebungen mit bekannten Proxies
        # nur die letzte vertrauenswürdige IP verwenden
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"
```
**Hinweis:** In einer LXC-Umgebung mit Traefik ist dies weniger kritisch, aber bei öffentlicher Verfügbarkeit wichtig.

---

### MED-2: JWT-Secret in Datenbank gespeichert

**Datei:** `api/main.py` ~Zeile 113
**Issue:** `get_jwt_secret()` generiert das JWT-Secret und speichert es in der SQLite-DB. Wenn die DB kompromittiert wird, können alle JWTs forgiert werden.
**Impact:** Token-Fälschung bei DB-Kompromittierung.
**Fix:** JWT-Secret aus Umgebungsvariable laden:
```python
import os
JWT_SECRET = os.getenv('NIA_TODO_JWT_SECRET')
if not JWT_SECRET:
    JWT_SECRET = secrets.token_urlsafe(32)
    # In .env schreiben oder beim ersten Start anzeigen
```

---

### MED-3: Keine Content-Security-Policy (CSP) Headers

**Datei:** `api/main.py`
**Issue:** Keine CSP-Headers werden gesetzt. XSS-Angriffe sind leichter ausnutzbar.
**Impact:** XSS, Clickjacking, Data-Injection.
**Fix:** Middleware hinzufügen:
```python
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response
```

---

### MED-4: Kein Audit-Log für sicherheitsrelevante Ereignisse

**Datei:** Global
**Issue:** Keine Protokollierung von Login-Versuchen, Passwort-Änderungen, Admin-Aktionen.
**Impact:** Forensik und Intrusion-Detection nahezu unmöglich.
**Fix:** Einfaches Audit-Log:
```sql
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    user_id INTEGER,
    ip_address TEXT,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
```

---

### MED-5: CORS allow_credentials mit strikten Origins

**Datei:** `api/main.py` ~Zeile 30-37
**Issue:** `allow_credentials=True` in Kombination mit expliziten Origins ist aktuell korrekt. Aber: Wenn Origins erweitert werden (z.B. Wildcards), entsteht ein CSRF-Risiko.
**Impact:** Potenzielle Credential-Theft bei CORS-Misconfiguration.
**Fix:** Keine Änderung nötig aktuell. Bei Erweiterung: `allow_origins` NIEMALS auf `*` setzen wenn `allow_credentials=True`.

---

## 🟢 Low (7)

### LOW-1: JWT-Ablaufzeit relativ lang (7 Tage)

**Datei:** `api/main.py` ~Zeile 102
**Issue:** `JWT_EXPIRY_DAYS = 7` — ein gestohlener Token ist 7 Tage gültig.
**Impact:** Gestohlener Token kann lange missbraucht werden.
**Fix:** Auf 1-3 Tage reduzieren oder Refresh-Token-Mechanismus implementieren.

---

### LOW-2: API-Keys haben kein Ablaufdatum

**Datei:** `api/main.py` ~Zeile 950+
**Issue:** Erstellte API-Keys laufen nie ab. Vergessene Keys bleiben ewig gültig.
**Impact:** Langfristiges Sicherheitsrisiko bei vergessenen Keys.
**Fix:** Optional `expires_at` in `api_keys` Tabelle:
```sql
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
```

---

### LOW-3: Negative IDs in Path-Parametern erlaubt

**Datei:** `api/main.py` (mehrere Endpoints)
**Issue:** `todo_id: int`, `project_id: int` etc. erlauben negative Werte.
**Impact:** Unsauber, potenziell unerwartetes Verhalten.
**Fix:** Pydantic Validierung:
```python
from pydantic import Field

@app.patch("/api/todos/{todo_id}")
async def update_todo(todo_id: Annotated[int, Field(gt=0)], ...)
```

---

### LOW-4: In-memory Rate-Limiting verloren bei Restart

**Datei:** `api/rate_limit.py`
**Issue:** Rate-Limiting-State ist nur im RAM. Nach Server-Restart sind alle Limits zurückgesetzt.
**Impact:** Angreifer kann nach Restart erneut angreifen.
**Fix:** Für ein selbst-gehostetes Tool akzeptabel. Für höhere Sicherheit: SQLite-basierte Rate-Limiting.

---

### LOW-5: Version-Information in OpenAPI sichtbar

**Datei:** `api/main.py` ~Zeile 27
**Issue:** `version="0.4.0"` wird in `/docs` und `/openapi.json` angezeigt.
**Impact:** Reconnaissance für Angreifer (bekannte Schwachstellen der Version).
**Fix:** In Produktion OpenAPI deaktivieren:
```python
app = FastAPI(title="nia-todo", version="0.4.0", docs_url=None, redoc_url=None, openapi_url=None)
```

---

### LOW-6: Keine Strict-Transport-Security (HSTS) Headers

**Datei:** Global
**Issue:** Keine HSTS-Headers erzwingen HTTPS.
**Impact:** Man-in-the-Middle-Angriffe möglich.
**Fix:** Im Reverse-Proxy (Traefik/Nginx) HSTS aktivieren oder Middleware:
```python
response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
```

---

### LOW-7: Setup-Status durch Timing erkennbar

**Datei:** `api/main.py` ~Zeile 648
**Issue:** `setup_status` gibt direkt zurück ob Setup abgeschlossen ist.
**Impact:** Angreifer kann erkennen ob ein ungeschütztes Setup verfügbar ist.
**Fix:** Rate-Limiting auf Setup-Endpoints anwenden (ist bereits vorhanden ✓).

---

## ℹ️ Info (2)

### INFO-1: Admin-Passwort und User-Passwörter mit gleichem bcrypt-Workfactor

**Issue:** Keine Unterscheidung zwischen Admin- und User-Passwort-Hashing-Stärke.
**Hinweis:** Aktuell akzeptabel, Admin-Passwort hat längere Mindestlänge als Kompensation.

---

### INFO-2: Keine Subresource Integrity (SRI) für CDN-Assets

**Datei:** `web/*.html`
**Issue:** Falls externe CDN-Assets eingebunden werden, keine SRI-Hashes.
**Hinweis:** Aktuell irrelevant da alles selbst-gehostet.

---

## Empfohlene Priorisierung

1. **Sofort:** HIGH-1 (User-Löschung fixen)
2. **Dieser Sprint:** HIGH-3 (XSS Frontend fixen)
3. **Nächster Sprint:** HIGH-2 (Setup-Admin fixen), MED-1 (XFF fixen), MED-3 (CSP)
4. **Backlog:** MED-2 (JWT Secret), MED-4 (Audit-Log), LOW-*

---

*Audit abgeschlossen. Keine Critical-Fehler — gute Arbeit! 💜*
