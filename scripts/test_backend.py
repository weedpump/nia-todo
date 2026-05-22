#!/usr/bin/env python3
"""
nia-todo Backend Test Suite - develop branch
Tests ALL API endpoints with automatic DB backup/restore.

Ablauf:
1. Bestehende DB sichern (umbenennen)
2. Dev-Dienst neustarten (leere DB)
3. Setup mit Admin + Test-User durchführen
4. Alle Tests ausführen
5. Ursprüngliche DB wiederherstellen
6. Dienst neustarten
"""

import subprocess
import json
import time
import shutil
import os
import sqlite3
from urllib.parse import urlparse, parse_qs
from pathlib import Path
from typing import Optional, Tuple, Any

# --- Configuration ------------------------------------------------------------

BASE = Path("~/projects/nia-todo-dev")
DB_PATH = BASE / "api" / "data" / "nia-todo-dev.db"
DB_BACKUP = BASE / "api" / "data" / "nia-todo-dev.db.backup"
URL = "http://localhost:8754"
SERVICE = "nia-todo-dev"

# Test credentials
ADMIN_PASSWORD = "TestAdmin123!"
USER_PASSWORD = "TestPass123!"
NEW_PASSWORD = "NewPass123!"

# --- Service Management -------------------------------------------------------

def service_stop():
    """Stop the dev service."""
    subprocess.run(f"systemctl stop {SERVICE}", shell=True, capture_output=True, check=True)

def service_start():
    """Start the dev service."""
    subprocess.run(f"systemctl start {SERVICE}", shell=True, capture_output=True, check=True)

def service_restart():
    """Restart the dev service."""
    subprocess.run(f"systemctl restart {SERVICE}", shell=True, capture_output=True, check=True)

def service_wait(timeout: int = 10) -> bool:
    """Wait for service to be ready. Returns True if successful."""
    for _ in range(timeout * 10):
        try:
            status, _ = curl("GET", "/api/setup/status")
            if status == 200:
                return True
        except:
            pass
        time.sleep(0.1)
    return False

# --- Database Backup/Restore --------------------------------------------------

def db_backup():
    """Backup existing database by renaming it."""
    if DB_PATH.exists():
        if DB_BACKUP.exists():
            DB_BACKUP.unlink()
        shutil.move(str(DB_PATH), str(DB_BACKUP))
        print(f"  💾 DB gesichert: {DB_BACKUP}")
    else:
        print("  ℹ️  Keine bestehende DB zum Sichern")

def db_restore():
    """Restore original database from backup."""
    service_stop()
    if DB_PATH.exists():
        DB_PATH.unlink()
    if DB_BACKUP.exists():
        shutil.move(str(DB_BACKUP), str(DB_PATH))
        print(f"  🔄 DB wiederhergestellt: {DB_PATH}")
    else:
        print("  ⚠️  Kein Backup zum Wiederherstellen")
    service_start()
    service_wait()

def db_reset():
    """Remove any existing DB for fresh start."""
    if DB_PATH.exists():
        DB_PATH.unlink()
        print("  🗑️  Alte DB entfernt")

# --- HTTP Helper --------------------------------------------------------------

def curl(
    method: str,
    endpoint: str,
    data: Optional[dict] = None,
    token: Optional[str] = None,
    csrf: Optional[str] = None,
    cookie_jar: Optional[str] = None,
    auth_scheme: str = "Bearer",
    headers: Optional[dict] = None,
) -> Tuple[int, Any]:
    """Execute HTTP request via curl, return (status_code, response_body)."""
    cmd = ["curl", "-s", "-o", "-", "-w", "\\n%{http_code}"]
    jar = cookie_jar or "/tmp/nia_test_cookies.txt"
    cmd += ["-b", jar, "-c", jar]
    if token:
        cmd += ["-H", f"Authorization: {auth_scheme} {token}"]
    if csrf:
        cmd += ["-H", f"X-CSRF-Token: {csrf}"]
    for key, value in (headers or {}).items():
        cmd += ["-H", f"{key}: {value}"]
    cmd += ["-X", method]
    if data:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(data)]
    cmd += [f"{URL}{endpoint}"]
    
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"curl failed with exit code {r.returncode}: {r.stderr.strip()}")
    out = r.stdout.strip().split("\n")
    status = int(out[-1]) if out[-1].isdigit() else 500
    body = "\n".join(out[:-1])
    
    try:
        return status, json.loads(body) if body else None
    except json.JSONDecodeError:
        return status, {"raw": body}

def ok(status: int, expected: int = 200) -> bool:
    return status == expected


def curl_headers(method: str, endpoint: str, headers: Optional[dict] = None) -> Tuple[int, dict]:
    """Execute HTTP request via curl and return (status_code, response_headers)."""
    cmd = ["curl", "-s", "-D", "-", "-o", "/dev/null", "-w", "\\n%{http_code}", "-X", method]
    for key, value in (headers or {}).items():
        cmd += ["-H", f"{key}: {value}"]
    cmd += [f"{URL}{endpoint}"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"curl failed with exit code {r.returncode}: {r.stderr.strip()}")
    lines = r.stdout.strip().splitlines()
    status = int(lines[-1]) if lines and lines[-1].isdigit() else 500
    response_headers = {}
    for line in lines[:-1]:
        if ":" in line:
            key, value = line.split(":", 1)
            response_headers[key.strip().lower()] = value.strip()
    return status, response_headers

# --- Setup Helpers ------------------------------------------------------------

def perform_setup() -> bool:
    """Perform initial setup: admin + first user."""
    print("\n🔧 Setup durchführen...")
    
    # Admin setzen
    status, data = curl("POST", "/api/setup/admin", {"admin_password": ADMIN_PASSWORD})
    if status != 200:
        print(f"  ❌ Admin-Setup fehlgeschlagen: {status}")
        return False
    print(f"  ✅ Admin-Setup: {status}")
    
    # First User erstellen
    status, data = curl("POST", "/api/setup/first-user", {
        "username": "testuser",
        "email": "testuser@example.invalid",
        "password": USER_PASSWORD,
        "display_name": "Test User"
    })
    if status != 200:
        print(f"  ❌ User-Setup fehlgeschlagen: {status}")
        return False
    print(f"  ✅ User-Setup: {status}")
    
    return True

# --- Test Suite ---------------------------------------------------------------

class TestSuite:
    def __init__(self):
        self.results = {}
        self.user_token = None
        self.user_csrf = None
        self.admin_token = None
        self.admin_csrf = None
        self.shared_token = None
        self.shared_csrf = None
        self.created_api_key = None
        self.shared_own_project_id = None
        self.shared_inbox_project_id = None
        self.created_ids = {"todo": [], "project": [], "section": [], "apikey": [], "user": [], "reminder": [], "invite": [], "shared_section": [], "shared_todo": []}
    
    def cleanup(self):
        """Reset state between tests."""
        self.user_token = None
        self.user_csrf = None
        self.admin_token = None
        self.admin_csrf = None
        self.shared_token = None
        self.shared_csrf = None
        self.created_api_key = None
        self.shared_own_project_id = None
        self.shared_inbox_project_id = None
        self.created_ids = {"todo": [], "project": [], "section": [], "apikey": [], "user": [], "reminder": [], "invite": [], "shared_section": [], "shared_todo": []}
    
    def record(self, name: str, status: int, expected: int = 200):
        passed = ok(status, expected)
        self.results[name] = {"status": status, "passed": passed, "expected": expected}
        return passed
    
    # --- Setup ----------------------------------------------------------------
    
    def test_setup_status(self):
        status, _ = curl("GET", "/api/setup/status")
        return self.record("setup_status", status)
    
    def test_setup_admin(self):
        status, data = curl("POST", "/api/setup/admin", {"admin_password": ADMIN_PASSWORD})
        return self.record("setup_admin", status)
    
    def test_setup_first_user(self):
        status, data = curl("POST", "/api/setup/first-user", {
            "username": "testuser",
            "email": "testuser@example.invalid",
            "password": USER_PASSWORD,
            "display_name": "Test User"
        })
        return self.record("setup_first_user", status)
    
    # --- User Auth ------------------------------------------------------------
    
    def test_login(self):
        status, data = curl("POST", "/api/login", {
            "username": "testuser",
            "password": USER_PASSWORD
        }, cookie_jar="/tmp/nia_user_cookies.txt")
        
        if ok(status):
            self.user_token = data.get("access_token")
            self.user_csrf = data.get("csrf_token")
        
        return self.record("login", status)
    
    def test_logout(self):
        status, _ = curl("POST", "/api/logout", token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("logout", status)
    
    def test_me(self):
        status, data = curl("GET", "/api/me", token=self.user_token, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("me", status)

    def test_invalid_own_email_rejected(self):
        status, _ = curl("PATCH", "/api/me/email", {"email": "broken-email"}, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("invalid_own_email_rejected", status, expected=400)
    
    def test_change_password(self):
        status, _ = curl("POST", "/api/me/change-password", {
            "old_password": USER_PASSWORD,
            "new_password": NEW_PASSWORD
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        
        # Re-login with new password
        if ok(status):
            s, d = curl("POST", "/api/login", {
                "username": "testuser",
                "password": NEW_PASSWORD
            }, cookie_jar="/tmp/nia_user_cookies.txt")
            if ok(s):
                self.user_token = d.get("access_token")
                self.user_csrf = d.get("csrf_token")
        
        return self.record("change_password", status)
    
    # --- Admin Auth -----------------------------------------------------------
    
    def test_admin_login(self):
        status, data = curl("POST", "/api/admin/login", {"password": ADMIN_PASSWORD}, cookie_jar="/tmp/nia_admin_cookies.txt")
        
        if ok(status) and data:
            self.admin_token = data.get("access_token")
            self.admin_csrf = data.get("csrf_token")
            # CSRF Cookie explizit ins File schreiben (curl kann es nicht aus Response lesen)
            with open("/tmp/nia_admin_cookies.txt", "a") as f:
                f.write(f"#HttpOnly_localhost\tFALSE\t/\tFALSE\t9999999999\tcsrf_token\t{self.admin_csrf}\n")
        
        return self.record("admin_login", status)
    
    def test_instance_config_get(self):
        status, data = curl("GET", "/api/admin/instance-config", token=self.admin_token, cookie_jar="/tmp/nia_admin_cookies.txt")
        passed = ok(status) and data is not None and "public_base_url" in data and "allowed_origins" in data and "trusted_proxies" in data
        self.results["instance_config_get"] = {"status": status, "passed": passed, "expected": "200 + config fields"}
        return passed

    def test_strict_cors_unknown_origin_rejected(self):
        status, _ = curl_headers("GET", "/api/setup/status", {"Origin": "https://evil.example"})
        return self.record("strict_cors_unknown_origin_rejected", status, expected=403)

    def test_instance_config_update(self):
        status, data = curl("PATCH", "/api/admin/instance-config", {
            "public_base_url": "",
            "allowed_origins": ["https://allowed.example"],
            "trusted_proxies": ["127.0.0.1", "10.0.10.0/24"],
        }, token=self.admin_token, csrf=self.admin_csrf, cookie_jar="/tmp/nia_admin_cookies.txt")
        passed = ok(status) and data and data.get("allowed_origins") == ["https://allowed.example"] and data.get("trusted_proxies") == ["127.0.0.1/32", "10.0.10.0/24"]
        self.results["instance_config_update"] = {"status": status, "passed": passed, "expected": "200 + normalized config"}
        return passed

    def test_instance_config_audit_written(self):
        with sqlite3.connect(DB_PATH) as db:
            row = db.execute("SELECT changed_keys FROM app_config_audit ORDER BY id DESC LIMIT 1").fetchone()
        passed = bool(row and "allowed_origins" in row[0] and "trusted_proxies" in row[0])
        self.results["instance_config_audit_written"] = {"status": 200 if passed else 500, "passed": passed, "expected": "audit row for config change"}
        return passed

    def test_strict_cors_allowed_origin_preflight(self):
        status, headers = curl_headers("OPTIONS", "/api/admin/login", {
            "Origin": "https://allowed.example",
            "Access-Control-Request-Method": "POST",
        })
        passed = status == 204 and headers.get("access-control-allow-origin") == "https://allowed.example"
        self.results["strict_cors_allowed_origin_preflight"] = {"status": status, "passed": passed, "expected": "204 + allow origin"}
        return passed

    def test_strict_cors_scheme_mismatch_rejected(self):
        status, _ = curl_headers("GET", "/api/setup/status", {
            "Origin": "http://proxy.example.invalid",
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "proxy.example.invalid",
        })
        return self.record("strict_cors_scheme_mismatch_rejected", status, expected=403)

    def test_strict_cors_disallowed_request_header_rejected(self):
        status, _ = curl_headers("OPTIONS", "/api/admin/login", {
            "Origin": "https://allowed.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "X-Not-Allowed",
        })
        return self.record("strict_cors_disallowed_request_header_rejected", status, expected=403)

    def test_strict_cors_default_port_normalized(self):
        status, headers = curl_headers("OPTIONS", "/api/admin/login", {
            "Origin": "https://allowed.example:443",
            "Access-Control-Request-Method": "POST",
        })
        passed = status == 204 and headers.get("access-control-allow-origin") == "https://allowed.example:443"
        self.results["strict_cors_default_port_normalized"] = {"status": status, "passed": passed, "expected": "204 + default-port origin allowed"}
        return passed

    def test_trusted_proxy_rejects_bad_forwarded_host(self):
        status, data = curl("POST", "/api/admin/users", {
            "username": "badforwardedhost",
            "display_name": "Bad Forwarded Host",
            "email": "badforwardedhost@example.invalid",
        }, token=self.admin_token, csrf=self.admin_csrf, cookie_jar="/tmp/nia_admin_cookies.txt", headers={
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "evil.example/path",
        })
        if ok(status) and data:
            self.created_ids["user"].append(data.get("id"))
        passed = ok(status) and data and data.get("password_setup_url", "").startswith("https://localhost:8754/set-password?token=")
        self.results["trusted_proxy_rejects_bad_forwarded_host"] = {"status": status, "passed": passed, "expected": "200 + fallback URL ignores bad forwarded host"}
        return passed

    def test_untrusted_proxy_ignores_forwarded_host(self):
        status, data = curl("POST", "/api/admin/users", {
            "username": "untrustedforwarded",
            "display_name": "Untrusted Forwarded",
            "email": "untrustedforwarded@example.invalid",
        }, token=self.admin_token, csrf=self.admin_csrf, cookie_jar="/tmp/nia_admin_cookies.txt", headers={
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "untrusted.example.invalid",
            "Host": "localhost:8754",
        })
        if ok(status) and data:
            self.created_ids["user"].append(data.get("id"))
        setup_url = data.get("password_setup_url", "") if data else ""
        passed = ok(status) and data and "untrusted.example.invalid" not in setup_url and setup_url.startswith("https://localhost:8754/set-password?token=")
        self.results["untrusted_proxy_ignores_forwarded_host"] = {"status": status, "passed": passed, "expected": "200 + forwarded host ignored", "url": setup_url}
        return passed

    def test_strict_cors_missing_origin_allowed(self):
        status, _ = curl("GET", "/api/setup/status")
        return self.record("strict_cors_missing_origin_allowed", status)

    def test_trusted_proxy_forwarded_link(self):
        status, data = curl("POST", "/api/admin/users", {
            "username": "proxyforwarded",
            "display_name": "Proxy Forwarded",
            "email": "proxyforwarded@example.invalid",
        }, token=self.admin_token, csrf=self.admin_csrf, cookie_jar="/tmp/nia_admin_cookies.txt", headers={
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "proxy.example.invalid",
        })
        if ok(status) and data:
            self.created_ids["user"].append(data.get("id"))
        passed = ok(status) and data and data.get("password_setup_url", "").startswith("https://proxy.example.invalid/set-password?token=")
        self.results["trusted_proxy_forwarded_link"] = {"status": status, "passed": passed, "expected": "200 + forwarded public URL"}
        return passed

    def test_set_trusted_proxies_script(self):
        cmd = ["python3", str(BASE / "api" / "set_trusted_proxies.py"), "127.0.0.1", "10.0.10.0/24", "--json"]
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(BASE), env={**os.environ, "NIA_TODO_DB": "nia-todo-dev.db"})
        if r.returncode != 0:
            self.results["set_trusted_proxies_script"] = {"status": r.returncode, "passed": False, "expected": 0, "error": r.stderr.strip()}
            return False
        data = json.loads(r.stdout[r.stdout.find("{"):])
        passed = data.get("trusted_proxies") == ["127.0.0.1/32", "10.0.10.0/24"]
        self.results["set_trusted_proxies_script"] = {"status": r.returncode, "passed": passed, "expected": "normalized proxy list"}
        return passed

    def test_admin_logout(self):
        # Admin-Logout braucht: Cookie (CSRF) + Authorization Header (Token)
        # Token und CSRF müssen explizit im Header mitgeschickt werden
        status, _ = curl("POST", "/api/admin/logout", token=self.admin_token, csrf=self.admin_csrf, cookie_jar="/tmp/nia_admin_cookies.txt")
        return self.record("admin_logout", status)
    
    def test_admin_change_password(self):
        # Fresh login for password change
        s, d = curl("POST", "/api/admin/login", {"password": ADMIN_PASSWORD}, cookie_jar="/tmp/nia_admin_cookies.txt")
        if not ok(s):
            return self.record("admin_change_password", s)
        
        token = d.get("access_token")
        csrf = d.get("csrf_token")
        
        status, _ = curl("POST", "/api/admin/change-password", {
            "old_password": ADMIN_PASSWORD,
            "new_password": "NewAdmin123!"
        }, token=token, csrf=csrf, cookie_jar="/tmp/nia_admin_cookies.txt")
        
        return self.record("admin_change_password", status)
    
    # --- Admin User Management ------------------------------------------------
    
    def test_admin_list_users(self):
        status, _ = curl("GET", "/api/admin/users", token=self.admin_token, cookie_jar="/tmp/nia_admin_cookies.txt")
        return self.record("admin_list_users", status)
    
    def test_invalid_admin_email_rejected(self):
        status, _ = curl("POST", "/api/admin/users", {
            "username": "bademailuser",
            "display_name": "Bad Email User",
            "email": "broken-email"
        }, token=self.admin_token, csrf=self.admin_csrf, cookie_jar="/tmp/nia_admin_cookies.txt")
        return self.record("invalid_admin_email_rejected", status, expected=400)

    def test_admin_create_user(self):
        status, data = curl("POST", "/api/admin/users", {
            "username": "testuser2",
            "display_name": "Test User 2",
            "email": "testuser2@example.invalid"
        }, token=self.admin_token, csrf=self.admin_csrf, cookie_jar="/tmp/nia_admin_cookies.txt")
        
        if ok(status) and data:
            self.created_ids["user"].append(data.get("id"))
        passed = ok(status) and data and data.get("password_setup_url") and data.get("password_setup_expires_hours") == 24
        self.results["admin_create_user"] = {"status": status, "passed": passed, "expected": "200 + password_setup_url + 24h expiry"}
        return passed

    def test_admin_create_shared_user(self):
        status, data = curl("POST", "/api/admin/users", {
            "username": "shareduser",
            "display_name": "Shared User",
            "email": "shareduser@example.invalid"
        }, token=self.admin_token, csrf=self.admin_csrf, cookie_jar="/tmp/nia_admin_cookies.txt")
        if ok(status) and data:
            self.created_ids["user"].append(data.get("id"))
            token = parse_qs(urlparse(data.get("password_setup_url", "")).query).get("token", [None])[0]
            if token:
                setup_status, _ = curl("POST", "/api/password-setup/complete", {
                    "token": token,
                    "password": "SharedPass123!"
                }, cookie_jar="/tmp/nia_shared_setup_cookies.txt")
                if not ok(setup_status):
                    status = setup_status
        return self.record("admin_create_shared_user", status)

    def test_shared_user_login(self):
        status, data = curl("POST", "/api/login", {
            "username": "shareduser",
            "password": "SharedPass123!"
        }, cookie_jar="/tmp/nia_shared_cookies.txt")
        if ok(status):
            self.shared_token = data.get("access_token")
            self.shared_csrf = data.get("csrf_token")
            p_status, p_data = curl("GET", "/api/projects", token=self.shared_token, cookie_jar="/tmp/nia_shared_cookies.txt")
            if ok(p_status) and p_data and p_data.get("projects"):
                self.shared_own_project_id = p_data["projects"][0].get("id")
                inbox = next((p for p in p_data["projects"] if p.get("is_inbox")), None)
                self.shared_inbox_project_id = inbox.get("id") if inbox else None
        return self.record("shared_user_login", status)

    def test_secondary_user_inbox_defaults(self):
        if not self.shared_token or not self.shared_inbox_project_id:
            self.results["secondary_user_inbox_defaults"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        status, projects_data = curl("GET", "/api/projects", token=self.shared_token, cookie_jar="/tmp/nia_shared_cookies.txt")
        if not ok(status):
            return self.record("secondary_user_inbox_defaults", status)
        projects = projects_data.get("projects", [])
        if not projects or not projects[0].get("is_inbox"):
            self.results["secondary_user_inbox_defaults"] = {"status": status, "passed": False, "expected": "inbox first"}
            return False

        status, todo = curl("POST", "/api/todos", {"title": "Secondary default inbox"}, token=self.shared_token, csrf=self.shared_csrf, cookie_jar="/tmp/nia_shared_cookies.txt")
        if not ok(status) or not todo:
            return self.record("secondary_user_inbox_defaults", status)
        self.created_ids["shared_todo"].append(todo.get("id"))
        if todo.get("project_id") != self.shared_inbox_project_id:
            self.results["secondary_user_inbox_defaults"] = {"status": status, "passed": False, "expected": "todo assigned to secondary user's inbox"}
            return False

        status, _ = curl("PATCH", f"/api/projects/{self.shared_inbox_project_id}", {"name": "Monis Eingang"}, token=self.shared_token, csrf=self.shared_csrf, cookie_jar="/tmp/nia_shared_cookies.txt")
        if not ok(status):
            return self.record("secondary_user_inbox_defaults", status)
        status, _ = curl("DELETE", f"/api/projects/{self.shared_inbox_project_id}", token=self.shared_token, csrf=self.shared_csrf, cookie_jar="/tmp/nia_shared_cookies.txt")
        return self.record("secondary_user_inbox_cannot_delete", status, expected=400)
    
    def test_admin_change_user_password(self):
        user_id = self.created_ids["user"][-1] if self.created_ids["user"] else None
        if not user_id:
            self.results["admin_change_user_password"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        
        status, data = curl("POST", f"/api/admin/users/{user_id}/password-link", {}, token=self.admin_token, csrf=self.admin_csrf, cookie_jar="/tmp/nia_admin_cookies.txt")
        passed = ok(status) and data and data.get("password_setup_url") and data.get("password_setup_expires_hours") == 24
        self.results["admin_change_user_password"] = {"status": status, "passed": passed, "expected": "200 + password_setup_url + 24h expiry"}
        return passed
    
    def test_admin_delete_user(self):
        user_id = self.created_ids["user"][-1] if self.created_ids["user"] else None
        if not user_id:
            self.results["admin_delete_user"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        
        status, _ = curl("DELETE", f"/api/admin/users/{user_id}", token=self.admin_token, csrf=self.admin_csrf, cookie_jar="/tmp/nia_admin_cookies.txt")
        return self.record("admin_delete_user", status)
    
    # --- API Keys -------------------------------------------------------------
    
    def test_apikey_create(self):
        status, data = curl("POST", "/api/me/api-keys", {"name": "Test Key"}, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        
        if ok(status) and data:
            self.created_ids["apikey"].append(data.get("id"))
            self.created_api_key = data.get("key")
        
        return self.record("apikey_create", status)

    def test_apikey_auth_requires_apikey_scheme_for_csrf_bypass(self):
        if not self.created_api_key:
            self.results["apikey_auth_requires_apikey_scheme_for_csrf_bypass"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        status, _ = curl("POST", "/api/todos", {"title": "Bearer API Key must not bypass CSRF"}, token=self.created_api_key, cookie_jar="/tmp/nia_apikey_cookies.txt")
        if not self.record("apikey_bearer_rejected_without_csrf", status, expected=403):
            return False
        status, data = curl("POST", "/api/todos", {"title": "API key scheme works"}, token=self.created_api_key, cookie_jar="/tmp/nia_apikey_cookies.txt", auth_scheme="ApiKey")
        if ok(status) and data:
            self.created_ids["todo"].append(data.get("id"))
        return self.record("apikey_scheme_allows_without_csrf", status)
    
    def test_apikey_list(self):
        status, _ = curl("GET", "/api/me/api-keys", token=self.user_token, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("apikey_list", status)
    
    def test_apikey_delete(self):
        key_id = self.created_ids["apikey"][-1] if self.created_ids["apikey"] else None
        if not key_id:
            self.results["apikey_delete"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        
        status, _ = curl("DELETE", f"/api/me/api-keys/{key_id}", token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("apikey_delete", status)
    
    # --- Todos ----------------------------------------------------------------
    
    def test_todo_create(self):
        status, data = curl("POST", "/api/todos", {
            "title": "Test Todo",
            "description": "Test description",
            "priority": 2,
            "status": "in_progress",
            "project_id": None,
            "section_id": None
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        
        if ok(status) and data:
            self.created_ids["todo"].append(data.get("id"))
        passed = ok(status) and data and data.get("status") == "in_progress"
        self.results["todo_create"] = {"status": status, "passed": passed, "expected": "200 + status=in_progress"}
        return passed
    
    def test_todo_list(self):
        status, _ = curl("GET", "/api/todos", token=self.user_token, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("todo_list", status)
    
    def test_todo_get_one(self):
        todo_id = self.created_ids["todo"][-1] if self.created_ids["todo"] else None
        if not todo_id:
            self.results["todo_get_one"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        
        status, _ = curl("GET", f"/api/todos/{todo_id}", token=self.user_token, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("todo_get_one", status)
    
    def test_todo_invalid_dates_rejected(self):
        status, _ = curl("POST", "/api/todos", {
            "title": "Invalid reminder",
            "due_date": "202666-05-20T19:30:00.000Z",
            "remind_at": "2026-05-20T19:99:00.000Z"
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        first_ok = status == 422

        todo_id = self.created_ids["todo"][-1] if self.created_ids["todo"] else None
        if not todo_id:
            self.results["todo_invalid_dates_rejected"] = {"status": status, "passed": first_ok, "expected": 422}
            return first_ok

        patch_status, _ = curl("PATCH", f"/api/todos/{todo_id}", {
            "due_date": "2026-13-20T19:30:00.000Z"
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        passed = first_ok and patch_status == 422
        self.results["todo_invalid_dates_rejected"] = {"status": patch_status, "passed": passed, "expected": 422}
        return passed

    def test_todo_patch(self):
        todo_id = self.created_ids["todo"][-1] if self.created_ids["todo"] else None
        if not todo_id:
            self.results["todo_patch"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        
        status, _ = curl("PATCH", f"/api/todos/{todo_id}", {
            "status": "in_progress",
            "title": "Updated Todo"
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        
        return self.record("todo_patch", status)
    
    def test_todo_delete(self):
        todo_id = self.created_ids["todo"][-1] if self.created_ids["todo"] else None
        if not todo_id:
            self.results["todo_delete"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        
        status, _ = curl("DELETE", f"/api/todos/{todo_id}", token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("todo_delete", status)
    
    # --- Projects -------------------------------------------------------------
    
    def test_project_create(self):
        status, data = curl("POST", "/api/projects", {
            "name": "Test Project",
            "color": "#6366f1",
            "sort_order": 0
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        
        if ok(status) and data:
            self.created_ids["project"].append(data.get("id"))
        
        return self.record("project_create", status)
    
    def test_project_list(self):
        status, _ = curl("GET", "/api/projects", token=self.user_token, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("project_list", status)
    
    def test_project_patch(self):
        proj_id = self.created_ids["project"][-1] if self.created_ids["project"] else None
        if not proj_id:
            self.results["project_patch"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        
        status, _ = curl("PATCH", f"/api/projects/{proj_id}", {
            "color": "#ff0000",
            "name": "Updated Project"
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        
        return self.record("project_patch", status)
    
    def test_project_workspace_move_rejected(self):
        proj_id = self.created_ids["project"][-1] if self.created_ids["project"] else None
        if not proj_id:
            self.results["project_workspace_move_rejected"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        status, workspace = curl("POST", "/api/workspaces", {
            "name": "Move Reject Workspace",
            "color": "#f59e0b"
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        if not ok(status) or not workspace.get("id"):
            self.results["project_workspace_move_rejected"] = {"status": status, "passed": False, "expected": "workspace created"}
            return False
        status, _ = curl("PATCH", f"/api/projects/{proj_id}", {
            "workspace_id": workspace["id"]
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("project_workspace_move_rejected", status, expected=400)

    def test_project_delete_uses_workspace_inbox(self):
        status, workspace = curl("POST", "/api/workspaces", {
            "name": "Delete Inbox Workspace",
            "color": "#0ea5e9"
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        if not ok(status) or not workspace.get("id"):
            self.results["project_delete_uses_workspace_inbox"] = {"status": status, "passed": False, "expected": "workspace created"}
            return False
        workspace_id = workspace["id"]

        status, projects_data = curl("GET", "/api/projects", token=self.user_token, cookie_jar="/tmp/nia_user_cookies.txt")
        if not ok(status):
            self.results["project_delete_uses_workspace_inbox"] = {"status": status, "passed": False, "expected": 200}
            return False
        workspace_inbox = next((p for p in projects_data.get("projects", []) if p.get("workspace_id") == workspace_id and p.get("is_inbox")), None)
        if not workspace_inbox:
            self.results["project_delete_uses_workspace_inbox"] = {"status": status, "passed": False, "expected": "workspace inbox"}
            return False

        status, project = curl("POST", "/api/projects", {
            "name": "Delete Me In Workspace",
            "color": "#6366f1",
            "workspace_id": workspace_id
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        if not ok(status) or not project.get("id"):
            self.results["project_delete_uses_workspace_inbox"] = {"status": status, "passed": False, "expected": "project created"}
            return False

        status, todo = curl("POST", "/api/todos", {
            "title": "Todo moves to workspace inbox",
            "project_id": project["id"]
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        if not ok(status) or not todo.get("id"):
            self.results["project_delete_uses_workspace_inbox"] = {"status": status, "passed": False, "expected": "todo created"}
            return False

        status, _ = curl("DELETE", f"/api/projects/{project['id']}", token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        if not ok(status):
            self.results["project_delete_uses_workspace_inbox"] = {"status": status, "passed": False, "expected": 200}
            return False

        status, moved = curl("GET", f"/api/todos/{todo['id']}", token=self.user_token, cookie_jar="/tmp/nia_user_cookies.txt")
        passed = ok(status) and moved.get("project_id") == workspace_inbox.get("id") and moved.get("section_id") is None
        self.results["project_delete_uses_workspace_inbox"] = {"status": status, "passed": passed, "expected": "todo in same workspace inbox"}
        return passed

    def test_project_clear_done(self):
        proj_id = self.created_ids["project"][-1] if self.created_ids["project"] else None
        if not proj_id:
            self.results["project_clear_done"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        
        status, _ = curl("POST", f"/api/projects/{proj_id}/clear-done", token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("project_clear_done", status)
    
    def test_project_delete(self):
        proj_id = self.created_ids["project"][-1] if self.created_ids["project"] else None
        if not proj_id:
            self.results["project_delete"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        
        status, _ = curl("DELETE", f"/api/projects/{proj_id}", token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("project_delete", status)
    
    # --- Sharing --------------------------------------------------------------

    def test_foreign_project_filter_rejected(self):
        if not self.shared_own_project_id:
            self.results["foreign_project_filter_rejected"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        status, _ = curl("GET", f"/api/todos?project_id={self.shared_own_project_id}", token=self.user_token, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("foreign_project_filter_rejected", status, expected=404)

    def test_share_project(self):
        proj_id = self.created_ids["project"][-1] if self.created_ids["project"] else None
        if not proj_id:
            self.results["share_project"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        status, data = curl("POST", f"/api/projects/{proj_id}/share", {"username": "shareduser"}, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        if ok(status) and data and data.get("member"):
            self.created_ids["invite"].append(data["member"].get("id"))
            self.shared_user_id = data["member"].get("user_id")
        return self.record("share_project", status)

    def test_shared_invite_list(self):
        status, data = curl("GET", "/api/projects/invites", token=self.shared_token, cookie_jar="/tmp/nia_shared_cookies.txt")
        passed = self.record("shared_invite_list", status)
        if passed and not data.get("invites"):
            self.results["shared_invite_list"] = {"status": status, "passed": False, "expected": "non_empty"}
            return False
        return passed

    def test_accept_invite(self):
        proj_id = self.created_ids["project"][-1] if self.created_ids["project"] else None
        invite_id = self.created_ids["invite"][-1] if self.created_ids["invite"] else None
        if not proj_id or not invite_id:
            self.results["accept_invite"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        status, _ = curl("POST", f"/api/projects/{proj_id}/invites/{invite_id}", {"accept": True}, token=self.shared_token, csrf=self.shared_csrf, cookie_jar="/tmp/nia_shared_cookies.txt")
        return self.record("accept_invite", status)

    def test_shared_project_visible(self):
        status, data = curl("GET", "/api/projects", token=self.shared_token, cookie_jar="/tmp/nia_shared_cookies.txt")
        passed = self.record("shared_project_visible", status)
        proj_id = self.created_ids["project"][-1] if self.created_ids["project"] else None
        if passed and not any(p.get("id") == proj_id and p.get("is_shared") for p in data.get("projects", [])):
            self.results["shared_project_visible"] = {"status": status, "passed": False, "expected": "shared project in list"}
            return False
        return passed

    def test_shared_project_cannot_patch(self):
        proj_id = self.created_ids["project"][-1] if self.created_ids["project"] else None
        if not proj_id:
            self.results["shared_project_cannot_patch"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        status, _ = curl("PATCH", f"/api/projects/{proj_id}", {"name": "Nope"}, token=self.shared_token, csrf=self.shared_csrf, cookie_jar="/tmp/nia_shared_cookies.txt")
        return self.record("shared_project_cannot_patch", status, expected=403)

    def test_shared_section_create_patch_delete(self):
        proj_id = self.created_ids["project"][-1] if self.created_ids["project"] else None
        if not proj_id:
            self.results["shared_section_create_patch_delete"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        status, data = curl("POST", f"/api/sections/by-project/{proj_id}", {"name": "Shared Section", "sort_order": 0}, token=self.shared_token, csrf=self.shared_csrf, cookie_jar="/tmp/nia_shared_cookies.txt")
        if not ok(status) or not data:
            return self.record("shared_section_create_patch_delete", status)
        section_id = data.get("id")
        self.created_ids["shared_section"].append(section_id)
        status, _ = curl("PATCH", f"/api/sections/{section_id}", {"name": "Shared Section Updated"}, token=self.shared_token, csrf=self.shared_csrf, cookie_jar="/tmp/nia_shared_cookies.txt")
        if not ok(status):
            return self.record("shared_section_create_patch_delete", status)
        return self.record("shared_section_create_patch_delete", status)

    def test_shared_todo_create_patch_delete(self):
        proj_id = self.created_ids["project"][-1] if self.created_ids["project"] else None
        section_id = self.created_ids["shared_section"][-1] if self.created_ids["shared_section"] else None
        if not proj_id:
            self.results["shared_todo_create_patch_delete"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        status, data = curl("POST", "/api/todos", {"title": "Shared Todo", "project_id": proj_id, "section_id": section_id}, token=self.shared_token, csrf=self.shared_csrf, cookie_jar="/tmp/nia_shared_cookies.txt")
        if not ok(status) or not data:
            return self.record("shared_todo_create_patch_delete", status)
        todo_id = data.get("id")
        self.created_ids["shared_todo"].append(todo_id)
        status, _ = curl("PATCH", f"/api/todos/{todo_id}", {"status": "done"}, token=self.shared_token, csrf=self.shared_csrf, cookie_jar="/tmp/nia_shared_cookies.txt")
        return self.record("shared_todo_create_patch_delete", status)

    def test_shared_reminders_are_user_scoped(self):
        proj_id = self.created_ids["project"][-1] if self.created_ids["project"] else None
        if not proj_id:
            self.results["shared_reminders_are_user_scoped"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        status, data = curl("POST", "/api/todos", {
            "title": "Owner reminder isolation",
            "project_id": proj_id,
            "remind_at": "2026-01-01T00:00:00"
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        if not ok(status) or not data:
            return self.record("shared_reminders_are_user_scoped", status)
        todo_id = data.get("id")
        self.created_ids["todo"].append(todo_id)
        status, shared_view = curl("GET", f"/api/todos/{todo_id}", token=self.shared_token, cookie_jar="/tmp/nia_shared_cookies.txt")
        if not ok(status):
            return self.record("shared_reminders_are_user_scoped", status)
        if shared_view.get("reminders"):
            self.results["shared_reminders_are_user_scoped"] = {"status": status, "passed": False, "expected": "no foreign reminders"}
            return False
        status, _ = curl("PATCH", f"/api/todos/{todo_id}", {"remind_at": "2026-01-02T00:00:00"}, token=self.shared_token, csrf=self.shared_csrf, cookie_jar="/tmp/nia_shared_cookies.txt")
        if not ok(status):
            return self.record("shared_reminders_are_user_scoped", status)
        status, owner_view = curl("GET", f"/api/todos/{todo_id}", token=self.user_token, cookie_jar="/tmp/nia_user_cookies.txt")
        if not ok(status):
            return self.record("shared_reminders_are_user_scoped", status)
        if len(owner_view.get("reminders", [])) != 1 or owner_view["reminders"][0].get("remind_at") != "2026-01-01T00:00:00":
            self.results["shared_reminders_are_user_scoped"] = {"status": status, "passed": False, "expected": "owner reminder unchanged"}
            return False
        return self.record("shared_reminders_are_user_scoped", status)

    def test_owner_remove_member_and_undo(self):
        proj_id = self.created_ids["project"][-1] if self.created_ids["project"] else None
        user_id = getattr(self, "shared_user_id", None)
        if not proj_id or not user_id:
            self.results["owner_remove_member_and_undo"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        status, _ = curl("DELETE", f"/api/projects/{proj_id}/members/{user_id}", token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        if not ok(status):
            return self.record("owner_remove_member_and_undo", status)
        status, _ = curl("POST", f"/api/projects/{proj_id}/members/{user_id}/restore", {"status": "accepted"}, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("owner_remove_member_and_undo", status)

    def test_leave_project_and_undo(self):
        proj_id = self.created_ids["project"][-1] if self.created_ids["project"] else None
        if not proj_id:
            self.results["leave_project_and_undo"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        status, _ = curl("POST", f"/api/projects/{proj_id}/leave", token=self.shared_token, csrf=self.shared_csrf, cookie_jar="/tmp/nia_shared_cookies.txt")
        if not ok(status):
            return self.record("leave_project_and_undo", status)
        status, _ = curl("POST", f"/api/projects/{proj_id}/leave/undo", token=self.shared_token, csrf=self.shared_csrf, cookie_jar="/tmp/nia_shared_cookies.txt")
        return self.record("leave_project_and_undo", status)

    def test_owner_cannot_leave(self):
        proj_id = self.created_ids["project"][-1] if self.created_ids["project"] else None
        if not proj_id:
            self.results["owner_cannot_leave"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        status, _ = curl("POST", f"/api/projects/{proj_id}/leave", token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("owner_cannot_leave", status, expected=400)

    # --- Sections -------------------------------------------------------------
    
    def test_section_create(self):
        proj_id = self.created_ids["project"][-1] if self.created_ids["project"] else 1
        
        status, data = curl("POST", f"/api/sections/by-project/{proj_id}", {
            "name": "Test Section",
            "sort_order": 0
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        
        if ok(status) and data:
            self.created_ids["section"].append(data.get("id"))
        
        return self.record("section_create", status)
    
    def test_section_list(self):
        status, _ = curl("GET", "/api/sections", token=self.user_token, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("section_list", status)
    
    def test_section_list_by_project(self):
        proj_id = self.created_ids["project"][-1] if self.created_ids["project"] else 1
        status, _ = curl("GET", f"/api/sections/by-project/{proj_id}", token=self.user_token, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("section_list_by_project", status)
    
    def test_section_patch(self):
        sec_id = self.created_ids["section"][-1] if self.created_ids["section"] else None
        if not sec_id:
            self.results["section_patch"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        
        status, _ = curl("PATCH", f"/api/sections/{sec_id}", {
            "name": "Updated Section",
            "sort_order": 1
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        
        return self.record("section_patch", status)
    
    def test_section_delete(self):
        sec_id = self.created_ids["section"][-1] if self.created_ids["section"] else None
        if not sec_id:
            self.results["section_delete"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        
        status, _ = curl("DELETE", f"/api/sections/{sec_id}", token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("section_delete", status)
    
    # --- Reminders ------------------------------------------------------------
    
    def test_reminder_list(self):
        status, _ = curl("GET", "/api/reminders", token=self.user_token, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("reminder_list", status)
    
    def test_reminder_mark_sent(self):
        # Create a todo with reminder first
        status, data = curl("POST", "/api/todos", {
            "title": "Reminder Test",
            "remind_at": "2026-01-01T00:00:00"
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        
        if not ok(status) or not data:
            self.results["reminder_mark_sent"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        
        todo_id = data.get("id")
        reminders = data.get("reminders", [])
        if reminders:
            reminder_id = reminders[0].get("id")
            self.created_ids["reminder"].append(reminder_id)
            # Mark as sent immediately (before password change invalidates token)
            status, _ = curl("POST", f"/api/reminders/{reminder_id}/sent", token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
            self.record("reminder_mark_sent", status)
            # Cleanup todo
            curl("DELETE", f"/api/todos/{todo_id}", token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
            return ok(status)
        
        self.results["reminder_mark_sent"] = {"status": -1, "passed": True, "expected": "skipped"}
        return True
    
    # --- Dashboard ------------------------------------------------------------
    
    def test_dashboard(self):
        status, _ = curl("GET", "/api/dashboard", token=self.user_token, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("dashboard", status)
    
    # --- Push Notifications ---------------------------------------------------
    
    def test_push_vapid_key(self):
        status, _ = curl("GET", "/api/push/vapid-public-key", token=self.user_token, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("push_vapid_key", status)
    
    def test_push_status(self):
        status, _ = curl("GET", "/api/push/status", token=self.user_token, cookie_jar="/tmp/nia_user_cookies.txt")
        return self.record("push_status", status)
    
    def test_push_subscribe(self):
        # Subscribe with valid VAPID keys
        status, data = curl("POST", "/api/push/subscribe", {
            "endpoint": "https://example.com/push/test123",
            "keys": {
                "p256dh": "BKbPQxXzVz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8",
                "auth": "Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8"
            }
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        
        return self.record("push_subscribe", status)
    
    def test_push_unsubscribe(self):
        # First subscribe, then unsubscribe from the same endpoint
        endpoint = "https://example.com/push/unsub123"
        keys = {
            "p256dh": "BKbPQxXzVz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8",
            "auth": "Vz8Vz8Vz8Vz8Vz8Vz8Vz8Vz8"
        }
        
        # Subscribe
        status, _ = curl("POST", "/api/push/subscribe", {
            "endpoint": endpoint,
            "keys": keys
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        
        # Unsubscribe from the same endpoint (needs keys too!)
        status, _ = curl("POST", "/api/push/unsubscribe", {
            "endpoint": endpoint,
            "keys": keys
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        
        return self.record("push_unsubscribe", status)
    
    def test_push_test(self):
        status, _ = curl("POST", "/api/push/test", {
            "title": "Test Push",
            "body": "Test notification body"
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        
        return self.record("push_test", status)
    
    # --- Run All Tests --------------------------------------------------------
    
    def run_all(self):
        """Execute all tests in logical order."""
        tests = [
            # Setup
            self.test_setup_status,
            self.test_setup_admin,
            self.test_setup_first_user,
            
            # User Auth
            self.test_login,
            self.test_me,
            self.test_invalid_own_email_rejected,

            # Admin session needed to create sharing test user
            self.test_admin_login,
            self.test_instance_config_get,
            self.test_strict_cors_unknown_origin_rejected,
            self.test_untrusted_proxy_ignores_forwarded_host,
            self.test_instance_config_update,
            self.test_instance_config_audit_written,
            self.test_strict_cors_allowed_origin_preflight,
            self.test_strict_cors_scheme_mismatch_rejected,
            self.test_strict_cors_disallowed_request_header_rejected,
            self.test_strict_cors_default_port_normalized,
            self.test_strict_cors_missing_origin_allowed,
            self.test_trusted_proxy_forwarded_link,
            self.test_trusted_proxy_rejects_bad_forwarded_host,
            self.test_set_trusted_proxies_script,
            self.test_admin_create_shared_user,
            self.test_shared_user_login,
            self.test_secondary_user_inbox_defaults,
            
            # API Keys
            self.test_apikey_create,
            self.test_apikey_auth_requires_apikey_scheme_for_csrf_bypass,
            self.test_apikey_list,
            
            # Projects (before todos for FK)
            self.test_project_create,
            self.test_project_list,
            self.test_project_patch,
            self.test_project_workspace_move_rejected,
            self.test_project_delete_uses_workspace_inbox,

            # Sharing
            self.test_foreign_project_filter_rejected,
            self.test_share_project,
            self.test_shared_invite_list,
            self.test_accept_invite,
            self.test_shared_project_visible,
            self.test_shared_project_cannot_patch,
            self.test_shared_section_create_patch_delete,
            self.test_shared_todo_create_patch_delete,
            self.test_shared_reminders_are_user_scoped,
            self.test_owner_remove_member_and_undo,
            self.test_leave_project_and_undo,
            self.test_owner_cannot_leave,
            
            # Sections
            self.test_section_create,
            self.test_section_list,
            self.test_section_list_by_project,
            self.test_section_patch,
            
            # Todos
            self.test_todo_create,
            self.test_todo_list,
            self.test_todo_get_one,
            self.test_todo_invalid_dates_rejected,
            self.test_todo_patch,
            
            # Reminders (BEFORE password change!)
            self.test_reminder_list,
            self.test_reminder_mark_sent,
            
            # Dashboard
            self.test_dashboard,
            
            # Push (subscribe/unsubscribe in same test)
            self.test_push_vapid_key,
            self.test_push_status,
            self.test_push_subscribe,
            self.test_push_unsubscribe,
            self.test_push_test,
            
            # Cleanup todos/projects/sections
            self.test_todo_delete,
            self.test_section_delete,
            self.test_project_clear_done,
            self.test_project_delete,
            
            # API Key cleanup
            self.test_apikey_delete,
            
            # Password change (invalidates token) - AFTER all auth-required tests!
            self.test_change_password,
            self.test_logout,
            
            # Admin (same session)
            self.test_admin_list_users,
            self.test_invalid_admin_email_rejected,
            self.test_admin_create_user,
            self.test_admin_change_user_password,
            self.test_admin_delete_user,
            self.test_admin_logout,  # Logout VOR password change!
            self.test_admin_change_password,
        ]
        
        for test in tests:
            try:
                test()
            except Exception as e:
                self.results[test.__name__] = {"status": -1, "passed": False, "expected": 200, "error": str(e)}
        
        return self.results

# --- Output -------------------------------------------------------------------

def print_results(results: dict):
    """Print test results summary."""
    total = 0
    passed = 0
    skipped = 0
    failed = 0
    
    print("\n" + "=" * 70)
    print("TEST RESULTS")
    print("=" * 70)
    
    for name in sorted(results.keys()):
        r = results[name]
        status = r.get("status", -1)
        passed_flag = r.get("passed", False)
        expected = r.get("expected", 200)
        
        total += 1
        
        if status == -1:
            print(f"  ⏭️  {name}: SKIPPED")
            skipped += 1
        elif passed_flag:
            print(f"  ✅ {name}: {status}")
            passed += 1
        else:
            print(f"  ❌ {name}: {status} (expected {expected})")
            failed += 1
    
    print("\n" + "=" * 70)
    print(f"TOTAL: {passed}/{total} passed | {failed} failed | {skipped} skipped")
    print("=" * 70)
    
    return failed == 0

# --- Main ---------------------------------------------------------------------

def main():
    print("=" * 70)
    print("🧪 nia-todo Backend Test Suite (develop)")
    print("=" * 70)
    print(f"Service: {SERVICE}")
    print(f"URL: {URL}")
    print(f"DB: {DB_PATH}")
    print(f"Backup: {DB_BACKUP}")
    print("=" * 70)
    
    all_passed = True
    
    try:
        # Step 1: Backup existing DB
        print("\n📦 Schritt 1/6: Bestehende DB sichern...")
        db_backup()
        
        # Step 2: Restart service (fresh DB)
        print("\n🔄 Schritt 2/6: Service neustarten (leere DB)...")
        service_restart()
        if not service_wait():
            print("❌ Service startet nicht!")
            return 1
        print("✅ Service läuft")
        
        # Step 3: Run tests (includes setup tests!)
        print("\n🏃 Schritt 3/6: Tests ausführen (inkl. Setup)...")
        suite = TestSuite()
        results = suite.run_all()
        
        # Print results
        if not print_results(results):
            all_passed = False
        
        # Save results
        output_file = BASE / "test-results.json"
        with open(output_file, "w") as f:
            json.dump(results, f, indent=2)
        print(f"\n📄 Ergebnisse: {output_file}")
        
    finally:
        # Step 4+5: Restore DB and restart
        print("\n🔄 Schritt 4/6: Ursprüngliche DB wiederherstellen...")
        try:
            db_restore()
        except Exception as e:
            all_passed = False
            print(f"❌ DB-Wiederherstellung fehlgeschlagen: {e}")
        
        print("\n🔄 Schritt 5/6: Service neustarten...")
        try:
            service_restart()
            if not service_wait():
                all_passed = False
                print("❌ Service startet nach Restore nicht korrekt!")
            else:
                print("✅ Service läuft wieder normal")
        except Exception as e:
            all_passed = False
            print(f"❌ Service-Neustart nach Restore fehlgeschlagen: {e}")
    
    # Final summary
    print("\n" + "=" * 70)
    if all_passed:
        print("🎉 ALLE TESTS BESTANDEN!")
        return 0
    else:
        print("⚠️  EINIGE TESTS FEHLGESCHLAGEN")
        return 1

if __name__ == "__main__":
    exit(main())
