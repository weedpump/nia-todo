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

run_step "1/38 Backend-Tests" python3 scripts/test_backend.py
run_step "2/38 BrainDump-Services-Tests" python3 scripts/test_braindump_v2_services.py
run_step "3/38 BrainDump-Extractor-Normalization-Tests" python3 scripts/test_braindump_v2_extractor_normalization.py
run_step "4/38 BrainDump-Todo-Creation-Tests" python3 scripts/test_braindump_v2_todo_creation.py
run_step "5/38 BrainDump-Admin-STT-Probe-Tests" python3 scripts/test_braindump_admin_stt_probe.py
run_step "6/38 E-Mail-Service-Tests" python3 scripts/test_email_services.py
run_step "7/38 2FA-Service-/Security-Tests" python3 scripts/test_two_factor_services.py
run_step "8/38 Instance-Config-Service-Tests" python3 scripts/test_instance_config_services.py
run_step "9/38 Migration-022-Duplicate-E-Mail-Test" python3 scripts/test_migration_022_email_duplicates.py
run_step "10/38 Migration-Partial-Recovery-Test" python3 scripts/test_migration_email_partial_recovery.py
run_step "11/38 Release-Version-Checker-Test" python3 scripts/test_release_versions.py
run_step "12/38 Server-Update-Tests" python3 scripts/test_server_updates.py
run_step "13/38 Admin-Password-Reset-Test" python3 scripts/test_admin_password_reset.py
run_step "14/38 Service-Worker-Precache-Test" node scripts/test_sw_precache.mjs
run_step_retry "15/38 Frontend-Smoke-Test" node scripts/test_frontend_smoke.mjs
run_step_retry "16/38 Frontend-App-Test" node scripts/test_frontend_app.mjs
run_step_retry "17/38 Frontend-Setup-Test" node scripts/test_frontend_setup.mjs
run_step_retry "18/38 Frontend-Admin-Test" node scripts/test_frontend_admin.mjs
run_step_retry "19/38 Frontend-Password-Reset-Test" node scripts/test_frontend_password_reset.mjs
run_step_retry "20/38 Frontend-Settings-Test" node scripts/test_frontend_settings.mjs
run_step_retry "21/38 Frontend-User-Menu-Alignment-Test" node scripts/test_frontend_user_menu_alignment.mjs
run_step_retry "22/38 Frontend-User-Menu-Scroll-Anchor-Test" node scripts/test_frontend_user_menu_scroll_anchor.mjs
run_step_retry "23/38 Frontend-Projects-Test" node scripts/test_frontend_projects.mjs
run_step_retry "24/38 Frontend-Workspaces-Test" node scripts/test_frontend_workspaces.mjs
run_step_retry "25/38 Frontend-DragDrop-Test" node scripts/test_frontend_dragdrop.mjs
run_step_retry "26/38 Frontend-Sharing-Test" node scripts/test_frontend_sharing.mjs
run_step_retry "27/38 Frontend-Security-Test" node scripts/test_frontend_security.mjs
run_step_retry "28/38 Frontend-Session-Test" node scripts/test_frontend_session.mjs
run_step_retry "29/38 Frontend-Offline-Sync-Test" node scripts/test_frontend_offline_sync.mjs
run_step_retry "30/38 Frontend-Realtime-Sync-Test" node scripts/test_frontend_realtime_sync.mjs
run_step_retry "31/38 Frontend-Native-Runtime-Config-Test" node scripts/test_frontend_native_runtime_config.mjs
run_step_retry "32/38 Frontend-Native-Passkeys-Test" node scripts/test_frontend_native_passkeys.mjs
run_step_retry "33/38 Frontend-Native-Offline-Test" node scripts/test_frontend_native_offline.mjs
run_step_retry "34/38 Frontend-Android-Reminder-Rehydration-Test" node scripts/test_frontend_android_reminder_rehydration.mjs
run_step_retry "35/38 Frontend-BrainDump-Capture-Test" node scripts/test_frontend_braindump_capture.mjs
run_step "36/38 Native-Windows-Installer-Cache-Hook-Test" node scripts/test_native_windows_installer_cache_hooks.mjs
run_step "37/38 Native-Android-WebView-Cache-Migration-Test" node scripts/test_native_android_webview_cache_migration.mjs
run_step "38/38 Native-Android-Reminder-Alarm-Policy-Test" node scripts/test_native_android_reminder_alarm_policy.mjs

echo
echo "🎉 Alles grün — alle Tests erfolgreich bestanden"
