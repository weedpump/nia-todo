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

run_step "1/46 Backend Tests" python3 scripts/test_backend.py
run_step "2/46 BrainDump Service Tests" python3 scripts/test_braindump_v2_services.py
run_step "3/46 BrainDump Extractor Normalization Tests" python3 scripts/test_braindump_v2_extractor_normalization.py
run_step "4/46 BrainDump Todo Creation Tests" python3 scripts/test_braindump_v2_todo_creation.py
run_step "5/46 BrainDump Admin STT Probe Tests" python3 scripts/test_braindump_admin_stt_probe.py
run_step "6/46 Todo Attachments API Tests" python3 scripts/test_todo_attachments.py
run_step "7/46 Email Service Tests" python3 scripts/test_email_services.py
run_step "8/46 2FA Service/Security Tests" python3 scripts/test_two_factor_services.py
run_step "9/46 Instance Config Service Tests" python3 scripts/test_instance_config_services.py
run_step "10/46 Migration 022 Duplicate Email Test" python3 scripts/test_migration_022_email_duplicates.py
run_step "11/46 Migration Partial Recovery Test" python3 scripts/test_migration_email_partial_recovery.py
run_step "12/46 Release Version Checker Test" python3 scripts/test_release_versions.py
run_step "13/46 Server Update Tests" python3 scripts/test_server_updates.py
run_step "14/46 Packaging Backup/Restore Tests" python3 scripts/test_packaging_backup.py
run_step "15/46 Admin Password Reset Test" python3 scripts/test_admin_password_reset.py
run_step "16/46 Service Worker Precache Test" node scripts/test_sw_precache.mjs
run_step_retry "17/46 Frontend Smoke Test" node scripts/test_frontend_smoke.mjs
run_step_retry "18/46 Frontend App Test" node scripts/test_frontend_app.mjs
run_step_retry "19/46 Frontend Release Ideas Test" node scripts/test_frontend_release_ideas.mjs
run_step_retry "20/46 Frontend Subtasks Test" node scripts/test_frontend_subtasks.mjs
run_step_retry "21/46 Frontend Setup Test" node scripts/test_frontend_setup.mjs
run_step_retry "22/46 Frontend Admin Test" node scripts/test_frontend_admin.mjs
run_step_retry "23/46 Frontend Password Reset Test" node scripts/test_frontend_password_reset.mjs
run_step_retry "24/46 Frontend Settings Test" node scripts/test_frontend_settings.mjs
run_step_retry "25/46 Frontend User Menu Alignment Test" node scripts/test_frontend_user_menu_alignment.mjs
run_step_retry "26/46 Frontend User Menu Scroll Anchor Test" node scripts/test_frontend_user_menu_scroll_anchor.mjs
run_step_retry "27/46 Frontend Projects Test" node scripts/test_frontend_projects.mjs
run_step_retry "28/46 Frontend Workspaces Test" node scripts/test_frontend_workspaces.mjs
run_step_retry "29/46 Frontend DragDrop Test" node scripts/test_frontend_dragdrop.mjs
run_step_retry "30/46 Frontend Sharing Test" node scripts/test_frontend_sharing.mjs
run_step_retry "31/46 Frontend Security Test" node scripts/test_frontend_security.mjs
run_step "32/46 Frontend Minimal Todo Mode Test" node scripts/test_frontend_minimal_todos.mjs
run_step_retry "33/46 Frontend Session Test" node scripts/test_frontend_session.mjs
run_step_retry "34/46 Frontend Offline Sync Test" node scripts/test_frontend_offline_sync.mjs
run_step_retry "35/46 Frontend Realtime Sync Test" node scripts/test_frontend_realtime_sync.mjs
run_step_retry "36/46 Frontend Native Runtime Config Test" node scripts/test_frontend_native_runtime_config.mjs
run_step_retry "37/46 Frontend Native Passkeys Test" node scripts/test_frontend_native_passkeys.mjs
run_step_retry "38/46 Frontend Native Offline Test" node scripts/test_frontend_native_offline.mjs
run_step_retry "39/46 Frontend Android Reminder Rehydration Test" node scripts/test_frontend_android_reminder_rehydration.mjs
run_step "40/46 Location Reminder Backend Test" python3 scripts/test_location_reminders.py
run_step "41/46 Frontend Location Reminder Test" node scripts/test_frontend_location_reminders.mjs
run_step "42/46 Native Android Location Reminder Test" node scripts/test_native_android_location_reminders.mjs
run_step_retry "43/46 Frontend BrainDump Capture Test" node scripts/test_frontend_braindump_capture.mjs
run_step "44/46 Native Windows Installer Cache Hook Test" node scripts/test_native_windows_installer_cache_hooks.mjs
run_step "45/46 Native Android WebView Cache Migration Test" node scripts/test_native_android_webview_cache_migration.mjs
run_step "46/46 Native Android Reminder Alarm Policy Test" node scripts/test_native_android_reminder_alarm_policy.mjs

echo
echo "🎉 All green — all tests passed successfully"
