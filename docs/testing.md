# Test Docs

## Getting Started

- `./scripts/test_all.sh`
- `npm test`

## Backend

`python3 scripts/test_backend.py`

Covers:
- Setup
- Auth
- Admin
- API keys
- Projects
- Sections
- Todos
- Push
- Reminders
- Project sharing and multi-user isolation
- Security regressions for CSRF/API key, IDOR, and date/time validation
- **Email/SMTP integration (neutral responses, verified email lookups)**
- **2FA service/security regressions for TOTP, recovery code consumption, challenge lockout, old JWTs after policy activation, WebAuthn RP/origin/HTTPS binding, one-time MFA grants, reauth replay protection, and recovery code cleanup after removing the last primary factor**

## Frontend

### Smoke
- Login
- App start
- Create project
- Search
- Delete + undo

### App
- Create/rename/delete sections
- Todo with section assignment
- Project switch in the todo modal
- Complete todo edit flow
- Validation of invalid deadline/reminder values
- Regression against `temp is not defined`

### Setup
- Initial setup flow

### Admin
- Admin login
- User management
- **Enable/disable global 2FA requirement + status display in the user list**
- **SMTP configuration + test mail**

### Settings
- Open settings
- Create/revoke API key
- Push status/test/disable
- Change password
- **Email verification**
- **2FA settings UI: status, TOTP setup with QR code, recovery code display, passkey/TOTP device lists, disable/revoke/regenerate, and security dialogs without browser popups**

### Projects
- Create project
- Create subproject
- Edit/delete project

### Drag & Drop
- Move todo between sections
- Unsorted
- Basic section reorder

### Sharing
- Invite/accept/reject project
- Member list and undo actions
- Shared project readonly UI
- Owner/member visibility
- **Email invite (neutral response, no pending members visible)**

### Security
- Markdown XSS regression
- Service worker does not cache `/api/*` responses
- Offline sync queue only allows permitted fields
- **Email enumeration protection (neutral responses for password reset/invite)**
- **2FA/MFA regressions: native passkey deferral, recovery code fallback labels, security dialogs instead of `alert/prompt/confirm`, one-time grant consumption, and sensitive actions with fresh reauth**

## Release Gate

- `release.sh` calls `./scripts/test_all.sh` first
- on error: abort immediately
- no merge, no tag, no push

Additionally useful for 2FA changes before release/review:
- `python3 scripts/test_two_factor_services.py`
- `node scripts/test_frontend_mfa_login.mjs`
- `node scripts/test_frontend_settings.mjs`
- `node scripts/test_frontend_admin.mjs`
- `node scripts/test_frontend_security.mjs`
- `node scripts/test_frontend_native_passkeys.mjs` for native passkey changes; covers browser, Windows/Tauri invoke, and Android `JavascriptInterface` callback bridge.
- For Android passkey changes, additionally verify that `/.well-known/assetlinks.json` still serves package `de.tobiaskneidl.nia_todo`, the bundled release fingerprint, and `delegate_permission/common.get_login_creds`.

Manual 2FA smoke paths:
- Set up TOTP, scan QR code, complete login with TOTP.
- Add passkey, complete login/reauth via passkey.
- Connect Android app to selfhosted server URL; passkey flow must work with the bundled app, custom/re-sign builds are not a supported test path for 2.0.
- Revoke TOTP/passkey; when removing the last primary factor, recovery codes must disappear and user-side 2FA must be disabled.
- Execute sensitive actions one after another; every action must require fresh MFA reauth.
- Trusted device must be able to skip login MFA, but must not authorize sensitive actions.
- Recovery code and email code must not work again after successful use.

## Email/SMTP Tests

### Service Tests
`python3 scripts/test_email_services.py`

Tests:
- SMTP configuration (get/patch)
- Email sending (send_email)
- Email templates (templates)
- Token hashing/prefix lookup

### Migration Tests
`python3 scripts/test_migration_022_email_duplicates.py`

Tests:
- Case-insensitive email uniqueness
- Duplicates are cleaned up

`python3 scripts/test_migration_email_partial_recovery.py`

Tests:
- Partial schema states are repaired
- Migration is idempotent

## Notes

- Frontend tests run against headless Chromium
- Tests back up/restore the dev DB; always run DB-mutating tests serially, not in parallel
- `web/manifest.json` is maintained by the dev/release flow
