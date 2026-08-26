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
echo "Policy: release-critical domain/API/security/sync/native checks only. Fragile UI micro-layout tests were intentionally trimmed."

run_step "Backend Core API" python3 scripts/test_backend.py
run_step "API Validation Error Contracts" python3 scripts/test_api_validation_errors.py
run_step "Security Rate Limit" python3 scripts/test_rate_limit.py
run_step "Security Request Body Limit" python3 scripts/test_request_body_limit.py
run_step "Security Password Length" python3 scripts/test_password_length.py
run_step "Security Trust Boundaries" python3 scripts/test_security_boundaries.py
run_step "Security First-Run Setup Token" python3 scripts/test_setup_token.py
run_step "Security Github Action Pins" python3 scripts/test_github_action_pins.py
run_step "Security Runtime Code Ownership" python3 scripts/test_runtime_code_ownership.py
run_step "Security Rate Limit Pruning" python3 scripts/test_rate_limit_pruning.py
run_step "Security Avatar Pixel Limit" python3 scripts/test_avatar_pixel_limit.py
run_step "Security Admin Error Escape" python3 scripts/test_admin_error_escape.py
run_step "Security Attachment Authorization Order" python3 scripts/test_attachment_authorization_order.py
run_step "Security Braindump Process Timeout" python3 scripts/test_braindump_process_timeout.py
run_step "BrainDump Services" python3 scripts/test_braindump_v2_services.py
run_step "BrainDump Extractor Normalization" python3 scripts/test_braindump_v2_extractor_normalization.py
run_step "BrainDump Todo Creation" python3 scripts/test_braindump_v2_todo_creation.py
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
run_step "Fresh Migrations" python3 scripts/test_fresh_migrations.py
run_step "Release Version Checker" python3 scripts/test_release_versions.py
run_step "Release Native Reuse" python3 scripts/test_release_native_reuse.py
run_step "Server Updates" python3 scripts/test_server_updates.py
run_step "Packaging Backup/Restore" python3 scripts/test_packaging_backup.py
run_step "Admin Password Reset" python3 scripts/test_admin_password_reset.py

run_step "Service Worker Precache" node scripts/test_sw_precache.mjs
run_step "Frontend Quick Add Inline" node scripts/test_frontend_quick_add_inline.mjs
run_step "Frontend Security" node scripts/test_frontend_security.mjs
run_step "Frontend Native Passkeys" node scripts/test_frontend_native_passkeys.mjs
run_step_retry "Frontend Android Todo Gestures" node scripts/test_frontend_android_todo_gestures.mjs
run_step "Sync Feature Race Guard" node scripts/test_sync_feature_race.mjs

frontend_suite_active=0
restore_frontend_suite() {
  if [[ "$frontend_suite_active" == "1" ]]; then
    frontend_suite_active=0
    node scripts/frontend_db_suite.mjs restore
  fi
}
trap restore_frontend_suite EXIT

step "Frontend DB Suite"
node scripts/frontend_db_suite.mjs begin
frontend_suite_active=1

run_frontend_step() {
  NIA_TODO_FRONTEND_DB_SUITE=1 run_step "$@"
}

run_frontend_step_retry() {
  NIA_TODO_FRONTEND_DB_SUITE=1 run_step_retry "$@"
}

run_frontend_shared_step_retry() {
  NIA_TODO_FRONTEND_DB_SUITE=1 NIA_TODO_FRONTEND_DB_SHARED=1 run_step_retry "$@"
}

step "Frontend Shared DB"
node scripts/frontend_db_suite.mjs prepare-shared
run_frontend_shared_step_retry "Frontend Smoke" node scripts/test_frontend_smoke.mjs
run_frontend_shared_step_retry "Frontend App Core" node scripts/test_frontend_app.mjs
run_frontend_shared_step_retry "Frontend Subtasks" node scripts/test_frontend_subtasks.mjs
run_frontend_shared_step_retry "Frontend Todo Interactive Click Isolation" node scripts/test_frontend_todo_interactive_clicks.mjs
run_frontend_shared_step_retry "Frontend DragDrop" node scripts/test_frontend_dragdrop.mjs

step "Frontend Isolated DB"
run_frontend_step_retry "Frontend Setup" node scripts/test_frontend_setup.mjs
run_frontend_step_retry "Frontend Admin CSP" node scripts/test_frontend_admin_csp.mjs
run_frontend_step_retry "Frontend Password Reset" node scripts/test_frontend_password_reset.mjs
run_frontend_step_retry "Frontend MFA Login" node scripts/test_frontend_mfa_login.mjs
run_frontend_step_retry "Frontend Sharing" node scripts/test_frontend_sharing.mjs
run_frontend_step_retry "Frontend Session" node scripts/test_frontend_session.mjs
run_frontend_step_retry "Frontend Offline Sync" node scripts/test_frontend_offline_sync.mjs
run_frontend_step_retry "Frontend Realtime Sync" node scripts/test_frontend_realtime_sync.mjs


# Native/static release checks remain part of the release gate because packaging/native regressions are release blockers.
run_frontend_step_retry "Frontend Native Runtime Config" node scripts/test_frontend_native_runtime_config.mjs
run_frontend_step_retry "Frontend Native Offline" node scripts/test_frontend_native_offline.mjs
run_frontend_step_retry "Frontend Android Reminder Rehydration" node scripts/test_frontend_android_reminder_rehydration.mjs

restore_frontend_suite
trap - EXIT
run_step "Native Android Location Reminder" node scripts/test_native_android_location_reminders.mjs
run_step "Native Android WebView Cache Migration" node scripts/test_native_android_webview_cache_migration.mjs
run_step "Native Debian WebView Cache Migration" node scripts/test_native_linux_webview_cache_migration.mjs
run_step "Native Debian Package Name" node scripts/test_native_debian_deb_package_name.mjs
run_step "Native Desktop Settings Static" node scripts/test_native_desktop_settings_static.mjs
run_step "Native Android Reminder Alarm Policy" node scripts/test_native_android_reminder_alarm_policy.mjs
run_step "Native Android Microphone Permission" node scripts/test_native_android_microphone_permission.mjs
run_step "Native Windows Installer Cache Hook" node scripts/test_native_windows_installer_cache_hooks.mjs

echo
echo "🎉 Release gate green"
