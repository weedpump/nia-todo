# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/de/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/lang/de/spec/v2.0.0.html).

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
