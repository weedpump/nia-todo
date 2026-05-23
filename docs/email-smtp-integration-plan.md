# E-Mail / SMTP Integration Plan

Status: Draft for Release 2.0 Control Feature 2/3  
Branch: `email-smtp-integration`

## Goals

- Provide optional instance-wide SMTP configuration via Admin UI.
- Use the existing public/base URL configuration for all generated links.
- Send password setup/reset links by email when email is configured.
- Add verified-email semantics for login, password reset, and project sharing.
- Keep safe non-email fallbacks for self-hosted instances without SMTP.
- Prepare email as a future 2FA fallback/recovery channel.

## Non-goals for this feature slice

- Full 2FA implementation.
- External email provider APIs beyond SMTP.
- Background queue infrastructure; mail sending can be synchronous initially, with clear errors and audit events.

## Configuration model

SMTP settings live in `app_config` and are updated through admin-only endpoints.

Planned keys:

- `smtp_enabled`: boolean string, default `false`
- `smtp_host`: SMTP hostname, default empty
- `smtp_port`: integer, default `587`
- `smtp_security`: `none | starttls | tls`, default `starttls`
- `smtp_auth_enabled`: boolean string, default `false`
- `smtp_username`: string, default empty
- `smtp_password_secret`: secret string, default empty; never returned by API
- `mail_from_address`: email address, default empty
- `mail_from_name`: display name, default `nia-todo`
- `mail_reply_to`: optional email address, default empty
- `password_link_ttl_hours`: integer, default `24`

API responses must redact secrets and return only whether a password is configured.

## User email state

`users` gets explicit verification state:

- `email_verified_at`: set when current `email` is verified
- `pending_email`: replacement email awaiting verification
- `pending_email_token_hash`: hash of the pending-email verification token
- `pending_email_token_prefix`: short lookup prefix
- `pending_email_token_expires_at`: expiry timestamp
- `email_changed_at`: last email/pending-email change

Migration policy for existing users:

- Existing non-empty `email` values are treated as verified if the user already has a password hash.
- New users and changed email addresses require verification.

## Password setup/reset tokens

Current `password_setup_tokens` already store hashed one-time tokens. The table will be extended with token lifecycle state.

Planned additions:

- `status`: `active | used | replaced`, default `active`
- `replaced_at`: timestamp
- `requested_by`: `admin | user | system`, default `admin`

Token lookup rules:

- Valid token: hash matches, status active, not used, not expired.
- Expired known token: may reveal only enough UI state to request a new link.
- Unknown token: generic invalid/expired message.

On new token creation for the same user + purpose:

- Mark older active tokens as `replaced`.
- Insert the new active token.

## Email service

New services:

- `api/services/email.py`
  - load and validate SMTP configuration
  - `is_email_configured()`
  - `send_email(to, subject, text, html=None)`
  - `send_test_email(to)`
- `api/services/email_templates.py`
  - password setup/invite
  - password reset
  - email verification
  - project share notification
  - future 2FA code template

Template rules:

- Include app/instance name.
- Include a button link and plain fallback URL.
- Include expiry and security note.
- Never include secrets other than the intended one-time link.

## Admin UI flows

Admin endpoints:

- `GET /api/admin/email-config`
- `PATCH /api/admin/email-config`
- `POST /api/admin/email-config/test`

Admin UI shows:

- SMTP host, port, security mode
- Optional auth username/password
- From address/name and reply-to
- Password link TTL
- Test mail target and result
- Clear configured/not-configured status

## Auth and account flows

### Password forgotten

- Login UI shows “Passwort vergessen” only when email is configured.
- Reset can be requested by username or verified email.
- Public reset request response is always neutral to avoid user enumeration.
- Reset mail is sent only if a matching account with an eligible email exists.

### Invite / new user

- If email is configured and the new user has an email address, the setup link is emailed and not returned in API/UI.
- If email is not configured, existing admin-visible setup link fallback remains.
- Completing an invite/setup link sets the password and verifies the email at the same time.

### Expired setup/reset link

- Known expired links show an “neuen Link anfordern” action.
- Requesting a new link rate-limits and invalidates/replaces older active links.
- The replacement email goes to the user’s stored email address.

### Email changes

- Admin/user email changes write `pending_email` first.
- New email must be confirmed before it replaces `email`.
- Until confirmation, the old verified email remains active for login/reset.
- UI shows pending state clearly.

### Login with email

- Once SMTP/email is configured, login accepts username or verified email address.
- Login by email only works for `email_verified_at IS NOT NULL`.
- Unverified emails cannot be used for login.

## Project sharing

- Share dialog accepts username or verified email.
- Backend resolves exact username or case-insensitive verified email.
- Email share notification is sent when SMTP is configured.
- UI notification remains unchanged as the reliable in-app source of truth.

## Security requirements

- No user enumeration in reset/resend flows.
- Rate-limit reset/resend by IP and identifier hash/user where possible.
- Keep token secrets hashed in DB.
- Do not log SMTP passwords, tokens, or full reset links.
- Invalidate or mark old active tokens as replaced when a new token is requested.
- Audit important events:
  - email config changed
  - test mail sent/failed
  - reset requested
  - setup/reset link created/replaced
  - email verification requested/completed
  - project share mail sent/failed

## Test strategy

Backend tests:

- SMTP config validation and secret redaction
- Email service with mocked SMTP
- Invite link email vs non-email fallback
- Password reset neutral responses
- Expired token resend behavior
- Token replacement semantics
- Email verification on setup completion
- Email change pending/confirm flow
- Login by verified email and rejection for unverified email
- Project sharing by verified email

Frontend tests:

- Login forgot-password visibility
- Admin SMTP settings and test-mail UI
- Admin create-user email/fallback behavior
- Set-password expired-state resend UI
- Share dialog accepts username/email
- Pending-email status display

Run DB-mutating tests serially.
