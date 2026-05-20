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
{ "email": "tobi@example.com" }
```

**Validierung**
- Pflichtfeld
- Muss eine gültige E-Mail-Adresse sein
- Muss eindeutig sein

**Response**
```json
{ "email": "tobi@example.com" }
```

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

## Setup

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
  "api_key": "nt_...",
  "message": "Speichere diesen Key sofort — er wird nie wieder angezeigt!"
}
```

### Widerrufen
`DELETE /api/me/api-keys/{id}`

**Response**
```json
{ "revoked": true }
```

### Auth mit API-Key
```text
Authorization: ApiKey nt_...
```

oder

```text
X-API-Key: nt_...
```

**Hinweise**
- API-Keys sind an den Benutzer gebunden
- widerrufene Keys sind sofort ungültig
- `last_used_at` wird gepflegt
- API-Keys umgehen CSRF nur mit `Authorization: ApiKey nt_...` oder `X-API-Key`; `Bearer nt_...` wird abgelehnt

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
