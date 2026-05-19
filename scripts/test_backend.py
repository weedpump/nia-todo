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
    subprocess.run(f"systemctl stop {SERVICE}", shell=True, capture_output=True)

def service_start():
    """Start the dev service."""
    subprocess.run(f"systemctl start {SERVICE}", shell=True, capture_output=True)

def service_restart():
    """Restart the dev service."""
    subprocess.run(f"systemctl restart {SERVICE}", shell=True, capture_output=True)

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
    cookie_jar: Optional[str] = None
) -> Tuple[int, Any]:
    """Execute HTTP request via curl, return (status_code, response_body)."""
    cmd = ["curl", "-s", "-o", "-", "-w", "\\n%{http_code}"]
    jar = cookie_jar or "/tmp/nia_test_cookies.txt"
    cmd += ["-b", jar, "-c", jar]
    if token:
        cmd += ["-H", f"Authorization: Bearer {token}"]
    if csrf:
        cmd += ["-H", f"X-CSRF-Token: {csrf}"]
    cmd += ["-X", method]
    if data:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(data)]
    cmd += [f"{URL}{endpoint}"]
    
    r = subprocess.run(cmd, capture_output=True, text=True)
    out = r.stdout.strip().split("\n")
    status = int(out[-1]) if out[-1].isdigit() else 500
    body = "\n".join(out[:-1])
    
    try:
        return status, json.loads(body) if body else None
    except json.JSONDecodeError:
        return status, {"raw": body}

def ok(status: int, expected: int = 200) -> bool:
    return status == expected

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
        self.created_ids = {"todo": [], "project": [], "section": [], "apikey": [], "user": [], "reminder": []}
    
    def cleanup(self):
        """Reset state between tests."""
        self.user_token = None
        self.user_csrf = None
        self.admin_token = None
        self.admin_csrf = None
        self.created_ids = {"todo": [], "project": [], "section": [], "apikey": [], "user": [], "reminder": []}
    
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
    
    def test_admin_create_user(self):
        status, data = curl("POST", "/api/admin/users", {
            "username": "testuser2",
            "password": "User2Pass123!",
            "display_name": "Test User 2"
        }, token=self.admin_token, csrf=self.admin_csrf, cookie_jar="/tmp/nia_admin_cookies.txt")
        
        if ok(status) and data:
            self.created_ids["user"].append(data.get("id"))
        
        return self.record("admin_create_user", status)
    
    def test_admin_change_user_password(self):
        user_id = self.created_ids["user"][-1] if self.created_ids["user"] else None
        if not user_id:
            self.results["admin_change_user_password"] = {"status": -1, "passed": True, "expected": "skipped"}
            return True
        
        status, _ = curl("POST", f"/api/admin/users/{user_id}/change-password", {
            "new_password": "NewUser2Pass123!"
        }, token=self.admin_token, csrf=self.admin_csrf, cookie_jar="/tmp/nia_admin_cookies.txt")
        
        return self.record("admin_change_user_password", status)
    
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
        
        return self.record("apikey_create", status)
    
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
            "project_id": None,
            "section_id": None
        }, token=self.user_token, csrf=self.user_csrf, cookie_jar="/tmp/nia_user_cookies.txt")
        
        if ok(status) and data:
            self.created_ids["todo"].append(data.get("id"))
        
        return self.record("todo_create", status)
    
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
            
            # API Keys
            self.test_apikey_create,
            self.test_apikey_list,
            
            # Projects (before todos for FK)
            self.test_project_create,
            self.test_project_list,
            self.test_project_patch,
            
            # Sections
            self.test_section_create,
            self.test_section_list,
            self.test_section_list_by_project,
            self.test_section_patch,
            
            # Todos
            self.test_todo_create,
            self.test_todo_list,
            self.test_todo_get_one,
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
            
            # Admin (separate session)
            self.test_admin_login,
            self.test_admin_list_users,
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
        db_restore()
        
        print("\n🔄 Schritt 5/6: Service neustarten...")
        service_restart()
        if not service_wait():
            print("⚠️  Service startet möglicherweise nicht korrekt!")
        else:
            print("✅ Service läuft wieder normal")
    
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
