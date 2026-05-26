# API Documentation

## Authentication

> All endpoints except `/api/login` and `/api/setup/**` require auth.

### Login
`POST /api/login`

**Body**
```json
{
  "username": "demo",
  "password": "***"
}
```

**Response**
```json
{
  "access_token": "eyJhbGciOi...",
  "token_type": "bearer",
  "user": {
    "id": 1,
    "username": "demo",
    "display_name": "Max Mustermann",
    "email": "user@example.com",
    "avatar_url": "/api/avatars/user-1.webp",
    "is_admin": true
  }
}
```

### Login with 2FA Challenge

If 2FA is active for the user or globally enforced, `POST /api/login` can return a challenge instead of a token. A verified email with working SMTP counts as an email-code factor:

```json
{
  "mfa_required": true,
  "challenge": {
    "challenge_token": "...",
    "methods": ["totp", "recovery_code"]
  },
  "state": {
    "enabled": true,
    "has_totp": true,
    "has_passkey": false,
    "recovery_codes_remaining": 8
  }
}
```

Completion:

`POST /api/2fa/challenge/verify`

```json
{
  "challenge_token": "...",
  "method": "totp",
  "code": "123456",
  "remember_device": true
}
```

The response matches the normal login (`access_token`, `csrf_token`, `user`). The login challenge is consumed atomically and only creates login MFA assurance; sensitive actions such as password changes/API key management still require a fresh one-time MFA reauth. With `remember_device=true`, an HttpOnly trusted-device cookie is also set; it replaces later login MFA, but likewise does not count for sensitive actions.

`POST /api/2fa/passkey/options` and `POST /api/2fa/passkey/verify` complete the same login challenge via passkey. Passkey login requires user verification and also consumes the challenge exactly once.

### Logout
`POST /api/logout`

**Response**
```json
{ "ok": true }
```

### Current User
`GET /api/me`

**Response**
```json
{
  "id": 1,
  "username": "demo",
  "display_name": "Max Mustermann",
  "email": "user@example.com",
  "avatar_url": "/api/avatars/user-1.webp",
  "avatar_updated_at": "2026-05-21T00:00:00+00:00",
  "is_admin": true
}
```

### Change Own Profile
`PATCH /api/me/profile`

**Body**
```json
{ "display_name": "Max Mustermann" }
```

**Response**
```json
{
  "id": 1,
  "username": "demo",
  "display_name": "Max Mustermann",
  "email": "user@example.com",
  "avatar_url": "/api/avatars/user-1.webp",
  "avatar_updated_at": "2026-05-21T00:00:00+00:00",
  "is_admin": true
}
```

### Upload Own Avatar
`PUT /api/me/avatar`

**Request**
- Body: raw image data
- `Content-Type`: `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/heic` or `image/heif`
- Maximum size: 5 MiB

**Storage**
- File: `api/data/avatars/user-{id}.webp`
- DB: only `avatar_url` and `avatar_updated_at`

**Response**
```json
{
  "avatar_url": "/api/avatars/user-1.webp",
  "avatar_updated_at": "2026-05-21T00:00:00+00:00"
}
```

### Change Own Email
`PATCH /api/me/email`

**Body**
```json
{ "email": "neue@example.com" }
```

**Validation**
- Required field
- Must be a valid email address
- Must be unique (case-insensitive)

**Response (with SMTP configured)**
```json
{
  "email": "alte@example.com",
  "pending_email": "neue@example.com",
  "email_verified_at": "2026-05-20T00:00:00+00:00",
  "email_verification_sent": true
}
```

**Response (without SMTP)**
```json
{
  "email": "neue@example.com",
  "email_verified_at": null,
  "email_trust_source": "unverified_no_smtp"
}
```

**Note:** With SMTP, the new email is stored as `pending_email` and a verification email is sent. The old email remains active until verification. Without SMTP, the email is active immediately, but not verified (cannot be used for login/sharing).

### Change Own Password
`POST /api/me/change-password`

**Body**
```json
{ "old_password": "alt123!", "new_password": "neu123!" }
```

**Response**
```json
{ "ok": true }
```

## Two-Factor Authentication

### 2FA Status
`GET /api/me/2fa`

Returns enabled/available factors, recovery-code count, global requirement, and passkey count. The status contains no secrets and remains readable with a valid interactive JWT even when no fresh action reauth is present, so clients can start the appropriate reauth flow.

### Start/Confirm TOTP
`POST /api/me/2fa/totp/start` returns secret and `otpauth_url`.

`POST /api/me/2fa/totp/confirm`
```json
{ "secret": "BASE32...", "code": "123456", "password": "..." }
```

Activates TOTP after password confirmation and returns new recovery codes exactly once, plus a fresh MFA JWT. The endpoint may also be used with an enrollment-only JWT; in this state, no additional MFA reauth is possible or required. Recovery codes are backup factors for TOTP/passkey, not the primary 2FA state.

### Disable 2FA / Revoke Factors / Regenerate Recovery Codes
- `POST /api/me/2fa/disable` — requires a fresh one-time MFA reauth, revokes trusted devices, passkeys, and recovery codes.
- `DELETE /api/me/2fa/totp` — revokes the configured TOTP secret, requires a fresh one-time MFA reauth. If no primary factor (TOTP/passkey) remains afterwards, recovery codes are automatically revoked and user-side 2FA is disabled; with a global policy, email-code MFA can still apply as a fallback.
- `POST /api/me/2fa/recovery-codes/regenerate` — requires a fresh one-time MFA reauth and at least one primary factor (TOTP or passkey), returns new codes exactly once.
- `POST /api/me/2fa/reauth` — verifies TOTP, recovery code, or email code with attempt lockout and issues a JWT with a single-use MFA action grant. Reauth buckets are consumed after success; email reauth codes are invalidated and TOTP reauth timesteps are accepted only once.
- `POST /api/me/2fa/reauth/email/start` — sends an email reauth code if email code is the available factor.
- `POST /api/me/2fa/reauth/passkey/options` and `POST /api/me/2fa/reauth/passkey/verify` — passkey reauth for passkey-only users.

### Active Device Sessions / Trusted Devices
- `GET /api/me/2fa/trusted-devices` — lists active signed-in device sessions for the current user, not only trusted 2FA devices. Sessions can optionally be linked to a trusted 2FA-remember device and include metadata such as user agent, last use, expiry, and whether it is the current session.
- `DELETE /api/me/2fa/trusted-devices/{id}` — revokes one device session using a normal interactive JWT plus CSRF protection; no fresh MFA action grant is required because this only reduces account access. If the session was linked to a trusted 2FA device, that trusted-device token is revoked too. Revoking the current session signs out the current browser/app.
- `DELETE /api/me/2fa/trusted-devices` — revokes all active user sessions and all trusted 2FA devices for the current user, then signs out the current browser/app.

### Passkeys
- `GET /api/me/passkeys` — list own passkeys.
- `POST /api/me/passkeys/options` — prepare registration options/challenge; allowed with enrollment-only JWT or fresh MFA reauth.
- `POST /api/me/passkeys/verify` — complete WebAuthn registration with password confirmation; allowed with enrollment-only JWT or single-use MFA action grant and returns a fresh MFA JWT.
- `POST /api/2fa/passkey/options` and `POST /api/2fa/passkey/verify` — complete login challenge via passkey.
- `DELETE /api/me/passkeys/{id}` — revoke passkey, requires a fresh one-time MFA reauth. If no primary factor (TOTP/passkey) remains afterwards, recovery codes are automatically revoked and user-side 2FA is disabled; with a global policy, email-code MFA can still apply as a fallback.

Passkeys are bound to the configured public base URL (`public_base_url`). HTTPS is mandatory for non-localhost hosts; without `public_base_url`, production passkey flows for non-localhost hosts fail closed. Windows Native uses a native WebAuthn bridge with server-provided origin; for this, the server URL configured in the app must match the `public_base_url` origin/RP ID.

Android Native uses AndroidX Credential Manager. Each self-hosted server instance serves `/.well-known/assetlinks.json` for the bundled Android app:

- Package: bundled release app ID
- Release certificate: bundled release certificate fingerprint
- Relation: `delegate_permission/common.get_login_creds`

In addition to the HTTPS web origin, the server accepts the pinned Android app origin `android:apk-key-hash:...`, while the RP ID hash continues to be checked against `public_base_url`. Self-hosters run their own server and connect the bundled Android app to their server URL. Custom package names, F-Droid/re-sign builds, and signing-key rotation are not part of the current 2.0 model and will later need an explicit config/migration strategy.

### Admin Policy
- `GET /api/admin/2fa-policy`
- `PATCH /api/admin/2fa-policy` with `{ "required": true }`
- `GET /api/admin/users` additionally includes 2FA/passkey/trusted-device/API-key status fields.
- `POST /api/admin/users/{user_id}/2fa/reset` — resets a user's factors, recovery codes, passkeys, and trusted devices, increments `token_version`, and thereby invalidates existing interactive JWT sessions. Open WebSocket connections of the user additionally receive `{"type":"session_invalidated","reason":"two_factor_reset"}` and are then closed server-side.

Security-sensitive account actions require a fresh, single-use MFA action grant for 2FA-required accounts. Login MFA and trusted devices count only for app access, not for sensitive actions. Initial TOTP/passkey setup is the exception: with an enrollment-only JWT, password confirmation is sufficient because no second factor exists yet. Reauth codes are hardened against replay: email reauth codes are deleted after success, TOTP reauth can issue only one grant per timestep, recovery codes are table-backed and consumed single-use. API keys (`ApiKey nt_...`) are intentionally exempt from interactive MFA during use as machine tokens. Creating and revoking own API keys always requires a new reauth for MFA-required accounts; the settings UI starts a reauth flow when needed. Existing API keys are not automatically revoked when MFA is enabled; the admin UI shows active keys as a warning. An enrollment-only token is issued only when global 2FA is enforced and no usable factor is available at all. Email-code fallback is a transitional/login fallback, not a user-configured primary factor.

## Email / SMTP

### Verify Own Email
`POST /api/me/email/verify`

**Body**
```json
{ "token": "abc123..." }
```

**Response**
```json
{
  "email": "neue@example.com",
  "email_verified_at": "2026-05-23T00:00:00+00:00",
  "ok": true
}
```

**Note:** One-time token from the verification email. After successful verification, `pending_email` becomes `email` and `email_verified_at` is set.

### Request Password Reset (public)
`POST /api/password-setup/request`

**Body**
```json
{ "identifier": "user@example.com" }
```

**Response (always neutral)**
```json
{
  "message": "Falls ein passendes Konto existiert, wurde eine E-Mail gesendet."
}
```

**Note:** For security reasons, a neutral response is always returned (no enumeration). Reset emails are sent only to verified emails.

### Fetch Password Setup Features (public)
`GET /api/password-setup/features`

**Response**
```json
{
  "email_configured": true,
  "password_reset_available": true
}
```

### Validate Password Setup Link (public)
`GET /api/password-setup/validate?token=...`

**Response (valid)**
```json
{
  "valid": true,
  "username": "demo",
  "display_name": "Max Mustermann",
  "purpose": "reset",
  "expires_at": "2026-05-24 12:00:00"
}
```

### Resend Expired Password Setup Link (public)
`POST /api/password-setup/resend`

**Body**
```json
{ "token": "..." }
```

**Response**
```json
{
  "message": "Neuer Link wurde per E-Mail gesendet.",
  "password_setup_delivery": "email",
  "password_setup_expires_hours": 24
}
```

### Request Password Setup Link (Admin)
`POST /api/admin/users/{user_id}/password-link`

**Response (with SMTP + verified email)**
```json
{
  "email_sent": true,
  "message": "Passwort-Setup-Link wurde per E-Mail gesendet."
}
```

**Response (without SMTP or unverified email)**
```json
{
  "email_sent": false,
  "password_setup_url": "https://todo.example.com/set-password?token=..."
}
```

**Note:** Admins can generate password setup links for users. With SMTP + verified email, the link is sent by email; otherwise it is returned as a manual link.


### Fetch Instance Configuration
`GET /api/admin/instance-config`

**Response**
```json
{
  "public_base_url": "https://todo.example.com",
  "allowed_origins": ["https://todo.example.com"],
  "trusted_proxies": ["192.0.2.10"]
}
```

### Update Instance Configuration
`PATCH /api/admin/instance-config`

**Body**
```json
{
  "public_base_url": "https://todo.example.com",
  "allowed_origins": ["https://todo.example.com"],
  "trusted_proxies": ["192.0.2.10"]
}
```

**Note:** `public_base_url` is used among other things for password/invitation links and production passkey origin/RP ID validation. CORS accepts only configured origins; forwarded headers are evaluated only from trusted proxies.

## Admin: Email Configuration

### Fetch SMTP Configuration
`GET /api/admin/email-config`

**Response**
```json
{
  "smtp_enabled": true,
  "smtp_host": "smtp.example.com",
  "smtp_port": 587,
  "smtp_security": "starttls",
  "smtp_auth_enabled": true,
  "smtp_username": "nia@example.com",
  "smtp_password_configured": true,
  "mail_from_address": "nia@example.com",
  "mail_from_name": "nia-todo",
  "mail_reply_to": null
}
```

**Note:** `smtp_password_configured` is a boolean field; the actual password is never returned.

### Update SMTP Configuration
`PATCH /api/admin/email-config`

**Body**
```json
{
  "smtp_enabled": true,
  "smtp_host": "smtp.example.com",
  "smtp_port": 587,
  "smtp_security": "starttls",
  "smtp_auth_enabled": true,
  "smtp_username": "nia@example.com",
  "smtp_password": "***",
  "mail_from_address": "nia@example.com",
  "mail_from_name": "nia-todo"
}
```

**Response**
```json
{ "ok": true }
```

### Send Test Email
`POST /api/admin/email-config/test`

**Body**
```json
{ "to": "user@example.com" }
```

**Response**
```json
{
  "ok": true,
  "message": "Test-Mail erfolgreich gesendet."
}
```

**Error (SMTP not configured)**
```json
{
  "ok": false,
  "error": "SMTP ist nicht konfiguriert."
}
```

## Project Sharing

### Share Project
`POST /api/projects/{project_id}/share`

**Body**
```json
{ "username": "user@example.com" }
```

**Response (username invite)**
```json
{
  "member": {
    "id": 42,
    "user_id": 5,
    "username": "alice",
    "display_name": "Alice Example",
    "status": "pending"
  },
  "notification_delivery": "in_app"
}
```

**Response (email invite — neutral)**
```json
{
  "notification_delivery": "email"
}
```

**Note:** For email identifiers (contains `@`), no member info is returned for security reasons (no enumeration). The invited user receives an email with a link.

### List Members
`GET /api/projects/{project_id}/members`

**Response**
```json
{
  "members": [
    {
      "id": 1,
      "user_id": 1,
      "username": "demo",
      "display_name": "Max Mustermann",
      "status": "accepted"
    }
  ]
}
```

**Note:** Shows only `accepted` members. Pending invites are not visible for privacy reasons (not even to owners).

### Accept/Decline Invitation
`POST /api/projects/{project_id}/invites/{invite_id}`

**Body**
```json
{ "accept": true }
```

**Response**
```json
{ "ok": true }
```

### Fetch Pending Invitations
`GET /api/projects/invites`

**Response**
```json
{
  "invites": [
    {
      "id": 42,
      "project_id": 5,
      "project_name": "Einkaufsliste",
      "invited_by_username": "demo",
      "status": "pending"
    }
  ]
}
```

## Admin: Users

### Set Admin Password
`POST /api/setup/admin`

**Body**
```json
{ "admin_password": "***" }
```

**Response**
```json
{ "ok": true }
```

### Create First User
`POST /api/setup/first-user`

**Body**
```json
{
  "username": "demo",
  "email": "user@example.com",
  "password": "***",
  "display_name": "Max Mustermann"
}
```

**Response**
```json
{ "ok": true }
```

### Setup Status
`GET /api/setup/status`

**Response**
```json
{
  "admin_password_set": true,
  "first_user_created": true,
  "needs_setup": false
}
```

## Admin

### Admin Login
`POST /api/admin/login`

**Body**
```json
{ "password": "***" }
```

**Response**
```json
{
  "access_token": "eyJhbGciOi...",
  "token_type": "bearer",
  "admin": true,
  "csrf_token": "..."
}
```

### Admin Logout
`POST /api/admin/logout`

Invalidates all admin sessions by increasing the admin token version.

### List Users
`GET /api/admin/users`

**Response**
```json
{
  "users": [
    {
      "id": 1,
      "username": "demo",
      "display_name": "Max Mustermann",
      "email": "user@example.com",
      "is_admin": true
    }
  ]
}
```

### Create User
`POST /api/admin/users`

**Body**
```json
{
  "username": "neu",
  "display_name": "Neuer User",
  "email": "neu@example.com"
}
```

The admin no longer sets a password directly. A one-time password setup link is generated during creation.

**Validation**
- `email` is required
- Must be a valid email address
- Must be unique

**Response**
```json
{
  "id": 2,
  "username": "neu",
  "display_name": "Neuer User",
  "email": "neu@example.com",
  "created_at": "2026-05-20T21:30:00Z",
  "password_setup_url": "https://todo.example.com/set-password?token=...",
  "password_setup_expires_hours": 24
}
```

### Update User
`PATCH /api/admin/users/{id}`

**Body**
```json
{ "email": "neu@example.com" }
```

Optionally, `display_name` can be provided as well.

**Response**
```json
{ "id": 2, "email": "neu@example.com", "display_name": null }
```

### Delete User
`DELETE /api/admin/users/{id}`

**Response**
```json
{ "deleted": true }
```

### Generate Password Setup/Reset Link
`POST /api/admin/users/{id}/change-password`

> Compatibility endpoint: admins no longer set passwords directly. The endpoint generates a one-time link.

**Response**
```json
{
  "password_setup_url": "https://todo.example.com/set-password?token=...",
  "password_setup_expires_hours": 24
}
```

### Generate Password Link
`POST /api/admin/users/{id}/password-link`

**Response**
```json
{
  "password_setup_url": "https://todo.example.com/set-password?token=...",
  "password_setup_expires_hours": 24
}
```

### Set Password via Link
`POST /api/password-setup/complete`

**Body**
```json
{ "token": "...", "password": "NeuesPasswort123!" }
```

**Response**
```json
{ "message": "Passwort gesetzt" }
```

Links are valid for 24 hours and can be used only once.

### Change Admin Password
`POST /api/admin/change-password`

**Body**
```json
{
  "old_password": "alt123!",
  "new_password": "neu123!"
}
```

**Response**
```json
{ "ok": true }
```

## API Keys

### List
`GET /api/me/api-keys`

**Response**
```json
{
  "api_keys": [
    {
      "id": 1,
      "name": "Nia-Integration",
      "key_prefix": "nt_e3b",
      "created_at": "2026-05-16T11:30:00",
      "last_used_at": "2026-05-16T12:00:00",
      "revoked_at": null
    }
  ]
}
```

### Create
`POST /api/me/api-keys`

**Body**
```json
{ "name": "Nia-Integration" }
```

**Response**
```json
{
  "id": 12,
  "name": "Nia-Integration",
  "prefix": "nt_abcd1234",
  "key": "nt_...",
  "created_at": "2026-05-16T11:30:00+00:00"
}
```

The full `key` is shown only once during creation.

### Revoke
`DELETE /api/me/api-keys/{id}`

**Response**
```json
{ "revoked": 12 }
```

### Auth with API Key
```text
Authorization: ApiKey nt_...
```

**Notes**
- API keys are bound to the user
- revoked keys are invalid immediately
- `last_used_at` is maintained
- API keys bypass CSRF only with `Authorization: ApiKey nt_...`; `Bearer nt_...` and `X-API-Key` are not supported as API key auth

## Todos

### List
`GET /api/todos`

**Query**
- `status=pending|in_progress|done`
- `project_id=2`
- `section_id=1`

**Response**
```json
{
  "todos": [
    {
      "id": 1,
      "title": "Nia-Todo aufbauen",
      "description": "",
      "priority": 3,
      "status": "pending",
      "due_date": "2026-05-14T10:00:00+00:00",
      "completed_at": null,
      "project_id": 3,
      "section_id": null,
      "project_name": "Arbeit",
      "section_name": null,
      "created_at": "2026-05-12T21:39:40",
      "updated_at": "2026-05-12T21:39:40",
      "reminders": [],
      "labels": []
    }
  ]
}
```

### Single Todo
`GET /api/todos/{id}`

**Response**
```json
{
  "id": 1,
  "title": "Nia-Todo aufbauen",
  "description": "",
  "priority": 3,
  "status": "pending",
  "project_id": 3,
  "section_id": null,
  "reminders": []
}
```

### Create
`POST /api/todos`

**Body**
```json
{
  "title": "Wäsche waschen",
  "description": "Nicht vergessen",
  "priority": 3,
  "project_id": 2,
  "section_id": 1,
  "due_date": "2026-05-14T10:00:00Z",
  "remind_at": "2026-05-14T09:00:00Z"
}
```

**Fields**
- `title` string, required
- `description` string, optional
- `priority` int, optional, `1..4`
- `project_id` int, optional
- `section_id` int, optional
- `due_date` ISO-8601, optional, valid year `1900..9999`
- `remind_at` ISO-8601, optional, valid year `1900..9999`

**Response**
```json
{
  "id": 17,
  "title": "Wäsche waschen",
  "status": "pending"
}
```

### Update
`PATCH /api/todos/{id}`

**Body**
- same fields as POST, all optional
- `status=done` sets `completed_at`

**Response**
```json
{
  "id": 17,
  "title": "Wäsche waschen",
  "status": "done"
}
```

### Delete
`DELETE /api/todos/{id}`

**Response**
```json
{ "deleted": true }
```

## Workspaces

### List
`GET /api/workspaces`

**Response**
```json
{
  "workspaces": [
    {
      "id": 1,
      "name": "Privat",
      "color": "#10b981",
      "icon": "home",
      "sort_order": 0,
      "is_default": 1
    }
  ]
}
```

**Notes**
- Each user has a default workspace and one inbox per workspace.
- On first fetch, a missing default workspace and missing workspace inbox are automatically repaired/created.

### Create
`POST /api/workspaces`

**Body**
```json
{ "name": "Arbeit", "color": "#6366f1", "icon": "briefcase", "sort_order": 10 }
```

**Response**
```json
{ "id": 2, "name": "Arbeit", "color": "#6366f1", "icon": "briefcase", "is_default": 0 }
```

### Update
`PATCH /api/workspaces/{id}`

**Body**
```json
{ "name": "Arbeit Neu", "color": "#0ea5e9", "icon": "folder", "sort_order": 20 }
```

**Response**
```json
{ "id": 2, "name": "Arbeit Neu", "color": "#0ea5e9", "icon": "folder" }
```

### Delete
`DELETE /api/workspaces/{id}`

**Response**
```json
{
  "deleted": 2,
  "moved_projects_to": 1,
  "moved_projects": []
}
```

**Note:** The default workspace cannot be deleted. When deleting, projects are moved to the default workspace; todos from the workspace inbox end up in the default inbox.

## Projects

### List
`GET /api/projects`

**Response**
```json
{
  "projects": [
    {
      "id": 1,
      "name": "Inbox",
      "color": "#6366f1",
      "parent_id": null,
      "sort_order": 0,
      "is_inbox": 1,
      "is_owner": true,
      "is_shared": false,
      "owner_username": "demo",
      "owner_display_name": "Max Mustermann"
    }
  ]
}
```

**Notes**
- Each user has exactly one inbox (`is_inbox=1`). The name may be changed; `is_inbox` remains the stable identity.
- Inbox projects cannot be deleted.
- Shared projects appear in the normal project list with `is_shared=true` and owner metadata.

### Create
`POST /api/projects`

**Body**
```json
{ "name": "Hobby", "color": "#ec4899", "icon": "folder", "workspace_id": 1, "sort_order": 5 }
```

**Response**
```json
{ "id": 7, "name": "Hobby" }
```

### Update
`PATCH /api/projects/{id}`

**Body**
```json
{ "name": "Hobby Neu", "icon": "folder-open" }
```

`parent_id` can be set to a project ID or removed again with `null`:
```json
{ "parent_id": null }
```

Project owners can move their own non-inbox projects to another of their workspaces:
```json
{ "workspace_id": 2 }
```

When an owner moves a project, descendant projects move with it. For subtree moves the response includes an `updated_projects` array with the caller-specific authoritative project views so offline clients can update all affected local rows.

Shared-project members can also patch `workspace_id`, but only for their own display workspace. Owner moves do not change member display workspaces.

**Response**
```json
{ "id": 7, "name": "Hobby Neu" }
```

Subtree workspace move response:
```json
{
  "id": 7,
  "name": "Hobby Neu",
  "workspace_id": 2,
  "updated_projects": [
    { "id": 7, "name": "Hobby Neu", "workspace_id": 2 },
    { "id": 8, "name": "Child project", "parent_id": 7, "workspace_id": 2 }
  ]
}
```

### Delete
`DELETE /api/projects/{id}`

**Response**
```json
{ "deleted": true }
```

### Delete Completed Todos in Project
`POST /api/projects/{id}/clear-done`

**Response**
```json
{ "deleted_count": 3 }
```

## Project Sharing


### Fetch Shared Projects
`GET /api/projects/shared`

**Response**
```json
{
  "projects": [
    {
      "id": 5,
      "name": "Gemeinsam",
      "member_status": "accepted",
      "member_color": "#f59e0b",
      "owner_username": "demo"
    }
  ]
}
```

### Pending Invitations
`GET /api/projects/invites`

**Response**
```json
{
  "invites": [
    {
      "id": 12,
      "project_id": 5,
      "project_name": "Gemeinsam",
      "project_color": "#6366f1",
      "invited_by_username": "demo",
      "invited_by_display_name": "Max Mustermann",
      "status": "pending"
    }
  ]
}
```

### Share Project
`POST /api/projects/{project_id}/share`

Owner-only.

**Body**
```json
{ "username": "alice" }
```

**Response**
```json
{
  "member": {
    "project_id": 5,
    "user_id": 2,
    "username": "alice",
    "display_name": "Alice Example",
    "status": "pending"
  }
}
```

### Accept/Decline Invitation
`POST /api/projects/{project_id}/invites/{invite_id}`

**Body**
```json
{ "accept": true }
```

**Response**
```json
{ "id": 12, "status": "accepted", "project_id": 5 }
```

### List Members
`GET /api/projects/{project_id}/members`

Owner and accepted members may see the list.

**Response**
```json
{
  "members": [
    {
      "project_id": 5,
      "user_id": 2,
      "username": "alice",
      "display_name": "Alice Example",
      "status": "accepted"
    }
  ]
}
```

### Remove Member
`DELETE /api/projects/{project_id}/members/{member_user_id}`

Owner can remove members; members can remove themselves. Removal is undo-capable and internally sets `status=removed`.

**Response**
```json
{ "removed": 12, "project_id": 5 }
```

### Restore Removed/Left Member
`POST /api/projects/{project_id}/members/{member_user_id}/restore`

**Body**
```json
{ "status": "accepted" }
```

**Response**
```json
{ "member": { "project_id": 5, "user_id": 2, "status": "accepted" } }
```


### Override Member Color
`PATCH /api/projects/{project_id}/members/{member_user_id}/color`

Owner-only. Sets a project-specific color marker for a member.

**Body**
```json
{ "color": "#f59e0b" }
```

**Response**
```json
{ "project_id": 5, "user_id": 2, "color": "#f59e0b" }
```

### Leave Shared Project / Undo
`POST /api/projects/{project_id}/leave`

Owners cannot leave their own projects.

**Response**
```json
{ "left": 12, "project_id": 5 }
```

`POST /api/projects/{project_id}/leave/undo`

**Response**
```json
{ "member": { "project_id": 5, "user_id": 2, "status": "accepted" } }
```

## Sections

### All Sections
`GET /api/sections`

**Response**
```json
{ "sections": [] }
```

### Sections of a Project
`GET /api/sections/by-project/{projectId}`

**Response**
```json
{
  "sections": [
    { "id": 1, "name": "Einkauf", "project_id": 2, "sort_order": 0 }
  ]
}
```

### Create
`POST /api/sections/by-project/{projectId}`

**Body**
```json
{ "name": "Einkauf", "sort_order": 0 }
```

**Response**
```json
{ "id": 9, "name": "Einkauf" }
```

### Update
`PATCH /api/sections/{id}`

**Body**
```json
{ "name": "Einkauf Neu" }
```

**Response**
```json
{ "id": 9, "name": "Einkauf Neu" }
```

### Delete
`DELETE /api/sections/{id}`

**Response**
```json
{ "deleted": true }
```

## Reminders

### List
`GET /api/reminders`

**Response**
```json
{
  "reminders": [
    {
      "id": 1,
      "todo_id": 1,
      "remind_at": "2026-05-14T09:00:00",
      "sent_at": null,
      "title": "Nia-Todo aufbauen",
      "status": "pending"
    }
  ]
}
```

### Mark as Sent
`POST /api/reminders/{id}/sent`

**Response**
```json
{ "ok": true }
```

## Dashboard

### Statistics
`GET /api/dashboard`

**Response**
```json
{
  "total": 5,
  "pending": 3,
  "in_progress": 1,
  "done": 1,
  "overdue": 0,
  "due_today": 2
}
```

## Push

### Status
`GET /api/push/status`

### VAPID Key
`GET /api/push/vapid-public-key`

### Subscribe
`POST /api/push/subscribe`

### Unsubscribe
`POST /api/push/unsubscribe`

### Test
`POST /api/push/test`

## Public Runtime/Native Endpoints

### API Documentation
`GET /api`

Returns this API documentation as a public HTML page for users and integrations. The JSON/app API remains available under the specific `/api/...` endpoints.

### Instance Info
`GET /api/instance`

Returns public instance metadata for web/native clients, including configured public base URL and passkey/WebAuthn-relevant origin information.

### Native App Download Manifest
`GET /downloads/app-downloads.json`

Returns the available Windows/Android artifacts with version, platform, architecture, filename, size, and SHA256. Intentionally served with `no-store`. If no release artifacts are published, the endpoint responds with `200` and an empty `apps` list so clients can hide the section cleanly without 404 console noise.

### Android Digital Asset Links
`GET /.well-known/assetlinks.json`

Returns the pinned relationship between server and bundled Android app for native passkeys.

## Notes

- Inbox is `project_id = 1`
- API keys are only useful for user endpoints
- Setup endpoints only for initial installation
