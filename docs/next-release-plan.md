# nia-todo Next Release Plan

This branch (`nia-todo-next`) is the integration branch for the next larger nia-todo release. `develop` intentionally stays untouched so fixes can still be made on the current codebase.

## Branch Policy

- Continue feature work on `nia-todo-next` or short-lived feature branches based on `nia-todo-next`.
- Do **not** merge `nia-todo-next` into `develop` until Tobi explicitly gives the go.
- Keep feature branches reviewable and merge them into `nia-todo-next`, not `develop`.
- Before release/merge-back: run the full release gate (`./scripts/test_all.sh`) and do a focused review of sync/offline/realtime behavior.

## Current State

Subtasks/checklists, todo comments, and sync architecture cleanup are merged into `nia-todo-next`.

Implemented:

- Lightweight checklist-style subtasks attached to a todo.
- Existing-todo subtasks use dedicated create/update/delete actions and no longer require saving the whole todo.
- New-todo subtasks remain part of the initial todo creation flow.
- Todo cards show only compact metadata chips, including subtask progress and comment count.
- Subtasks and comments are edited only inside the Todo modal.
- Subtask deletion and comment deletion require confirmation.
- Parent completion with open subtasks requires confirmation.
- Recurring todos copy checklist titles/order into the next occurrence and reset them to open.
- Todo comments support author display, local timestamps, shared-project permissions, and dedicated add/edit/delete endpoints.
- Comment and subtask realtime updates use dedicated delta events instead of actor-specific full todo broadcasts.
- The Todo modal uses compact collapsible sections for planning, organization, subtasks, and comments, with mobile metadata panels collapsed by default.
- Disabled action buttons are visually muted and do not show click/press animation.
- Mobile todo quick actions and floating action buttons are layered so the New Todo FAB no longer sits behind the quick-action reveal button.
- Offline queue, IndexedDB persistence, REST refresh, WebSocket sync, sharing, and reload behavior have targeted regression coverage.
- Generic button primitives were refined:
  - `.btn` owns common layout/sizing/typography.
  - `.btn-primary` has no default shadow.
  - `.btn-small` and `.btn-icon` are reusable primitives.
  - `.btn-icon` remains square on mobile.

Reviews:

- Subtasks architecture review: PASS.
- Subtasks design/UI review: PASS after accessibility fixes.
- Comments/subtasks architecture review: PASS.
- Independent-subtasks regression review: PASS.

## Completed Work: Sync Architecture Cleanup

Final architecture:

- REST owns authoritative startup/full refresh and IndexedDB/UI cache replacement.
- WebSocket startup handles auth/session state and realtime deltas, not normal full-cache replacement.
- Offline queue sync is guarded so authoritative refreshes do not clobber pending local changes.
- Sharing/project/workspace visibility recovery uses REST refresh instead of normal WebSocket full sync.
- WebSocket full sync remains only as fallback/recovery behavior and must keep payload shape aligned with REST list payloads.

## Completed Work: Todo Subtasks and Comments

Final behavior:

- Todos support checklist-style subtasks with compact progress chips on cards.
- Existing-todo subtasks can be created, renamed, toggled, and deleted without saving the whole todo.
- New-todo subtasks are saved with the initial todo creation because no todo ID exists yet.
- Subtask deletion requires confirmation.
- Completing a parent todo with open subtasks requires confirmation.
- Recurring todos copy subtask titles/order into the next occurrence and reset them to open.
- Todos support comments with author display, local timestamps, comment-count chips, and dedicated add/edit/delete actions.
- Comment deletion requires confirmation.
- Comment and subtask realtime updates use dedicated delta events, not actor-specific full todo broadcasts.
- Existing comment/subtask actions require online API access; offline queueing can be added later if needed.

## Completed Work: Todo Modal and Mobile UI Polish

Final behavior:

- Todo modal sections for planning, organization, subtasks, and comments are compact/collapsible.
- Empty comments/subtasks start collapsed; existing comments/subtasks start visible.
- Mobile planning/organization panels stay collapsed by default.
- The Save button only enables for changes that require saving the todo itself.
- Disabled action buttons are visually muted and do not show click/press animation.
- Mobile todo quick actions and floating action buttons are layered so the New Todo FAB no longer sits behind the quick-action reveal button.

## Reviews

- Subtasks architecture review: PASS.
- Subtasks design/UI review: PASS after accessibility fixes.
- Comments/subtasks architecture review: PASS.
- Independent-subtasks regression review: PASS.

## Targeted Checks

```bash
python3 scripts/test_subtasks.py
python3 scripts/test_todo_comments.py
node scripts/test_frontend_subtasks.mjs
node scripts/test_frontend_realtime_sync.mjs
node scripts/test_frontend_offline_sync.mjs
node scripts/test_frontend_sharing.mjs
```

## Planned Feature Themes After Comments MVP

These are candidates for later releases. Keep them separate and reviewable.

### 1. Attachments

MVP idea:

- Attach files/photos to todos from the modal.
- Keep card display minimal: at most an attachment count chip.

Architecture questions:

- Storage path and cleanup policy.
- File size/type limits.
- Access control for shared projects.
- Backup/export implications.
- Native app upload/download behavior.

### 2. Calendar View / Calendar Sync

MVP idea:

- Calendar-style view for todos with `due_date`, reminders, and recurring tasks.
- Later option: external calendar sync/export.

Architecture questions:

- Read-only internal calendar view first, before external sync.
- How recurring todos render future occurrences.
- Timezone handling must reuse existing recurring timezone logic.
- Avoid generating infinite future instances.

### 3. Subtask and Comment Follow-ups

Only after MVP is stable:

- Optional offline queueing for existing-todo subtask/comment actions.
- Optional reorder UX polish for subtasks.
- Optional subtask/comment timestamps/history beyond current MVP metadata.
- Optional conflict handling beyond last-write-wins/delta replacement.
- Optional explicit regression tests for minimal realtime payload shapes.

## Current Useful Commands

```bash
# Work branch
git checkout nia-todo-next

# Focused checks
python3 scripts/test_subtasks.py
python3 scripts/test_todo_comments.py
node scripts/test_frontend_subtasks.mjs
node scripts/test_frontend_offline_sync.mjs
node scripts/test_frontend_realtime_sync.mjs
node scripts/test_frontend_sharing.mjs

# Full release gate
./scripts/test_all.sh
```

## Do Not Forget

- `develop` stays as-is until Tobi explicitly says otherwise.
- `nia-todo-next` is the integration branch for the next larger release.
- Before release/merge-back: run the full release gate (`./scripts/test_all.sh`) and do a focused review of sync/offline/realtime behavior.
