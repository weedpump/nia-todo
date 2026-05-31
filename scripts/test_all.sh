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
  local code
  shift
  step "$label"
  if "$@"; then
    echo "✅ OK: $label"
    return 0
  fi

  code=$?
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

run_step "1/32 Backend-Tests" python3 scripts/test_backend.py
run_step "2/32 E-Mail-Service-Tests" python3 scripts/test_email_services.py
run_step "3/32 2FA-Service-/Security-Tests" python3 scripts/test_two_factor_services.py
run_step "4/32 Instance-Config-Service-Tests" python3 scripts/test_instance_config_services.py
run_step "5/32 Migration-022-Duplicate-E-Mail-Test" python3 scripts/test_migration_022_email_duplicates.py
run_step "6/32 Migration-Partial-Recovery-Test" python3 scripts/test_migration_email_partial_recovery.py
run_step "7/32 Release-Version-Checker-Test" python3 scripts/test_release_versions.py
run_step "8/32 Server-Update-Tests" python3 scripts/test_server_updates.py
run_step "9/32 Service-Worker-Precache-Test" node scripts/test_sw_precache.mjs
run_step_retry "10/32 Frontend-Smoke-Test" node scripts/test_frontend_smoke.mjs
run_step_retry "11/32 Frontend-App-Test" node scripts/test_frontend_app.mjs
run_step_retry "12/32 Frontend-Setup-Test" node scripts/test_frontend_setup.mjs
run_step_retry "13/32 Frontend-Admin-Test" node scripts/test_frontend_admin.mjs
run_step_retry "14/32 Frontend-Password-Reset-Test" node scripts/test_frontend_password_reset.mjs
run_step_retry "15/32 Frontend-Settings-Test" node scripts/test_frontend_settings.mjs
run_step_retry "16/32 Frontend-User-Menu-Alignment-Test" node scripts/test_frontend_user_menu_alignment.mjs
run_step_retry "17/32 Frontend-User-Menu-Scroll-Anchor-Test" node scripts/test_frontend_user_menu_scroll_anchor.mjs
run_step_retry "18/32 Frontend-Projects-Test" node scripts/test_frontend_projects.mjs
run_step_retry "19/32 Frontend-Workspaces-Test" node scripts/test_frontend_workspaces.mjs
run_step_retry "20/32 Frontend-DragDrop-Test" node scripts/test_frontend_dragdrop.mjs
run_step_retry "21/32 Frontend-Sharing-Test" node scripts/test_frontend_sharing.mjs
run_step_retry "22/32 Frontend-Security-Test" node scripts/test_frontend_security.mjs
run_step_retry "23/32 Frontend-Session-Test" node scripts/test_frontend_session.mjs
run_step_retry "24/32 Frontend-Offline-Sync-Test" node scripts/test_frontend_offline_sync.mjs
run_step_retry "25/32 Frontend-Realtime-Sync-Test" node scripts/test_frontend_realtime_sync.mjs
run_step_retry "26/32 Frontend-Native-Runtime-Config-Test" node scripts/test_frontend_native_runtime_config.mjs
run_step_retry "27/32 Frontend-Native-Passkeys-Test" node scripts/test_frontend_native_passkeys.mjs
run_step_retry "28/32 Frontend-Native-Offline-Test" node scripts/test_frontend_native_offline.mjs
run_step_retry "29/32 Frontend-Android-Reminder-Rehydration-Test" node scripts/test_frontend_android_reminder_rehydration.mjs
run_step "30/32 Native-Windows-Installer-Cache-Hook-Test" node scripts/test_native_windows_installer_cache_hooks.mjs
run_step "31/32 Native-Android-WebView-Cache-Migration-Test" node scripts/test_native_android_webview_cache_migration.mjs
run_step "32/32 Native-Android-Reminder-Alarm-Policy-Test" node scripts/test_native_android_reminder_alarm_policy.mjs

echo
echo "🎉 Alles grün — alle Tests erfolgreich bestanden"
