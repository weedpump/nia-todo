# Test Docs

## Getting Started

- Full release gate: `./scripts/test_all.sh` or `npm test`
- Backend-focused suite: `npm run test:backend`
- Frontend-focused suite: `npm run test:frontend`
- Native-focused suite: `npm run test:native`

`./scripts/test_all.sh` is the release gate. It runs 45 serial steps and retries Playwright/realtime-sensitive frontend steps once to filter timing flakes. DB-mutating tests must stay serial; do not run review agents or another frontend/backend gate against the same dev DB at the same time.

## Release Gate: `./scripts/test_all.sh`

Current steps:

1. Backend Tests — `python3 scripts/test_backend.py`
2. BrainDump Service Tests — `python3 scripts/test_braindump_v2_services.py`
3. BrainDump Extractor Normalization Tests — `python3 scripts/test_braindump_v2_extractor_normalization.py`
4. BrainDump Todo Creation Tests — `python3 scripts/test_braindump_v2_todo_creation.py`
5. BrainDump Admin STT Probe Tests — `python3 scripts/test_braindump_admin_stt_probe.py`
6. Todo Attachments API Tests — `python3 scripts/test_todo_attachments.py`
7. Email Service Tests — `python3 scripts/test_email_services.py`
8. 2FA Service/Security Tests — `python3 scripts/test_two_factor_services.py`
9. Instance Config Service Tests — `python3 scripts/test_instance_config_services.py`
10. Migration 022 Duplicate Email Test — `python3 scripts/test_migration_022_email_duplicates.py`
11. Migration Partial Recovery Test — `python3 scripts/test_migration_email_partial_recovery.py`
12. Release Version Checker Test — `python3 scripts/test_release_versions.py`
13. Server Update Tests — `python3 scripts/test_server_updates.py`
14. Admin Password Reset Test — `python3 scripts/test_admin_password_reset.py`
15. Service Worker Precache Test — `node scripts/test_sw_precache.mjs`
16. Frontend Smoke Test — `node scripts/test_frontend_smoke.mjs`
17. Frontend App Test — `node scripts/test_frontend_app.mjs`
18. Frontend Release Ideas Test — `node scripts/test_frontend_release_ideas.mjs`
19. Frontend Subtasks Test — `node scripts/test_frontend_subtasks.mjs`
20. Frontend Setup Test — `node scripts/test_frontend_setup.mjs`
21. Frontend Admin Test — `node scripts/test_frontend_admin.mjs`
22. Frontend Password Reset Test — `node scripts/test_frontend_password_reset.mjs`
23. Frontend Settings Test — `node scripts/test_frontend_settings.mjs`
24. Frontend User Menu Alignment Test — `node scripts/test_frontend_user_menu_alignment.mjs`
25. Frontend User Menu Scroll Anchor Test — `node scripts/test_frontend_user_menu_scroll_anchor.mjs`
26. Frontend Projects Test — `node scripts/test_frontend_projects.mjs`
27. Frontend Workspaces Test — `node scripts/test_frontend_workspaces.mjs`
28. Frontend DragDrop Test — `node scripts/test_frontend_dragdrop.mjs`
29. Frontend Sharing Test — `node scripts/test_frontend_sharing.mjs`
30. Frontend Security Test — `node scripts/test_frontend_security.mjs`
31. Frontend Minimal Todo Mode Test — `node scripts/test_frontend_minimal_todos.mjs`
32. Frontend Session Test — `node scripts/test_frontend_session.mjs`
33. Frontend Offline Sync Test — `node scripts/test_frontend_offline_sync.mjs`
34. Frontend Realtime Sync Test — `node scripts/test_frontend_realtime_sync.mjs`
35. Frontend Native Runtime Config Test — `node scripts/test_frontend_native_runtime_config.mjs`
36. Frontend Native Passkeys Test — `node scripts/test_frontend_native_passkeys.mjs`
37. Frontend Native Offline Test — `node scripts/test_frontend_native_offline.mjs`
38. Frontend Android Reminder Rehydration Test — `node scripts/test_frontend_android_reminder_rehydration.mjs`
39. Location Reminder Backend Test — `python3 scripts/test_location_reminders.py`
40. Frontend Location Reminder Test — `node scripts/test_frontend_location_reminders.mjs`
41. Native Android Location Reminder Test — `node scripts/test_native_android_location_reminders.mjs`
42. Frontend BrainDump Capture Test — `node scripts/test_frontend_braindump_capture.mjs`
43. Native Windows Installer Cache Hook Test — `node scripts/test_native_windows_installer_cache_hooks.mjs`
44. Native Android WebView Cache Migration Test — `node scripts/test_native_android_webview_cache_migration.mjs`
45. Native Android Reminder Alarm Policy Test — `node scripts/test_native_android_reminder_alarm_policy.mjs`

`release.sh` calls `./scripts/test_all.sh` first and aborts immediately on failure: no merge, no tag, no push.

## Additional Focused Tests

These are covered by npm scripts or useful for targeted work, but not all are part of the 44-step release gate:

### Backend / API / migrations

- `python3 scripts/test_changelog_nested_lists.py`
- `python3 scripts/test_api_validation_errors.py`
- `python3 scripts/test_braindump_v2_services.py`
- `python3 scripts/test_braindump_v2_extractor_normalization.py`
- `python3 scripts/test_braindump_v2_todo_creation.py`
- `python3 scripts/test_braindump_admin_stt_probe.py`
- `python3 scripts/test_todo_attachments.py`
- `python3 scripts/test_default_reminder_offset.py`
- `python3 scripts/test_instance_config_services.py`
- `python3 scripts/test_location_reminders.py`
- `python3 scripts/test_oidc_services.py`
- `python3 scripts/test_push_services.py`
- `python3 scripts/test_recurring_todos.py`
- `python3 scripts/test_subtasks.py`
- `python3 scripts/test_release_native_reuse.py`
- `python3 scripts/test_websocket_location_reminders.py`
- `python3 scripts/test_braindump_audio_fixture_e2e.py`
- `python3 scripts/test_braindump_semantic_extractor.py`

### Frontend

- `node scripts/test_frontend_api_errors.mjs`
- `node scripts/test_frontend_app_downloads.mjs`
- `node scripts/test_frontend_clear_done_projects.mjs`
- `node scripts/test_frontend_todo_quick_status.mjs`
- `node scripts/test_frontend_quick_add_inline.mjs`
- `node scripts/test_frontend_braindump_capture.mjs`
- `node scripts/test_frontend_design_layout.mjs` — layout contracts including mobile FAB/sidebar/quick-action stacking.
- `node scripts/test_frontend_location_reminders.mjs`
- `node scripts/test_frontend_login_auth_layout.mjs`
- `node scripts/test_frontend_mfa_login.mjs`
- `node scripts/test_frontend_minimal_todos.mjs`
- `node scripts/test_frontend_todo_menu_flip.mjs`
- `node scripts/test_frontend_todo_modal_mobile_layout.mjs`
- `node scripts/test_frontend_ui_dropdowns.mjs`
- `node scripts/test_frontend_todo_interactive_clicks.mjs`
- `node scripts/test_frontend_subtasks.mjs`
- `node scripts/test_frontend_native_todo_actions.mjs`
- `node scripts/test_frontend_android_todo_gestures.mjs`

### Native

- `node scripts/test_native_android_location_reminders.mjs`
- `node scripts/test_native_android_microphone_permission.mjs`

## Coverage Areas

### Backend

`python3 scripts/test_backend.py`

Covers:
- Setup
- Auth
- Admin
- API keys
- Projects
- Workspaces
- Sections
- Todos, including checklist subtasks
- Push
- Reminders
- Project sharing and multi-user isolation
- Security regressions for CSRF/API key, IDOR, and date/time validation
- Email/SMTP integration: neutral responses, verified email lookups, token hashing/prefix lookup
- 2FA service/security regressions for TOTP, recovery code consumption, challenge lockout, old JWTs after policy activation, WebAuthn RP/origin/HTTPS binding, one-time MFA grants, reauth replay protection, and recovery code cleanup after removing the last primary factor

### Frontend

Representative coverage:
- Smoke: login, app start, create project, search, delete + undo
- App: sections, todo modal, validation, quick-add/status, clear-done
- Setup/password reset
- Admin: users, SMTP, OIDC provider config, global 2FA, server update UI paths
- Settings: API keys, push status/test/disable, email verification, password changes, 2FA/passkeys, dialogs without browser popups
- Projects/workspaces/drag & drop/sharing
- Security: Markdown XSS, service-worker API cache exclusion, offline sync field allowlist, email enumeration protection, MFA regressions
- Service Worker precache: every JS module, required app-shell asset, and `index.html` static JS/CSS reference must be precached. Query-string app-shell refs such as cache-busted module URLs require query-insensitive cache matching (`ignoreSearch: true`) so installed PWAs can still start offline.
- Offline/realtime sync, including subtask persistence through REST, IndexedDB, WebSocket sync responses, and reloads
- Native runtime config, native offline, native passkeys, native todo actions
- Android reminder rehydration, location reminders, todo gestures, microphone permission

## Manual Smoke Paths

### 2FA / account security

- Set up TOTP, scan QR code, complete login with TOTP.
- Add passkey, complete login/reauth via passkey.
- Connect Android app to a self-hosted server URL; passkey flow must work with the bundled app. Custom/re-sign builds are not a supported 2.x test path.
- Revoke TOTP/passkey; when removing the last primary factor, recovery codes must disappear and user-side 2FA must be disabled.
- Execute sensitive actions one after another; every action must require fresh MFA reauth.
- Trusted device must be able to skip login MFA, but must not authorize sensitive actions.
- Recovery code and email code must not work again after successful use.

### Android passkeys

For Android passkey changes, verify that `/.well-known/assetlinks.json` still serves:
- package `de.tobiaskneidl.nia_todo`
- the bundled release certificate fingerprint
- relation `delegate_permission/common.get_login_creds`

### BrainDump audio/STT

For audio/STT work, use controlled fixture recordings instead of making Tobi trial-and-error test core flows. Prefer replay/probe scripts such as:
- `python3 scripts/braindump_audio_fixture_probe.py`
- `python3 scripts/braindump_audio_replay_probe.py`
- `python3 scripts/braindump_llm_latency_probe.py`

## Email/SMTP Tests

`python3 scripts/test_email_services.py` covers SMTP config, sending, templates, token hashing/prefix lookup.

Migration tests:
- `python3 scripts/test_migration_022_email_duplicates.py` — case-insensitive uniqueness and duplicate cleanup
- `python3 scripts/test_migration_email_partial_recovery.py` — partial schema repair and idempotency

## Notes

- Frontend tests run against headless Chromium.
- Tests back up/restore the dev DB; always run DB-mutating tests serially, not in parallel. After long gates, verify the dev DB still has users (`users > 0`) before starting more tests or reviews.
- `web/manifest.json` is maintained by the dev/release flow.
