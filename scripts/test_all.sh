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

run_step "1/21 Backend-Tests" python3 scripts/test_backend.py
run_step "2/21 Service-Worker-Precache-Test" node scripts/test_sw_precache.mjs
run_step "3/21 Frontend-Smoke-Test" node scripts/test_frontend_smoke.mjs
run_step "4/21 Frontend-App-Test" node scripts/test_frontend_app.mjs
run_step "5/21 Frontend-Setup-Test" node scripts/test_frontend_setup.mjs
run_step "6/21 Frontend-Admin-Test" node scripts/test_frontend_admin.mjs
run_step "7/21 Frontend-Settings-Test" node scripts/test_frontend_settings.mjs
run_step "8/21 Frontend-User-Menu-Alignment-Test" node scripts/test_frontend_user_menu_alignment.mjs
run_step "9/21 Frontend-User-Menu-Scroll-Anchor-Test" node scripts/test_frontend_user_menu_scroll_anchor.mjs
run_step "10/21 Frontend-Projects-Test" node scripts/test_frontend_projects.mjs
run_step "11/21 Frontend-Workspaces-Test" node scripts/test_frontend_workspaces.mjs
run_step "12/21 Frontend-DragDrop-Test" node scripts/test_frontend_dragdrop.mjs
run_step "13/21 Frontend-Sharing-Test" node scripts/test_frontend_sharing.mjs
run_step "14/21 Frontend-Security-Test" node scripts/test_frontend_security.mjs
run_step "15/21 Frontend-Session-Test" node scripts/test_frontend_session.mjs
run_step "16/21 Frontend-Offline-Sync-Test" node scripts/test_frontend_offline_sync.mjs
run_step "17/21 Frontend-Realtime-Sync-Test" node scripts/test_frontend_realtime_sync.mjs
run_step "18/21 Frontend-Native-Runtime-Config-Test" node scripts/test_frontend_native_runtime_config.mjs
run_step "19/21 Frontend-Native-Offline-Test" node scripts/test_frontend_native_offline.mjs
run_step "20/21 Native-Windows-Installer-Cache-Hook-Test" node scripts/test_native_windows_installer_cache_hooks.mjs
run_step "21/21 Native-Android-WebView-Cache-Migration-Test" node scripts/test_native_android_webview_cache_migration.mjs

echo
echo "🎉 Alles grün — alle Tests erfolgreich bestanden"
