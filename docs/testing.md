# Test Strategy

nia-todo has many regression scripts. Not every historical UI/layout regression belongs in the default release gate.

## Policy

- `./scripts/test_all.sh` / `npm test` is the release gate.
- The release gate should cover release-critical behavior: backend/domain logic, security/auth, migrations, sync/offline/realtime, packaging, PWA/native runtime, and representative frontend flows.
- Pixel/layout/micro-interaction checks should be kept small and focused. They can be run separately during UI work, and the maintained subset also runs in the release gate.
- DB-mutating tests must stay serial. Do not run review agents or another frontend/backend gate against the same dev DB at the same time.
- Before real frontend/backend test runs or builds in the dev project, back up `api/data/nia-todo-dev.db`; after long gates verify the dev DB still has users (`users > 0`).

## Commands

```bash
# Release gate, also called by release.sh
./scripts/test_all.sh
npm test

# Focused suites
npm run test:backend
npm run test:frontend
npm run test:native
npm run test:todo
npm run test:ui
```

## Release Gate: `./scripts/test_all.sh`

The release gate is intentionally serial and aborts on the first failure. Playwright/realtime-sensitive app checks retry once where useful.

Current release-critical coverage:

### Backend / API / domain

- `python3 scripts/test_backend.py`
- `python3 scripts/test_api_validation_errors.py`
- `python3 scripts/test_changelog_nested_lists.py`
- `python3 scripts/test_braindump_v2_services.py`
- `python3 scripts/test_braindump_v2_extractor_normalization.py`
- `python3 scripts/test_braindump_v2_todo_creation.py`
- `python3 scripts/test_braindump_admin_stt_probe.py`
- `python3 scripts/test_recurring_todos.py`
- `python3 scripts/test_default_reminder_offset.py`
- `python3 scripts/test_subtasks.py`
- `python3 scripts/test_todo_comments.py`
- `python3 scripts/test_todo_attachments.py`
- `python3 scripts/test_location_reminders.py`
- `python3 scripts/test_websocket_location_reminders.py`
- `python3 scripts/test_email_services.py`
- `python3 scripts/test_two_factor_services.py`
- `python3 scripts/test_oidc_services.py`
- `python3 scripts/test_push_services.py`
- `python3 scripts/test_instance_config_services.py`
- `python3 scripts/test_migration_022_email_duplicates.py`
- `python3 scripts/test_migration_email_partial_recovery.py`
- `python3 scripts/test_release_versions.py`
- `python3 scripts/test_release_native_reuse.py`
- `python3 scripts/test_server_updates.py`
- `python3 scripts/test_packaging_backup.py`
- `python3 scripts/test_admin_password_reset.py`

### Frontend / PWA representative flows

- `node scripts/test_sw_precache.mjs`
- `node scripts/test_frontend_smoke.mjs`
- `node scripts/test_frontend_app.mjs`
- `node scripts/test_frontend_setup.mjs`
- `node scripts/test_frontend_admin.mjs`
- `node scripts/test_frontend_password_reset.mjs`
- `node scripts/test_frontend_settings.mjs`
- `node scripts/test_frontend_projects.mjs`
- `node scripts/test_frontend_workspaces.mjs`
- `node scripts/test_frontend_sharing.mjs`
- `node scripts/test_frontend_security.mjs`
- `node scripts/test_frontend_session.mjs`
- `node scripts/test_frontend_offline_sync.mjs`
- `node scripts/test_frontend_realtime_sync.mjs`
- `node scripts/test_frontend_braindump_capture.mjs`
- `./scripts/test_ui_contracts.sh`

### Native / packaging release blockers

- `node scripts/test_frontend_native_runtime_config.mjs`
- `node scripts/test_frontend_native_passkeys.mjs`
- `node scripts/test_frontend_native_offline.mjs`
- `node scripts/test_frontend_android_reminder_rehydration.mjs`
- `node scripts/test_native_android_location_reminders.mjs`
- `node scripts/test_native_android_webview_cache_migration.mjs`
- `node scripts/test_native_android_reminder_alarm_policy.mjs`
- `node scripts/test_native_android_microphone_permission.mjs`
- `node scripts/test_native_windows_installer_cache_hooks.mjs`

`release.sh` calls `./scripts/test_all.sh` and aborts immediately on failure: no merge, no tag, no push.

## Focused Todo Feature Suite

Use before merging larger Todo UX/interaction changes:

```bash
npm run test:todo
```

Covers Todo API basics plus representative Todo frontend/native interaction scripts:

- backend core Todo coverage
- subtasks/comments/attachments APIs
- frontend smoke/app
- frontend subtasks
- quick-add/status
- interactive click isolation
- native Todo actions
- Android Todo gestures

## Optional UI Contract Suite

Use after broad UI refactors, visual-system migrations, dropdown/layout rewrites, or when a touched area specifically needs early feedback. The same maintained UI contract suite is also called by the release gate:

```bash
npm run test:ui
```

This suite intentionally keeps only reusable UI contracts and currently relevant layout checks:

- frontend API error adapter contract
- clear-done project logic
- broad design layout contracts
- touch zoom lock
- shared UI dropdown primitive
- Todo modal mobile layout while the Todo redesign is active

Historical one-off pixel/layout tests for user-menu alignment, scroll anchoring, Todo menu flip, action breakpoints, overview stat clamp, app-download visibility, login layout, and minimal Todo mode were removed instead of being kept forever as release baggage.

## Native Focused Suite

```bash
npm run test:native
```

Use for native runtime, Android wrapper, passkey, reminder, microphone, WebView cache, or installer changes.

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

## Notes

- Frontend tests run against headless Chromium.
- `withFreshDb` tests temporarily move the dev DB and attachment directory; this is why gates must stay serial.
- Review subagents should not run full gates by default. They may run static/syntax checks or a focused suite only when explicitly requested.
- `web/manifest.json` is maintained by the dev/release flow.
