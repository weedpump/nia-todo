# API-Doku

## Authentifizierung

> Alle Endpunkte außer `/api/login` und `/api/setup/**` erfordern Auth.

### Login
`POST /api/login`

**Body**
```json
{
  "username": "tobi",
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
    "username": "tobi",
    "display_name": "Tobi",
    "email": "tobi@example.com",
    "avatar_url": "/api/avatars/user-1.webp",
    "is_admin": true
  }
}
```

### Login mit 2FA-Challenge

Wenn für den Benutzer 2FA aktiv oder global erzwungen ist, kann `POST /api/login` statt eines Tokens eine Challenge liefern:

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

Abschluss:

`POST /api/2fa/challenge/verify`

```json
{
  "challenge_token": "...",
  "method": "totp",
  "code": "123456",
  "remember_device": true
}
```

Response entspricht dem normalen Login (`access_token`, `csrf_token`, `user`). Bei `remember_device=true` wird zusätzlich ein HttpOnly-Trusted-Device-Cookie gesetzt.

### Logout
`POST /api/logout`

**Response**
```json
{ "ok": true }
```

### Aktueller Benutzer
`GET /api/me`

**Response**
```json
{
  "id": 1,
  "username": "tobi",
  "display_name": "Tobi",
  "email": "tobi@example.com",
  "avatar_url": "/api/avatars/user-1.webp",
  "avatar_updated_at": "2026-05-21T00:00:00+00:00",
  "is_admin": true
}
```

### Eigenes Profil ändern
`PATCH /api/me/profile`

**Body**
```json
{ "display_name": "Tobi" }
```

**Response**
```json
{
  "id": 1,
  "username": "tobi",
  "display_name": "Tobi",
  "email": "tobi@example.com",
  "avatar_url": "/api/avatars/user-1.webp",
  "avatar_updated_at": "2026-05-21T00:00:00+00:00",
  "is_admin": true
}
```

### Eigenen Avatar hochladen
`PUT /api/me/avatar`

**Request**
- Body: rohe Bilddaten
- `Content-Type`: `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/heic` oder `image/heif`
- Maximalgröße: 5 MiB

**Speicherung**
- Datei: `api/data/avatars/user-{id}.webp`
- DB: nur `avatar_url` und `avatar_updated_at`

**Response**
```json
{
  "avatar_url": "/api/avatars/user-1.webp",
  "avatar_updated_at": "2026-05-21T00:00:00+00:00"
}
```

### Eigene E-Mail ändern
`PATCH /api/me/email`

**Body**
```json
{ "email": "neue@example.com" }
```

**Validierung**
- Pflichtfeld
- Muss eine gültige E-Mail-Adresse sein
- Muss eindeutig sein (case-insensitive)

**Response (mit SMTP konfiguriert)**
```json
{
  "email": "alte@example.com",
  "pending_email": "neue@example.com",
  "email_verified_at": "2026-05-20T00:00:00+00:00",
  "email_verification_sent": true
}
```

**Response (ohne SMTP)**
```json
{
  "email": "neue@example.com",
  "email_verified_at": null,
  "email_trust_source": "unverified_no_smtp"
}
```

**Hinweis:** Mit SMTP wird die neue E-Mail als `pending_email` gespeichert und eine Verifizierungs-Mail gesendet. Die alte E-Mail bleibt aktiv bis zur Verifizierung. Ohne SMTP ist die E-Mail sofort aktiv, aber nicht verifiziert (kann nicht für Login/Sharing verwendet werden).

### Eigenes Passwort ändern
`POST /api/me/change-password`

**Body**
```json
{ "old_password": "alt123!", "new_password": "neu123!" }
```

**Response**
```json
{ "ok": true }
```

## Zwei-Faktor-Authentifizierung

### 2FA-Status
`GET /api/me/2fa`

Liefert aktivierte/verfügbare Faktoren, Recovery-Code-Anzahl, globale Pflicht und Passkey-Anzahl.

### TOTP starten/bestätigen
`POST /api/me/2fa/totp/start` liefert Secret und `otpauth_url`.

`POST /api/me/2fa/totp/confirm`
```json
{ "secret": "BASE32...", "code": "123456", "password": "..." }
```

Aktiviert TOTP nach Passwortbestätigung und liefert einmalig neue Recovery Codes sowie ein frisches MFA-JWT zurück.

### 2FA deaktivieren / Recovery Codes regenerieren
- `POST /api/me/2fa/disable` — benötigt recent MFA, widerruft Trusted Devices und Passkeys.
- `POST /api/me/2fa/recovery-codes/regenerate` — benötigt recent MFA, liefert neue Codes einmalig zurück.
- `POST /api/me/2fa/reauth` — prüft TOTP/Recovery-Code mit Attempt-Lockout und stellt ein frisches JWT mit `mfa_at` aus.
- `POST /api/me/2fa/reauth/passkey/options` und `/api/me/2fa/reauth/passkey/verify` — Passkey-Reauth für Passkey-only Nutzer.

### Passkeys
- `GET /api/me/passkeys` — eigene Passkeys auflisten.
- `POST /api/me/passkeys/options` — Registrierungsoptionen/Challenge vorbereiten.
- `POST /api/me/passkeys/verify` — WebAuthn-Registrierung mit Passwortbestätigung abschließen.
- `POST /api/2fa/passkey/options` und `/api/2fa/passkey/verify` — Login-Challenge per Passkey abschließen.
- `DELETE /api/me/passkeys/{id}` — Passkey widerrufen, benötigt recent MFA.

Passkeys sind an die konfigurierte öffentliche Basis-URL (`public_base_url`) gebunden. Für Nicht-Localhost-Hosts ist HTTPS Pflicht; ohne `public_base_url` sind produktive Passkey-Flows für Nicht-Localhost-Hosts fail-closed. Native Apps bekommen bis zur nativen Passkey-Bridge keinen WebView-Passkey-Sonderpfad.

### Admin-Policy
- `GET /api/admin/2fa-policy`
- `PATCH /api/admin/2fa-policy` mit `{ "required": true }`
- `GET /api/admin/users` enthält zusätzlich 2FA-/Passkey-/Trusted-Device-/API-Key-Statusfelder.
- `POST /api/admin/users/{user_id}/2fa/reset` — setzt Faktoren, Recovery Codes, Passkeys und Trusted Devices eines Benutzers zurück.

Security-sensitive Account-Aktionen verlangen bei 2FA-pflichtigen Accounts ein JWT mit frischem `mfa_at`. API Keys (`ApiKey nt_...`) sind bewusst als Maschinen-Token von interaktiver MFA bei der Nutzung ausgenommen. Erzeugung und Widerruf eigener API Keys benötigen bei MFA-pflichtigen Accounts recent MFA; die Settings-UI stößt dafür bei Bedarf einen Reauth-Flow an. Bestehende API Keys werden beim Aktivieren von MFA nicht automatisch widerrufen; die Admin-UI zeigt aktive Keys als Warnhinweis.

## E-Mail / SMTP

### Eigene E-Mail verifizieren
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

**Hinweis:** Einmaliger Token aus der Verifizierungs-Mail. Nach erfolgreicher Verifizierung wird `pending_email` zu `email` und `email_verified_at` gesetzt.

### Passwort-Reset anfordern (öffentlich)
`POST /api/password-reset/request`

**Body**
```json
{ "email": "user@example.com" }
```

**Response (immer neutral)**
```json
{
  "ok": true,
  "message": "Falls ein passender verifizierter Account existiert, wurde die E-Mail gesendet."
}
```

**Hinweis:** Aus Sicherheitsgründen wird immer eine neutrale Response geliefert (keine Enumeration). Reset-Mails werden nur an verifizierte E-Mails gesendet.

### Passwort-Setup-Link anfordern (Admin)
`POST /api/admin/users/{user_id}/password-link`

**Response (mit SMTP + verifizierter E-Mail)**
```json
{
  "email_sent": true,
  "message": "Passwort-Setup-Link wurde per E-Mail gesendet."
}
```

**Response (ohne SMTP oder nicht verifizierte E-Mail)**
```json
{
  "email_sent": false,
  "password_setup_url": "http://todo-dev.kneidl-home.de:8753/set-password?token=..."
}
```

**Hinweis:** Admins können Passwort-Setup-Links für Benutzer generieren. Bei SMTP + verifizierter E-Mail wird der Link per Mail gesendet, andernfalls als manueller Link zurückgegeben.

## Admin: E-Mail-Konfiguration

### SMTP-Konfiguration abrufen
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

**Hinweis:** `smtp_password_configured` ist ein Boolean-Feld; das tatsächliche Passwort wird nie zurückgegeben.

### SMTP-Konfiguration aktualisieren
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
  "smtp_password": "geheim123",
  "mail_from_address": "nia@example.com",
  "mail_from_name": "nia-todo"
}
```

**Response**
```json
{ "ok": true }
```

### Test-Mail senden
`POST /api/admin/email-config/test`

**Body**
```json
{ "to": "tobi@example.com" }
```

**Response**
```json
{
  "ok": true,
  "message": "Test-Mail erfolgreich gesendet."
}
```

**Fehler (SMTP nicht konfiguriert)**
```json
{
  "ok": false,
  "error": "SMTP ist nicht konfiguriert."
}
```

## Projekt-Sharing

### Projekt teilen
`POST /api/projects/{project_id}/share`

**Body**
```json
{ "username": "user@example.com" }
```

**Response (Username-Invite)**
```json
{
  "member": {
    "id": 42,
    "user_id": 5,
    "username": "moni",
    "display_name": "Moni",
    "status": "pending"
  },
  "notification_delivery": "in_app"
}
```

**Response (E-Mail-Invite — neutral)**
```json
{
  "notification_delivery": "email"
}
```

**Hinweis:** Bei E-Mail-Identifiern (enthält `@`) wird aus Sicherheitsgründen keine Member-Info zurückgegeben (keine Enumeration). Der eingeladene User erhält eine E-Mail mit Link.

### Mitglieder auflisten
`GET /api/projects/{project_id}/members`

**Response**
```json
{
  "members": [
    {
      "id": 1,
      "user_id": 1,
      "username": "tobi",
      "display_name": "Tobi",
      "status": "accepted"
    }
  ]
}
```

**Hinweis:** Zeigt nur `accepted` Mitglieder an. Pending Invites sind aus Privacy-Gründen nicht sichtbar (auch nicht für Owner).

### Einladung annehmen/ablehnen
`POST /api/projects/{project_id}/invites/{invite_id}`

**Body**
```json
{ "accept": true }
```

**Response**
```json
{ "ok": true }
```

### Ausstehende Einladungen abrufen
`GET /api/projects/invites`

**Response**
```json
{
  "invites": [
    {
      "id": 42,
      "project_id": 5,
      "project_name": "Einkaufsliste",
      "invited_by_username": "tobi",
      "status": "pending"
    }
  ]
}
```

## Admin: Benutzer

### Admin-Passwort setzen
`POST /api/setup/admin`

**Body**
```json
{ "admin_password": "***" }
```

**Response**
```json
{ "ok": true }
```

### Ersten Benutzer erstellen
`POST /api/setup/first-user`

**Body**
```json
{
  "username": "tobi",
  "email": "tobi@example.com",
  "password": "***",
  "display_name": "Tobi"
}
```

**Response**
```json
{ "ok": true }
```

### Setup-Status
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

### Benutzer auflisten
`GET /api/admin/users`

**Response**
```json
{
  "users": [
    {
      "id": 1,
      "username": "tobi",
      "display_name": "Tobi",
      "email": "tobi@example.com",
      "is_admin": true
    }
  ]
}
```

### Benutzer anlegen
`POST /api/admin/users`

**Body**
```json
{
  "username": "neu",
  "display_name": "Neuer User",
  "email": "neu@example.com"
}
```

Der Admin setzt kein Passwort mehr direkt. Beim Anlegen wird ein einmaliger Passwort-Setup-Link erzeugt.

**Validierung**
- `email` ist Pflicht
- Muss eine gültige E-Mail-Adresse sein
- Muss eindeutig sein

**Response**
```json
{
  "id": 2,
  "username": "neu",
  "display_name": "Neuer User",
  "email": "neu@example.com",
  "created_at": "2026-05-20T21:30:00Z",
  "password_setup_url": "https://example.local/set-password?token=...",
  "password_setup_expires_hours": 24
}
```

### Benutzer aktualisieren
`PATCH /api/admin/users/{id}`

**Body**
```json
{ "email": "neu@example.com" }
```

Optional kann `display_name` mitgegeben werden.

**Response**
```json
{ "id": 2, "email": "neu@example.com", "display_name": null }
```

### Benutzer löschen
`DELETE /api/admin/users/{id}`

**Response**
```json
{ "deleted": true }
```

### Passwort-Setup-/Reset-Link erzeugen
`POST /api/admin/users/{id}/change-password`

> Kompatibilitäts-Endpunkt: Admins setzen Passwörter nicht mehr direkt. Der Endpoint erzeugt einen einmaligen Link.

**Response**
```json
{
  "password_setup_url": "https://example.local/set-password?token=...",
  "password_setup_expires_hours": 24
}
```

### Passwort-Link erzeugen
`POST /api/admin/users/{id}/password-link`

**Response**
```json
{
  "password_setup_url": "https://example.local/set-password?token=...",
  "password_setup_expires_hours": 24
}
```

### Passwort per Link setzen
`POST /api/password-setup/complete`

**Body**
```json
{ "token": "...", "password": "NeuesPasswort123!" }
```

**Response**
```json
{ "message": "Passwort gesetzt" }
```

Links sind 24 Stunden gültig und nur einmal verwendbar.

### Admin-Passwort ändern
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

## API-Keys

### Auflisten
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

### Erstellen
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

Der vollständige `key` wird nur einmalig beim Erstellen angezeigt.

### Widerrufen
`DELETE /api/me/api-keys/{id}`

**Response**
```json
{ "revoked": 12 }
```

### Auth mit API-Key
```text
Authorization: ApiKey nt_...
```

**Hinweise**
- API-Keys sind an den Benutzer gebunden
- widerrufene Keys sind sofort ungültig
- `last_used_at` wird gepflegt
- API-Keys umgehen CSRF nur mit `Authorization: ApiKey nt_...`; `Bearer nt_...` und `X-API-Key` werden nicht als API-Key-Auth unterstützt

## Todos

### Liste
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

### Einzelnes Todo
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

### Erstellen
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

**Felder**
- `title` string, Pflicht
- `description` string, optional
- `priority` int, optional, `1..4`
- `project_id` int, optional
- `section_id` int, optional
- `due_date` ISO-8601, optional, gültiges Jahr `1900..9999`
- `remind_at` ISO-8601, optional, gültiges Jahr `1900..9999`

**Response**
```json
{
  "id": 17,
  "title": "Wäsche waschen",
  "status": "pending"
}
```

### Aktualisieren
`PATCH /api/todos/{id}`

**Body**
- gleiche Felder wie POST, alle optional
- `status=done` setzt `completed_at`

**Response**
```json
{
  "id": 17,
  "title": "Wäsche waschen",
  "status": "done"
}
```

### Löschen
`DELETE /api/todos/{id}`

**Response**
```json
{ "deleted": true }
```

## Projekte

### Liste
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
      "owner_username": "tobi",
      "owner_display_name": "Tobi"
    }
  ]
}
```

**Hinweise**
- Jeder Benutzer hat genau eine Inbox (`is_inbox=1`). Der Name darf geändert werden; `is_inbox` bleibt die stabile Identität.
- Inbox-Projekte können nicht gelöscht werden.
- Shared-Projekte erscheinen in der normalen Projektliste mit `is_shared=true` und Owner-Metadaten.

### Erstellen
`POST /api/projects`

**Body**
```json
{ "name": "Hobby", "color": "#ec4899", "sort_order": 5 }
```

**Response**
```json
{ "id": 7, "name": "Hobby" }
```

### Aktualisieren
`PATCH /api/projects/{id}`

**Body**
```json
{ "name": "Hobby Neu" }
```

`parent_id` kann auf eine Projekt-ID gesetzt oder mit `null` wieder entfernt werden:
```json
{ "parent_id": null }
```

**Response**
```json
{ "id": 7, "name": "Hobby Neu" }
```

### Löschen
`DELETE /api/projects/{id}`

**Response**
```json
{ "deleted": true }
```

### Erledigte Todos im Projekt löschen
`POST /api/projects/{id}/clear-done`

**Response**
```json
{ "deleted_count": 3 }
```

## Projekt-Sharing

### Ausstehende Einladungen
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
      "invited_by_username": "tobi",
      "invited_by_display_name": "Tobi",
      "status": "pending"
    }
  ]
}
```

### Projekt teilen
`POST /api/projects/{project_id}/share`

Owner-only.

**Body**
```json
{ "username": "moni" }
```

**Response**
```json
{
  "member": {
    "project_id": 5,
    "user_id": 2,
    "username": "moni",
    "display_name": "Moni",
    "status": "pending"
  }
}
```

### Einladung annehmen/ablehnen
`POST /api/projects/{project_id}/invites/{invite_id}`

**Body**
```json
{ "accept": true }
```

**Response**
```json
{ "id": 12, "status": "accepted", "project_id": 5 }
```

### Mitglieder auflisten
`GET /api/projects/{project_id}/members`

Owner und akzeptierte Mitglieder dürfen die Liste sehen.

**Response**
```json
{
  "members": [
    {
      "project_id": 5,
      "user_id": 2,
      "username": "moni",
      "display_name": "Moni",
      "status": "accepted"
    }
  ]
}
```

### Mitglied entfernen
`DELETE /api/projects/{project_id}/members/{member_user_id}`

Owner kann Mitglieder entfernen; Mitglieder können sich selbst entfernen. Entfernen ist undo-fähig und setzt intern `status=removed`.

**Response**
```json
{ "removed": 12, "project_id": 5 }
```

### Entferntes/ausgetretenes Mitglied wiederherstellen
`POST /api/projects/{project_id}/members/{member_user_id}/restore`

**Body**
```json
{ "status": "accepted" }
```

**Response**
```json
{ "member": { "project_id": 5, "user_id": 2, "status": "accepted" } }
```

### Shared-Projekt verlassen / Undo
`POST /api/projects/{project_id}/leave`

Owner können eigene Projekte nicht verlassen.

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

### Alle Sections
`GET /api/sections`

**Response**
```json
{ "sections": [] }
```

### Sections eines Projekts
`GET /api/sections/by-project/{projectId}`

**Response**
```json
{
  "sections": [
    { "id": 1, "name": "Einkauf", "project_id": 2, "sort_order": 0 }
  ]
}
```

### Erstellen
`POST /api/sections/by-project/{projectId}`

**Body**
```json
{ "name": "Einkauf", "sort_order": 0 }
```

**Response**
```json
{ "id": 9, "name": "Einkauf" }
```

### Aktualisieren
`PATCH /api/sections/{id}`

**Body**
```json
{ "name": "Einkauf Neu" }
```

**Response**
```json
{ "id": 9, "name": "Einkauf Neu" }
```

### Löschen
`DELETE /api/sections/{id}`

**Response**
```json
{ "deleted": true }
```

## Reminders

### Liste
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

### Als gesendet markieren
`POST /api/reminders/{id}/sent`

**Response**
```json
{ "ok": true }
```

## Dashboard

### Statistiken
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

### VAPID-Key
`GET /api/push/vapid-public-key`

### Subscribe
`POST /api/push/subscribe`

### Unsubscribe
`POST /api/push/unsubscribe`

### Test
`POST /api/push/test`

## Hinweise

- Inbox ist `project_id = 1`
- API-Keys sind nur für Benutzer-Endpunkte sinnvoll
- Setup-Endpoints nur für Erstinstallation
