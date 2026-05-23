# Native Apps Phase 0 Inventory

Status: inventory plus first implementation notes.
Branch: `native-apps-clean-architecture`.
Baseline parent: `develop@d4289b4`.

## Repository state inspected

Tracked native-related footprint:

- `src-tauri/` exists and has 69 tracked files.
- `src-tauri/desktop-shell/index.html` is a local server-selection shell.
- `src-tauri/src/lib.rs` contains desktop settings, server URL storage, notifications, tray, global hotkeys, and an in-process reminder scheduler.
- `src-tauri/gen/android/...` contains generated Android project files plus custom Kotlin bridge/reminder code.
- `web/static/js/features/desktop-integration.js` contains Tauri/Android bridge integration.
- `web/static/js/features/service-worker-updates.js` contains native-aware SW update behavior.
- `scripts/test_frontend_native_offline.mjs` simulates Tauri-like launch via `?nativeApp=tauri` and server-hosted SW cache.
- `release.sh` builds Windows/Android artifacts via Tauri as part of every shared release.
- `docs/tauri-windows-poc.md` exists as native app history/docs; native changes now use the shared `CHANGELOG.md`.

Generated/local build output also exists under `src-tauri/target/`, but this is not tracked.

## Current implementation shape

The current Tauri setup is not a fully bundled offline app shell. It is closer to:

1. Start local `desktop-shell`.
2. Ask for server URL and store it in local Tauri config.
3. Navigate the WebView to the remote server URL with `nativeApp=tauri`.
4. Rely on the remote Web App + Service Worker cache for later offline cold starts.

Evidence:

- `src-tauri/tauri.conf.json` uses `frontendDist: ./desktop-shell`.
- `src-tauri/desktop-shell/index.html` redirects to the configured remote server URL.
- `web/static/js/core/config.js` has `API = ''` and derives WebSocket URL from `location.host`.
- Native offline regression test launches `${BASE_URL}/?nativeApp=tauri`, i.e. the server-hosted UI, not a bundled local UI.

## Strong parts worth preserving conceptually

These are useful ideas, but should be copied/rebuilt deliberately, not accepted wholesale:

- Local first-run server URL setup screen.
- Server URL normalization to `http(s)` without trailing slash.
- Separate browser push vs native local reminder concept.
- Windows tray/autostart/hotkey features as later optional desktop polish.
- Android notification permission handling.
- Android `AlarmManager` reminder scheduling and reboot re-registration concept.
- Browser-only app download visibility checks.
- Release flow option flags for platform artifacts.

## Problem areas / architecture mismatches

### 1. Remote WebView dependency

The configured server page is the actual app shell. That violates the new target that the native app must cold-start offline from local assets.

Impact:

- First offline start before successful server load only shows local setup shell, not app UI.
- Offline cold start after login depends on SW cache correctness of a remote origin.
- DNS/TLS/server outage can still break navigation semantics.

### 2. API/WebSocket tied to `location`

`web/static/js/core/config.js` currently uses:

- `API = ''`
- `WS_URL = location.protocol/host + /ws`

That works for same-origin browser/PWA, but native local UI needs an explicit configured remote API base URL.

Required refactor:

- Runtime config abstraction for browser vs native.
- API base URL and WebSocket URL derived from configured server URL in native mode.
- Tests for both same-origin browser mode and configured-remote native mode.

### 3. Capability allowlist is hardcoded to Tobi-specific hosts

`src-tauri/capabilities/*.json` currently allow remote URLs including:

- `https://todo.kneidl-home.de`
- `https://todo-dev.kneidl-home.de`
- `http://todo-dev.kneidl-home.de:*`

This conflicts with generic configurable server architecture.

Decision needed:

- If Tauri remains, how do we safely support arbitrary configured servers without broadening native bridge exposure too much?
- Prefer local UI origin with API fetch permissions instead of exposing Tauri commands to arbitrary remote pages.

### 4. CSP is disabled

`tauri.conf.json` has `security.csp: null`.

For the old remote-wrapper model this is especially risky. For the new local-shell model, CSP should be intentionally designed.

### 5. Native bridge exposed to remote content

Current model loads remote server content and gives it access to native commands / Android JS interface.

Risk:

- If the configured server or any injected content is compromised, native commands become reachable from that page.
- Server URL configurability plus native bridge exposure is a big security review item.

Preferred direction:

- Native bridge only exposed to local bundled UI.
- Remote API is data-only, not executable UI.

### 6. Android notification action writes IndexedDB via injected JS

`MainActivity.kt` builds a JS snippet that scans hardcoded DB names and writes to IndexedDB/syncQueue.

Concerns:

- Hardcoded DB names: `nia-todo-db`, `nia-todo-db`.
- No explicit server/instance/user scoping in the action path.
- The script runs inside the current WebView context.

This can be rebuilt later, but should not be carried forward blindly.

### 7. Windows reminder scheduler is in-process only

`desktop_schedule_reminders` spawns sleeping threads in the running process.

Impact:

- Reminders disappear if the app/process is not running.
- Tray/autostart mitigates but does not equal OS-level scheduling.

Acceptable only if documented as v1 limitation, or replaced with proper OS scheduler/background strategy.

### 8. Release script builds the native Tauri artifacts with each release

`release.sh` builds and publishes Web, Windows and Android together with one shared version.

For now:

- Web-only releases are intentionally disabled.
- Native release paths must be tested/reviewed before merging this branch.

### 9. `/api/instance` does not exist yet

Generic Server Config exists, but public instance verification endpoint is still missing.

Needed:

- Low-information unauthenticated endpoint.
- Stable public instance id.
- API/server version/capability metadata.
- Tests that secrets/admin/internal config do not leak.

## Runtime decision: Tauri vs alternative

### Keep Tauri

Pros:

- Existing toolchain and build path already present.
- Rust core can serve bundled assets / provide secure local config.
- Windows packaging and Android project are already bootstrapped.
- Native capabilities are mostly known.

Cons:

- Existing code is emotionally tempting but architecturally wrong in important places.
- Arbitrary configurable remote URLs and Tauri capability model need careful design.
- Android/Tauri custom bridge code is brittle and generated-project-heavy.

If kept, recommended approach:

- Keep Tauri as runtime only.
- Recreate/refactor `src-tauri` around local bundled app shell.
- Do not load remote UI into a privileged WebView.
- Treat current native bridge code as reference snippets, not source of truth.

### Replace Tauri

Pros:

- Could use platform-native clients with clearer separation.
- Android could be a real Kotlin app; Windows could be .NET/WinUI/WebView2 with explicit local assets.

Cons:

- Much larger rewrite.
- Two app stacks instead of one shared native packaging story.
- Higher maintenance for a small selfhosted app.

Inventory recommendation:

- Keep Tauri for now, but invert the architecture: local bundled UI + remote API.
- Delete/rebuild the remote-wrapper assumptions instead of trying to patch them.

## Suggested cleanup categories

### Keep as active plan/docs

- `docs/native-apps-clean-architecture.md`
- This inventory file.

### Freeze as legacy reference

- `docs/tauri-windows-poc.md`
- Existing Tauri/native changelogs.
- Current `src-tauri` implementation details.

### Likely rewrite

- `src-tauri/desktop-shell/index.html`
- `src-tauri/capabilities/*.json`
- `web/static/js/core/config.js` runtime API/WS config.
- `web/static/js/features/desktop-integration.js` native bridge surface.
- `scripts/test_frontend_native_offline.mjs` to test true local-shell native mode.
- Native release path in `release.sh`.

### Likely preserve/refactor

- App download UI concept.
- Android icon/assets/signing knowledge.
- Reminder scheduling concepts.
- Browser/PWA Service Worker behavior for browser mode.

## First implementation changes on this branch

Implemented after this inventory:

- Added `GET /api/instance` with stable public instance id and low-information metadata.
- Added migration 020 for public instance metadata defaults.
- Added native built-in CORS allowance for Tauri local asset origin (`http://tauri.localhost` / `https://tauri.localhost`).
- Allowed native Tauri-origin bearer requests to bypass cookie CSRF, because native uses Authorization headers rather than same-site browser cookies.
- Added runtime config initialization before `app.js` import.
- Switched Tauri build output from old remote `desktop-shell` redirect to bundled `../web` assets.
- Added local native first-run server setup form in the bundled Web UI.
- Removed Tobi-specific remote host allowlists from Tauri capabilities.
- Replaced `csp: null` with an explicit Tauri CSP that permits configurable HTTP(S)/WS(S) API connections.

## Recommended next discussion decisions

1. Do we keep Tauri as runtime? Recommendation: yes, but only as local-shell runtime.
2. Do we remove current remote-wrapper code before building? Recommendation: yes, with small commits and docs updated.
3. Do we implement `/api/instance` before native refactor? Recommendation: yes, it gives a clean contract early.
4. Do we defer signed UI bundle updates? Recommendation: yes. First release should bundle UI in installer/APK.
5. Do we make native auth token storage secure in v1? Recommendation: yes where practical; at minimum no worse than current browser storage, but design for secure storage.
