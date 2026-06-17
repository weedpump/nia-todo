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

step "🧪 nia-todo Release Gate"
echo "Repo: $(pwd)"
echo "Time: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Policy: release-critical domain/API/security/sync/native checks only. UI contract/micro-layout tests live in focused optional suites."

run_step "Backend Core API" python3 scripts/test_backend.py
run_step "API Validation Error Contracts" python3 scripts/test_api_validation_errors.py
run_step "Changelog Nested Lists" python3 scripts/test_changelog_nested_lists.py
run_step "BrainDump Services" python3 scripts/test_braindump_v2_services.py
run_step "BrainDump Extractor Normalization" python3 scripts/test_braindump_v2_extractor_normalization.py
run_step "BrainDump Todo Creation" python3 scripts/test_braindump_v2_todo_creation.py
run_step "BrainDump Admin STT Probe" python3 scripts/test_braindump_admin_stt_probe.py
run_step "Recurring Todos" python3 scripts/test_recurring_todos.py
run_step "Default Reminder Offset" python3 scripts/test_default_reminder_offset.py
run_step "Subtasks API" python3 scripts/test_subtasks.py
run_step "Todo Comments API" python3 scripts/test_todo_comments.py
run_step "Todo Attachments API" python3 scripts/test_todo_attachments.py
run_step "Location Reminder Backend" python3 scripts/test_location_reminders.py
run_step "Location Reminder WebSocket" python3 scripts/test_websocket_location_reminders.py
run_step "Email Services" python3 scripts/test_email_services.py
run_step "2FA Service/Security" python3 scripts/test_two_factor_services.py
run_step "OIDC Services" python3 scripts/test_oidc_services.py
run_step "Push Services" python3 scripts/test_push_services.py
run_step "Instance Config Services" python3 scripts/test_instance_config_services.py
run_step "Migration 022 Duplicate Email" python3 scripts/test_migration_022_email_duplicates.py
run_step "Migration Partial Recovery" python3 scripts/test_migration_email_partial_recovery.py
run_step "Release Version Checker" python3 scripts/test_release_versions.py
run_step "Release Native Reuse" python3 scripts/test_release_native_reuse.py
run_step "Server Updates" python3 scripts/test_server_updates.py
run_step "Packaging Backup/Restore" python3 scripts/test_packaging_backup.py
run_step "Admin Password Reset" python3 scripts/test_admin_password_reset.py

run_step "Service Worker Precache" node scripts/test_sw_precache.mjs
run_step_retry "Frontend Smoke" node scripts/test_frontend_smoke.mjs
run_step_retry "Frontend App Core" node scripts/test_frontend_app.mjs
run_step_retry "Frontend Setup" node scripts/test_frontend_setup.mjs
run_step_retry "Frontend Admin" node scripts/test_frontend_admin.mjs
run_step_retry "Frontend Password Reset" node scripts/test_frontend_password_reset.mjs
run_step_retry "Frontend Settings" node scripts/test_frontend_settings.mjs
run_step_retry "Frontend Projects" node scripts/test_frontend_projects.mjs
run_step_retry "Frontend Workspaces" node scripts/test_frontend_workspaces.mjs
run_step_retry "Frontend Sharing" node scripts/test_frontend_sharing.mjs
run_step_retry "Frontend Security" node scripts/test_frontend_security.mjs
run_step_retry "Frontend Session" node scripts/test_frontend_session.mjs
run_step_retry "Frontend Offline Sync" node scripts/test_frontend_offline_sync.mjs
run_step_retry "Frontend Realtime Sync" node scripts/test_frontend_realtime_sync.mjs
run_step_retry "Frontend BrainDump Capture" node scripts/test_frontend_braindump_capture.mjs

# Focused UI contracts are also part of release; they stay separately runnable for targeted UI work.
run_step_retry "UI Contract Suite" ./scripts/test_ui_contracts.sh

# Native/static release checks remain part of the release gate because packaging/native regressions are release blockers.
run_step_retry "Frontend Native Runtime Config" node scripts/test_frontend_native_runtime_config.mjs
run_step "Frontend Native Passkeys" node scripts/test_frontend_native_passkeys.mjs
run_step_retry "Frontend Native Offline" node scripts/test_frontend_native_offline.mjs
run_step_retry "Frontend Android Reminder Rehydration" node scripts/test_frontend_android_reminder_rehydration.mjs
run_step "Native Android Location Reminder" node scripts/test_native_android_location_reminders.mjs
run_step "Native Android WebView Cache Migration" node scripts/test_native_android_webview_cache_migration.mjs
run_step "Native Android Reminder Alarm Policy" node scripts/test_native_android_reminder_alarm_policy.mjs
run_step "Native Android Microphone Permission" node scripts/test_native_android_microphone_permission.mjs
run_step "Native Windows Installer Cache Hook" node scripts/test_native_windows_installer_cache_hooks.mjs

echo
echo "🎉 Release gate green"
