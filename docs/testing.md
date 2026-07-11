# Test Strategy

nia-todo has many regression scripts. The default gate is intentionally release-focused: it should catch domain/API/security/sync/native regressions without preserving every historical UI/layout micro-test forever.

## Policy

- `./scripts/test_all.sh` / `npm test` is the release gate.
- The release gate is serial and aborts on the first failure.
- Playwright/realtime-sensitive checks retry once where useful.
- DB-mutating tests must stay serial. Do not run review agents or another frontend/backend gate against the same dev DB at the same time.
- Frontend/browser tests that touch the dev DB are grouped by DB needs:
  - no DB/static checks
  - one shared fresh frontend DB for representative core UI flows
  - isolated fresh DBs for setup/auth/offline/realtime/native-runtime flows
- Before real frontend/backend test runs or builds in the dev project, back up `api/data/nia-todo-dev.db`; after long gates verify the dev DB still has users and was not left as the `frontenduser` test DB.
- Probe/manual scripts that require external services, configured LLMs, real audio tooling, or operator judgment must not be named as `scripts/test_*` unless they are part of the maintained automated test surface.

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

`release.sh` calls `./scripts/test_all.sh` and aborts immediately on failure: no merge, no tag, no push.

### Backend / API / domain

- `python3 scripts/test_backend.py`
- `python3 scripts/test_api_validation_errors.py`
- `python3 scripts/test_braindump_v2_services.py`
- `python3 scripts/test_braindump_v2_extractor_normalization.py`
- `python3 scripts/test_braindump_v2_todo_creation.py`
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
- `python3 scripts/test_fresh_migrations.py`
- `python3 scripts/test_release_versions.py`
- `python3 scripts/test_release_native_reuse.py`
- `python3 scripts/test_server_updates.py`
- `python3 scripts/test_packaging_backup.py`
- `python3 scripts/test_admin_password_reset.py`

### Frontend static / no DB

These checks run before the frontend DB suite because they do not need a browser-backed dev DB reset.

- `node scripts/test_sw_precache.mjs`
- `node scripts/test_frontend_quick_add_inline.mjs`
- `node scripts/test_frontend_security.mjs`
- `node scripts/test_frontend_native_passkeys.mjs`
- `node scripts/test_frontend_android_todo_gestures.mjs`
- `node scripts/test_sync_feature_race.mjs`

### Frontend DB suite

`test_all.sh` creates one suite backup with `scripts/frontend_db_suite.mjs begin` and restores it at the end, also via `trap` on abort. The suite backup is copy-based and refuses to preserve a DB that only contains the `frontenduser` test account.

#### Shared fresh frontend DB

One fresh frontend test DB is prepared for representative core UI flows. These tests may create todos/projects/sections, but they should not depend on an otherwise pristine DB beyond the initial shared setup.

- `node scripts/test_frontend_smoke.mjs`
- `node scripts/test_frontend_app.mjs`
- `node scripts/test_frontend_subtasks.mjs`
- `node scripts/test_frontend_todo_interactive_clicks.mjs`
- `node scripts/test_frontend_dragdrop.mjs`

#### Isolated fresh frontend DB

These tests get a fresh DB per script because they modify setup/auth/session/offline/realtime/native state or are otherwise order-sensitive.

- `node scripts/test_frontend_setup.mjs`
- `node scripts/test_frontend_password_reset.mjs`
- `node scripts/test_frontend_mfa_login.mjs`
- `node scripts/test_frontend_sharing.mjs`
- `node scripts/test_frontend_session.mjs`
- `node scripts/test_frontend_offline_sync.mjs`
- `node scripts/test_frontend_realtime_sync.mjs`
- `node scripts/test_frontend_native_runtime_config.mjs`
- `node scripts/test_frontend_native_offline.mjs`
- `node scripts/test_frontend_android_reminder_rehydration.mjs`

### Native / packaging release blockers

These checks run after the frontend DB suite restore unless explicitly listed above.

- `node scripts/test_native_android_location_reminders.mjs`
- `node scripts/test_native_android_webview_cache_migration.mjs`
- `node scripts/test_native_linux_webview_cache_migration.mjs`
- `node scripts/test_native_debian_deb_package_name.mjs`
- `node scripts/test_native_desktop_settings_static.mjs`
- `node scripts/test_native_android_reminder_alarm_policy.mjs`
- `node scripts/test_native_android_microphone_permission.mjs`
- `node scripts/test_native_windows_installer_cache_hooks.mjs`

## Focused Suites

### Backend

```bash
npm run test:backend
```

Runs the backend/domain/security/release Python checks from the release gate. Some service tests create temporary databases and run migrations in quiet mode; `test_fresh_migrations.py` intentionally exercises a full fresh migration.

### Frontend

```bash
npm run test:frontend
```

Runs the focused frontend subset from `package.json`. For the full DB-suite grouping and native/static additions, use `./scripts/test_all.sh`.

### Todo feature checks

```bash
npm run test:todo
```

Use before merging larger Todo UX/interaction changes. The suite keeps Todo API coverage plus representative Todo frontend/native interaction checks.

### UI contract check

```bash
npm run test:ui
```

Currently runs the maintained touch-zoom contract. Historical one-off pixel/layout tests were removed from the automated gate instead of being kept forever as release baggage.

### Native

```bash
npm run test:native
```

Use for native runtime, desktop settings, Android wrapper, passkey, reminder, microphone, WebView cache, Debian package naming, or installer changes.

The native suite includes static/package checks that protect platform-specific release contracts:

- Debian desktop `.deb` package name must be `nia-todo-desktop`, not `nia-todo`, so it does not conflict with the server package.
- Debian desktop WebView cache migration must only clear volatile cache directories when the app version or executable marker changes.
- Native desktop settings must keep desktop-only options scoped correctly and avoid leaking Windows-only wording onto Debian desktop.

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
- `python3 scripts/braindump_semantic_extractor_probe.py`
- `python3 scripts/braindump_audio_fixture_e2e_probe.py`

## Notes

- Frontend tests run against headless Chromium.
- `withFreshDb` still protects single-test execution by backing up/restoring the dev DB for isolated runs.
- Inside `test_all.sh`, `NIA_TODO_FRONTEND_DB_SUITE=1` switches frontend tests to the suite-managed DB lifecycle.
- `NIA_TODO_FRONTEND_DB_SHARED=1` tells `withFreshDb` to reuse the already prepared shared test DB instead of creating an isolated DB.
- Review subagents should not run full gates by default. They may run static/syntax checks or a focused suite only when explicitly requested.
- `web/manifest.json` and `src-tauri/frontend-dist/` are maintained by the dev/release flow; source tests generally target `web/` unless a native packaging test says otherwise.
