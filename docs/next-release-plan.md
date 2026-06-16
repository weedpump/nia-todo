# nia-todo Next Release Plan

This branch (`nia-todo-next`) is the integration branch for the next larger nia-todo release. `develop` intentionally stays untouched so fixes can still be made on the current codebase.

## Branch Policy

- Continue feature work on `nia-todo-next` or short-lived feature branches based on `nia-todo-next`.
- Do **not** merge `nia-todo-next` into `develop` until Tobi explicitly gives the go.
- Keep feature branches reviewable and merge them into `nia-todo-next`, not `develop`.
- Before release/merge-back: run the full release gate (`./scripts/test_all.sh`) and do a focused review of sync/offline/realtime behavior.

## Current State

Subtasks/checklists are merged into `nia-todo-next` via merge commit `420aded`.

Implemented:

- Lightweight checklist-style subtasks attached to a todo.
- Todo cards show only a compact progress chip, e.g. `1/2 erledigt`.
- Subtasks are edited only inside the Todo modal.
- Parent completion with open subtasks requires confirmation.
- Recurring todos copy checklist titles/order into the next occurrence and reset them to open.
- Offline queue, IndexedDB persistence, REST refresh, WebSocket sync, sharing, and reload behavior have targeted regression coverage.
- Generic button primitives were refined:
  - `.btn` owns common layout/sizing/typography.
  - `.btn-primary` has no default shadow.
  - `.btn-small` and `.btn-icon` are reusable primitives.
  - `.btn-icon` remains square on mobile.

Reviews:

- Architecture review: PASS.
- Design/UI review: PASS after accessibility fixes.

Important known MVP tradeoffs:

- Updating subtasks currently replaces the full checklist; individual subtask IDs are not preserved across update operations.
- Concurrent checklist edits are last-write-wins at todo level.
- This is acceptable for the MVP, but revisit if per-subtask audit/history/collaborative editing is added.

## Next Work Item: Sync Architecture Cleanup

Goal: remove the duplicate full-load race between REST refresh and WebSocket initial sync.

Current architecture problem:

- App startup loads from IndexedDB.
- REST `refreshFromServer()` performs an authoritative full pull.
- WebSocket also sends `sync_request` and receives a full `sync_response`.
- Both paths can write to IndexedDB/UI.
- The subtask bug happened because one full payload shape was incomplete and won the write race.

Recommended target architecture:

- REST is the normal source of truth for full sync / startup refresh.
- WebSocket is for auth/session state and realtime delta events only:
  - `todo_create`
  - `todo_update`
  - `todo_delete`
  - project/section/workspace events
  - reminder/session events
- WebSocket full `sync_response` should either be removed from normal startup or kept only as explicit fallback/recovery.
- One code path should own authoritative full-cache replacement.

Suggested safe implementation steps:

1. Document current startup order:
   - IndexedDB local load
   - REST refresh
   - WebSocket connect/auth
   - WebSocket sync request/response
   - online/pageshow/visibility periodic sync attempts

   Current code map captured on `feature/sync-architecture-cleanup`:
   - `app-lifecycle.js:initApp()` loads IndexedDB first, then sets the app initialized, connects WebSocket, and starts REST `refreshFromServer()` when online.
   - `sync.js:refreshFromServer()` first pushes pending offline queue via `syncWithServer()`, then performs the authoritative REST full pull and replaces `todos/projects/sections/workspaces` in IndexedDB/UI.
   - Previous `websocket-client.js:onopen()` also pushed pending queue and then sent normal `sync_request`, creating a second full-cache writer during startup.
   - Previous `project_delete`/`workspace_delete` handling requested WS full sync as recovery; sharing membership events called `syncWithServer()` despite needing a full visibility refresh.

2. Add focused tests before changing behavior:
   - startup REST full refresh populates IndexedDB and UI
   - WebSocket connects but does not perform competing full-cache replacement during normal startup
   - realtime delta events still update a second tab/device
   - offline queue is pushed before any authoritative pull
   - pageshow/visibility recovery still syncs stale tabs
   - shared project changes still reach members live
3. Change normal WebSocket startup:
   - stop sending normal `sync_request` after `auth_ok`, or gate it behind explicit recovery mode
   - ensure `syncWithServer()` still runs before REST full refresh when pending offline queue exists

   Initial implementation on `feature/sync-architecture-cleanup`:
   - normal WebSocket startup no longer sends `sync_request`
   - startup still attempts `syncWithServer()` to push queued offline edits
   - `refreshFromServer()` now waits for an already-running queue sync before any authoritative REST pull/cache replacement, then re-checks that the queue is drained
   - project/workspace delete recovery and sharing membership refreshes now use REST `refreshFromServer()` instead of WS full sync
   - frontend realtime test now asserts that normal startup sends zero outbound `sync_request` messages
   - `scripts/test_sync_feature_race.mjs` covers the active-sync vs authoritative-pull race guard

4. Keep/fix fallback semantics:
   - if REST full refresh fails but WS is connected, optionally request WS full sync as recovery
   - if WS full sync remains, payload shape must stay identical to REST list payloads
5. Run targeted tests:
   - `node scripts/test_frontend_subtasks.mjs`
   - `node scripts/test_frontend_offline_sync.mjs`
   - `node scripts/test_frontend_realtime_sync.mjs`
   - `node scripts/test_frontend_sharing.mjs`
   - `python3 scripts/test_subtasks.py`
6. Request a focused architecture review before merging the sync cleanup into `nia-todo-next`.

## Planned Feature Themes After Sync Cleanup

These are candidates for the larger next release. Keep them separate and reviewable.

### 1. Notes / Comments on Todos

MVP idea:

- Add a notes/comments area to the Todo modal.
- Decide early whether this is:
  - a single rich/plain `notes` field on the todo, or
  - multiple timestamped comments.
- Prefer simple plain text first unless Tobi explicitly wants threaded comments/history.

Architecture questions:

- Should comments be editable/deletable?
- Should comments sync as part of todo payload or separate endpoint/table?
- How should shared project permissions apply?
- Should comments appear in card preview or modal only?

### 2. Attachments

MVP idea:

- Attach files/photos to todos from the modal.
- Keep card display minimal: at most an attachment count chip.

Architecture questions:

- Storage path and cleanup policy.
- File size/type limits.
- Access control for shared projects.
- Backup/export implications.
- Native app upload/download behavior.

### 3. Calendar View / Calendar Sync

MVP idea:

- Calendar-style view for todos with `due_date`, reminders, and recurring tasks.
- Later option: external calendar sync/export.

Architecture questions:

- Read-only internal calendar view first, before external sync.
- How recurring todos render future occurrences.
- Timezone handling must reuse existing recurring timezone logic.
- Avoid generating infinite future instances.

### 4. Subtask Follow-ups

Only after MVP is stable:

- Consider per-subtask endpoints if needed.
- Preserve subtask IDs on update.
- Optional reorder UX polish.
- Optional subtask-level timestamps/history.
- Optional conflict handling beyond last-write-wins.

## Current Useful Commands

```bash
# Work branch
git checkout nia-todo-next

# Focused subtasks checks
python3 scripts/test_subtasks.py
node scripts/test_frontend_subtasks.mjs
node scripts/test_frontend_offline_sync.mjs
node scripts/test_frontend_realtime_sync.mjs
node scripts/test_frontend_sharing.mjs

# Full release gate
./scripts/test_all.sh
```

## Do Not Forget

- `develop` stays as-is until Tobi explicitly says otherwise.
- Next immediate engineering topic is the sync architecture cleanup, not another UI feature.
- Any sync cleanup must be treated as core architecture work, not a quick refactor.
- Subtasks are already in `nia-todo-next`; the old `feature/subtasks-checklist` branch was deleted locally and remotely.
