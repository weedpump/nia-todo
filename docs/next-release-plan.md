# nia-todo Next Release Plan

This branch (`nia-todo-next`) is the integration branch for the next larger nia-todo release. `develop` intentionally stays untouched so fixes can still be made on the current codebase.

## Branch Policy

- Continue feature work on `nia-todo-next` or short-lived feature branches based on `nia-todo-next`.
- Do **not** merge `nia-todo-next` into `develop` until Tobi explicitly gives the go.
- Keep feature branches reviewable and merge them into `nia-todo-next`, not `develop`.
- Before release/merge-back: run the full release gate (`./scripts/test_all.sh`) and do a focused review of sync/offline/realtime behavior.

## Current State

Subtasks/checklists, todo comments, sync architecture cleanup, modal/mobile UI polish, todo attachments, and the final UI scrollbar/icon polish are completed on the next-release line.

Implemented:

- Lightweight checklist-style subtasks attached to a todo.
- Existing-todo subtasks use dedicated create/update/delete actions and no longer require saving the whole todo.
- New-todo subtasks remain part of the initial todo creation flow.
- Todo cards show only compact metadata chips, including subtask progress, comment count, and attachment count.
- Subtasks, comments, and attachments are edited only inside the Todo modal.
- Subtask deletion, comment deletion, and attachment deletion require confirmation where destructive UI flows need it.
- Parent completion with open subtasks requires confirmation.
- Recurring todos copy checklist titles/order into the next occurrence and reset them to open.
- Todo comments support author display, local timestamps, shared-project permissions, and dedicated add/edit/delete endpoints.
- Todo attachments support authenticated server-local uploads/downloads, shared-project permissions, image/PDF preview, delete/download actions, and realtime attachment updates.
- Admins can enable/disable new attachment uploads globally, configure allowed file extensions, set the default attachment quota, and override quota per user.
- Users can see their attachment storage usage in Settings.
- Comment, subtask, and attachment realtime updates use dedicated delta events instead of actor-specific full todo broadcasts.
- The Todo modal uses compact collapsible sections for planning, organization, subtasks, comments, and attachments, with mobile metadata panels collapsed by default.
- Attachment image/PDF preview opens as a fullscreen viewer on mobile and desktop.
- Disabled action buttons are visually muted and do not show click/press animation.
- Mobile todo quick actions and floating action buttons are layered so the New Todo FAB no longer sits behind the quick-action reveal button.
- Offline queue, IndexedDB persistence, REST refresh, WebSocket sync, sharing, reload behavior, and attachment behavior have targeted regression coverage.
- Generic button primitives were refined:
  - `.btn` owns common layout/sizing/typography.
  - `.btn-primary` has no default shadow.
  - `.btn-small` and `.btn-icon` are reusable primitives.
  - `.btn-icon` remains square on mobile.
- Overlay scrollbars are auto-hidden in the main app and admin panel, render as 7px custom indicators, and do not reserve layout width.
- App, admin, setup, and password pages use the generated Lucide icon subset from the npm package instead of page-local/manual icon tables.
- The Service Worker precache test now validates `index.html` app-shell JS/CSS refs, including cache-busted query URLs, so installed PWAs keep working offline.

Reviews:

- Subtasks architecture review: PASS.
- Subtasks design/UI review: PASS after accessibility fixes.
- Comments/subtasks architecture review: PASS.
- Independent-subtasks regression review: PASS.
- Todo attachments architecture/security review: PASS before final UX/admin hardening.
- Todo attachments final review: PASS before merge to `nia-todo-next`.
- UI scrollbar/icon polish final review: PASS before merge to `nia-todo-next`.

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

## Completed Work: Todo Attachments

Final behavior:

- Todos support attachments from the Todo modal with a compact attachment-count chip on cards.
- Files are stored server-local under the attachment data directory; database metadata never exposes stored filenames publicly.
- Uploads are authenticated and require write access to the Todo/project. Shared/invited users with current project write access can upload and delete attachments.
- Downloads and previews are authenticated. The frontend previews images/PDFs via `fetch -> blob -> objectURL` instead of public file URLs.
- Image/PDF previews use a fullscreen viewer on both mobile and desktop, with bottom Close/Download actions.
- Existing attachments remain visible/downloadable when the admin disables new uploads.
- New uploads enforce:
  - global enablement flag,
  - allowed extension allowlist,
  - per-file size cap,
  - default/per-user quota,
  - magic-byte validation for PNG/JPEG/GIF/WebP/PDF/ZIP,
  - hard blocks for active content such as SVG/HTML/JavaScript.
- Uploads stream request chunks into a temporary file and move into place only after policy/quota checks pass.
- Client-side preflight catches disabled uploads, too-large files, blocked extensions, and exhausted quota before upload starts; the server remains authoritative.
- Admin attachment settings include:
  - header autosave toggle for upload enablement,
  - comma-separated allowed file extensions (`png, jpg, jpeg, gif, webp, pdf` by default),
  - default quota in GB,
  - per-user quota override in GB.
- A per-user quota of `0` locks attachments for that user and displays as fully used (`100%`).
- Todo deletion removes attachment metadata and the corresponding attachment directory.
- Regression tests preserve attachment files when fresh-DB test helpers swap databases, preventing DB/file mismatches.

## Completed Work: Todo Modal and Mobile UI Polish

Final behavior:

- Todo modal sections for planning, organization, subtasks, comments, and attachments are compact/collapsible.
- Empty comments/subtasks/attachments start collapsed; existing comments/subtasks/attachments start visible.
- Mobile planning/organization panels stay collapsed by default.
- The Save button only enables for changes that require saving the todo itself.
- Disabled action buttons are visually muted and do not show click/press animation.
- Mobile todo quick actions and floating action buttons are layered so the New Todo FAB no longer sits behind the quick-action reveal button.

## Completed Work: Final UI Scrollbar and Icon Polish

Final behavior:

- The main app and admin panel use auto-hidden overlay scrollbars that appear while scrolling and do not reserve native scrollbar gutter width.
- The main content scrollbar starts below the topbar; the indicator is 7px wide and right-aligned.
- Lucide icons are sourced from the `lucide` npm package via `scripts/generate_lucide_icons.mjs`; browser/PWA runtime uses `web/static/js/icons/lucide-generated.js` and the central `iconSvg()`/`hydrateIcons()` resolver.
- Admin update status icons, Todo modal section icons, Todo card metadata chips, sidebar Filter, and topbar/minimal-mode icons use the central resolver.
- Mobile stacking order is explicit: quick actions `170`, FABs `180`, sidebar overlay `199`, sidebar `200`.
- Cache-busted app-shell module URLs are served from the Service Worker precache offline via query-insensitive cache matching.

## Reviews

- Subtasks architecture review: PASS.
- Subtasks design/UI review: PASS after accessibility fixes.
- Comments/subtasks architecture review: PASS.
- Independent-subtasks regression review: PASS.
- Todo attachments architecture/security review: PASS before final UX/admin hardening.
- Todo attachments final review: PASS.
- UI scrollbar/icon polish final review: PASS.

## Targeted Checks

Use focused suites instead of running every historical UI regression after each visual iteration:

```bash
# Todo UX/API integration before larger Todo merges
npm run test:todo

# Optional UI/micro-layout contracts after broad visual refactors
npm run test:ui

# Full release gate; also called by release.sh
npm test
```

## In Progress: Todo Detail View Redesign

Current design direction:

- Existing todos open in a read-first Todo detail view instead of the old form-first modal stack.
- Desktop remains modal-sized; tablet/mobile use fullscreen detail view behavior.
- Title, meta chips, and rendered description form the top read area.
- Meta fields are shown as compact view-mode chips; the final edit UX for planning/organization still needs a clean integration instead of simply expanding form controls inline.
- Subtasks, attachments, and comments are visible by default in calmer content sections:
  - subtasks as a checklist,
  - attachments as compact file cards plus a persistent multi-file upload/drop zone,
  - comments as a quieter feed.
- Attachment upload supports multiple selected files and desktop drag-and-drop in the detail view prototype.
- Image/PDF preview behavior must stay scoped to the attachment preview and return to the Todo detail view when closed.

Still to finish for this design concept:

- Bring the New Todo create flow into the same redesigned modal family. Existing todos use the read-first detail view; new todos should use a matching create/composer mode instead of the old form-modal styling.
- Update/regenerate frontend tests once the Todo modal redesign is structurally settled. Tests are required for the merge/release gate, but visual iteration should use targeted syntax/smoke checks instead of repeated full test runs.
- Run one focused review after the create flow and tests are aligned.

Follow-up after this branch:

- Decide whether the new Todo detail visual language becomes the global nia-todo design system. This includes pill-shaped action buttons, cleaner modal headers, less nested/boxed container styling, shared action-row primitives, and consistent mobile fullscreen modal behavior. Keep this as a separate follow-up branch/workstream instead of expanding the current Todo-detail branch.

## Planned Feature Themes After Attachments

These are candidates for later releases. Keep them separate and reviewable.

### 1. Calendar View / Calendar Sync

MVP idea:

- Calendar-style view for todos with `due_date`, reminders, and recurring tasks.
- Later option: external calendar sync/export.

Architecture questions:

- Read-only internal calendar view first, before external sync.
- How recurring todos render future occurrences.
- Timezone handling must reuse existing recurring timezone logic.
- Avoid generating infinite future instances.

### 2. Rich Description Editor Follow-up

Ship separately after the Todo detail view design concept is settled:

- Replace the temporary/prototype description editor with a real maintained editor dependency instead of growing a custom editor engine.
- Candidate direction: TipTap/ProseMirror for a modern WYSIWYG document editor, or Milkdown if Markdown-first editing remains the preferred storage/editing model.
- Keep the view mode clean and rendered; edit mode should feel like a compact modern editor with basics such as bold, italic, headings, lists, paste handling, undo/redo, keyboard shortcuts, and sane mobile behavior.
- Continue storing descriptions in a migration-friendly format; Markdown storage is acceptable initially if the chosen editor round-trips it cleanly.
- Comments can remain as-is for this step unless Tobi explicitly decides they should also use richer Markdown/rendered editing.

### 3. Subtask, Comment, and Attachment Follow-ups

Only after MVP is stable:

- Optional offline queueing for existing-todo subtask/comment/attachment actions.
- Optional reorder UX polish for subtasks.
- Optional subtask/comment/attachment timestamps/history beyond current MVP metadata.
- Optional attachment orphan cleanup/repair admin tool.
- Optional drag-and-drop attachment upload.
- Optional explicit E2E coverage for image/PDF preview on both desktop and mobile.
- Optional conflict handling beyond last-write-wins/delta replacement.
- Optional explicit regression tests for minimal realtime payload shapes.

## Current Useful Commands

```bash
# Work branch
git checkout nia-todo-next

# Focused checks
python3 scripts/test_subtasks.py
python3 scripts/test_todo_comments.py
python3 scripts/test_todo_attachments.py
node scripts/test_frontend_subtasks.mjs
node scripts/test_frontend_offline_sync.mjs
node scripts/test_frontend_realtime_sync.mjs
node scripts/test_frontend_sharing.mjs
node scripts/test_frontend_admin.mjs
node scripts/test_frontend_settings.mjs

# Full release gate
./scripts/test_all.sh
```

## Do Not Forget

- `develop` stays as-is until Tobi explicitly says otherwise.
- `nia-todo-next` is the integration branch for the next larger release.
- Before release/merge-back: run the full release gate (`./scripts/test_all.sh`) and do a focused review of sync/offline/realtime behavior.
