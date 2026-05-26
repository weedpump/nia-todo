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

run_step_retry() {
  local label="$1"
  shift
  step "$label"
  if "$@"; then
    echo "✅ OK: $label"
    return 0
  fi

  local code=$?
  echo "⚠️  FEHLER: $label"
  echo "   Exit-Code: $code"
  echo "   Wiederhole einmal, um Playwright-/Realtime-Timing-Flakes abzufangen..."

  if "$@"; then
    echo "✅ OK nach Retry: $label"
  else
    code=$?
    echo "❌ FEHLER: $label"
    echo "   Exit-Code: $code"
    echo "   Abbruch — bitte Fehler oben prüfen."
    exit "$code"
  fi
}

step "🧪 nia-todo Test Suite"
echo "Repo: $(pwd)"
echo "Zeit: $(date '+%Y-%m-%d %H:%M:%S %Z')"

run_step "1/28 Backend-Tests" python3 scripts/test_backend.py
run_step "2/28 E-Mail-Service-Tests" python3 scripts/test_email_services.py
run_step "3/28 2FA-Service-/Security-Tests" python3 scripts/test_two_factor_services.py
run_step "4/28 Migration-022-Duplicate-E-Mail-Test" python3 scripts/test_migration_022_email_duplicates.py
run_step "5/28 Migration-Partial-Recovery-Test" python3 scripts/test_migration_email_partial_recovery.py
run_step "6/28 Release-Version-Checker-Test" python3 scripts/test_release_versions.py
run_step "7/28 Service-Worker-Precache-Test" node scripts/test_sw_precache.mjs
run_step_retry "8/28 Frontend-Smoke-Test" node scripts/test_frontend_smoke.mjs
run_step_retry "9/28 Frontend-App-Test" node scripts/test_frontend_app.mjs
run_step_retry "10/28 Frontend-Setup-Test" node scripts/test_frontend_setup.mjs
run_step_retry "11/28 Frontend-Admin-Test" node scripts/test_frontend_admin.mjs
run_step_retry "12/28 Frontend-Password-Reset-Test" node scripts/test_frontend_password_reset.mjs
run_step_retry "13/28 Frontend-Settings-Test" node scripts/test_frontend_settings.mjs
run_step_retry "14/28 Frontend-User-Menu-Alignment-Test" node scripts/test_frontend_user_menu_alignment.mjs
run_step_retry "15/28 Frontend-User-Menu-Scroll-Anchor-Test" node scripts/test_frontend_user_menu_scroll_anchor.mjs
run_step_retry "16/28 Frontend-Projects-Test" node scripts/test_frontend_projects.mjs
run_step_retry "17/28 Frontend-Workspaces-Test" node scripts/test_frontend_workspaces.mjs
run_step_retry "18/28 Frontend-DragDrop-Test" node scripts/test_frontend_dragdrop.mjs
run_step_retry "19/28 Frontend-Sharing-Test" node scripts/test_frontend_sharing.mjs
run_step_retry "20/28 Frontend-Security-Test" node scripts/test_frontend_security.mjs
run_step_retry "21/28 Frontend-Session-Test" node scripts/test_frontend_session.mjs
run_step_retry "22/28 Frontend-Offline-Sync-Test" node scripts/test_frontend_offline_sync.mjs
run_step_retry "23/28 Frontend-Realtime-Sync-Test" node scripts/test_frontend_realtime_sync.mjs
run_step_retry "24/28 Frontend-Native-Runtime-Config-Test" node scripts/test_frontend_native_runtime_config.mjs
run_step_retry "25/28 Frontend-Native-Passkeys-Test" node scripts/test_frontend_native_passkeys.mjs
run_step_retry "26/28 Frontend-Native-Offline-Test" node scripts/test_frontend_native_offline.mjs
run_step "27/28 Native-Windows-Installer-Cache-Hook-Test" node scripts/test_native_windows_installer_cache_hooks.mjs
run_step "28/28 Native-Android-WebView-Cache-Migration-Test" node scripts/test_native_android_webview_cache_migration.mjs

echo
echo "🎉 Alles grün — alle Tests erfolgreich bestanden"
