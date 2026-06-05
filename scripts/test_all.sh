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
    echo "❌ FAILED: $label"
    echo "   Exit code: $code"
    echo "   Aborting — check the error above."
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
  echo "⚠️  FAILED: $label"
  echo "   Exit code: $code"
  echo "   Retrying once to catch Playwright/realtime timing flakes..."

  if "$@"; then
    echo "✅ OK after retry: $label"
  else
    code=$?
    echo "❌ FAILED: $label"
    echo "   Exit code: $code"
    echo "   Aborting — check the error above."
    exit "$code"
  fi
}

step "🧪 nia-todo Test Suite"
echo "Repo: $(pwd)"
echo "Time: $(date '+%Y-%m-%d %H:%M:%S %Z')"

run_step "1/42 Backend Tests" python3 scripts/test_backend.py
run_step "2/42 BrainDump Service Tests" python3 scripts/test_braindump_v2_services.py
run_step "3/42 BrainDump Extractor Normalization Tests" python3 scripts/test_braindump_v2_extractor_normalization.py
run_step "4/42 BrainDump Todo Creation Tests" python3 scripts/test_braindump_v2_todo_creation.py
run_step "5/42 BrainDump Admin STT Probe Tests" python3 scripts/test_braindump_admin_stt_probe.py
run_step "6/42 Email Service Tests" python3 scripts/test_email_services.py
run_step "7/42 2FA Service/Security Tests" python3 scripts/test_two_factor_services.py
run_step "8/42 Instance Config Service Tests" python3 scripts/test_instance_config_services.py
run_step "9/42 Migration 022 Duplicate Email Test" python3 scripts/test_migration_022_email_duplicates.py
run_step "10/42 Migration Partial Recovery Test" python3 scripts/test_migration_email_partial_recovery.py
run_step "11/42 Release Version Checker Test" python3 scripts/test_release_versions.py
run_step "12/42 Server Update Tests" python3 scripts/test_server_updates.py
run_step "13/42 Admin Password Reset Test" python3 scripts/test_admin_password_reset.py
run_step "14/42 Service Worker Precache Test" node scripts/test_sw_precache.mjs
run_step_retry "15/42 Frontend Smoke Test" node scripts/test_frontend_smoke.mjs
run_step_retry "16/42 Frontend App Test" node scripts/test_frontend_app.mjs
run_step_retry "17/42 Frontend Setup Test" node scripts/test_frontend_setup.mjs
run_step_retry "18/42 Frontend Admin Test" node scripts/test_frontend_admin.mjs
run_step_retry "19/42 Frontend Password Reset Test" node scripts/test_frontend_password_reset.mjs
run_step_retry "20/42 Frontend Settings Test" node scripts/test_frontend_settings.mjs
run_step_retry "21/42 Frontend User Menu Alignment Test" node scripts/test_frontend_user_menu_alignment.mjs
run_step_retry "22/42 Frontend User Menu Scroll Anchor Test" node scripts/test_frontend_user_menu_scroll_anchor.mjs
run_step_retry "23/42 Frontend Projects Test" node scripts/test_frontend_projects.mjs
run_step_retry "24/42 Frontend Workspaces Test" node scripts/test_frontend_workspaces.mjs
run_step_retry "25/42 Frontend DragDrop Test" node scripts/test_frontend_dragdrop.mjs
run_step_retry "26/42 Frontend Sharing Test" node scripts/test_frontend_sharing.mjs
run_step_retry "27/42 Frontend Security Test" node scripts/test_frontend_security.mjs
run_step "28/42 Frontend Minimal Todo Mode Test" node scripts/test_frontend_minimal_todos.mjs
run_step_retry "29/42 Frontend Session Test" node scripts/test_frontend_session.mjs
run_step_retry "30/42 Frontend Offline Sync Test" node scripts/test_frontend_offline_sync.mjs
run_step_retry "31/42 Frontend Realtime Sync Test" node scripts/test_frontend_realtime_sync.mjs
run_step_retry "32/42 Frontend Native Runtime Config Test" node scripts/test_frontend_native_runtime_config.mjs
run_step_retry "33/42 Frontend Native Passkeys Test" node scripts/test_frontend_native_passkeys.mjs
run_step_retry "34/42 Frontend Native Offline Test" node scripts/test_frontend_native_offline.mjs
run_step_retry "35/42 Frontend Android Reminder Rehydration Test" node scripts/test_frontend_android_reminder_rehydration.mjs
run_step "36/42 Location Reminder Backend Test" python3 scripts/test_location_reminders.py
run_step "37/42 Frontend Location Reminder Test" node scripts/test_frontend_location_reminders.mjs
run_step "38/42 Native Android Location Reminder Test" node scripts/test_native_android_location_reminders.mjs
run_step_retry "39/42 Frontend BrainDump Capture Test" node scripts/test_frontend_braindump_capture.mjs
run_step "40/42 Native Windows Installer Cache Hook Test" node scripts/test_native_windows_installer_cache_hooks.mjs
run_step "41/42 Native Android WebView Cache Migration Test" node scripts/test_native_android_webview_cache_migration.mjs
run_step "42/42 Native Android Reminder Alarm Policy Test" node scripts/test_native_android_reminder_alarm_policy.mjs

echo
echo "🎉 All green — all tests passed successfully"
