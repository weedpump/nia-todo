#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Direct test processes import the FastAPI application and execute its startup
# hooks. Keep their update checks away from production endpoints just like the
# installed package integration service.
export NIA_TODO_UPDATE_PRIMARY_URL="http://127.0.0.1:9/update/stable.json"
export NIA_TODO_UPDATE_RELEASE_API_URL="http://127.0.0.1:9/releases/latest"
export NIA_TODO_UPDATE_UMAMI_URL="http://127.0.0.1:9"
export NIA_TODO_UPDATE_UMAMI_WEBSITE_ID=""

TEST_STEP_TIMEOUT_SECONDS="${NIA_TODO_TEST_STEP_TIMEOUT_SECONDS:-300}"

run_test_command() {
  local code
  if python3 scripts/run_with_timeout.py "${TEST_STEP_TIMEOUT_SECONDS}" "$@"; then
    return 0
  else
    code=$?
  fi
  if [[ "$code" == "124" || "$code" == "137" ]]; then
    echo "⏱️  Test step timed out or required forced termination; checking for interrupted backend test state..."
    if ! python3 scripts/test_backend.py --recover-interrupted; then
      echo "❌ Failed to recover state after the timed-out test step."
      return 125
    fi
  fi
  return "$code"
}

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
  if run_test_command "$@"; then
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
  if run_test_command "$@"; then
    echo "✅ OK: $label"
    return 0
  else
    code=$?
  fi

  echo "⚠️  FAILED: $label"
  echo "   Exit code: $code"
  echo "   Retrying once to catch Playwright/realtime timing flakes..."

  if run_test_command "$@"; then
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
run_step "Security Tauri Vendor Sync" node scripts/test_tauri_vendor_sync.mjs
run_step "Security First-Run Setup Token" python3 scripts/test_setup_token.py
run_step "Security First-Run Setup Sequence" python3 scripts/test_setup_sequence.py
run_step "Project Sharing Semantics" python3 scripts/test_project_sharing_semantics.py
run_step "Household Entity Access" python3 scripts/test_household_entity_access.py
run_step "Shopping Lists" python3 scripts/test_shopping_lists.py
run_step "Household API" python3 scripts/test_household_api.py
run_step "Project Household Access" python3 scripts/test_project_household_access.py
run_step "Household Access Regressions" python3 scripts/test_household_access_regressions.py
run_step "Account Module Visibility" python3 scripts/test_account_module_visibility.py
run_step "Dashboard Preferences Sync" python3 scripts/test_dashboard_preferences_sync.py
run_step "Security Github Action Pins" python3 scripts/test_github_action_pins.py
run_step "Android CLI Workflow Contract" python3 scripts/test_android_cli_workflow.py
run_step "Playwright Workflow Contract" python3 scripts/test_playwright_workflow.py
run_step "Security Runtime Code Ownership" python3 scripts/test_runtime_code_ownership.py
run_step "Security Avatar Pixel Limit" python3 scripts/test_avatar_pixel_limit.py
run_step "Avatar Profile Updates" python3 scripts/test_avatar_profile_update.py
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
run_step "WebSocket Auth Registration" python3 scripts/test_websocket_auth_registration.py
run_step "Email Services" python3 scripts/test_email_services.py
run_step "2FA Service/Security" python3 scripts/test_two_factor_services.py
run_step "OIDC Services" python3 scripts/test_oidc_services.py
run_step "Push Services" python3 scripts/test_push_services.py
run_step "Instance Config Services" python3 scripts/test_instance_config_services.py
run_step "Fresh Migrations" python3 scripts/test_fresh_migrations.py
run_step "Release Version Checker" python3 scripts/test_release_versions.py
run_step "Release Native Reuse" python3 scripts/test_release_native_reuse.py
run_step "Windows Updater Endpoint" python3 scripts/test_native_windows_updater_endpoint.py
run_step "Windows Updater Contract" python3 scripts/test_windows_tauri_updater_contract.py
run_step "Debian Updater Contract" python3 scripts/test_debian_native_updater_contract.py
run_step "Android Updater Contract" python3 scripts/test_android_native_updater_contract.py
run_step "Server Updates" python3 scripts/test_server_updates.py
run_step "Update Analytics Admin Static" python3 scripts/test_update_analytics_admin_static.py
run_step "Packaging Backup/Restore" python3 scripts/test_packaging_backup.py
run_step "Admin Password Reset" python3 scripts/test_admin_password_reset.py

run_step "Product Branding" node scripts/test_product_branding.mjs
run_step "Module Shell" node scripts/test_module_shell.mjs
run_step "Shared Entity Sidebar" node scripts/test_frontend_entity_sidebar.mjs
run_step "Shared Section UI" node scripts/test_shared_section_ui.mjs
run_step "Shopping Sections" node scripts/test_shopping_sections.mjs
run_step "Shopping Items" node scripts/test_shopping_items.mjs
run_step "Shopping List Content Browser" node scripts/test_frontend_shopping_content.mjs
run_step "Shared Entity Appearance" node scripts/test_frontend_entity_appearance.mjs
run_step "Shared Entity Appearance Browser" node scripts/test_frontend_entity_appearance_browser.mjs
run_step "Shopping List Delete Browser" node scripts/test_frontend_shopping_delete.mjs
run_step "Auth Module Hydration" node scripts/test_frontend_auth_module_hydration.mjs
run_step "Service Worker Precache" node scripts/test_sw_precache.mjs
run_step "Service Worker Avatar Privacy" node scripts/test_sw_avatar_privacy.mjs
run_step "Workspace Modal Lifecycle" node scripts/test_frontend_workspace_modal_lifecycle.mjs
run_step "Account Module Settings" node scripts/test_frontend_module_settings.mjs
run_step "Settings Navigation Lifecycle" node scripts/test_frontend_settings_navigation_lifecycle.mjs
run_step "Avatar IndexedDB" node scripts/test_avatar_indexeddb.mjs
run_step "Avatar Offline Cache" node scripts/test_avatar_cache.mjs
run_step "Avatar Realtime Updates" node scripts/test_avatar_realtime.mjs
run_step "Todo Attachment Thumbnails" node scripts/test_todo_attachment_thumbnails.mjs
run_step "Frontend Quick Add Inline" node scripts/test_frontend_quick_add_inline.mjs
run_step "Frontend Multi Todo Add" node scripts/test_frontend_multi_todo_add.mjs
run_step "Frontend Project Counters" node scripts/test_frontend_project_counters.mjs
run_step "Frontend Security" node scripts/test_frontend_security.mjs
run_step "Frontend Rich Text Editor" node scripts/test_frontend_rich_text_editor.mjs
run_step "Frontend Native Passkeys" node scripts/test_frontend_native_passkeys.mjs
run_step_retry "Frontend Android Todo Gestures" node scripts/test_frontend_android_todo_gestures.mjs
run_step "Mobile Swipe Runtime" node scripts/test_mobile_swipe_runtime.mjs
run_step "Mobile Swipe Underlay" node scripts/test_mobile_swipe_underlay.mjs
run_step "Frontend Todo Details Layout" node scripts/test_frontend_todo_details_layout.mjs
run_step "Todo Metadata Summary Live Updates" node scripts/test_todo_meta_summary_live_updates.mjs
run_step "Sync Feature Race Guard" node scripts/test_sync_feature_race.mjs
run_step "WebSocket Access Snapshot" node scripts/test_frontend_access_snapshot.mjs
run_step "Offline Todo Child Sync Contracts" node scripts/test_offline_todo_child_sync.mjs
run_step "Offline Shopping Sync Contracts" node scripts/test_offline_shopping_sync.mjs
run_step "Frontend Shopping Realtime" node scripts/test_frontend_shopping_realtime.mjs
run_step "Shopping Store Snapshot" node scripts/test_shopping_store_snapshot.mjs

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
  local label="$1"
  local code
  shift
  step "$label"

  node scripts/frontend_db_suite.mjs prepare-shared
  if NIA_TODO_FRONTEND_DB_SUITE=1 NIA_TODO_FRONTEND_DB_SHARED=1 run_test_command "$@"; then
    echo "✅ OK: $label"
    return 0
  else
    code=$?
  fi

  echo "⚠️  FAILED: $label"
  echo "   Exit code: $code"
  echo "   Resetting the shared frontend DB before one retry..."

  node scripts/frontend_db_suite.mjs prepare-shared
  if NIA_TODO_FRONTEND_DB_SUITE=1 NIA_TODO_FRONTEND_DB_SHARED=1 run_test_command "$@"; then
    echo "✅ OK after isolated retry: $label"
  else
    code=$?
    echo "❌ FAILED: $label"
    echo "   Exit code: $code"
    echo "   Aborting — check the error above."
    exit "$code"
  fi
}

step "Frontend Shared DB"
run_frontend_shared_step_retry "Frontend Smoke" node scripts/test_frontend_smoke.mjs
run_frontend_shared_step_retry "Frontend App Core" node scripts/test_frontend_app.mjs
run_frontend_shared_step_retry "Shared Entity Sidebar Browser" node scripts/test_frontend_entity_sidebar_browser.mjs
run_frontend_shared_step_retry "Frontend Subtasks" node scripts/test_frontend_subtasks.mjs
run_frontend_shared_step_retry "Frontend Offline Todo Children" node scripts/test_frontend_offline_todo_children.mjs
run_frontend_shared_step_retry "Frontend Todo Interactive Click Isolation" node scripts/test_frontend_todo_interactive_clicks.mjs
run_frontend_shared_step_retry "Frontend Todo Metadata Badges" node scripts/test_frontend_todo_meta_badges.mjs
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
run_step "Native Android Dashboard Scrollbars" node scripts/test_native_android_dashboard_scrollbars.mjs
run_step "Native Android Location Reminder" node scripts/test_native_android_location_reminders.mjs
run_step "Android Location Permission Guidance" node scripts/test_frontend_android_location_permission.mjs
run_step "Native Android WebView Cache Migration" node scripts/test_native_android_webview_cache_migration.mjs
run_step "Native Debian WebView Cache Migration" node scripts/test_native_linux_webview_cache_migration.mjs
run_step "Native Debian Package Name" node scripts/test_native_debian_deb_package_name.mjs
run_step "Native Desktop Settings Static" node scripts/test_native_desktop_settings_static.mjs
run_step "i18n Language Lifecycle" node scripts/test_i18n_language_lifecycle.mjs
run_step "Desktop Hotkey Description Sync" node scripts/test_desktop_hotkey_description_sync.mjs
run_step "Native Linux Window Integration" node scripts/test_native_linux_window_integration.mjs
run_step "Native Android Reminder Alarm Policy" node scripts/test_native_android_reminder_alarm_policy.mjs
run_step "Native Android Microphone Permission" node scripts/test_native_android_microphone_permission.mjs
run_step "Native Linux Microphone Permission" node scripts/test_native_linux_microphone_permission.mjs
run_step "Native Windows Installer Cache Hook" node scripts/test_native_windows_installer_cache_hooks.mjs
run_step "Frontend Windows Native Update" node scripts/test_frontend_windows_native_update.mjs
run_step "Frontend Debian Native Update" node scripts/test_frontend_debian_native_update.mjs
run_step "Frontend Android Native Update" node scripts/test_frontend_android_native_update.mjs

echo
echo "🎉 Release gate green"
