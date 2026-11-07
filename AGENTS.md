# Nia — Repository Agent Instructions

## Product and current direction

Nia is a self-hosted, modular app for organizing everyday life, not just a todo app.
V4 is transitioning the existing nia-todo codebase into a shared application shell
with independent modules and reusable identity, sharing, and UI infrastructure.

- Registered modules: `tasks`, `shopping`, and `recipes`. Tasks is established,
  Shopping is under active development, and Recipes currently has a placeholder shell.
  Do not assume all modules have equivalent features or lifecycle requirements.
- Preserve existing `nia-todo` package names, URLs, API contracts, database paths,
  native app IDs, and compatibility identifiers unless a change explicitly requires
  a coordinated migration. The user-facing product name is Nia.
- Keep modules independent. Add shared behavior to shared primitives/services
  instead of copying Tasks behavior into Shopping or future modules.

## Where to work

- `api/`: FastAPI routers, services, SQLite access, and numbered SQL migrations.
- `web/`: vanilla JavaScript UI, CSS, i18n, offline PWA, IndexedDB, and service worker.
- `web/static/js/modules/`: module registry, shell contracts, and module-specific UI.
- `web/static/js/features/`: reusable and module-specific controllers and sync behavior.
- `web/static/js/api/`: frontend API clients.
- `src-tauri/`: Windows, Android, and Debian native client integration.
- `scripts/`: Python, Node.js, Playwright, and release/test helpers.
- `packaging/`, `systemd/`, `.github/workflows/`: installation, services, and CI/release.

Use the relevant existing references rather than rereading every document for
every task: `docs/architecture.md` for ownership/sync/native invariants,
`docs/design-concept.md` for UI patterns, `docs/testing.md` for test safety,
`docs/workflow.md` for releases, and `CONTRIBUTING.md` for local setup.
Some documentation may lag the V4 transition; check the current code and tests
before relying on older todo-only descriptions.

## Execution and subagent orchestration

1. Understand the requested outcome, inspect the relevant implementation and
   nearby tests, and make a short plan for non-trivial changes.
2. Work autonomously within the requested scope. Prefer completing the feature,
   updating affected tests/docs, and validating it over stopping after a proposal.
3. When multi-agent tools are available, proactively delegate independent,
   bounded work that genuinely benefits from parallelism (for example backend
   analysis, UI implementation, test coverage, or a separate code review).
   Do not spawn agents merely to satisfy a quota or for small changes.
4. Give each subagent explicit scope, expected output, and file ownership.
   Use read-only subagents for overlapping exploration/review. If agents edit,
   keep their file sets non-overlapping or use isolated worktrees when available.
   The coordinating agent owns cross-cutting edits, integration, and final review.
5. Never let parallel agents run database-mutating tests, migrations, frontend
   database suites, or the release gate against the same database/service.
   Schedule those operations serially under one coordinator.
6. Review subagent output and the combined diff; resolve conflicts, rerun
   relevant checks, and report any unverified behavior.
7. Preserve unrelated user changes. Avoid speculative large refactors and
   generated-file churn. Ask only when a genuine product/security decision is
   ambiguous or a destructive action needs authorization.

## V4 module and UI contracts

- Follow `web/static/js/modules/registry.js` and
  `web/static/js/features/module-shell.js` for module registration, lifecycle,
  and slot composition. Use the declared module capabilities; currently Tasks
  uses personal workspaces, while Shopping and Recipes do not.
- Module enable/disable preferences are **per account**, not per workspace:
  `users.disabled_modules_json`, `api/services/module_visibility.py`, and
  `web/static/js/modules/visibility.js` must stay consistent. Always leave at
  least one registered module enabled; preserve synchronization across devices.
- Prefer shared entity sidebar, editors, primary actions, topbar controls,
  dialogs, and CSS primitives instead of introducing parallel UI systems.
  Refer to `docs/design-concept.md`; preserve DOM IDs used by JavaScript.
- User-facing changes must work on desktop and mobile, with keyboard/touch
  behavior, accessible states/labels, and no horizontal body overflow.
- Add and maintain translation keys in all supported
  `web/static/i18n/*.json` locales. Avoid hardcoded user-facing strings.
  Use icons supported by the repository's icon registry.
- The web shell is shared with PWA and Tauri native clients. Check native
  behavior when modifying navigation, authentication, hotkeys, notifications,
  caching, or runtime/environment detection.

## Ownership, sharing, privacy, and sync

- Use the V4 generic entity access contract in
  `api/services/entity_access.py` and the relevant sharing/household routers.
  Top-level shareable entities have exactly one owner: a person **or** a
  household. Ownership transfer is not an additional share.
- Keep personal workspaces separate from households. Respect the existing
  additive access sources (personal ownership, household membership, direct
  entity grants, and compatible legacy project memberships).
- Distinguish content editing from management: participants may edit permitted
  content, while ownership/management permissions control access grants,
  metadata, transfer, archive, and deletion. Enforce boundaries server-side,
  not just through hidden frontend controls.
- Children inherit the top-level entity's permission boundary; do not create
  independent authorization shortcuts for items, sections, or attachments.
  Never expose another user's private records in API responses, WebSocket
  events, snapshots, caches, or invitations.
- Respect SQLite writer-transaction and concurrency invariants around
  ownership transfer, subtree operations, household transitions, attachments,
  and sharing. Keep related validation and writes atomic.
- Offline changes must survive reloads, reconnects, temporary failures, and
  optimistic updates. Preserve queue ordering, idempotent client mutation IDs,
  temporary-ID remapping, pending local state, and recipient-specific
  authoritative snapshots. Prevent stale snapshots from overwriting pending
  writes; revoke inaccessible cached data after access changes.

## Shopping module specifics

- Shopping lists are top-level shareable entities. Their sections, items,
  stores, and user-specific view preferences belong to that list.
- Backend entry points: `api/routers/shopping.py`,
  `api/routers/entity_sharing.py`, and `api/services/entity_access.py`.
  The existing schema is in `api/migrations/059_add_shopping_lists.sql`.
- Frontend entry points: `web/static/js/modules/shopping.js`,
  `web/static/js/api/shopping.js`, `web/static/js/features/shopping-*.js`,
  and the shared `web/static/js/features/sync.js`.
- Preserve list-scoped stores and item/store relationships; never allow
  cross-list references or unauthorized access through direct IDs.
- For Shopping changes, test list/section/item/store lifecycle, household and
  direct sharing, per-user preferences, offline/realtime behavior, temporary
  IDs, reconnects, and permission revocation as applicable.
- Recipes is not yet a completed domain module; do not treat its placeholder
  as evidence that recipes storage or APIs already exist.

## Database, security, and migration rules

- Add new schema changes as new, sequential `api/migrations/NNN_*.sql`
  migrations; do not rewrite an already-applied migration for new features.
  Check migration ordering and upgrade/fresh-install behavior.
- Protect authentication, MFA, OIDC, CSRF, WebAuthn, rate limiting, and
  household/entity authorization. Never log or commit tokens, credentials,
  production data, SQLite DBs, signing keys, or personal information.
- Do not reset, migrate, or repurpose a non-disposable database simply to
  make a test pass. Production lives separately from the development checkout.
- Prefer explicit validation, bounded queries, compatible API contracts,
  and regression tests for security- or data-sensitive behavior.

## Testing and verification

- Start with focused regression scripts near changed code. Relevant commands
  include `npm run test:backend`, `npm run test:frontend`,
  `npm run test:native`, `npm run test:todo`, and `npm run test:ui`;
  for Shopping, use the existing `scripts/test_shopping_*.{py,mjs}`,
  `scripts/test_frontend_shopping_*.mjs`, and
  `scripts/test_offline_shopping_sync.mjs` as appropriate.
- `./scripts/test_all.sh` (`npm test`) is the **serial release gate**, not a
  safe generic command to run concurrently. Read `docs/testing.md` first.
  Frontend/backend browser tests may modify the installed development DB at
  `/var/lib/nia-todo/nia-todo.db`. Before running them, establish an isolated
  test environment and verified backup/restore plan; verify the original DB
  survives afterward. Never point these tests at production.
- Run relevant backend, frontend, authorization, offline, mobile, and native
  checks for cross-cutting changes. Don't claim tests passed unless they ran.
  If the environment cannot safely run a test, explain exactly what was skipped.
- Update targeted tests when behavior changes; add regressions for bugs.
  Don't weaken existing test assertions just to produce a green result.

## Branches, releases, and completion

- Respect the checked-out branch and its intended merge target. V4 is an
  active modularization effort; feature branches may target `v4` before
  changes eventually reach `main`. Never assume the current branch is
  release-ready merely because `main` is the default branch.
- Do not merge branches, force-push, push release tags, trigger a release,
  publish artifacts/images, deploy, restart production services, or modify
  live data unless explicitly requested. Release tags can initiate
  automated version changes and publication.
- Update documentation when changing an architectural contract or workflow.
  At completion, summarize what changed, where, which checks ran, any
  outstanding risks, and whether additional approval is needed.
