# Test Strategy

nia-todo has many regression scripts. The default gate is intentionally release-focused: it should catch domain/API/security/sync/native regressions without preserving every historical UI/layout micro-test forever.

## Policy

- `./scripts/test_all.sh` / `npm test` is the release gate.
- The release gate is serial and aborts on the first failure.
- Playwright/realtime-sensitive checks retry once where useful.
- DB-mutating tests must stay serial. Do not run review agents or another frontend/backend gate against the same dev DB at the same time.
- Run service/database integration checks and the full gate in an isolated test environment with a dedicated service and data directory. Verify those targets and a backup/restore plan before starting; a temporary checkout alone does not isolate the installed service or DB.
- Frontend/browser tests that touch the dev DB are grouped by DB needs:
  - no DB/static checks
  - one shared fresh frontend DB for representative core UI flows
  - isolated fresh DBs for setup/auth/offline/realtime/native-runtime flows
- Before real frontend/backend test runs or builds, back up the installed DB (`/var/lib/nia-todo/nia-todo.db`); after long gates verify it still has users and was not left as the `frontenduser` test DB.
- Probe/manual scripts that require external services, configured LLMs, real audio tooling, or operator judgment must not be named as `scripts/test_*` unless they are part of the maintained automated test surface.

## Commands

```bash
# Release gate, also run by the CI/release GitHub Actions workflows
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

Both CI workflows build and install a real Debian package before invoking the gate through `scripts/release/install-and-test.sh`. The ordinary `tests.yml` workflow builds a test package first. A tagged `release.yml` run prepares the release version and builds the release artifacts before testing the resulting server package; publishing still depends on the package and browser gates succeeding.

The current command inventory is in `scripts/test_all.sh`; the lists below summarize its coverage. Focused checks passing do not replace the complete gate before a module is approved for integration.

### V4 modules and shared capture

The gate covers generic entity ownership, invitations and access privacy alongside Shopping list/section/item/store lifecycle, shared editors and navigation, view preferences, offline queue/remapping and realtime snapshots. Shared Quick Add and multi-item capture checks cover both Tasks and Shopping, including localization and browser interaction. Representative entry points are `scripts/test_shopping_lists.py`, `scripts/test_entity_sharing_boundaries.py`, `scripts/test_shopping_items.mjs`, `scripts/test_frontend_shopping_bulk_add.mjs`, `scripts/test_multi_add.mjs`, `scripts/test_frontend_multi_todo_add.mjs`, `scripts/test_offline_shopping_sync.mjs`, and `scripts/test_frontend_shopping_realtime.mjs`.

Changes to shared shells, editors, capture controllers, storage or sync require the relevant Tasks regressions as well as Shopping checks. Run DB-mutating checks serially under one coordinator; inspect each script's service/data configuration rather than assuming every focused check uses a temporary DB. Cookbook container coverage includes fresh/upgrade migration preservation, actor-scoped retries, concurrent creates, personal/household/direct access and private snapshots (`scripts/test_cookbooks.py`), shared-editor/mobile/permission lifecycle (`scripts/test_frontend_cookbooks.mjs`), actual IndexedDB upgrades and replay (`scripts/test_offline_cookbooks_sync.mjs`), and real-service two-browser CRUD/offline/reconnect (`scripts/test_frontend_cookbooks_e2e.mjs`). Recipe aggregates are covered by `scripts/test_recipes.py`, `scripts/test_recipe_images.py`, `scripts/test_frontend_recipes.mjs`, `scripts/test_offline_recipes_sync.mjs`, `scripts/test_recipe_image_cache.mjs`, and `scripts/test_frontend_recipes_e2e.mjs`. These cover child identity/order, multiline steps, tags, unit normalization and scaling, inherited permissions, revision conflicts and retries, private images, parent remapping, reloads and two-browser realtime/offline behavior.

Mixed BrainDump regressions use mocked audio/extraction and isolated databases: `scripts/test_frontend_braindump_modules.mjs` covers the shared launcher, editable routing, session guards, partial retries and mobile layout; `scripts/test_braindump_shopping_queue.mjs` and `scripts/test_offline_shopping_sync.mjs` cover durable writes and reference remapping. The backend extraction/learning scripts cover permissions, opt-out/reset and idempotency; `scripts/test_fresh_migrations.py` checks upgrade rollback and retry. These checks do not exercise a real microphone, STT service or LLM.

Attachment quota access regressions use a disposable, fully migrated database and files in `scripts/test_attachment_quota_access.py`: direct and household access loss, inherited and alternative access, restored access, retained uploader attribution, account deletion, admin totals and transaction boundaries. `scripts/test_todo_attachment_quota.mjs` exercises fresh upload-policy checks and stale account/privacy responses without a browser, service or database. The established attachment API, entity privacy and household lifecycle checks remain relevant when changing this policy.

Optimistic Todo deletion is covered by `scripts/test_todo_delete_identity.mjs` (private browser fixture for keyboard/modal deletion and IDs remapped during confirmation) and `scripts/test_offline_todo_delete_sync.mjs` (held HTTP creation/deletion responses, unsent cancellation, receipts, reload, Undo and privacy boundaries). The real-service `test_frontend_app.mjs` deliberately holds the creation request until its temporary Todo has been deleted locally, then verifies deletion of the server record. This fixes the race deterministically instead of relying on extra timeouts or retries.

`scripts/test_frontend_shopping_e2e.mjs` additionally runs the actual application against the isolated API service across two browser sessions. It covers list/section/store/item creation, real WebSocket delivery, mobile offline queue/reconnect, temporary-ID remapping, reload and layout overflow without mocking Shopping HTTP or WebSocket traffic. Optional screenshots are written to `NIA_TODO_TEST_OUTPUT_DIR`.

Use `waitForPageCondition` from `scripts/browser_page_condition.mjs` for asynchronous browser predicates; it awaits the result and enforces one total deadline. An async `waitForFunction` callback can otherwise resolve on its first truthy Promise before the condition holds. Loopback-only test namespaces can opt into `NIA_TODO_TEST_ISOLATED_NETWORK=1`: the shared browser helper then aligns the page's online signal with Playwright's actual transport offline setting, including across reloads. This does not expose host networking or mock application API/WebSocket traffic.

Recipe-to-Shopping transfer has four isolated regression scripts: `test_recipe_shopping_transfer.py` exercises full migrations, permissions, atomic rollback, quantities and concurrent idempotency on temporary SQLite databases; `test_frontend_recipe_shopping_transfer.mjs` exercises the shared transfer dialog at a mocked browser origin; `test_offline_recipe_shopping_transfer.mjs` uses real IndexedDB with controlled API transports for retry, remapping, source dependencies and privacy fences. `test_recipe_shopping_transfer_e2e.mjs` starts its own temporary FastAPI process and database, then checks actual login, transfer, private provenance, mobile PWA offline reload and reconnect. It uses the checkout venv when present, otherwise `python3`; `NIA_TODO_TEST_PYTHON` overrides the interpreter. None uses the development database or service. Run database-mutating checks serially.

Unit coverage uses `test_quantity_units.py` and `test_recipe_quantities.mjs` for shared registry/rounding vectors, all twelve locale labels, no-fuzzy unknowns and frontend/backend normalization parity. `test_quantity_registry_update.py` verifies CLDR refresh preservation without network requests. Quick Add, BrainDump review and Shopping/recipe UI regressions use the same registry; transfer tests assert exact arithmetic, display-mode boundaries and manual quantity preservation.

Recipe step links and cooking are covered by the expanded disposable `test_recipes.py`, shared-renderer checks in `test_recipe_step_ingredients.mjs`, private mocked editor/IndexedDB tests in `test_frontend_recipe_step_editor.mjs`, and real browser-history/mobile checks in `test_frontend_recipe_cooking.mjs`. The self-contained `test_recipe_shopping_transfer_e2e.mjs` also checks actual persistence, cooking reload, Back navigation and ingredient badges before exercising Shopping transfer/offline reload. These fixtures do not use the development database. Step-amount coverage includes full/repeated references, numeric and free-text overrides, legacy PATCH preservation, quantity validation, mobile editor focus and offline payloads. Transfer coverage includes one product checklist, default combination of compatible sources with differing notes, explicit separation, partial source selection and mixed checkbox states, original-source totals/provenance, target separation, responsive defaults spacing and immutable grouped replay.

### Shared routing memory

- `python3 scripts/test_routing_memory.py` uses disposable databases for exact multilingual names, partial intent, multiple stores, cross-flow writes, authorization, idempotency, reset epochs and compatibility. `test_fresh_migrations.py` covers upgrade and fresh-install migrations; the routing tests cover the schema 069 import, deduplicated legacy counters, complete hidden-target competition, generation fences for old clients and schema 070 Unicode/collision/rollback upgrades with corrections to imported evidence.
- `node scripts/test_routing_memory_matching.mjs` verifies the generated numeric parameters and independent exact/phrase/statistical counterexamples against both JS and Python implementations, without a service/database. History tests include competing observations, decay, negative empty choices, replay/reset fences and one-seed-only schema 068 upgrades.
- `node scripts/test_routing_memory.mjs` checks the shared client's offline cache, explicit-field feedback, access filtering, account isolation and stale reply/reset fences without a service or database. `test_frontend_shopping_routing_memory.mjs` uses a private mocked browser origin for manual/Quick Add/bulk precedence, drag learning, empty selections and asynchronous modal guards.
- `python3 scripts/test_routing_memory_base.py` checks pure personal-corpus inference, exact personal precedence, imported evidence, conflicts and candidate budgets without a database. `node scripts/test_routing_memory_base_recognition.mjs` checks independently authored cases across twelve locales, including JS/Python route and decision parity, CJK, corpus frequency, field conflicts and immutable input evidence. Typo regressions cover all four single-edit operations, minimum lengths, unique personal spellings, per-field uncertainty barriers, list-only observations, bounded work and unchanged-input/non-learning behavior.
- `node scripts/test_routing_memory_lifecycle.mjs` checks trailing refreshes, immutable cached results, in-place authorization changes and captured save/reset/session boundaries. `node scripts/test_routing_memory_prepared.mjs` checks raw/prepared and JS/Python parity, snapshot ownership, policy invalidation and bounded model analysis for large recipe catalogs without timing assertions.
- `node scripts/test_task_routing_memory.mjs` checks Tasks exact/token matching with JS/Python parity, workspace isolation, access revocation and pending-feedback reset fences, without a database. `test_frontend_todo_routing_memory.mjs` uses a private mocked browser origin for normal Tasks single/bulk entry, automatic AI badges, explicit choices, live cache changes and attempted versus unsent create edits.
- Existing BrainDump/recipe UI and offline suites verify feedback provenance, durable serialization, temporary-ID remapping and immutable attempted bodies. `test_shared_routing_memory_e2e.mjs` starts a private temporary service/database and checks actual Shopping-to-Recipe and Recipe-to-Shopping learning, proposal-only non-learning, AI-source chips without acceptance buttons, repeated confidence after corrections, personal phrase variants, multiple stores, the shared BrainDump adapter without an LLM, non-BrainDump memory settings, normal Tasks-to-BrainDump round trips, unfamiliar qualifiers in Shopping/recipe transfer and statistically discriminating Task entry, unchanged-prediction non-learning, and stale-generation rejection. Its normal and typo scenarios run serially against separate temporary services, retaining production rate limits. Run it serially with other database-mutating checks; it never uses the development database.

### Security / workflow contracts

- `python3 scripts/test_rate_limit.py`
- `python3 scripts/test_request_body_limit.py`
- `python3 scripts/test_password_length.py`
- `python3 scripts/test_security_boundaries.py`
- `node scripts/test_tauri_vendor_sync.mjs`
- `python3 scripts/test_setup_token.py`
- `python3 scripts/test_setup_sequence.py`
- `python3 scripts/test_project_sharing_semantics.py`
- `python3 scripts/test_github_action_pins.py`
- `python3 scripts/test_playwright_workflow.py`
- `python3 scripts/test_runtime_code_ownership.py`
- `python3 scripts/test_avatar_pixel_limit.py`

### Backend / API / domain

- `python3 scripts/test_backend.py`
- `python3 scripts/test_api_validation_errors.py`
- `python3 scripts/test_braindump_v2_services.py`
- `python3 scripts/test_braindump_v2_extractor_normalization.py`
- `python3 scripts/test_braindump_v2_todo_creation.py`
- `python3 scripts/test_braindump_shopping_extraction.py`
- `python3 scripts/test_braindump_shopping_learning.py`
- `python3 scripts/test_quantity_units.py`
- `python3 scripts/test_recurring_todos.py`
- `python3 scripts/test_default_reminder_offset.py`
- `python3 scripts/test_subtasks.py`
- `python3 scripts/test_todo_comments.py`
- `python3 scripts/test_todo_attachments.py`
- `python3 scripts/test_location_reminders.py`
- `python3 scripts/test_websocket_location_reminders.py`
- `python3 scripts/test_websocket_auth_registration.py`
- `python3 scripts/test_email_services.py`
- `python3 scripts/test_two_factor_services.py`
- `python3 scripts/test_oidc_services.py`
- `python3 scripts/test_push_services.py`
- `python3 scripts/test_instance_config_services.py`
- `python3 scripts/test_fresh_migrations.py`
- `python3 scripts/test_release_versions.py`
- `python3 scripts/test_release_native_reuse.py`
- `python3 scripts/test_server_updates.py`
- `python3 scripts/test_update_analytics_admin_static.py`
- `python3 scripts/test_packaging_backup.py`
- `python3 scripts/test_admin_password_reset.py`

### Frontend static / no DB

These checks run before the frontend DB suite because they do not need a browser-backed dev DB reset.

- `node scripts/test_sw_precache.mjs`
- `node scripts/test_todo_attachment_thumbnails.mjs`
- `node scripts/test_frontend_quick_add_inline.mjs`
- `node scripts/test_frontend_project_counters.mjs`
- `node scripts/test_frontend_security.mjs`
- `node scripts/test_frontend_rich_text_editor.mjs`
- `node scripts/test_frontend_native_passkeys.mjs`
- `node scripts/test_frontend_android_todo_gestures.mjs`
- `node scripts/test_mobile_swipe_runtime.mjs`
- `node scripts/test_mobile_swipe_underlay.mjs`
- `node scripts/test_frontend_todo_details_layout.mjs`
- `node scripts/test_sync_feature_race.mjs`

### Frontend DB suite

`test_all.sh` creates one suite backup with `scripts/frontend_db_suite.mjs begin` and restores it at the end, also via `trap` on abort. The suite backup is copy-based and refuses to preserve a DB that only contains the `frontenduser` test account.

#### Shared fresh frontend DB

One fresh frontend test DB is prepared for representative core UI flows. These tests may create todos/projects/sections, but they should not depend on an otherwise pristine DB beyond the initial shared setup.

- `node scripts/test_frontend_smoke.mjs`
- `node scripts/test_frontend_app.mjs`
- `node scripts/test_frontend_subtasks.mjs`
- `node scripts/test_frontend_todo_interactive_clicks.mjs`
- `node scripts/test_frontend_todo_meta_badges.mjs`
- `node scripts/test_frontend_dragdrop.mjs`

#### Isolated fresh frontend DB

These tests get a fresh DB per script because they modify setup/auth/session/offline/realtime/native state or are otherwise order-sensitive.

- `node scripts/test_frontend_setup.mjs`
- `node scripts/test_frontend_admin_csp.mjs`
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
- `node scripts/test_native_android_dashboard_scrollbars.mjs`
- `node scripts/test_native_android_webview_cache_migration.mjs`
- `node scripts/test_native_linux_webview_cache_migration.mjs`
- `node scripts/test_native_debian_deb_package_name.mjs`
- `node scripts/test_native_desktop_settings_static.mjs`
- `node scripts/test_i18n_language_lifecycle.mjs`
- `node scripts/test_desktop_hotkey_description_sync.mjs`
- `node scripts/test_native_linux_window_integration.mjs`
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

Currently runs the maintained touch-zoom contract and the responsive Todo details stacking regression across Android widths and drawer breakpoints.

### Native

```bash
npm run test:native
```

Use for native runtime, desktop settings, Android wrapper, passkey, reminder, microphone, WebView cache, Debian package naming, or installer changes.

The native suite includes static/package checks that protect platform-specific release contracts:

- Debian desktop `.deb` package name must be `nia-todo-desktop`, not `nia-todo`, so it does not conflict with the server package.
- Debian desktop packages must install `de.tobiaskneidl.nia-todo.desktop`, matching the host application ID registered before GlobalShortcuts portal access.
- Portal action descriptions must come from the active nia-todo language, serialize rapid language changes, retry transient persistence failures, and remain available in desktop settings. Description-only changes must not re-register any hotkey backend. Configured Wayland hotkeys must still register with safe fallback labels when localized descriptions are temporarily unavailable.
- Wayland toggle/close-to-tray handling must fully hide the window so nia-todo remains tray-only. Because the surface is unmapped, GNOME may choose a different monitor when reopening it; the app must not attempt unsupported absolute positioning.
- Debian desktop WebView cache migration must only clear volatile cache directories when the app version or executable marker changes.
- Native desktop settings must keep desktop-only options scoped correctly and avoid leaking Windows-only wording onto Debian desktop.

For a local Debian desktop build and GNOME/Wayland hotkey smoke test, follow [`debian-desktop-build.md`](debian-desktop-build.md).

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

For audio/STT work, use controlled fixture recordings instead of making Tobi trial-and-error test core flows.

## Notes

- Frontend tests run primarily against headless Chromium; mobile swipe rendering and shared item drag-and-drop also run against Playwright WebKit. The package CI job selects `MOBILE_SWIPE_BROWSERS=chromium` and `ITEM_DND_BROWSERS=chromium`; both WebKit fixtures run in the existing pinned Playwright container job in test and release workflows. Local release gates keep both engines by default. `ITEM_DND_BROWSERS` accepts comma-separated `chromium`/`webkit` selections.
- `withFreshDb` still protects single-test execution by backing up/restoring the dev DB for isolated runs.
- Inside `test_all.sh`, `NIA_TODO_FRONTEND_DB_SUITE=1` switches frontend tests to the suite-managed DB lifecycle.
- `NIA_TODO_FRONTEND_DB_SHARED=1` tells `withFreshDb` to reuse the already prepared shared test DB instead of creating an isolated DB.
- Review subagents should not run full gates by default. They may run static/syntax checks or a focused suite only when explicitly requested.
- `web/manifest.json` and `src-tauri/frontend-dist/` are maintained by the dev/release flow; source tests generally target `web/` unless a native packaging test says otherwise.
- In CI, `install-and-test.sh` runs the release gate against the real installed `.deb` service, owned by the `nia-todo` system user rather than the CI runner user (`NIA_TODO_TEST_SUDO_FS=1`). Scripts touching that data use `sudo -n` for filesystem operations and must use the app's venv Python explicitly (`APP_PYTHON` in `frontend_test_lib.mjs`, similar constant in `test_backend.py`) - a bare `python3` under `sudo -n` loses the venv from `PATH` and misses `fastapi`. New DB-touching test scripts must set `NIA_TODO_DATA_DIR` themselves rather than relying on the ambient environment, or they'll target the real service data dir.

URL import regressions: `test_public_fetch.py` mocks DNS/sockets/HTTP to check public
address pinning, redirects and download bounds; `test_recipe_import.py` parses local
HTML fixtures with network access prohibited. `test_frontend_recipe_import.mjs` uses
a private mocked browser origin and never the development database. Existing recipe
API, image, migration and offline suites cover source-field persistence and upgrade.

Recipe BrainDump regressions: `test_recipe_ai.py` mocks model calls/access and checks
protected facts, ingredient keys, strict JSON and revocation before/after retry.
`test_llm_client.py` verifies shared provider adapters and bounded transport.
`test_frontend_recipe_ai.mjs` uses a private mocked origin for current-draft refinement,
text entry, cancellation and stale/access fences. `test_recipe_ai_e2e.mjs` runs its
own temporary app/database and mocks only the external model; it never uses an
installed service or sends test content to the configured operator model.

Recipe BrainDump compact-patch cases include import-like UUIDs and long steps, partial
updates, unknown/duplicate references and truncated nonempty replies.
Step-title regressions cover explicit optional headings, body-only imports, semantic
description cleanup, inferred fractions/remainders and protected manual quantities.
The fresh-migration suite verifies the actual startup dispatch for migration 072,
including complete rollback, stable IDs/links/amounts and the AUTOINCREMENT high-water
mark. Editor/cooking fixtures check both reported spacing gaps at desktop/mobile
widths; the private full-app BrainDump test persists headings through offline replay.
`test_recipe_ai_diagnostics.py` checks rejection logs with deliberately injected
sensitive-looking values; recipe content, URLs, keys and provider configuration must
never appear in those logs. It uses only mocked dependencies and no application DB.
