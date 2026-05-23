#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

step() {
  echo
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "$1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

run_step() {
  local label="$1"
  shift
  step "$label"
  if "$@"; then
    echo "✅ OK: $label"
  else
    local code=$?
    echo "❌ FEHLER: $label"
    echo "   Exit-Code: $code"
    echo "   Abbruch — bitte Fehler oben prüfen."
    exit "$code"
  fi
}

step "🧪 nia-todo Test Suite"
echo "Repo: $(pwd)"
echo "Zeit: $(date '+%Y-%m-%d %H:%M:%S %Z')"

run_step "1/26 Backend-Tests" python3 scripts/test_backend.py
run_step "2/26 E-Mail-Service-Tests" python3 scripts/test_email_services.py
run_step "3/26 2FA-Service-/Security-Tests" python3 scripts/test_two_factor_services.py
run_step "4/26 Migration-022-Duplicate-E-Mail-Test" python3 scripts/test_migration_022_email_duplicates.py
run_step "5/26 Migration-Partial-Recovery-Test" python3 scripts/test_migration_email_partial_recovery.py
run_step "6/26 Service-Worker-Precache-Test" node scripts/test_sw_precache.mjs
run_step "7/26 Frontend-Smoke-Test" node scripts/test_frontend_smoke.mjs
run_step "8/26 Frontend-App-Test" node scripts/test_frontend_app.mjs
run_step "9/26 Frontend-Setup-Test" node scripts/test_frontend_setup.mjs
run_step "10/26 Frontend-Admin-Test" node scripts/test_frontend_admin.mjs
run_step "11/26 Frontend-Password-Reset-Test" node scripts/test_frontend_password_reset.mjs
run_step "12/26 Frontend-Settings-Test" node scripts/test_frontend_settings.mjs
run_step "13/26 Frontend-User-Menu-Alignment-Test" node scripts/test_frontend_user_menu_alignment.mjs
run_step "14/26 Frontend-User-Menu-Scroll-Anchor-Test" node scripts/test_frontend_user_menu_scroll_anchor.mjs
run_step "15/26 Frontend-Projects-Test" node scripts/test_frontend_projects.mjs
run_step "16/26 Frontend-Workspaces-Test" node scripts/test_frontend_workspaces.mjs
run_step "17/26 Frontend-DragDrop-Test" node scripts/test_frontend_dragdrop.mjs
run_step "18/26 Frontend-Sharing-Test" node scripts/test_frontend_sharing.mjs
run_step "19/26 Frontend-Security-Test" node scripts/test_frontend_security.mjs
run_step "20/26 Frontend-Session-Test" node scripts/test_frontend_session.mjs
run_step "21/26 Frontend-Offline-Sync-Test" node scripts/test_frontend_offline_sync.mjs
run_step "22/26 Frontend-Realtime-Sync-Test" node scripts/test_frontend_realtime_sync.mjs
run_step "23/26 Frontend-Native-Runtime-Config-Test" node scripts/test_frontend_native_runtime_config.mjs
run_step "24/26 Frontend-Native-Offline-Test" node scripts/test_frontend_native_offline.mjs
run_step "25/26 Native-Windows-Installer-Cache-Hook-Test" node scripts/test_native_windows_installer_cache_hooks.mjs
run_step "26/26 Native-Android-WebView-Cache-Migration-Test" node scripts/test_native_android_webview_cache_migration.mjs

echo
echo "🎉 Alles grün — alle Tests erfolgreich bestanden"
