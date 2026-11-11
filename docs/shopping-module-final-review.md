# Shopping module completion review

> Historical record: this report describes the Shopping-only review on
> 7 November 2026, before its V4 integration and subsequent Recipes work.
> The branch names, test totals, scope limits and local evidence below belong to
> that snapshot; they are not the current V4 completion status. For maintained
> contracts and verification guidance, see [Architecture](architecture.md) and
> [Testing](testing.md).

The Shopping feature branch is ready for integration into `v4` within the scope below. No merge, release, deployment or development-service restart was performed as part of this review.

## Reviewed state

- Branch: `feat/v4-shopping-lists`; original head `7463ce6178f93771e3ee6b002fc2b09e6cb22de4`, plus the review fixes accompanying this report.
- Integration target: `v4` at `378fa7db265437fbdc146873fe91b7bdc734c3a1`.
- Frozen tested source fingerprint: `2789a9f725ce02bdcc5d01e864733b1c4d6bcb836e5dce44591a8796e24e0e51` (SHA-256 over sorted tracked paths/file contents and maintained new source/test files; excludes this subsequent report and unrelated local files).
- Isolated gate started: `2026-11-07T23:31:56.678732+00:00`.

## Findings resolved

- Shopping replay preserves per-list ordering when parent writes fail or their receipts are fenced out. Empty idempotent mutation batches no longer enqueue invalid actions.
- Account switches suspend and drain old access-privacy work before database closure and new-identity hydration; new schedules resume after reopening.
- Access snapshots durably remove revoked content and pending writes while protecting newer grants, independent child access and server-confirmed moves. Complete Shopping snapshots reconcile or remove legacy store-only queue records; partial snapshots do not infer revocation.
- BrainDump learning respects explicitly spoken or cleared destinations. Conservative provenance validation and deduplication protect those choices, while inferred routes remain correctable. Typed legacy Task learning rejects ambiguous project/section names instead of silently routing elsewhere.
- Shopping PATCH endpoints reject explicit null ordering values without rejecting legitimate nullable item fields.
- Shared menus and Shopping filter/editor controls preserve focus, drafts and active interactions during equivalent background refreshes. Changed targets, permissions and module deactivation close obsolete controls. Late store saves and delayed editor autofocus cannot overwrite newer interactions.
- Immediate selection of a pending Task project now preserves its opaque ID. Parent receipts remap dependent cache/queue references, navigation and editor targets; unresolved parents defer child requests. This covers the Tasks regression exercised by the shared frontend gate.
- Stale isolated test schemas, missing fixture assets and asynchronous browser wait conditions were repaired without weakening their behavioral assertions.

## Verification and isolation

- Complete canonical `./scripts/test_all.sh`: **167/167 steps passed**, including backend/API/security, ownership/sharing, migrations, Shopping, Tasks, BrainDump, offline/realtime, localization and native integration contracts.
- Real Shopping end-to-end: two independent browser sessions against the actual isolated API/WebSocket service, list/section/store/item creation, completion propagation, mobile offline queueing, exactly-once reconnect, temporary-ID remapping, online reload and module roundtrip. Desktop/mobile screenshots were inspected and horizontal overflow assertions passed.
- Separate agents reviewed backend/routing, UI/lifecycle and sync/privacy. Fixes received cross-review and coordinator integration review; no unresolved Shopping integration blocker remains.
- A private checkout, disposable data directory, dedicated service controller and loopback-only network namespace isolated all service/database tests. Host filesystems were read-only; real repository data and installed database locations were masked. Only one coordinator ran shared service/database tests, serially. Independent fixture tests used their own temporary databases/browser contexts.
- Original development database backup verified; final integrity check and original-user preservation verified. The original development process remained running and the development endpoint remained reachable. No original database restore was needed.

Local evidence: `/tmp/nia-shopping-final-bce2cuf6/gate.log`, `snapshot.json`, `shopping-e2e-pass.log`, `ui/`; independent standalone fixture results: `/tmp/nia-shopping-browser-preflight/results.json`. Generated logs/screenshots and the private database backup are not committed.

## Verification boundaries

BrainDump extraction/audio regressions mock external services; this gate does not certify a real microphone, STT or LLM. Native checks cover repository/runtime contracts, not new Windows/Android/Debian release binaries or physical devices. The real Shopping end-to-end reload occurs online after reconnect; separate offline/cache suites cover their own offline scenarios.

Task project/section creation still uses its existing server API; this review does not introduce server-side idempotency for an ambiguous connection loss after those legacy create requests. Shopping mutation idempotency is covered by its dedicated tests. Recipes remains a placeholder and is outside this module approval.
