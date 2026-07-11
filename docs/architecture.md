# Architecture

## Stack

- FastAPI
- SQLite
- Vanilla JS Frontend
- Offline-PWA

## Areas

- `api/` -> backend and data access
- `web/` -> UI, Service Worker, manifest
- `scripts/` -> tests and helpers
- `systemd/` -> services for live/dev

## Data Model

- Each user has their own inbox (`projects.is_inbox = 1`), regardless of the project name
- Project names are unique per user, not globally
- Shared projects are managed via `project_members` (`pending`, `accepted`, `removed`, `left`, `declined`)

## Sync

- local changes go into a sync queue
- WebSocket/sync keeps local data and server state in sync
- server refresh writes the authoritative state directly into IndexedDB so reloads after login stay stable

## Native Apps

Native apps are shipped from the same Tauri codebase and share the web UI version with the server release. They are not pure remote WebViews: the app bundles a local UI shell, stores the configured server URL locally, verifies the target server through `/api/instance`, and uses that URL as API/WebSocket base.

Current state:

- Tauri bundles a clean `src-tauri/frontend-dist` generated from `web/`; `web/downloads/` is deliberately excluded from the native bundle.
- Windows, Android, and Debian desktop releases use the same `X.Y.Z` version as web/server and are built by `release.sh`.
- Debian desktop is distributed as a Debian package named `nia-todo-desktop`, with artifacts named `nia-todo-desktop-vX.Y.Z-debian-amd64.deb`, so it does not conflict with the server package `nia-todo`.
- Native local reminders are implemented: Windows uses the local scheduler/tray path, Android uses `AlarmManager` and rehydrates reminders after reboot/app restart.
- Offline cold start is supported through the bundled UI shell plus service-worker cache.
- The Debian desktop app uses Linux WebKitGTK/Tauri custom-scheme origins such as `tauri://localhost`; the backend allows those origins for native runtime requests after instance verification.
- The Debian desktop app clears volatile WebView cache directories when the app version or executable path changes so stale bundled frontend assets do not survive desktop app updates.
- Debian desktop notifications prefer `notify-send` when available, falling back to the Tauri notification API.
- Debian desktop hotkeys use the XDG Desktop Portal GlobalShortcuts API when the desktop backend supports it, applying activation tokens/timestamps on the GTK main thread for clean focus transfer. Desktops without that portal, including some GNOME 46 stacks, fall back to the legacy Tauri global-shortcut path.
- Native passkeys are supported: Windows uses the native WebAuthn bridge; Android uses AndroidX Credential Manager and the bundled app ID/signing-key binding exposed through `/.well-known/assetlinks.json`. Debian desktop passkeys are intentionally deferred.
- Browser/PWA push remains browser/PWA-only; native reminders must not depend on browser push.

Operational constraints:

- Android is pinned to app ID `de.tobiaskneidl.nia_todo` and the permanent release key. Re-sign/custom package builds need an explicit migration strategy before they can be passkey-compatible.
- Native app compatibility is controlled by `min_native_client_version` from `/api/instance`; normal releases do not raise it unless `release.sh --set-min-app-version` is used.

## Auth

- JWT / Session-Token
- User sessions last 30 days and are rolling-extended via `/api/me` when they are about to expire
- Admin sessions are shorter-lived and versioned separately
- CSRF-Schutz für Browser-Sessions
- API keys for external use only via `Authorization: ApiKey ...`
- Users see their own data plus accepted shared projects
- shared project access is checked in projects, todos, sections, reminders, and WebSocket payloads
- **Email verification**: login, password reset, and project sharing require verified emails
- **OIDC/SSO**: users and admins can sign in through a configured OIDC provider. Admin configuration stores issuer/client/scopes and write-only client secret data; account links live as OIDC identities and native apps complete sign-in through a short-lived native exchange handoff.
- **Neutral API responses** for email-based actions prevent user enumeration
- **Pending invites** are visible only to the invitee for privacy reasons (not to owners/members)
- **2FA/MFA** is integrated into the normal password login: if an account requires 2FA and no valid trusted-device cookie exists, `/api/login` returns a challenge instead of an access token. After a successful login challenge, a JWT with `mfa_login_at` is issued; sensitive actions use separate one-time MFA action grants.
- **2FA methods**: TOTP and passkeys are the primary self-managed factors. Recovery codes are stored hashed/table-backed, single-use, and only backup factors to TOTP/passkey; when the last primary factor is removed, they are automatically revoked and cannot be regenerated without an active primary factor. Email code is a valid fallback factor when no stronger factor is present, a verified email exists, and sending succeeded. Passkeys use WebAuthn challenge/verify endpoints with ES256/P-256 assertions, user-verification required, explicit HTTPS `public_base_url` RP/origin binding (`http` only locally), `none` attestation parsing, signature verification, and sign-counter rollback checks; credentials live revocably in `passkeys`/`passkey_challenges`. Native passkeys run on Windows through the native WebAuthn bridge and on Android through AndroidX Credential Manager; Android is deliberately pinned to the bundled app ID `de.tobiaskneidl.nia_todo` and the release key via Digital Asset Links. Debian desktop passkeys are intentionally deferred until a dedicated Linux credential-manager integration exists.
- **Device sessions and trusted devices**: interactive JWTs can be backed by `user_sessions` so individual signed-in devices can be revoked without invalidating the whole account. Trusted 2FA-remember devices are stored separately as an HttpOnly cookie plus hashed server token, expire after 30 days, and are invalidated via `two_factor_remember_version` on reset/disable. A device revoke ends the corresponding JWT session; if it was also a trusted 2FA device, the trusted-device record is revoked too. Trusted devices allow app login without repeat MFA, but do not count for sensitive actions: password changes or API key management must still trigger a real one-time MFA reauth.
- **Security-sensitive actions** use one-time MFA action grants; for 2FA-required accounts, each sensitive action must consume exactly one fresh grant. Old JWTs without login MFA assurance are rejected for normal API auth after 2FA activation/policy. Reauth is replay-hardened: action grants are consumed atomically, reauth buckets are closed after success, email codes are deleted, and TOTP reauth timesteps are accepted only once. The non-sensitive 2FA status remains readable for valid interactive JWTs so clients can choose the correct reauth factor.
- **Audit events** document 2FA policy changes, enrollment, recovery code generation/use, challenge success/failure, email code sending for login/reauth, passkey changes, trusted-device creation/revocation, and admin reset. Challenge and reauth verification are limited by attempt counters, including email/passkey reauth challenges; challenge consumption happens via `consumed_at IS NULL` updates against replay/races. API keys are deliberately excluded from interactive MFA as machine tokens and remain revocable; the settings UI reauthenticates API key management when needed, and the admin UI shows the active API key count as a hint but does not automatically revoke existing keys.

## User Onboarding

- Email addresses are required for new users, are validated, and are kept unique
- Existing users without an email remain migratable; admin or user can add the address later
- Admins do not set user passwords directly
- New users receive a one-time password setup link (`password_setup_tokens`)
- Password setup/reset links are valid for 24 hours and are stored hashed
- Users can change their own email and display name in the settings modal; the username remains immutable
- Avatar images live as WebP files under `api/data/avatars/`; the database stores only the URL and modification timestamp
- Avatar uploads accept JPEG/PNG/WebP/GIF as well as HEIC/HEIF; HEIC is processed server-side via `pillow-heif` or `heif-convert` when the browser does not support preview/cropping
- Production now runs on a separate LXC; this dev checkout does not contain or manage live data/backups.


## Location Reminders

- Saved places are user-scoped records under `/api/places` with name, address, and icon.
- Todos can carry location reminder metadata for Android-native arrival/departure triggers.
- Address data is stored server-side for the owning user and synchronized to linked location reminders when a saved place address changes.
- Android handles local geofence-style reminder behavior; browser/PWA push remains separate.
