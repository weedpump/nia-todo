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

run_step "1/33 Backend-Tests" python3 scripts/test_backend.py
run_step "2/33 E-Mail-Service-Tests" python3 scripts/test_email_services.py
run_step "3/33 2FA-Service-/Security-Tests" python3 scripts/test_two_factor_services.py
run_step "4/33 Instance-Config-Service-Tests" python3 scripts/test_instance_config_services.py
run_step "5/33 Migration-022-Duplicate-E-Mail-Test" python3 scripts/test_migration_022_email_duplicates.py
run_step "6/33 Migration-Partial-Recovery-Test" python3 scripts/test_migration_email_partial_recovery.py
run_step "7/33 Release-Version-Checker-Test" python3 scripts/test_release_versions.py
run_step "8/33 Server-Update-Tests" python3 scripts/test_server_updates.py
run_step "9/33 Admin-Password-Reset-Test" python3 scripts/test_admin_password_reset.py
run_step "10/33 Service-Worker-Precache-Test" node scripts/test_sw_precache.mjs
run_step_retry "11/33 Frontend-Smoke-Test" node scripts/test_frontend_smoke.mjs
run_step_retry "12/33 Frontend-App-Test" node scripts/test_frontend_app.mjs
run_step_retry "13/33 Frontend-Setup-Test" node scripts/test_frontend_setup.mjs
run_step_retry "14/33 Frontend-Admin-Test" node scripts/test_frontend_admin.mjs
run_step_retry "15/33 Frontend-Password-Reset-Test" node scripts/test_frontend_password_reset.mjs
run_step_retry "16/33 Frontend-Settings-Test" node scripts/test_frontend_settings.mjs
run_step_retry "17/33 Frontend-User-Menu-Alignment-Test" node scripts/test_frontend_user_menu_alignment.mjs
run_step_retry "18/33 Frontend-User-Menu-Scroll-Anchor-Test" node scripts/test_frontend_user_menu_scroll_anchor.mjs
run_step_retry "19/33 Frontend-Projects-Test" node scripts/test_frontend_projects.mjs
run_step_retry "20/33 Frontend-Workspaces-Test" node scripts/test_frontend_workspaces.mjs
run_step_retry "21/33 Frontend-DragDrop-Test" node scripts/test_frontend_dragdrop.mjs
run_step_retry "22/33 Frontend-Sharing-Test" node scripts/test_frontend_sharing.mjs
run_step_retry "23/33 Frontend-Security-Test" node scripts/test_frontend_security.mjs
run_step_retry "24/33 Frontend-Session-Test" node scripts/test_frontend_session.mjs
run_step_retry "25/33 Frontend-Offline-Sync-Test" node scripts/test_frontend_offline_sync.mjs
run_step_retry "26/33 Frontend-Realtime-Sync-Test" node scripts/test_frontend_realtime_sync.mjs
run_step_retry "27/33 Frontend-Native-Runtime-Config-Test" node scripts/test_frontend_native_runtime_config.mjs
run_step_retry "28/33 Frontend-Native-Passkeys-Test" node scripts/test_frontend_native_passkeys.mjs
run_step_retry "29/33 Frontend-Native-Offline-Test" node scripts/test_frontend_native_offline.mjs
run_step_retry "30/33 Frontend-Android-Reminder-Rehydration-Test" node scripts/test_frontend_android_reminder_rehydration.mjs
run_step "31/33 Native-Windows-Installer-Cache-Hook-Test" node scripts/test_native_windows_installer_cache_hooks.mjs
run_step "32/33 Native-Android-WebView-Cache-Migration-Test" node scripts/test_native_android_webview_cache_migration.mjs
run_step "33/33 Native-Android-Reminder-Alarm-Policy-Test" node scripts/test_native_android_reminder_alarm_policy.mjs

echo
echo "🎉 Alles grün — alle Tests erfolgreich bestanden"
