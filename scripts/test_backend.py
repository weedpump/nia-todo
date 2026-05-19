#!/usr/bin/env python3
"""Complete Backend Test: develop vs refactor/backend-modular"""

import subprocess
import json
import time
from pathlib import Path

BASE = Path("~/projects/nia-todo-dev")
DB = BASE / "api" / "data" / "nia-todo-dev.db"
URL = "http://localhost:8754"

def curl(method, endpoint, data=None, token=None, csrf=None, cookie_jar=None):
    cmd = ["curl", "-s", "-o", "-", "-w", "\\n%{http_code}"]
    jar = cookie_jar or "/tmp/user_cookies.txt"
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
    except:
        return status, {"raw": body}

def test_branch(branch):
    print(f"\n{'='*60}\nBRANCH: {branch}\n{'='*60}")
    results = {}

    subprocess.run(f"git checkout {branch}", shell=True, cwd=str(BASE), capture_output=True)
    if DB.exists(): DB.unlink()
    subprocess.run("systemctl restart nia-todo-dev", shell=True, capture_output=True)
    time.sleep(3)

    # Setup
    results["setup_admin"] = curl("POST", "/api/setup/admin", {"admin_password": "TestAdmin123!"})
    results["setup_user"] = curl("POST", "/api/setup/first-user", {"username": "testuser", "password": "TestPass123!", "display_name": "Test User"})

    # USER AUTH
    results["login"] = curl("POST", "/api/login", {"username": "testuser", "password": "TestPass123!"}, cookie_jar="/tmp/user_cookies.txt")
    token = results["login"][1].get("access_token", "") if results["login"][0] == 200 else ""
    csrf = results["login"][1].get("csrf_token", "") if results["login"][0] == 200 else ""
    if not token:
        return results

    results["me"] = curl("GET", "/api/me", token=token, cookie_jar="/tmp/user_cookies.txt")

    # Todos
    results["todo_create"] = curl("POST", "/api/todos", {"title": "Test", "priority": 2}, token, csrf, "/tmp/user_cookies.txt")
    todo_id = results["todo_create"][1].get("id") if results["todo_create"][0] == 200 else None
    results["todo_list"] = curl("GET", "/api/todos", token=token, cookie_jar="/tmp/user_cookies.txt")
    results["todo_get_one"] = curl("GET", f"/api/todos/{todo_id}", token=token, cookie_jar="/tmp/user_cookies.txt") if todo_id else (-1, {})
    results["todo_patch"] = curl("PATCH", f"/api/todos/{todo_id}", {"status": "in_progress"}, token, csrf, "/tmp/user_cookies.txt") if todo_id else (-1, {})
    results["todo_delete"] = curl("DELETE", f"/api/todos/{todo_id}", token=token, csrf=csrf, cookie_jar="/tmp/user_cookies.txt") if todo_id else (-1, {})

    # Projects
    results["project_create"] = curl("POST", "/api/projects", {"name": "Test Proj"}, token, csrf, "/tmp/user_cookies.txt")
    proj_id = results["project_create"][1].get("id") if results["project_create"][0] == 200 else None
    results["project_list"] = curl("GET", "/api/projects", token=token, cookie_jar="/tmp/user_cookies.txt")
    results["project_patch"] = curl("PATCH", f"/api/projects/{proj_id}", {"color": "#ff0000"}, token, csrf, "/tmp/user_cookies.txt") if proj_id else (-1, {})
    results["project_clear_done"] = curl("POST", f"/api/projects/{proj_id}/clear-done", token=token, csrf=csrf, cookie_jar="/tmp/user_cookies.txt") if proj_id else (-1, {})

    # Sections - BEFORE project delete!
    sec_base = "/api/sections/by-project" if (BASE / "api" / "routers" / "sections.py").exists() else "/api/projects"
    sec_suffix = f"/{proj_id or 1}/sections" if sec_base.startswith("/api/projects") else f"/{proj_id or 1}"
    
    results["section_create"] = curl("POST", f"{sec_base}{sec_suffix}", {"name": "Sec1", "sort_order": 0}, token, csrf, "/tmp/user_cookies.txt")
    sec_id = results["section_create"][1].get("id") if results["section_create"][0] == 200 else None
    results["section_list"] = curl("GET", "/api/sections", token=token, cookie_jar="/tmp/user_cookies.txt")
    results["section_patch"] = curl("PATCH", f"/api/sections/{sec_id}", {"name": "Sec2"}, token, csrf, "/tmp/user_cookies.txt") if sec_id else (-1, {})
    results["section_delete"] = curl("DELETE", f"/api/sections/{sec_id}", token=token, csrf=csrf, cookie_jar="/tmp/user_cookies.txt") if sec_id else (-1, {})
    
    results["project_delete"] = curl("DELETE", f"/api/projects/{proj_id}", token=token, csrf=csrf, cookie_jar="/tmp/user_cookies.txt") if proj_id else (-1, {})

    # Dashboard, Reminders
    results["dashboard"] = curl("GET", "/api/dashboard", token=token, cookie_jar="/tmp/user_cookies.txt")
    results["reminder_list"] = curl("GET", "/api/reminders", token=token, cookie_jar="/tmp/user_cookies.txt")

    # API Keys (user)
    results["apikey_create"] = curl("POST", "/api/me/api-keys", {"name": "Key1"}, token, csrf, "/tmp/user_cookies.txt")
    key_id = results["apikey_create"][1].get("id") if results["apikey_create"][0] == 200 else None
    results["apikey_list"] = curl("GET", "/api/me/api-keys", token=token, cookie_jar="/tmp/user_cookies.txt")
    results["apikey_delete"] = curl("DELETE", f"/api/me/api-keys/{key_id}", token=token, csrf=csrf, cookie_jar="/tmp/user_cookies.txt") if key_id else (-1, {})

    # Push
    results["push_status"] = curl("GET", "/api/push/status", token=token, cookie_jar="/tmp/user_cookies.txt")
    results["push_vapid"] = curl("GET", "/api/push/vapid-public-key", token=token, cookie_jar="/tmp/user_cookies.txt")

    # ADMIN AUTH (separate cookie jar!)
    results["admin_login"] = curl("POST", "/api/admin/login", {"password": "TestAdmin123!"}, cookie_jar="/tmp/admin_cookies.txt")
    admin_token = results["admin_login"][1].get("access_token", "") if results["admin_login"][0] == 200 else ""
    admin_csrf = results["admin_login"][1].get("csrf_token", "") if results["admin_login"][0] == 200 else ""
    
    results["admin_users"] = curl("GET", "/api/admin/users", token=admin_token, cookie_jar="/tmp/admin_cookies.txt")
    results["admin_create_user"] = curl("POST", "/api/admin/users", {"username": "user2", "password": "Pass123!", "display_name": "User 2"}, token=admin_token, csrf=admin_csrf, cookie_jar="/tmp/admin_cookies.txt")
    user2_id = results["admin_create_user"][1].get("id") if results["admin_create_user"][0] == 200 else None
    results["admin_user_chpwd"] = curl("POST", f"/api/admin/users/{user2_id}/change-password", {"new_password": "NewPass123!"}, token=admin_token, csrf=admin_csrf, cookie_jar="/tmp/admin_cookies.txt") if user2_id else (-1, {})
    results["admin_user_delete"] = curl("DELETE", f"/api/admin/users/{user2_id}", token=admin_token, csrf=admin_csrf, cookie_jar="/tmp/admin_cookies.txt") if user2_id else (-1, {})
    results["admin_logout"] = curl("POST", "/api/admin/logout", token=admin_token, csrf=admin_csrf, cookie_jar="/tmp/admin_cookies.txt")
    
    # Admin password change needs fresh login (invalidates token)
    results["admin_chpwd_login"] = curl("POST", "/api/admin/login", {"password": "TestAdmin123!"}, cookie_jar="/tmp/admin_cookies.txt")
    admin_token2 = results["admin_chpwd_login"][1].get("access_token", "") if results["admin_chpwd_login"][0] == 200 else ""
    admin_csrf2 = results["admin_chpwd_login"][1].get("csrf_token", "") if results["admin_chpwd_login"][0] == 200 else ""
    results["admin_chpwd"] = curl("POST", "/api/admin/change-password", {"old_password": "TestAdmin123!", "new_password": "TestAdmin456!"}, token=admin_token2, csrf=admin_csrf2, cookie_jar="/tmp/admin_cookies.txt") if admin_token2 else (-1, {})

    # USER LOGOUT (use user cookie jar)
    results["logout"] = curl("POST", "/api/logout", token=token, csrf=csrf, cookie_jar="/tmp/user_cookies.txt")

    return results

def print_results(results, title):
    print(f"\n{'='*60}\n{title}\n{'='*60}")
    total = 0
    ok = 0
    for key in sorted(results.keys()):
        val = results[key]
        status = val[0] if isinstance(val, tuple) else val.get("status", -1)
        total += 1
        if status == 200:
            ok += 1
            print(f"  ✅ {key}: {status}")
        elif status == -1:
            print(f"  ⏭️  {key}: skipped")
        else:
            print(f"  ❌ {key}: {status}")
    print(f"\n  Total: {ok}/{total} passed")

def main():
    print("nia-todo COMPLETE Backend Test")
    print("=" * 60)

    dev = test_branch("develop")
    ref = test_branch("refactor/backend-modular")

    print_results(dev, "DEVELOP RESULTS")
    print_results(ref, "REFACTOR RESULTS")

    out = Path("~/workspace/backend-test-develop-vs-refactor.md")
    with open(out, "w") as f:
        f.write("# Backend Test: develop vs refactor\n\n")
        f.write("## Develop\n\n```json\n" + json.dumps({k: v[0] if isinstance(v, tuple) else v for k, v in dev.items()}, indent=2) + "\n```\n\n")
        f.write("## Refactor\n\n```json\n" + json.dumps({k: v[0] if isinstance(v, tuple) else v for k, v in ref.items()}, indent=2) + "\n```\n")
    print(f"\n📄 Saved: {out}")

    subprocess.run("systemctl stop nia-todo-dev", shell=True, capture_output=True)
    subprocess.run("git checkout develop", shell=True, cwd=str(BASE), capture_output=True)

if __name__ == "__main__":
    main()
