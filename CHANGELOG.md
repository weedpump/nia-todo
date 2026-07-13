# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/de/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/lang/de/spec/v2.0.0.html).

## [3.0.1] - 2026-07-13

### Fixed
- Native Windows and Debian todo card Status/Snooze dropdowns now open reliably by preserving placement state and suppressing the follow-up WebView summary click after the native pointer handler toggles the menu.
- Long todo titles now wrap within todo cards instead of overflowing past the viewport and blocking mobile quick actions.
- Todo title editing now uses an auto-growing multi-line field so long titles remain readable while creating, editing, and viewing todos.
- Mobile title editing now keeps Enter available for line breaks, while desktop users can still save with Ctrl+Enter or Cmd+Enter.
- Workspace menus now use the shared Lucide plus icon for the add-workspace action instead of a literal plus character.
- Mobile todo swipe gestures now use pointer capture, animation-frame updates, and stricter cancel cleanup to avoid stuck or jittery swipe states.
- Mobile todo swipes can now start from the checkbox/status control area while still respecting the left-edge navigation dead zone.
- Mobile sidebars now keep the header and footer fixed while only the navigation/project region scrolls, with clipped pills fixed without horizontal overflow.
- iOS/Safari now hides native WebKit scrollbars while keeping the app's custom overlay scrollbars visible, preventing duplicate scroll indicators in light and dark mode.
- Android native todo drag-and-drop now keeps a visible drag ghost attached to the finger while moving todos between projects or sections.
- Closing the mobile sidebar now immediately hides its custom scrollbar overlay instead of letting it float over the dashboard until the fade timeout.

## [3.0.0] - 2026-07-13

### Added
- Added checklist subtasks for todos, including progress chips, independent subtask updates, realtime sync, recurring-todo carry-over, and confirmation before completing a parent todo with open subtasks.
- Added todo comments with author display, edit/delete actions, shared-project permissions, comment-count chips, and realtime updates.
- Added todo attachments with authenticated server-local uploads/downloads, attachment-count chips, image/PDF preview, native download handling, shared-project access checks, realtime updates, and backup/restore coverage.
- Added admin controls for attachments, including global upload enablement, allowed file extensions, a default 5 GB quota, per-user quota overrides, and user-visible storage usage.
- Added a global Calendar sidebar view for due todos with day, week, and month modes, timeline-style day/week layouts, mobile month day selection, localized labels, offline/PWA coverage, and normal todo interactions from calendar entries.
- Added draft subtasks, comments, and attachments while creating new todos, with online-only handling when draft data needs a real server todo ID.
- Added full UI language support for 12 languages: German, English, Czech, French, Italian, Dutch, Polish, Brazilian Portuguese, Russian, Swedish, Spanish, and Simplified Chinese.
- Added localized app UI, system emails, release-tour content, native/OIDC handoff screens, offline/PWA language precache coverage, and locale-aware date/time formatting.
- Added a version-aware “What’s new” release tour with per-user seen state, carry-forward display across follow-up releases, responsive icon-based slides, and offline/PWA precache coverage.
- Added a native Debian desktop app package alongside Windows and Android, including release/download manifest integration, Debian platform download UI, autostart support, tray/global-hotkey settings, OIDC URL handler registration, desktop notifications, and WebKitGTK cache cleanup after app or executable changes.
- Added Debian desktop global-hotkey activation through the XDG Desktop Portal GlobalShortcuts API when available, with a legacy global-shortcut fallback for desktops without portal support.
- Added curated Lucide icon choices for projects and workspaces, with localized labels and searchable keywords.
- Added desktop/tablet drag-and-drop for moving todos directly onto sidebar projects while preserving offline sync behavior.
- Added auto-hiding overlay scrollbars for the main app and admin panel.

### Changed
- Refreshed the app with the Next UI design system: calmer surfaces, rounded borderless cards, shared button/field/dropdown/menu primitives, unified light/dark polish, and more consistent responsive desktop/tablet/mobile layouts.
- Refined Todo, Project, Workspace, Settings, BrainDump, login, setup, admin, confirmation, danger, native OIDC return, app download, and update dialogs to use shared detail-modal and action primitives.
- Reworked the Todo detail experience into a larger editor shell with compact collapsible sections for content, planning, organization, subtasks, comments, attachments, recurring, and location-related details.
- Unified project and workspace editors with the Todo detail modal language, including large inline title fields, drawer-style sections, header actions, polished sharing rows, and hidden save actions until changes are present.
- Merged todo status selection into the left todo control, using a compact icon-only dropdown on mobile and a full status pill with label on desktop.
- Refined dashboard, project views, todo rows/cards, sidebar navigation, workspace switching, user menu, topbar search, section actions, version/download actions, and mobile swipe actions to match the Next UI visual language.
- Centralized icon rendering through the generated Lucide icon subset across the app, setup/password pages, and admin panel; the sidebar Focus entry is now labeled as Filter.
- Renamed the native desktop `.deb` target from Linux to Debian across manifest platform keys, artifact names, UI labels, release metadata, and downloads.
- Renamed the Debian desktop package/artifact to `nia-todo-desktop` / `nia-todo-desktop-vX.Y.Z-debian-amd64.deb` to avoid conflicts with the server package.
- Updated release packaging so Windows, Android, and Debian desktop clients are bundled consistently into the server `.deb` and Docker image downloads with versioned SHA256 manifest metadata.
- Switched packaged backups to snapshot runtime data under `NIA_TODO_DATA_DIR` alongside a consistent SQLite backup, covering database state, attachments, avatars, generated keys, and future runtime files while excluding backup archives and SQLite temp/journal files.
- Disabled touch pinch-zoom/two-finger page scaling and precision-touchpad pinch zoom for the web app while keeping normal browser zoom via keyboard/menu available.
- Replaced remaining legacy inline app event handlers with delegated `data-*` actions across todo cards, sections, settings, API keys, and drag-and-drop.

### Fixed
- Kept cache-busted app-shell modules available offline by matching Service Worker cache entries without query strings.
- Cleaned up startup sync ownership so REST handles authoritative full refreshes while WebSocket startup stays focused on auth/session and realtime deltas, preventing duplicate full-cache writers from racing IndexedDB/UI state.
- Guarded authoritative REST refreshes while local offline queue sync is active or pending, preventing cache replacement from clobbering queued offline changes.
- Deferred server-side todo hard-deletes until the undo grace window expires, so undoing a delete preserves related todo data instead of recreating only the parent todo.
- Show pinned todos in project views in a dedicated top group, matching the main dashboard behavior.
- Improved German wording for parent project fields from “Eltern-Projekt” to “Übergeordnetes Projekt”.
- Improved mobile/touch behavior for todo quick actions, drag-and-drop, swipe gestures, FAB layering, and iPad-sized layouts.
- Fixed admin header/auth state handling, logged-out action guards, OIDC login button initialization, create-user field height, mobile action stacking, and admin CSS scoping.

### Security
- Hardened attachment uploads with streaming temp-file writes, server-side quota/type policy enforcement, magic-byte validation for common binary formats, active-content blocking, and client-side preflight for disabled uploads, file type, file size, and quota.
- Hardened native attachment downloads with authenticated Tauri download handling, same-origin redirect protection, timeout handling, size guards, and platform download directories.

## [2.12.2] - 2026-06-16

### Added
- Added due-date sorting, todo duplication, and i18n-aware Quick Add syntax for recurring todos.

### Changed
- Refined todo list layout with cleaner cards, better metadata placement, and section grouping in search results.
- Improved local/offline completion state handling for todos.

## [2.12.1] - 2026-06-14

### Changed
- Refreshed the public API documentation for the latest OIDC/SSO, location reminder, admin session/statistics, BrainDump learning, and profile preference endpoints.

## [2.12.0] - 2026-06-12

### Added
- Added OIDC-based single sign-on for users and admins, including admin-side provider configuration and account linking.

### Changed
- Cleaned up the login screen for the new sign-in options: API docs and changelog links were removed, alternative login actions are grouped more clearly, the theme switcher is less prominent, app downloads stay visible, and the mobile fullscreen login is centered.
- Android todo drag auto-scroll now starts consistently near the visible top and bottom edges, including browser/iPad HTML5 drag and native pointer drag paths, so moving todos through long lists feels symmetric in both directions.

### Fixed
- Android passkey login now rebinds its trusted origin immediately after changing the configured server URL, so switching servers no longer requires restarting the app before passkeys work again.
- Native offline cold starts now wait for the bundled app shell before showing backend/API connection errors, preventing a false boot error when the app is opened without network.
- Android/native todo dragging now cleans up stale drag-over and ghost state reliably after pointer/touch cancel paths, preventing stuck visual drop indicators.
- Android native todo dragging now blocks secondary finger input during an active drag, preventing multi-touch background swipes from stranding the dragged todo or hiding it until the app is restarted.

## [2.11.8] - 2026-06-06

### Fixed
- Restored the persisted global Today Focus button state after app reload/start so the active indicator matches the filtered view.

## [2.11.7] - 2026-06-06

### Fixed
- Focus date filtering now treats reminder-only todos as scheduled for their reminder day when no deadline is set, so Today Focus and Focus view filters include quick reminder-driven tasks without requiring artificial deadlines.

## [2.11.6] - 2026-06-06

### Fixed
- BrainDump now preserves model-provided `due_datetime`/`reminder_datetime` aliases as todo deadlines and reminders, preventing valid extracted times from being dropped when the BrainDump agent uses datetime-style field names despite the prompt schema.
- BrainDump's processing equalizer now switches to a calm bounded animation after recording stops, so loud final audio peaks no longer carry into the transcription/loading state or push the bars behind surrounding text.

## [2.11.5] - 2026-06-05

### Fixed
- Installed Safari/iPadOS PWAs now keep their active nia-todo Service Worker during hard-reload recovery and refresh the app-shell cache in place, preventing Safari's offline error page after closing and reopening the app offline.
- Boot-error and admin server-update reload recovery now use the same Service Worker preserve strategy as the sidebar/login hard reload flow, only unregistering workers or clearing nia-todo CacheStorage when no active nia-todo Service Worker can be kept.

## [2.11.4] - 2026-06-05

### Fixed
- Browser hard reload recovery now bypasses stale Service Worker CacheStorage and browser HTTP cache for app-shell/static assets across sidebar, login-screen, and boot-error **Neu laden** flows, disables reload buttons from the existing offline indicator state, then restores an active precached Service Worker so installed PWAs still start offline after a hard reload.

## [2.11.3] - 2026-06-05

### Changed
- Android reminder notifications now open the app only and no longer expose the broken **Erledigt/Completed** action.
- BrainDump todo preview now shows detected route, deadline, reminder, recurrence, and location reminder metadata as the same compact chips used by regular todo cards, so accepted candidates are easier to verify before creation.

### Fixed
- Minimal todo mode now hides badges, metadata pills, and description previews again instead of accidentally restyling location reminder pills.
- Dashboard **Due today** now counts all open todos due within the current day, including already-overdue items from earlier today.
- Admin sign-in now restores the stored admin session correctly after a page reload instead of clearing the token during initial statistics loading.
- Admin sign-in markup is now password-manager friendly, allowing browser extensions such as Bitwarden to recognize and autofill the admin password field.

## [2.11.2] - 2026-06-05

### Changed
- Server startup now defaults to `NIA_TODO_HOST=auto`, binding every available wildcard stack: IPv6 plus IPv4 when possible, falling back to IPv4-only on hosts without IPv6.
- Releases can now reuse an older native app version via `--reuse-native-app-version`, keeping bundled Windows/Android downloads, manifest metadata, and native update hints tied to the last actual native app release while Server/Web/Docker advance.

### Fixed
- Web app reload recovery now clears stale nia-todo service worker/cache state for boot, login, sidebar, and server-update reload flows while preserving offline PWA caches and using cache-busting reloads after app updates.

## [2.11.1] - 2026-06-04

### Changed
- Admin Statistics now only show counters collected at runtime after the update, making the data coverage explicit instead of reconstructing historical values from service logs.
- Admin Statistics now avoid misleading shared bar scales for mixed units: inventory and capacity summaries use numeric metric cards, while inventory trends are normalized per series.

### Removed
- Removed the admin-only journal log backfill flow, including the **Logs analysieren** button, the `/api/admin/technical-stats/backfill` endpoint, and the unused session client-mix backfill helpers.

## [2.11.0] - 2026-06-04

### Added
- Location-based reminders can now be created and managed from the web UI and trigger locally in the Android app when arriving at or leaving saved places or manually entered addresses, with privacy-first address-only server storage and user-managed saved places.
- BrainDump can now extract recurring todos from the model-provided JSON schema, including half-year intervals such as every six months, and persists the recurrence when the candidate has a deadline start point.
- BrainDump preview editing now lets users correct deadline, reminder, and recurrence metadata before creating todos, alongside the existing title/project/section quick fixes.
- Users can now configure automatic default reminders for todo deadlines, including presets and a custom amount with hours/days units; todos with deadlines get a default reminder when no explicit reminder is set, and automatic reminders keep following deadline changes and recurring next occurrences.
- Admins can now inspect each user's active sessions/devices directly from the user list and revoke individual sessions or sign out all devices with the same collapsible session layout used in user settings.
- The admin panel now includes a privacy-preserving Statistics section with backend-only aggregate counters for database growth, workload trends, LLM/STT/Audio usage, token totals when providers report them, active sessions, and long-term client mix analysis.

### Changed
- BrainDump extraction now keeps the system prompt as the single source for output schema and extraction rules; the runtime prompt only sends current datetime, workspace context, and the transcript.
- BrainDump preview dropdowns are constrained above the modal action bar so open menus no longer block the create/accept button.
- The admin panel order now surfaces Server Update first and Statistics directly below it, with Statistics fully localized through semantic `admin.stats.*` i18n keys.

### Fixed
- Public Debian/Docker builds now use a valid VAPID subject for Web Push notifications by honoring `NIA_TODO_VAPID_SUBJECT` or the configured HTTPS public base URL, instead of replacing the private development subject with `example.invalid`, which Apple Web Push rejects with `BadJwtToken`.
- Snooze actions now keep deadlines and reminders consistent: undo restores both original values, `+1 hour` moves existing deadline/reminder values relative to themselves, and calendar presets such as this evening and tomorrow morning resolve from the current date.
- Mobile todo action menus now open upward when there is not enough room below, avoiding viewport clipping and visible flip flicker.
- Recurring todo interval inputs now stay editable while replacing the default `1`, so users can type values like `6` months directly instead of working around an immediate reset.
- Recurring todos now store/update an IANA timezone from the editing browser, keep their local wall-clock time across DST changes, move spring-forward gaps to the next valid local time, and use the first occurrence for fall-back folds.
- BrainDump now ignores recurrence metadata without a deadline instead of creating invalid recurring todos, matching the recurring todo start-date requirement.
- Safari on iPadOS is now identified via client runtime metadata instead of being mislabeled as macOS when WebKit sends a desktop-style `Macintosh` user agent.
- Revoking all user sessions now also invalidates legacy JWTs without per-device session IDs and existing WebSocket sync requests revalidate their token before returning data.
- Admin Statistics now strictly normalizes native/browser client metadata before counting it, preventing untrusted header values from becoming stored counter labels while keeping Android app, Windows app, browser, OS, and Safari/WebKit classification accurate.

## [2.10.3] - 2026-06-04

### Added
- A new guided web-install dialog now explains the iOS Safari add-to-home-screen flow with interactive step-by-step visuals and localized text.

### Changed
- The login page resource buttons now align their icons vertically with the label text.
- The web-install dialog now uses a cleaner iOS-style share icon and no longer hardcodes the Dev label in its mock screenshots.

## [2.10.2] - 2026-06-02

### Fixed
- Upgraded installs now add the missing `todos.recurring_rule` and `todos.parent_id` database columns required by recurring todos, preventing todo edit/reminder sync from failing with backend 500 errors after 2.10 updates.

## [2.10.1] - 2026-06-02

### Fixed
- Focus view filters now visually match the dashboard and project widgets, including the shared widget card styling, round icon avatar placement, header rhythm, and desktop stat subtitles.
- Focus filter inputs and dropdowns now use the softer modal-style control background in dark and light themes instead of appearing as nearly black fields.
- BrainDump preview correction fields for candidate title, project, section, and dropdown search now use the same softer control styling as the rest of the redesigned UI.
- Mobile topbar search now stays inside the viewport when expanded instead of overflowing to the right on narrow screens.

## [2.10.0] - 2026-06-02

### Added
- The main open-todos navigation has been replaced with a new Focus view that lets users build a filtered working set by due date, projects, priorities, and statuses, including searchable project dropdowns with subproject indentation and consistent project markers.
- A new topbar Minimal mode makes dense todo lists one-line by showing only the checkbox, priority marker, title, and right-side actions.
- Todos can now repeat daily, weekly, monthly, or yearly from the New/Edit Todo planning card; completing a recurring todo creates the next occurrence with its reminder shifted forward.
- The BrainDump admin configuration now shows the current backend-provided default extraction prompt as a readonly reference before admins append or replace custom instructions.

### Changed
- Project invite metadata now tracks whether an invite was created from a username or email identifier, with a conservative migration that keeps existing pending invites hidden unless they can be safely classified.
- Sharing regression coverage now verifies owner reload visibility, invitee reload hydration, and the verified-email privacy boundary.
- Project, priority, and status selectors now use the shared custom dropdown presentation more consistently, including project search, project icons/dots, priority color dots, and status icons where applicable.

### Fixed
- Mobile topbar layout now keeps the workspace switcher compact as an icon/color chip so Focus, Minimal mode, search, and offline/sync indicators no longer crowd or overlap.
- Snoozing a todo now shifts an existing reminder together with the deadline, preserving the reminder's offset instead of leaving it behind on the old time.
- Reopening and completing the same recurring todo again now reuses the already-created next occurrence instead of creating duplicate future todos.
- Windows desktop autostart now repairs its startup registration on app launch/settings load, so updates no longer leave the app setting enabled while the Windows Task Manager startup entry disappears.
- BrainDump preview project and section dropdowns now scroll smoothly in the Android app without jittering while editing candidate todos.
- Todo rows now keep the checkbox, priority dot, and right-side actions vertically centered for wrapped titles and todos with descriptions; descriptions and metadata align under the title text instead of slipping left under the priority dot.
- Desktop todo list titles and the New/Edit Todo title field now use calmer normal-weight sizing instead of oversized bold text.
- Todo lists now keep enough bottom scroll clearance so the final todo, section, or group header is not hidden behind the New Todo and BrainDump floating buttons.
- Project sharing invitations now survive app restarts reliably: owners can still see and revoke pending username invites, and invitees see pending project invitations again after reload, reconnect, or returning online.
- Neutral email-based project invites remain privacy-safe after reload by hiding matched pending email invites from owner member lists, avoiding account enumeration while preserving the invite for the recipient.

## [2.9.0] - 2026-06-01

### Added
- BrainDump can now remember where each user places confirmed tasks and use those preferences to suggest matching projects and sections in future previews, with a user setting to turn this off and delete saved assignments.
- Admin user management now includes a client-side user search with live result counts and an empty-state message for unmatched filters.

### Changed
- BrainDump routing is now more reliable: project/section context is passed to the configured model in a compact structured form, backend validation prevents invalid destinations, and saved user preferences are applied only after model extraction so they are never sent to the model.
- BrainDump STT defaults to automatic language detection and no longer sends `language=auto` to Whisper-compatible remote STT endpoints.
- The OpenClaw BrainDump agent path can be used via the OpenAI-compatible endpoint/model pair, allowing `openclaw/braindump` to route extraction through the dedicated OpenClaw agent.

### Fixed
- Admin sign-in now focuses the password field immediately when the login card is shown, including after logout or an expired stored admin token.
- BrainDump extraction is now stricter and safer: it no longer relies on backend semantic fallbacks or internal `kind` markers, handles local/OpenAI-compatible model responses more robustly, and falls back unknown projects to the active workspace inbox while keeping sections only when they belong to a valid matched project.

## [2.8.2] - 2026-06-01

### Changed
- Todo swipe gestures now feel more native and polished, with richer action reveal plates, progress-tinted cards, stronger ready-state feedback, and Android-specific visual depth.
- Desktop users can now press Delete/Entf while hovering or focusing a todo to open the normal delete confirmation, then press Enter to confirm.

### Fixed
- API key rows in user settings now use the shared settings device-row layout, placing the revoke button below the key details on mobile like passkey and authenticator entries.

## [2.8.1] - 2026-05-31

### Added
- A packaged admin password recovery command is now available for Debian/systemd and Docker installs: `nia-todo-admin-password-reset` resolves the configured SQLite database, validates the new password, updates the admin hash, and invalidates existing admin sessions.

### Fixed
- Public GitHub source exports now allowlist documentation instead of copying internal docs wholesale, keeping only API docs and README screenshots public.
- Public GitHub source exports no longer duplicate systemd units at the repository root; package units live only under `packaging/systemd`.
- BrainDump now uses the currently selected workspace as its routing context, matching the New Todo flow: extraction, candidate quick-fix project lists, inbox fallback, project resolution, and unique-section routing are limited to projects/sections visible in that workspace.
- BrainDump now includes member-visible shared projects according to the member's display workspace, so shared-project routing follows the user's own workspace organization instead of the owner's workspace.
- Release-enforced native app compatibility floors now win over older persisted `app_config.min_native_client_version` values, so releases built with `--set-min-app-version` are reflected correctly by `/api/instance` even when production already has an older DB value.

## [2.8.0] - 2026-05-31

### Added
- A shared custom dropdown/menu system now powers redesigned user-facing selectors and action menus across todos, projects, settings, and admin screens, with keyboard support, accessible hidden native-select synchronization, viewport-aware menu placement, and regression coverage.
- A formal UI design concept and dropdown migration plan now document the app's card-based modal patterns, mobile behavior, shared controls, BrainDump UX expectations, and intentional exceptions.

### Changed
- Todo, project, workspace, user settings, admin, topbar, user-menu, and BrainDump surfaces have been visually aligned around calmer cards, consistent icon tiles, improved spacing, responsive mobile layouts, and reusable UI primitives.
- Todo cards now have a more polished layout with safer description previews, reminder metadata chips, aligned action menus, and smoother swipe gestures with elastic movement, action labels, threshold feedback, and full-width iPad/mobile swiping.
- BrainDump opens into a voice-first flow that starts recording immediately from the launcher, groups/sorts preview candidates by project, indents subprojects in quick-fix dropdowns, and keeps its modal/action layout aligned with the redesigned UI system.
- BrainDump documentation and admin/README wording now present the feature as configured/controlled rather than experimental.
- BrainDump preview candidates now include compact quick-fix controls for editing the title, project, and section before creating todos, using the shared custom dropdown system and an inline icon-only edit action.
- BrainDump extraction now uses a provider-neutral, language-agnostic ledger contract so capable OpenAI-compatible, Ollama, OpenClaw-agent, or other chat/instruct models apply later corrections/removals before returning final candidates.
- BrainDump's deterministic shopping safety net now only fills completely empty extractions, preventing regex-derived fallback items from re-adding candidates that a capable LLM correctly removed semantically.
- Frontend regression coverage now locks the shared dropdown behavior, redesigned modal/layout expectations, mobile todo modal layout, admin/settings selects, BrainDump capture flow, native/mobile todo gestures, and provider-neutral correction handling.

### Fixed
- Mobile todo swipe gestures again move the todo card itself instead of only revealing the background, support full-width swipes on iPad/mobile, and keep action labels visible on narrow screens.
- Redesigned dropdowns no longer appear as visible browser-default selects in migrated surfaces, avoid modal clipping, preserve existing JS-bound select IDs, and keep German/English labels readable.
- Project sharing/member management and workspace controls were reviewed for the redesign scope; workspace-specific controls remain intentional custom patterns, while project sharing uses inline actions rather than dropdown-style member menus.
- BrainDump no longer turns later correction/removal phrases or orphaned sentence fragments into todos when the configured LLM already returned semantic candidates.

## [2.7.0] - 2026-05-31

### Added
- BrainDump voice capture for turning spoken notes into user-confirmed todo candidates, including configurable LLM/STT providers, OpenAI-compatible and Ollama backends, OpenClaw agent selection, desktop/native app recording support, polished admin configuration, global and per-user access controls, robust local-model parsing, and self-hosting documentation.
- Admins can now edit a user's username from the admin panel, with duplicate/empty validation, safe handling for special characters such as apostrophes, and a confirmation warning that passkeys remain bound to the internal user ID while device-side account labels may still show the old username.

### Changed
- Admin UI has been streamlined with collapsible configuration sections, autosaving header switches, responsive user cards, and a dialog-based admin password change flow.
- HTML fallback text for localized settings UI now defaults to English consistently before translations are applied.
- Native app login screens are cleaner and more compact: the browser-only app reload action and divider are hidden, and the server-switch area no longer reserves unnecessary empty space.

### Fixed
- Android BrainDump recording now falls back to a native `MediaRecorder` bridge when WebView microphone capture fails, including live level feedback, silence auto-stop, lifecycle cleanup, trusted local WebView gating, and recording size/duration guards.
- Android WebView cache refresh now also handles same-version APK reinstalls, avoiding stale bundled frontend assets during native app updates and testing.
- Todo modal no longer shows a horizontal scrollbar on desktop due to the hidden pinned-checkbox control overflowing the dialog.
- User settings now hide the Disable 2FA button reliably when two-factor authentication is inactive, independent of the current UI language.

## [2.6.3] - 2026-05-29

### Fixed
- Android haptic feedback now falls back to direct vibrator feedback on Samsung devices where WebView/View haptics can report success without a perceptible pulse.
- Android native haptic fallback now declares the required `VIBRATE` permission and keeps non-Samsung devices on the standard system haptic path with vibrator fallback only when needed.

## [2.6.2] - 2026-05-29

### Fixed
- Android native notification settings can now be toggled without the app hitting the `desktop_set_setting` ACL error.
- Android native haptic feedback now uses the app bridge for todo status changes, with browser vibration kept as fallback.
- Android native reminders are rehydrated after login, app start, boot, user unlock, and app updates so existing todo reminders are scheduled locally again.
- Todo list API responses now include reminder metadata needed by native clients to rebuild local reminder schedules after a fresh install or login.
- Android reminder alarms now prefer exact while-idle scheduling when permitted, with safe fallback behavior when Android or OEM policy denies exact alarms.

### Changed
- Native Android reminder and haptic regression coverage is now part of the regular test suite, including reminder rehydration and alarm-policy checks.

## [2.6.1] - 2026-05-29

### Fixed
- Debian/systemd server self-updates now run in a detached transient systemd unit so package installation is not killed by the app service restart, avoiding interrupted `dpkg` states.
- Server update detection is more robust across Debian packages, Docker deployments, and development checkouts, and completed updates reconcile stale progress state in the admin panel.
- Windows/Tauri todo quick actions now keep nested controls usable: checkbox, status, snooze, pin, and delete actions no longer trigger todo edit or unwanted press feedback.
- Android/native todo swipe gestures now coexist with quick-action controls: taps remain button actions, while intentional horizontal swipes can start from the right-side action area.
- Todo row press feedback is now isolated to empty todo-card areas so interactive controls no longer make the row jitter or open the edit dialog.

### Changed
- Server update helper installation and sudoers handling were hardened with stricter path/config validation and safer failure behavior.
- Frontend regression coverage now locks todo interactive click isolation, native quick-action handling, and Android action-zone swipe behavior.

## [2.6.0] - 2026-05-29

### Added
- Today Focus mode helps surface pinned, overdue, due-today, and high-priority todos, and can be toggled with the `F` keyboard shortcut.
- Quick Add now understands inline todo syntax for priority, due dates, reminders, projects, and sections, with live visual chips for recognized tokens.
- Todo rows now support snooze actions for quickly moving due dates forward.
- Todos can now be pinned into a dedicated pinned group for easier access.
- Pin/unpin and snooze changes now support undo from the toast action.
- Mobile/native UX feedback now uses visible rounded press states with accent color, ring, glow, and subtle scale feedback instead of the default square browser highlight.
- Native haptic feedback now confirms real todo status changes on supported devices.
- Sync visibility now includes a compact pending-sync badge that fits the mobile top bar alongside the offline indicator.
- Admin user management now shows each user's last activity so inactive accounts are easier to identify.

### Changed
- Mobile todo navigation is more compact: search collapses to an icon, focus/search stay on the left, workspace selection stays on the right, and offline/sync indicators are centered between them.
- Dashboard and project widgets are hidden while searching so mobile search results start immediately at the top of the list.
- Browser Back/Forward now navigates between app views such as dashboard, filters, and projects while keeping the address bar clean.
- Pinned todo cards, deadline emphasis, and project/todo focus styling were refined for clearer hierarchy without making the UI heavier.

### Fixed
- Server update progress now reconciles stale `installing` states when the installed server version already matches or exceeds the update target, preventing completed updates from leaving outdated progress text in the admin panel.
- Login layout now stays usable on small mobile and desktop viewports: mobile uses a fullscreen scrollable form, login actions keep consistent sizing, and short desktop windows scroll instead of clipping the form.
- Todo swipe gestures still work when starting over the right-side todo action area for pin, snooze, or delete.
- The login refresh action stays attached to the login form instead of drifting to the page footer.
- Admin login errors now render readable messages for structured API errors such as rate limits instead of showing `[object Object]`.

## [2.5.5] - 2026-05-28

### Fixed
- Native apps now stay independent from the browser/PWA Service Worker: bundled app assets load locally, while native update checks use the native app update flow.
- Browser/PWA web-app update checks remain active before login so stale cached login or 2FA screens can recover before authentication.

### Changed
- Regression tests now explicitly lock the browser/PWA versus native update behavior so web update prompts, native app update prompts, and offline startup paths cannot be mixed accidentally.

## [2.5.4] - 2026-05-28

### Added
- Admin panel server update management for packaged Debian/systemd installations, including release checks, update severity indicators, install progress polling, and a guarded host helper that downloads the latest `.deb`, verifies SHA256, installs it, and requests a service restart.
- Docker installations now show update availability and manual `docker compose pull && docker compose up -d` guidance instead of attempting unsafe in-container self-updates.
- The login screen now exposes a subtle app refresh action and can show web-app update prompts before authentication, helping users recover from stale cached clients that miss newer login/2FA UI.

### Changed
- Server update status copy is localized and simplified so the update card relies on clear version, severity, and Debian/Docker-specific helper text.
- Public source exports and full Debian bundles now include the server update helper and normalize exported web/service-worker versions to the released version.
- WebSocket connections are skipped while logged out, preventing unauthenticated reconnect loops on the login page.

## [2.5.3] - 2026-05-28

### Added
- Passwordless passkey login is now available directly from the normal login screen, using discoverable/resident WebAuthn credentials to identify the account without username/password.
- Passkey login challenges now use dedicated replay-protected challenge storage with rate limiting, cleanup, and server-side user-handle validation.

### Changed
- Workspace number shortcuts now use `Alt+1` through `Alt+6` instead of browser-reserved `Ctrl+1` through `Ctrl+6`.
- New passkey registrations now require discoverable/resident credentials so newly created passkeys can be used for passwordless login, while existing non-discoverable passkeys continue to work for MFA and re-authentication.

### Fixed
- Native Changelog links now open exactly once in the external browser instead of ignoring the first click or opening duplicate tabs.
- User settings no longer show an empty Authenticator App device tile when no authenticator app is configured.
- The Add passkey action is hidden when no public base URL is configured and passkey setup would fail.

## [2.5.2] - 2026-05-28

### Added
- Browser/PWA download discovery now includes a compact `Download apps` launcher in the sidebar footer and on the login page, both opening a shared app download modal.
- The app download modal now shows Windows and Android downloads side by side and includes the exact server hostname users should enter in the native apps, preferring the configured public base URL and falling back to the current host without `https://`.
- Todo rows on wide screens now expose an inline status menu for quickly switching between open, in-progress, and done without opening the todo dialog.
- Keyboard shortcuts now support hovering a todo and pressing Space to cycle its status, plus `Alt+1` through `Alt+6` to switch between workspaces inside the app.
- Frontend regression coverage was added for app download visibility, quick todo status controls, project clear-done handling, workspace number shortcuts, and changelog nested list rendering.

### Changed
- App download UI is browser-only, hidden from native apps/PWA standalone mode, removed from user settings, and styled consistently with the existing mobile fullscreen modal patterns.
- Todo row quick actions are always visible and layout-stable, preventing hover height jumps in long lists.
- The inline todo status control now uses a custom rounded dropdown, closes on click-away/Escape, and renders above surrounding app chrome.
- Login page resource/download placement now mirrors the sidebar structure more closely, with API docs and changelog above a divider and the app download launcher at the bottom.
- GitHub release notes are now generated from the matching `CHANGELOG.md` version section, with distribution targets appended automatically.

### Fixed
- Clearing completed todos in a project now handles the project API response correctly instead of expecting a raw fetch response.
- App download modal layering now works from the login page instead of opening behind the login overlay.
- The Android platform download icon now renders correctly.
- The public changelog renderer now preserves nested bullet lists instead of rendering indented sub-bullets as left-aligned plain paragraphs.

## [2.5.1] - 2026-05-26

### Changed
- Windows installers now use English and German installer languages instead of German-only text, with NSIS showing a language selector.
- Release test runs retry frontend E2E checks once to avoid aborting full releases on transient Playwright/WebSocket timing flakes.

## [2.5.0] - 2026-05-26

### Added
- Initial public release packaging for a clean AGPL-licensed source export, a full Debian/Ubuntu server bundle, and a Docker image built from tag checkout.
- Initial public release publishing workflow for pushing the source snapshot/tag to GitHub, uploading the `.deb`, checksum, and manifest as GitHub release assets, and publishing the Docker image to GHCR.
- Packaged server backup/restore support with bundled helper commands, a systemd timer, runtime-data isolation, and hardened restore validation.

## [2.4.0] - 2026-05-26

### Added
- Mobile todo rows now support swipe actions: swipe left toggles done, swipe right toggles in-progress, with a left-edge deadzone to avoid sidebar gesture conflicts.
- Active sessions/devices in user settings are now collapsed by default, show the session count, and include privacy-local IP classification details.
- Native clients now send app/platform metadata so active sessions/devices can show clearer device labels.
- TOTP status now shows "1 TOTP" in admin panel and settings (consistent with passkey count display).

### Changed
- Session IP tracking now records the real client IP behind trusted reverse proxies using `X-Forwarded-For` or `X-Real-IP`, and keeps it updated during normal authenticated activity, MFA/re-auth flows, and WebSocket authentication.
- TOTP setup button is now hidden when TOTP is already configured, preventing duplicate setup.

### Fixed
- iOS Safari/Chrome no longer zooms the page when focusing todo inputs, selects, or text fields.
- Sidebar user menu dropdown is now opaque in iOS Safari instead of letting the sidebar bleed through.
- Todo swipe action reveal colors now render correctly in iOS Safari by using dedicated action backdrops instead of relying on transformed-element shadows.
- Modern email templates now keep body text, details, links, and bold 2FA codes readable in iOS Mail dark mode without changing the Outlook/MSO template path.
- Session/device labels are more stable across browser, native, and WebView clients, including service-worker precaching for the shared device-label helper.
- Admin panel now shows actual TOTP count ("1 TOTP") instead of just "TOTP" label.
- Fixed ReferenceError in settings UI when rendering TOTP status with active TOTP.

## [2.3.1] - 2026-05-26

### Fixed
- Todo dialogs no longer overflow horizontally on iOS Safari/Chrome when deadline or reminder date/time fields are visible.
- The active workspace name in the top bar no longer falls back to the translated generic label after opening and closing user settings.
- Existing pre-2.3.0 browser sessions are now migrated into revokable device sessions on the next `/api/me` auth check, so users do not need to log out and back in before the current device appears in Active sessions/devices.

## [2.3.0] - 2026-05-25

### Added
- Active sessions/devices management in user security settings, including current-session indicators and controls to revoke one device session or all active sessions/trusted devices.
- Session-backed trusted-device handling: login JWTs can now be linked to stored user sessions and remembered/trusted devices, making device revocation enforceable immediately.
- Project owners can move their own non-inbox projects between their workspaces. Shared members keep their independently chosen display workspace.

### Changed
- Trusted-device revocation no longer requires a fresh MFA reauth, so users can quickly remove stale or suspicious sessions/devices.
- Trusted-device wording and API documentation now distinguish active device sessions from remembered/trusted devices more clearly.
- Owner project workspace moves now move descendant projects together and return authoritative `updated_projects` data for offline clients.
- Project WebSocket updates now send recipient-specific project views, preserving member display workspaces while exposing the owner's workspace as `owner_workspace_id`.

### Fixed
- Revoking a trusted/current device invalidates the linked JWT session and logs out affected clients instead of only deleting the remember-device cookie.
- `/api/me` JWT refresh preserves and extends the existing session instead of creating duplicate sessions.
- Trusted-device/session updates are more robust under repeated revoke attempts, stale sessions, and normal token refreshes.
- Public API documentation table-of-contents generation handles deeper heading structures more cleanly.
- Offline sync now applies all server-returned project updates after workspace moves, including moved descendants.
- Separately shared child projects inside a moved subtree now notify the correct members and keep member display workspaces intact.
- Mobile setup page scrolls correctly when the first-user setup form is taller than the viewport.

## [2.2.2] - 2026-05-25

### Fixed
- Automatic language fallback now defaults to English when the browser language is unsupported or a dictionary cannot be loaded.

## [2.2.1] - 2026-05-25

### Fixed
- Native Windows app startup arguments no longer break non-desktop/native builds.
- Language selection in Windows and Android native apps now persists and immediately applies instead of reverting to Automatic.
- Changelog pill in the Windows native app opens exactly one external browser tab instead of two.
- Todo creation falls back to locally cached project sections when the app still appears online but the sections request fails, so offline/stale-network creation keeps section selection available.

## [2.2.0] - 2026-05-25

### Added
- Internationalization support added with English and German UI translations, language selection, persisted per-user language preference, localized error messages, and English-only public documentation.

### Fixed
- Admin user 2FA summaries no longer show remembered/trusted login devices as configured 2FA devices; the admin users API no longer returns that misleading count.
- Offline-created todos now sync exactly once after reconnect instead of being created twice when multiple online/WebSocket sync triggers race.
- Section counters in project views now respect the active filters, search, and hidden completed todos instead of showing the total section size.
- Delete confirmation dialogs and workspace create/edit dialogs use the same fullscreen mobile modal layout as the other app dialogs.
- The changelog link in native apps opens the changelog through the system browser instead of inside the app or with no visible effect.

## [2.1.0] - 2026-05-24

### Added
- Public changelog under `/changelog` added; the app links to it in the version area, in native apps below the app version, and on the login page next to the API documentation.
- Windows app can optionally start directly minimized to the tray on autostart without opening the main window.
- Shared projects can be assigned to a member-specific display workspace; by default they land in the default workspace.

### Fixed
- Migration for shared project workspaces is more robust with partially repaired legacy schemas.
- API rate limit is less tight for extended app/admin usage, so legitimate short action sequences and the release test suite do not unnecessarily run into HTTP 429.
- Search in public API docs and changelog shows the associated headings for matches, so version and section context remains visible.
- Shared projects no longer appear in every workspace, and members can no longer locally appear to change project icons.
- Avatar can be deleted again in profile settings; UI, API, and stored user state cleanly fall back to initials afterward.
- New-todo dialog focuses the title field directly when opened via the `N` key or native desktop hotkey.
- Native apps refresh the instance configuration again before the update check, so a freshly increased `min_native_client_version` cannot remain treatable as an optional update due to stale boot data.

### Changed
- Version area of the web app shows the version number separately above the equally wide actions `Changelog` and `Reload`; native apps show the changelog link below the app version without a reload action.
- API docs link in settings now sits directly in the API key section instead of the push/download area.
- Public API documentation and changelog use neutral, public-suitable wording instead of user- or instance-specific details.

## [2.0.1] - 2026-05-24

### Fixed
- MFA login again offers both methods for accounts with passkey and authenticator/recovery code; native apps prefer the code flow so desktop/Android passkey limitations do not create a login dead end.
- App download manifest and download artifacts are actively treated as `never-cache` in the service worker and removed from old caches, so outdated APK/installer links are no longer shown.
- Avatar URLs are resolved in native apps relative to the configured server URL, so profile images are not loaded against the local app shell origin.
- Release script waits for the live-migrated `app_config` table when optionally setting `min_native_client_version`.

## [2.0.0] - 2026-05-24

### Fixed
- Release version checker validates SemVer more strictly and covers `min_native_client_version` boundaries with a regression test.
- Android release sets generated `tauri.properties` deterministically before the APK build, so old generated versions do not cause a late build failure.
- Native app update notices can be deferred until the next app start for optional updates; only an increased `min_native_client_version` enforces the update.
- Release versioning hardened: web, service worker, Tauri, and Cargo versions are set consistently; `min_native_client_version` remains a deliberately maintained compatibility boundary.
- Release script only raises `min_native_client_version` with explicit `--set-min-app-version`; standard releases therefore remain native-app-compatible.
- Android release now validates the expected `versionCode` in addition to `versionName`.
- Missing native download manifest no longer creates 404/console noise, but returns an empty manifest with HTTP 200.

### Added
- Workspaces added as a new display/organization layer for projects and todos.
- Each user receives a default workspace `Private`; existing projects are migrated there.
- Each workspace has its own inbox; existing and new workspace data therefore remains cleanly separated.
- Workspace switcher with custom dropdown, color selection, create, rename, and delete added.
- Local Lucide SVG icon set added as an offline-/PWA-friendly icon base.
- Optional icons for projects and workspaces added; configured icons use the respective project/workspace color.
- Collapsible icon picker with search, categories, and all locally available Lucide icons added.
- Local design color presets added in the user menu: default plus six accent designs for light and dark theme.
- Local accent intensity slider added, including an option to disable accent effects completely.
- New app-owned danger confirm modal for deleting todos, projects, sections, and workspaces.
- Frontend/backend regression tests for workspaces, sharing, workspace inboxes, project deletion, and realtime sync added.
- Generic instance configuration for public base URL, allowed origins/CORS, and trusted proxies added.
- Native Windows and Android apps added, including a dedicated app update dialog with external download button.
- Native app downloads are delivered through a unified manifest with platform/architecture/version/SHA256 validation.
- Public API documentation under `/api` added; it renders the existing `docs/api.md` as a lightweight theme-compatible HTML page with search, without Swagger/OpenAPI UI.
- Native drag & drop uses a pointer/touch fallback instead of browser HTML5 DnD and supports Android scrolling without accidental moving or sticky hover highlighting.
- Native WebViews support search, section enter, and global keyboard paths consistently.
- Native regression tests for runtime configuration, offline start, Windows installer cache, and Android WebView cache added.
- **Email/SMTP integration** added for invitations, password reset, and email verification.
- **Admin UI for SMTP configuration** with host, port, security (none/starttls/tls), auth, sender, and test mail function.
- **Email templates** for setup link, password reset, email verification, and project sharing invitation.
- **Verified email semantics**: login, password reset, and project sharing only work with verified emails.
- **Email verification flow** with token hashing, prefix lookup, TTL, and safe fallback on SMTP failure.
- **Neutral API responses** for email-based actions (password reset, invitation) to prevent user enumeration.
- **Privacy-safe member lists**: pending invites are visible only to the invitee, not to owners or other members.
- **WebSocket broadcasts** for invitations only to the invitee (without `project_id` in the payload) to avoid leaking pending-invite existence.
- **Migrations 021–023** for SMTP configuration, case-insensitive email uniqueness, and email trust source.
- **Two-factor authentication (2FA)** added with TOTP/authenticator app, passkeys/WebAuthn including passkey reauth, recovery codes, login challenge flow with attempt lockout, optional “remember device”, and email code as a valid factor for accounts without TOTP/passkey.
- **Passkeys production-hardened**: WebAuthn is bound to HTTPS `public_base_url` (`http` only locally), validates origin/RP ID, user verification, `none` attestation, signatures, and sign counter; native apps show passkeys only after a separate native passkey bridge.
- **Android native passkeys** added: the official Android app uses AndroidX Credential Manager via a native callback bridge, validates configured server origin/RP ID before the credential ceremony, and uses server-delivered Digital Asset Links for the official app signature.
- **Official-app trust model for Android** documented: self-hosters host their server and connect the official app; custom package names, F-Droid/re-sign builds, and signing key rotation later need an explicit config/migration strategy.
- **2FA admin control** added: global 2FA requirement, user status including factors/API key note, and admin reset per user.
- **2FA/reauth protection** added for security-critical account actions, including changing email, changing password, disabling 2FA, regenerating recovery codes, API key management, and passkey management; email code can also be used for reauth.
- **One-time MFA action grants** added: login MFA and trusted devices count only for app access; every sensitive action requires a fresh, single-use MFA confirmation.
- **2FA settings UX** revised: TOTP setup with QR code, passkey/TOTP device lists with revocation, app-owned security dialogs instead of browser `alert`/`prompt`/`confirm`, dynamic reauth labels, and theme-compatible input fields.
- **2FA replay/race hardening** added: atomic challenge consumption, table-backed recovery code consumption, single-use email reauth codes, TOTP reauth timestep protection, and atomic passkey challenge usage.
- **Recovery code semantics** sharpened: recovery codes are backup factors for TOTP/passkey, are automatically revoked when the last primary factor is removed, and can only be regenerated with an active primary factor.
- **Migrations 024–028** added for 2FA status, challenges, attempt lockout, trusted devices, passkeys, one-time MFA grants, recovery code rows, and replay protection.
- Configurable `min_native_client_version` entry in `app_config` added, so the native compatibility boundary can be maintained explicitly and migration-backed.

### Changed
- System emails use a shared, modern HTML/text template with nia-todo branding, logo support, and consistent action buttons.
- Project, todo, dashboard, and section views are filtered by active workspace; notifications, reminders, push, and WebSocket sync remain global.
- UI emojis were replaced with consistent SVG icons or neutral status texts.
- New projects are created in the active workspace; subprojects must stay in the same workspace as their parent.
- Shared projects are shown in the workspace selected by the respective member and are selectable there in the todo modal.
- Project deletion moves contained todos to the inbox of the same workspace instead of broadly to a global inbox.
- Workspace deletion moves projects and workspace inbox todos to the default workspace.
- Identical project names are allowed; project identity is based on IDs instead of names.
- WebSocket sync updates workspaces, project deletions, child projects, and sharing restore events more robustly across multiple clients.
- Migration run for workspaces is more robust against partially applied workspace schema states.
- Default workspace `Private` directly receives the home icon; inbox projects directly receive the inbox icon.
- Admin, setup, login, and password dialogs were visually aligned with the new button/icon system.
- Accent colors only affect the main app; setup, admin, and password pages remain on the neutral theme.
- Password setup links now use the configured public base URL instead of implicitly using the request URL.
- CORS consistently rejects unknown origins; forwarded headers are accepted only from configured trusted proxies.
- Release workflow versions web, Windows, and Android together, always builds the native artifacts, and regenerates the download manifest from the current build artifacts.
- Native update manifest and download files are excluded from the app cache and delivered server-side with `no-store`.
- Release publishing cleans `/downloads/` before publishing new app artifacts, so old installers/APKs are no longer reachable via direct URL.
- Release builds check a download-free Tauri frontend bundle and abort on unexpectedly large Windows/Android artifacts.
- Native Windows and Android downloads open externally without a CORS preflight trap; Android accepts only safe HTTP(S) URLs without control characters.
- Android passkeys use the official app identity plus release certificate in `/.well-known/assetlinks.json`; this binding is deliberately not configurable per self-hosted instance.
- Windows upgrades specifically clean up WebView cache directories; Android cleanly migrates stale WebView cache states.
- **Email sharing returns neutral responses** (no member details) to prevent email enumeration.
- **Member lists show only `accepted` members** — pending invites are private until accepted.
- **Password reset and invitations** are sent only to verified emails; neutral responses prevent enumeration.
- **SMTP secrets are redacted in API responses** (`smtp_password_configured` instead of plaintext).
- Login responses can now return a 2FA challenge instead of an access token; clients must then complete `/api/2fa/challenge/verify` or the passkey verify flow. Globally enforced 2FA without a usable factor only creates an enrollment token; email code remains a fallback/transition path and does not count as a configured primary factor.
- Recovery codes no longer count as a standalone primary factor: once TOTP and passkeys are removed, remaining recovery codes are revoked and user-side 2FA is disabled; global 2FA policy can still require email-code MFA afterward.

### Fixed
- Project creation in workspaces no longer produces 500s on database conflicts or workspace assignment.
- Reload in a project view reliably restores navigation and active sidebar highlighting.
- Reload in the dashboard reliably marks the dashboard entry in the sidebar as active again.
- Project deletion via UI/offline sync no longer bypasses the backend workspace inbox logic.
- Realtime sync correctly removes deleted parent/child projects and stale local cache entries.
- Shared project changes including restored members update other clients via WebSocket.
- Confirm dialog buttons are visually centered cleanly.
- Theme buttons, admin mobile layout, and password setup actions are higher contrast and cleanly aligned.
- Icon/color values for projects and workspaces are validated backend-side and rendered safely frontend-side.
- Accent gradients, plus button, and dashboard avatar remain visually consistent across all presets and intensities.
- **Email enumeration in the share flow closed** (neutral responses, no member details for email identifiers).
- **Pending-invite leaks via WebSocket fixed** (broadcasts only to invitee, without `project_id`).
- **Email invite lookup limited to verified emails** (no username matching for email identifiers).
- Sharing UI keeps locally started username invitations visible without reopening privacy-safe server member lists for pending invites.
- 2FA challenges, reauth buckets, recovery codes, and MFA action grants cannot be reused multiple times for security-critical actions.
- 2FA/security flows no longer use native browser popups; confirmations, password prompts, and reauth run through app dialogs.
- Offline cold start with cached session no longer logs expected server refresh network errors as frontend errors.
- 2FA enrollment-only tokens do not load a normal app UI or local todo data behind the setup modal after login or reload.
- Initial TOTP and passkey setup cleanly finish the enrollment lock, initialize the app without reload, and only ask for the possible password secret.
- Recovery code regeneration is possible in UI and API only with an active primary factor (TOTP or passkey); email-code-only is not sufficient.
- Admin 2FA reset invalidates existing sessions via `token_version`, informs clients via WebSocket, and disconnects active user WebSockets server-side.
- Mobile 2FA/security modals, workspace switcher topbar, and API docs theme behave consistently in layout and theme.

## [1.7.3] - 2026-05-22

### Added
- Project views optionally show a compact project-related dashboard widget.
- User menu contains a saved toggle for the project widget.

### Changed
- New default view sorts by priority and hides completed todos without overwriting existing user preferences.
- Dashboard spacing and project widget appearance were visually smoothed.
- Toggle labels in the user menu are shorter.
- Project sections group todos by status: in progress, open, completed.

### Fixed
- API key timestamps are correctly converted from UTC to local time.
- Project reload restores navigation before the first render and prevents incorrect active sidebar highlighting.

## [1.7.2] - 2026-05-22

### Changed
- Web update modal uses shorter text.
- Native app version in the sidebar footer uses clearer wording without hyphens.
- Mobile update and connect buttons are aligned more compactly.
- Download manifest is normalized without duplicate app entries.

## [1.7.1] - 2026-05-22

### Changed
- Sidebar footer shows web app version and reload button compactly in one line.
- Native app version is shown below as a one-line app version.

## [1.7.0] - 2026-05-22

### Added
- Native Windows/Android apps are built with the same version as the web app.
- Web app shows available native app updates with a download button.
- Installed native app version is shown in the sidebar footer.

### Changed
- Release script always builds web app, Windows installer, and Android APK together with one version.
- Service worker update notice is now a mandatory fullscreen modal instead of a sidebar button.
- Update checks run more robustly on app start, focus, online event, and periodically without blocking offline start.

### Fixed
- Release flow sets web, Tauri/Cargo, and download versions consistently and protects against broken intermediate states.

## [1.6.5] - 2026-05-22

### Fixed
- Settings/user dropdown consistently aligns all menu icons and labels through a fixed icon column.
- Open user dropdown remains anchored to the user tile while scrolling the sidebar.
- Regression tests for user menu alignment and scroll anchoring added.

## [1.6.4] - 2026-05-22

### Fixed
- Offline→online sync pushes local changes before authoritative server refresh, so offline-completed/edited todos are not overwritten again by server state.
- Offline status now wins over stale WebSocket status; the app no longer attempts API syncs in true offline mode.
- Online-event sync uses multiple retry attempts plus app focus/periodic checks, so native/WebView reliably pushes local queue changes to the server after network changes.
- Regression test added for complete offline → sync online → server sees change → remains completed after reload.
- WebSocket realtime updates render with updated in-memory state again after incoming changes; changes from other clients are visible without reload.
- Regression test added for two clients: client A changes a todo, client B sees the change live via WebSocket.

## [1.6.3] - 2026-05-21

### Changed
- Manual reload button in the sidebar footer now clearly shows “↻ Reload” instead of only an icon.

### Fixed
- Service worker no longer activates new versions when precache fails; this preserves the last complete app cache on unstable/offline connections.
- Inline boot watchdog shows an error when app modules are missing instead of an endless spinner.
- Version rendering no longer deletes the manual reload button after app start.
- Service worker precache no longer contains a nonexistent `/favicon.ico`.
- Test suite now validates that the service worker precache contains all frontend JS modules and app shell assets and does not reference stale assets.

## [1.6.2] - 2026-05-21

### Added
- Sidebar footer has a manual reload button next to the version number that forces service worker update/cache refresh and reloads the web app.

### Fixed
- Native Android app no longer removes the service worker on start, so repeated offline cold starts no longer land in `ERR_NAME_NOT_RESOLVED`.
- Release script will now abort if no `CHANGELOG.md` section exists for the target version.

## [1.6.1] - 2026-05-21

### Fixed
- Native offline cold start in Windows/Android app loads the app shell from the service worker cache instead of getting stuck on the boot spinner.

## [1.6.0] - 2026-05-21

### Added
- Native local reminder scheduling for Windows/Tauri and Android/Tauri.
  - Windows schedules reminders locally in the running tray/app process.
  - Android schedules reminders through `AlarmManager`, persists scheduled reminders, and restores them after device restart.
- Android notifications have a native action “Completed” that marks the todo as completed locally offline and later syncs it through the sync queue.
- Android app works offline after a single load, including cold start through the service worker cache.
- Android uses its own monochrome small notification icon.

### Changed
- Native apps use known reminder times locally; browser/PWA push remains browser/PWA-only.
- Native apps no longer register server-side WebSocket reminder readiness.
- Service worker remains active in native wrappers so offline cold start works; native wrappers automatically activate service worker updates.
- Android uses native system bar/window insets handling instead of CSS hacks.

### Fixed
- Android server URL setup screen is correctly centered on narrow displays and does not overflow the viewport.
- Android launcher/task icon and notification icon are consistent with the app.
- Dashboard panels “Focus” and “Active Projects” are visually evenly aligned.
- Clicks on project links in the dashboard synchronize the active sidebar selection.
- Windows/Tauri starts offline after app restart from cache again instead of getting stuck on the empty start screen.

### Known limitations
- Android “Completed” from the native notification currently uses a native IndexedDB single-shot path. This reliably marks completed offline, but currently shows no web undo toast.

## [1.5.2] - 2026-05-21

### Fixed
- Android/Tauri start loads the web app with a native launch parameter to bypass stale service worker navigation caches.
- Service worker is disabled in native Tauri wrappers and existing registrations are removed so Android does not get stuck on the boot spinner.
- Android gets a native statusbar inset so topbar and sidebar do not sit under the system status bar.
- Boot process shows a reload error on hanging initialization instead of an endless spinner.

## [1.5.1] - 2026-05-21

### Changed
- Android APK is now signed with a permanent release keystore so future Android updates can be installed cleanly over it.
- Download buttons use fixed Windows/Android SVG logos instead of platform-dependent emojis.

### Fixed
- Release script reliably signs Android APKs with `apksigner` and verifies the signature.

## [1.5.0] - 2026-05-21

### Added
- **Android Tauri app** as a native wrapper alongside Windows
  - Local server URL selection like Windows, without a hardcoded default URL
  - Android-native notifications via Tauri Notification Plugin including runtime permission
  - Android app ID changed to the official release app ID
- **Android download in the browser**
  - Download manifest contains Windows setup and Android APK equally
  - Login and settings download area show both platforms side by side

### Changed
- Native app settings apply to Windows and Android together; desktop-only options such as tray, autostart, and global hotkeys are hidden on Android.
- Release automation builds and publishes a signed Android APK including SHA256 in addition to the Windows installer.

### Fixed
- Android statusbar/edge-to-edge overlap fixed by removing native edge-to-edge mode.
- Android launcher/task-switcher icon regenerated from the app icons.
- Browser push settings are hidden in native apps because native notifications run separately there.

## [1.4.0] - 2026-05-21

### Added
- **Windows desktop app based on Tauri**
  - Server URL is configured locally instead of hardcoded
  - Native Windows notifications for reminders
  - Global desktop hotkeys for show/hide app, new todo, and search
  - Hotkeys are captured by keypress and stored locally
  - Window size, position, and maximized state are restored across restarts
- **Desktop download in the browser**
  - Current Windows setup file can be downloaded in the regular browser under login and settings
  - Download is hidden in desktop app/PWA/standalone mode
- **Release automation for Windows**
  - `release.sh` sets the Tauri version, builds the Windows setup, and places it versioned under `/downloads/` on the live server
  - Download manifest with version, filename, size, and SHA256 is generated automatically

### Changed
- Service worker precaches new desktop/download modules and uses stable avatar URLs for better offline cache

### Fixed
- Offline cold start remains logged in with a valid local session and loads IndexedDB data instead of forcing login
- Avatars remain visible offline after prior online loading
- Hotkey capture no longer stores modifier-only events (`Ctrl` alone) and ignores key repeat while holding keys

## [1.3.6] - 2026-05-21

### Fixed
- Sidebar user menu is narrower on desktop and mobile and centered on the sidebar user container

## [1.3.5] - 2026-05-21

### Fixed
- Sidebar user menu is no longer clipped by sidebar overflow in desktop PWA and mobile

## [1.3.4] - 2026-05-21

### Fixed
- WebPush VAPID claims are isolated per subscription so Android/FCM and Windows/WNS do not overwrite each other's target audience in a shared send

## [1.3.3] - 2026-05-21

### Fixed
- Push test now reports the real WebPush send result instead of always showing success
- Test notifications use unique tags so Windows/Edge does not silently replace or group them

## [1.3.2] - 2026-05-21

### Added
- Mobile sidebar can be opened from the left with a defensive edge swipe gesture

### Changed
- Swipe start zone was widened for Android so the browser/system back gesture interferes less

## [1.3.1] - 2026-05-21

### Changed
- Dashboard pill at top right removed so the header feels calmer
- **Active Projects** now sorts by the last todo change per project instead of by open todo count
  - Uses `updated_at` with fallback to `created_at`
  - Shows relative change time such as `3 min ago` or `2 h ago`

## [1.3.0] - 2026-05-21

### Added
- **Dashboard view** replaces “All” as the central overview
  - Personal greeting with display name, avatar, date, and time
  - KPI cards for total, open, in progress, and overdue
  - Focus area with due today, next 7 days, completed, and completion rate
  - Active projects as a clickable overview
- **Floating Action Button** for creating new todos
  - Round plus button at bottom right instead of “Neues Todo” in the topbar
  - Mobile safe area and extra list spacing accounted for

### Changed
- Global stats bar is no longer shown in project views
- Dashboard scrolls together with the todo list; topbar remains sticky
- User/settings menu was moved from the topbar to the lower sidebar footer
- Sidebar view “All” was renamed to “Dashboard”

## [1.2.3] - 2026-05-21

### Fixed
- **Header avatar visually aligned**
  - Avatar button now sits cleanly at the same height as the topbar actions
  - `Neues Todo` button and avatar control use a consistent 40px height

## [1.2.2] - 2026-05-21

### Fixed
- **Todo editing preserves sections correctly**
  - Section selection in the edit modal is now loaded based on the todo project
  - Existing `section_id` is correctly preselected when opening
  - Saving without a section change no longer incorrectly moves todos to “Unsorted”
- Regression test for todo edit with section preservation added

## [1.2.1] - 2026-05-21

### Fixed
- **PWA offline cold start**: app remains logged in after complete quit and reopening without network
  - Temporary network/offline errors for `/api/me` no longer delete the local session
  - Valid local session is reconstructed from cached user profile/JWT
  - Real auth errors still correctly delete the session
- Regression test for offline cold start added

## [1.2.0] - 2026-05-21

### Added
- **Avatar/user menu at top right** as a new place for global actions
  - Settings, theme, sorting, hide completed todos, and logout in a compact menu
  - Old sidebar user footer was removed
- **User profile in settings modal**
  - Username is displayed read-only
  - Display name is editable inline like the email
  - Email and profile load fresh `/api/me` data when opening
- **Avatar upload through settings**
  - Round cropper with drag, pinch-to-zoom on mobile, and mouse wheel/trackpad zoom on desktop
  - JPEG/PNG/WebP/GIF as well as HEIC/HEIF as upload formats
  - HEIC/HEIF is processed server-side when the browser does not support preview
  - Always saved as WebP under `api/data/avatars/`; the DB stores only URL and modification timestamp
- **Avatar backups**
  - Live backup stores SQLite DB, metadata, and avatar files together as a rotating ZIP per slot

### Changed
- User menu text colors normalized so active toggle entries stay visually calm
- Settings profile area arranged more compactly and cleanly

### Fixed
- Undo for reopened todos correctly restores the previous status
- Avatar cropper displays images correctly on mobile instead of starting with `scale(0)` due to invisible modal size
- Project modal can set a subproject back to “no parent project” (`parent_id: null` is now applied)

## [1.1.0] - 2026-05-20

### Added
- **Password setup/reset links** for user onboarding
  - Admins automatically generate a one-time setup link when creating users
  - Admins can generate a new password link for existing users at any time
  - Public `/set-password` page for setting the password by token
  - Tokens are stored hashed, one-time use, and valid for 24 hours
- **Email addresses for users**
  - Email is required for new users and the first setup user
  - Admin UI shows email addresses in the user list
  - Admins can edit email addresses inline with pen/check/X
  - Users can edit their own email inline in the settings modal
- **Email validation** in backend, admin UI, setup UI, and user settings

### Changed
- Admins no longer set user passwords directly; password links are generated instead
- User settings load fresh `/api/me` data when opening so admin changes are visible immediately
- Admin user list simplified: status column removed, more compact email editing
- Settings modal cleaned up: password button sits directly in the password section

### Fixed
- Todo creation correctly applies the selected status and sets `completed_at` for directly completed todos
- Admin table layout no longer overflows the container during inline editing
- Table ellipsis no longer incorrectly appears next to “Link erzeugen”

### Security
- Password setup tokens are stored only hashed and are invalid after use
- Email addresses must be unique and formally valid
- `/api/password-setup/complete` is explicitly token-based public, but remains CSRF-independently limited to the one-time token

## [1.0.0] - 2026-05-20

### Added
- **Project sharing**: projects can be shared with other users
  - Invitations by username
  - Accept/decline in the UI
  - Owner/member roles with clear readonly view for shared projects
  - Remove members, leave project, and undo for both cases
  - Owner metadata (`owner_username`, `owner_display_name`) for shared projects
- **Stable inbox identity**: `projects.is_inbox` replaces hard assumptions about name or ID
  - Each user has their own inbox
  - Inbox may be renamed but remains protected
  - Migration repairs missing/broken inbox assignments and projectless todos
- **Frontend security test**: new regression tests for Markdown XSS, service worker API cache, and offline sync queue
- **Sharing frontend test**: Playwright test for invite, member list, readonly UI, and owner visibility
- **Cold-start loading screen**: shows a dedicated loading state during app boot instead of an overly early login mask

### Changed
- **Project names unique only per user** instead of globally unique
- **Todo default project**: new todos without project land in the current user's inbox
- **Login/reload stability**: server refresh renders immediately and persists projects/todos/sections directly in IndexedDB
- **PWA session**: user logins last 30 days and are automatically extended when opening the app if they expire soon
- **Service worker**: `/api/*` is no longer cached to avoid auth/user data leaks
- **API key auth**: CSRF bypass only for `Authorization: ApiKey ...`; `Bearer nt_...` and `X-API-Key` are rejected
- **Reminder/deadline inputs**: frontend and backend validation for invalid date/time values (`1900..9999`, valid time)

### Fixed
- **Multi-user isolation**: project/section/todo/reminder filters validate access before data queries
- **Shared reminders**: reminders are user-specific visible and dispatched to the correct user
- **Delete project**: todos are moved to the respective user's inbox, not hardcoded to project ID 1
- **Login race**: form submit can no longer fire before the app modules are ready
- **App import failure**: dynamic import errors now show an error state with “Reload” instead of endless spinner
- **Markdown rendering**: token contents are escaped instead of allowing regex reinjection
- **Offline sync queue**: payloads are whitelisted/sanitized
- **Sharing UI polish**: inline invite errors, subtle member list, compact action buttons, visible owner info

### Security
- CSRF hardening for API key confusion (`Bearer nt_...`)
- IDOR protection for foreign project/section filters
- No authenticated API response caching in the service worker
- Stricter shared-data isolation through REST and WebSocket

## [0.4.11] - 2026-05-20

### Architecture
- **Backend modularized**: monolithic `main.py` split into routers + services
  - `api/routers/` — API endpoints (auth, todos, projects, sections, push, admin, me, setup, dashboard, websocket, reminders)
  - `api/services/` — business logic (auth, push, audit, utils, websocket)
  - `api/middleware/` — security middleware (CSRF, rate limiting)
  - `api/migrations/` — versioned DB migrations
- **Frontend modularized**: legacy inline script replaced by ES module architecture
  - `web/static/js/features/` — isolated feature modules (auth, sync, todos, projects, sections, drag-drop, toast-undo, push, theme, websocket, view-preferences, service-worker-updates, app-lifecycle, ui-shell, navigation, section-actions, todo-rendering, app-rendering, api-keys, user-settings, connection-status, legacy-globals)
  - `web/static/js/api/` — API clients (http, auth, todos, projects, sections, push)
  - `web/static/js/core/` — config + utilities
  - `web/static/js/storage/` — IndexedDB + app storage wrapper

### Added
- **Test framework**: frontend regression tests with Playwright (8 modules)
  - `scripts/test_all.sh` — full suite (backend + 8 frontend tests)
  - `scripts/test_backend.py` — 40 API endpoints with automatic DB backup/restore
  - `scripts/test_frontend_smoke.mjs` — login, project, section, todo, theme, search, delete, undo
  - `scripts/test_frontend_app.mjs` — todo CRUD, edit, filter, prio, drag & drop between sections
  - `scripts/test_frontend_setup.mjs` — setup flow, admin creation, first user
  - `scripts/test_frontend_admin.mjs` — admin login, user management, password reset
  - `scripts/test_frontend_settings.mjs` — API keys, push settings, password change
  - `scripts/test_frontend_projects.mjs` — project CRUD, subprojects, colors
  - `scripts/test_frontend_dragdrop.mjs` — drag & drop between sections and projects
- **Docs**: split into separate files under `docs/`
  - `docs/api.md` — complete API documentation (request/response/body/examples)
  - `docs/testing.md` — frontend and backend test guide
  - `docs/workflow.md` — Git workflow, branches, release process
  - `docs/architecture.md` — frontend and backend architecture
- **Release gate**: `./scripts/test_all.sh` must be green before tag/merge

### Fixed
- **Startup performance**: `app.js` is now imported dynamically after DOMContentLoaded
  - Significantly reduces blocking initial load
- **Reload remains logged in**: `startAppModule()` is called explicitly on every import
  - Previously: ESM cache prevented re-execution of startup side effects
- **Service worker**: no false update notice on first installation
  - Update button only with `controller` before registration + `waiting` worker
- **Service worker**: no automatic reload loop on the first `controllerchange`
- **Auth**: login flow stabilized against timeouts during setup/auth checks
- **Settings test**: push buttons robust against `display:none` in the test context
- **Section DnD UX**: separators only when moving sections, todo zones only when moving todos

## [0.4.10] - 2026-05-18

### Changed
- **Release/version update** to `v0.4.10`
  - Version texts in UI, frontend, and service worker raised
  - No functional changes compared to `v0.4.9`

## [0.4.9] - 2026-05-17

### Added
- **Delete completed**: inline button next to "New section" deletes all done todos in the project
  - Including subprojects
  - Confirmation dialog with count
  - **Batch undo**: undo restores all deleted todos
- **Remember project**: last selected project/filter is restored after reload
- **Shortcut 'n'**: opens todo modal and directly focuses the title field
- **Deadline & overdue**: shown again in todo list (second line)
- **Description**: now shown in todo list (third line, max. 12 words)
- **Markdown support**: descriptions support **bold**, *italic*, `code`, - lists, [links](url)
- **Live Markdown Preview**: realtime preview in the todo edit modal

## [0.4.8] - 2026-05-16

### Added
- **Push notifications**: complete PWA notifications for todo reminders
  - VAPID-based Web Push Notifications
  - Settings UI with server status check (shows "inactive" when subscription is dead)
  - "Completed" action from notification marks todo directly (app stays in background)
  - Background task checks every **30 seconds** for due reminders
  - Automatic cleanup: 14-day cleanup removes dead subscriptions
  - Server status endpoint: `GET /api/push/status`
- **UX improvement**: new todo has current project preselected (or inbox)

### Fixed
- **Delete reminder**: reminder can now be removed (empty field → deletes reminder)
- **Sync duplicates**: race condition for todos, sections, and projects fixed
- **Async startup**: background loop now starts reliably (previously sync def with asyncio.create_task)
- **Service worker**: ignores silent health-check pushes (no empty notifications)
- **Undo toast**: toast notification is now centered on mobile

### Removed
- Telegram reminder scripts (replaced by push notifications)
- Internal audit/debug files removed from the release package

## [0.4.6] - 2026-05-16

### Fixed
- **Section broadcasts**: WebSocket broadcasts for section CRUD added
  - `section_create`, `section_update`, `section_delete` are now sent to other devices in realtime
  - Renaming/creating sections appears immediately on all connected devices
- **Sync consistency**: `sync_response` now merges todos only when no local pending updates exist
  - Previously server state could overwrite local todo updates (as already correct for projects/sections)
- **Project WS handler**: `renderStats()` and `renderTodos()` are called on `project_create`/`project_update`
  - Todo view immediately shows updated project names/colors without switching views

## [0.4.5] - 2026-05-16

### Fixed
- **CSRF cookie support**: `credentials: 'include'` added to all `fetch()` calls
  - All writing operations (PATCH, POST, DELETE) now work correctly
  - Project renames, color changes, todo updates, etc. are now synced to the server
  - Login/logout/API keys also fixed
- **Migration 008**: `updated_at` column added to `sections` (for offline sync)

## [0.4.4] - 2026-05-16

### Added
- **Sections offline-first**: CREATE/UPDATE/DELETE sections now works offline with sync queue
  - `updated_at` column added to `sections`
  - Merge logic for sections during server refresh (like todos/projects)
  - Sync queue handler: `CREATE_SECTION`, `UPDATE_SECTION`, `DELETE_SECTION`

### Fixed
- **Project sync**: offline-renamed projects are no longer overwritten by the server
  - `updated_at` comparison + pending-changes check for projects in `refreshFromServer()`
- **Mobile scroll**: last todo is no longer clipped in the PWA
  - `100dvh` instead of `100vh` for correct viewport height
  - `padding-bottom` for mobile safe areas
  - Toast position now accounts for `safe-area-inset-bottom`

## [0.4.3] - 2026-05-16

### Changed
- **Projects sorted alphabetically**: inbox (ID=1) always first, then custom projects A→Z

## [0.4.2] - 2026-05-16

### Changed
- **Projects sorted alphabetically**: sidebar tree, todo modal dropdown, and project modal dropdown now sort by project name (A→Z)

## [0.4.1] - 2026-05-16

### Added
- **3-state checkbox**: click on checkbox toggles open → in progress → completed → open
- **Undo toast**: "Undo" button appears after completing/deleting a todo (5s timeout)
- **Sort toggle**: sorting in topbar switches between order / priority / alphabetical
- **Hide-done toggle**: hide completed todos app-wide (localStorage)
- **Offline indicator**: only visible when offline — subtle red dot, no text

### Changed
- **Theme toggle**: sidebar now has a single button instead of three (cycles Light/Dark/System)
- **Compact todos**: prio emoji before the title, no project name anymore, one line per todo
- **Global views**: todos in All/Open/In Progress/Completed now grouped by project
- **Sections**: minimal style without background/border, no folder icon
- **Logout button**: now as an icon next to the settings icon in the sidebar
- **Topbar**: new toggle buttons (40×40) for better ergonomics
- **"In progress" above "Open"**: order changed in global views

## [0.4.0] - 2026-05-16

### Added
- **Multi-user support**: multiple users with their own data
- **JWT authentication**: bearer token with 1-day lifetime, `token_version` for immediate invalidation of all sessions
- **Admin setup** (`/setup`): set admin password + create first user
- **Admin panel** (`/admin`): create users, delete users, reset passwords
- **Password management**:
  - User can change own password (settings modal)
  - Admin can change own password
  - Admin can reset user passwords
  - Console emergency reset: `api/change_admin_password.py`
- **Password strength validation**: admin 12+ characters, user 8+ characters (uppercase/lowercase letter, digit, special character)
- **Theme toggle**: Light/Dark/System with localStorage persistence
- **Data isolation**: users see only their own projects, todos, and sections
- **IndexedDB cache security**: automatic deletion on logout/user switch
- **Migration system expanded**: 003_add_user_support.sql + 004_add_jwt_support.sql
- **API key authentication**: users can generate API keys in settings
- **Rate limiting / brute-force protection**: login (5 attempts / 15 min), API (100 requests / min), WebSocket (max 10 per IP)
- **CORS**: allowed origins are configurable and checked restrictively
- **CSRF protection**: double-submit cookie pattern for all state-changing endpoints
- **Security headers**: CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, HSTS
- **Audit log**: security-relevant events are logged
- **Input sanitization**: HTML tags are removed, null bytes stripped
- **Input validation**: username (3-32 characters, alphanumeric), password length, text length limits

### Changed
- Sidebar always shows complete project tree (no more toggle buttons)
- Admin panel with dedicated login page instead of browser prompt
- Inbox (id=1) protected: no deletion, no parent dropdown, not selectable as parent
- WebSocket auth: token is sent as message instead of query parameter
- JWT expiration time: 7 days → 1 day
- OpenAPI docs disabled in production
- **UI**: admin link removed from sidebar (direct URL only /admin)
- **UI**: logout button as icon next to settings, more compact user bar

### Security
- **SQL injection** fixed in `update_todo` and `update_project` (column whitelist)
- **XSS** fixed in frontend and admin panel (`escapeHtml`, `escapeHtmlAttr`)
- **Path traversal** fixed in SPA route (`PurePath.name`)
- **User deletion** now deletes all user data (cascade)
- **Setup admin** cannot be run multiple times
- **X-Forwarded-For** is trusted only from internal proxies

## [0.3.3] - 2026-05-15

### Added
- **Theme support**: Light/Dark/System theme with toggle in sidebar
- Theme setting is stored in localStorage
- Theme reacts live to system theme changes ("System" mode)

## [0.3.2] - 2026-05-15

### Added
- CHANGELOG.md with complete version history

### Fixed
- Section button is now **always** shown (even in empty projects)
- Empty state no longer overwrites the "New section" button

## [0.3.1] - 2026-05-15

### Added
- Automatic incrementing of the dev version after release (release.sh)
- DB backup before live upgrade (timestamped backups in api/data/backups/)

### Changed
- Sidebar always shows complete project tree (no more toggle buttons)
- Inbox is protected: no deletion, no parent dropdown, not selectable as parent

### Fixed
- Project deletion was not synced (DELETE_PROJECT handler was missing)
- Duplicate projects after creation (temp ID cleanup)
- Duplicate todos after creation (temp ID + WS handler fix)
- Dropdown indentation for sub-subprojects (non-breaking spaces)
- Project tree in todo modal dropdown

## [0.3.0] - 2026-05-15

### Added
- **Subproject support**: projects can now have parent projects
- `parent_id` column in `projects` table
- Tree structure in sidebar with indentation
- Recursive todo count in subprojects
- Cascade delete: deleting a parent deletes all children
- Cycle detection: prevents circular dependencies
- Migration system: 001_initial_schema.sql + 002_add_project_parent_id.sql

### Changed
- Project modal: parent dropdown with tree structure
- API expanded: create/update/delete with `parent_id`
- `db.py`: `UNIQUE(name, parent_id)` instead of `UNIQUE(name)`

### Fixed
- Dropdown display for nested subprojects
- Live upgrade: migration 002 safely adds `parent_id`

## [0.2.17] - 2026-05-14

### Added
- Offline-first PWA with IndexedDB
- WebSocket realtime sync
- Service worker with update mechanism
- Sync queue for offline changes

### Fixed
- Various UI bugs

## [0.2.0] - Earlier

### Added
- Basic todo management
- Projects and sections
- Priorities and due dates
- Reminder function
- Dark mode UI
