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

run_step "1/43 Backend Tests" python3 scripts/test_backend.py
run_step "2/43 BrainDump Service Tests" python3 scripts/test_braindump_v2_services.py
run_step "3/43 BrainDump Extractor Normalization Tests" python3 scripts/test_braindump_v2_extractor_normalization.py
run_step "4/43 BrainDump Todo Creation Tests" python3 scripts/test_braindump_v2_todo_creation.py
run_step "5/43 BrainDump Admin STT Probe Tests" python3 scripts/test_braindump_admin_stt_probe.py
run_step "6/43 Email Service Tests" python3 scripts/test_email_services.py
run_step "7/43 2FA Service/Security Tests" python3 scripts/test_two_factor_services.py
run_step "8/43 Instance Config Service Tests" python3 scripts/test_instance_config_services.py
run_step "9/43 Migration 022 Duplicate Email Test" python3 scripts/test_migration_022_email_duplicates.py
run_step "10/43 Migration Partial Recovery Test" python3 scripts/test_migration_email_partial_recovery.py
run_step "11/43 Release Version Checker Test" python3 scripts/test_release_versions.py
run_step "12/43 Server Update Tests" python3 scripts/test_server_updates.py
run_step "13/43 Admin Password Reset Test" python3 scripts/test_admin_password_reset.py
run_step "14/43 Service Worker Precache Test" node scripts/test_sw_precache.mjs
run_step_retry "15/43 Frontend Smoke Test" node scripts/test_frontend_smoke.mjs
run_step_retry "16/43 Frontend App Test" node scripts/test_frontend_app.mjs
run_step_retry "17/43 Frontend Release Ideas Test" node scripts/test_frontend_release_ideas.mjs
run_step_retry "18/43 Frontend Setup Test" node scripts/test_frontend_setup.mjs
run_step_retry "19/43 Frontend Admin Test" node scripts/test_frontend_admin.mjs
run_step_retry "20/43 Frontend Password Reset Test" node scripts/test_frontend_password_reset.mjs
run_step_retry "21/43 Frontend Settings Test" node scripts/test_frontend_settings.mjs
run_step_retry "22/43 Frontend User Menu Alignment Test" node scripts/test_frontend_user_menu_alignment.mjs
run_step_retry "23/43 Frontend User Menu Scroll Anchor Test" node scripts/test_frontend_user_menu_scroll_anchor.mjs
run_step_retry "24/43 Frontend Projects Test" node scripts/test_frontend_projects.mjs
run_step_retry "25/43 Frontend Workspaces Test" node scripts/test_frontend_workspaces.mjs
run_step_retry "26/43 Frontend DragDrop Test" node scripts/test_frontend_dragdrop.mjs
run_step_retry "27/43 Frontend Sharing Test" node scripts/test_frontend_sharing.mjs
run_step_retry "28/43 Frontend Security Test" node scripts/test_frontend_security.mjs
run_step "29/43 Frontend Minimal Todo Mode Test" node scripts/test_frontend_minimal_todos.mjs
run_step_retry "30/43 Frontend Session Test" node scripts/test_frontend_session.mjs
run_step_retry "31/43 Frontend Offline Sync Test" node scripts/test_frontend_offline_sync.mjs
run_step_retry "32/43 Frontend Realtime Sync Test" node scripts/test_frontend_realtime_sync.mjs
run_step_retry "33/43 Frontend Native Runtime Config Test" node scripts/test_frontend_native_runtime_config.mjs
run_step_retry "34/43 Frontend Native Passkeys Test" node scripts/test_frontend_native_passkeys.mjs
run_step_retry "35/43 Frontend Native Offline Test" node scripts/test_frontend_native_offline.mjs
run_step_retry "36/43 Frontend Android Reminder Rehydration Test" node scripts/test_frontend_android_reminder_rehydration.mjs
run_step "37/43 Location Reminder Backend Test" python3 scripts/test_location_reminders.py
run_step "38/43 Frontend Location Reminder Test" node scripts/test_frontend_location_reminders.mjs
run_step "39/43 Native Android Location Reminder Test" node scripts/test_native_android_location_reminders.mjs
run_step_retry "40/43 Frontend BrainDump Capture Test" node scripts/test_frontend_braindump_capture.mjs
run_step "41/43 Native Windows Installer Cache Hook Test" node scripts/test_native_windows_installer_cache_hooks.mjs
run_step "42/43 Native Android WebView Cache Migration Test" node scripts/test_native_android_webview_cache_migration.mjs
run_step "43/43 Native Android Reminder Alarm Policy Test" node scripts/test_native_android_reminder_alarm_policy.mjs

echo
echo "🎉 All green — all tests passed successfully"
