# Native Apps: Clean Architecture Plan

Status: implementation started for 2.0 native-app rebuild after Generic Server Config.
Base: `develop@d4289b4`.

Related: [Phase 0 Inventory](native-apps-phase0-inventory.md)

## Context

The previous Tauri direction is treated as legacy implementation context only. This rebuild must not merge or copy Tauri changes from discarded branches. Any existing native files on `develop` must be re-evaluated against this plan before reuse.

## Goals

- Real native/offline-robust Windows and Android apps.
- Offline cold start works without server/network reachability.
- Server URL is user-configurable and never hardcoded.
- Remote API is used for sync and authoritative server state.
- UI is available locally at startup, either bundled in the app or later updated through a safe signed update mechanism.
- The app can verify a configured server before login.
- Manual Windows and Android testing is mandatory before merge.
- Two separate security/architecture reviews are mandatory before merge.

## Non-goals

- No reuse of abandoned-branch Tauri changes.
- No native app that is only a remote website wrapper.
- No server-specific URL baked into binaries.
- No merge based only on automated browser tests.

## Target architecture

### 1. Local app shell

The native app starts from local bundled UI assets, not from the remote server page.

Required properties:

- App can launch with airplane mode / disconnected network.
- Login/server setup/offline state can render without API access.
- Existing offline data can be displayed from local storage.
- No blank WebView if DNS, TLS, VPN, proxy, or server startup fails.

Recommended baseline:

- Bundle `web/` assets into the native app package.
- Build the frontend so API calls target a configured `apiBaseUrl`, not `location.origin`.
- Keep Service Worker/PWA behavior for browser use, but native cold start must not depend on fetching the shell from the server.

Current branch status:

- Tauri `frontendDist` now points at bundled `../web` instead of the old `desktop-shell` remote redirect shell.
- `web/static/js/core/config.js` initializes runtime mode before loading `app.js`.
- Browser mode keeps same-origin API/WS behavior.
- Native mode reads the locally stored Tauri server URL and derives remote API/WS URLs from it.
- If no native server URL exists, the local bundled UI shows a server setup form without loading the remote app.
- Runtime mode, platform and feature switches are centralized in `web/static/js/core/config.js` via `RUNTIME_CAPABILITIES`.
- Native-only UI/features stay in the shared Web-App bundle, but are activated through capability checks instead of scattered Tauri/platform checks.

Future option:

- Signed local UI bundle updates, separate from full native installer/APK updates.
- Only after the bundled-shell baseline is stable.

### 2. Remote API boundary

The native app talks to a configured nia-todo server API.

Rules:

- API base URL is stored locally per app install/user profile.
- URL normalization accepts only `http`/`https`.
- No credentials in URLs.
- API client must not infer server URL from WebView origin.
- CORS/browser-origin assumptions must not be the security boundary for native clients.

### 3. Server verification endpoint

Add later: `GET /api/instance`.

Purpose:

- Verify that a configured URL is a compatible nia-todo server.
- Show clear setup errors before login.
- Support future client/server compatibility checks.

Proposed response shape:

```json
{
  "app": "nia-todo",
  "instance_id": "stable-random-public-id",
  "display_name": "Nia Todo",
  "public_base_url": "https://todo.example.test",
  "api_version": 1,
  "server_version": "1.7.0",
  "min_native_client_version": "1.7.0",
  "capabilities": ["offline-sync", "reminders", "shared-projects"]
}
```

Security notes:

- Do not expose secrets, internal paths, trusted proxies, DB status, usernames, or admin config.
- `instance_id` should be public but non-sensitive and generated once.
- Endpoint should be unauthenticated but rate-limit friendly and intentionally low-information.

### 4. Local storage and offline model

Native app local state:

- Server URL and instance metadata.
- Auth/session token using platform-appropriate secure storage where practical.
- IndexedDB/app DB cache for todos/projects/settings needed offline.
- Sync queue for offline mutations.
- Local reminder schedule state.

Offline behavior:

- Cold start loads local shell and local cache.
- User sees explicit offline banner/state.
- Mutations queue locally and sync later.
- Logout/server switch requires careful local data isolation/cleanup.

### 5. Native capabilities

Keep native layer small and explicit.

Windows:

- Local notifications.
- Local reminder scheduling while app/background agent is available.
- Optional tray/autostart/hotkeys only after core cold-start + sync architecture is stable.

Android:

- Local notifications.
- `AlarmManager`-based reminders.
- Re-register reminders after reboot.
- Runtime notification permission.
- Offline completion action only if it writes safely to local queue and cannot cross user/server context.

### 6. Web/PWA compatibility

Browser/PWA remains first-class.

- Browser continues to use same-origin server-hosted UI and API.
- Native uses local UI + remote API.
- Shared frontend modules must support both modes explicitly.
- No native-only assumptions may break normal browser/PWA behavior.

### 7. Shared Web-App capability model

The native apps and browser/PWA intentionally use one Web-App codebase. The boundary is capability-based:

- Shared by all runtimes: Todos, projects, login, offline sync, WebSocket sync, normal settings.
- Browser/PWA only: Web Push settings and browser app download prompts.
- Native only: server selection, local app version, native update prompt, native notifications/reminders.
- Desktop native only: tray/autostart/global hotkeys.
- Android native only: Android native notification/reminder bridge.

Rules:

- New runtime checks should use `RUNTIME_CAPABILITIES` from `core/config.js`.
- Avoid new scattered `window.__TAURI__`, `nativeApp=tauri`, user-agent or platform checks outside the runtime adapter/config layer.
- Platform-specific native bridge calls must be isolated behind feature modules, not embedded in general Todo/UI logic.
- Current adapter boundary: `web/static/js/features/native-bridge.js` wraps Tauri invoke, Android `JavascriptInterface`, native notifications/reminders, notification action handoff, app version lookup and hotkey event listening.
- Native reminder action rule: platform code may persist/forward an action payload, but Todo state changes stay in the authenticated Web-App layer so current-user checks, offline queue semantics and API sync remain centralized.

## Proposed implementation phases

### Phase 0: Inventory and cleanup decision

- Inventory current `src-tauri`, native docs, release scripts, tests, and frontend integration.
- Mark what is legacy, what can remain as reference, and what must be removed/rebuilt.
- Decide whether to keep Tauri as runtime or switch runtime before coding.

Exit criteria:

- Written decision record.
- No ambiguous old-native behavior documented as current truth.

### Phase 1: Native app shell abstraction

- Introduce frontend runtime config abstraction:
  - `mode: browser | native`
  - `apiBaseUrl`
  - `instance metadata`
- Refactor API calls away from implicit `location.origin` where needed.
- Native startup screen can configure server URL before login.

Exit criteria:

- Browser tests still pass.
- Native-mode browser simulation can boot local shell and point to configurable API base.

### Phase 2: `/api/instance`

Implemented on this branch:

- DB-backed public `instance_id` and display name defaults via migration 020.
- Unauthenticated `GET /api/instance`.
- Response intentionally excludes admin config, trusted proxies, allowed origins, secrets, DB paths and user data.
- Native first-run server setup verifies the URL through `/api/instance` before saving it.

Exit criteria:

- Invalid URL, wrong app and unreachable server show clear setup states.
- Compatibility/version gating exists at metadata level; strict blocking policy can be tightened later.

### Phase 3: Offline cold-start hardening

- Ensure local shell startup without network.
- Ensure cached user data renders offline after at least one successful sync.
- Ensure login/setup screen renders offline before first server connection.
- Add automated regression where possible.

Exit criteria:

- Automated cold-start simulation passes.
- Manual Android offline cold-start passes.
- Manual Windows offline cold-start passes.

### Phase 4: Native reminders and notifications

- Rebuild native reminder bridge cleanly.
- Validate user/server isolation in queued reminder actions.
- Keep browser push separate from native local reminders.

Exit criteria:

- Windows manual reminder test passes.
- Android manual reminder + reboot reschedule test passes.

### Phase 5: Packaging and release flow

- Rebuild Windows installer and Android APK pipeline only after core architecture is stable.
- Downloads metadata remains browser-only.
- Release script must fail if native artifacts are expected but missing/unverified.

Exit criteria:

- Installer/APK generated from clean branch.
- Manual install/update tests documented.

## Mandatory manual test matrix

### Windows

- Fresh install opens local setup screen with network disabled.
- Configure server URL and verify `/api/instance`.
- Login and sync data.
- Fully close app, disable network, cold start again.
- Create/edit/complete todo offline, reconnect, verify sync.
- Local reminder fires at expected time.
- Server URL change/reset does not leak previous user data into another server context.

### Android

- Fresh install opens local setup screen with airplane mode enabled.
- Configure server URL and verify `/api/instance`.
- Login and sync data.
- Force close app, enable airplane mode, cold start again.
- Create/edit/complete todo offline, reconnect, verify sync.
- Local reminder fires.
- Reboot device/emulator and verify scheduled reminders are restored.
- Notification permission denied/granted paths behave clearly.
- Server URL change/reset does not leak previous user data into another server context.

## Required pre-merge reviews

Two separate reviews are required after implementation and before merge:

1. Security review
   - Server URL validation and SSRF-like risks.
   - Token/session storage.
   - Cross-instance/user data isolation.
   - `/api/instance` information exposure.
   - Native bridge command surface and permissions.
   - Offline queue tampering/replay assumptions.

2. Architecture review
   - Native/browser mode separation.
   - Offline cold-start guarantees.
   - Sync queue correctness.
   - Packaging/update strategy.
   - Release/test gates.
   - Maintainability of shared frontend code.

Both reviews must be documented with findings, fixes, and explicit sign-off before merge.

## Open decisions

- Keep Tauri as the native runtime, or replace it?
- If Tauri remains, do we delete/recreate `src-tauri` or refactor in place from a known-clean baseline?
- Which secure storage mechanism is acceptable for Windows and Android?
- Should signed UI bundle updates be part of v1, or explicitly deferred?
- How strict should native/server version compatibility be for the first release?
