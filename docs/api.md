# API-Doku

## Auth

Alle Endpunkte außer `/api/login` und `/api/setup/**` brauchen Auth.

### Login
- `POST /api/login`
- Body: `username`, `password`

### Logout
- `POST /api/logout`

### Me
- `GET /api/me`

### Passwort ändern
- `POST /api/me/change-password`
- `POST /api/admin/change-password`
- `POST /api/admin/users/{user_id}/change-password`

## Setup

- `POST /api/setup/admin`
- `POST /api/setup/first-user`
- `GET /api/setup/status`

## Admin

- `GET /api/admin/users`
- `POST /api/admin/users`
- `DELETE /api/admin/users/{id}`

## API-Keys

- `GET /api/me/api-keys`
- `POST /api/me/api-keys`
- `DELETE /api/me/api-keys/{id}`

## Todos

- `GET /api/todos`
- `POST /api/todos`
- `GET /api/todos/{id}`
- `PATCH /api/todos/{id}`
- `DELETE /api/todos/{id}`

### Todo-Felder
- `title`
- `description`
- `priority`
- `status`
- `project_id`
- `section_id`
- `due_date`
- `remind_at`

## Projekte

- `GET /api/projects`
- `POST /api/projects`
- `PATCH /api/projects/{id}`
- `DELETE /api/projects/{id}`
- `POST /api/projects/{id}/clear-done`

## Sections

- `GET /api/sections`
- `GET /api/sections/by-project/{projectId}`
- `POST /api/sections/by-project/{projectId}`
- `PATCH /api/sections/{id}`
- `DELETE /api/sections/{id}`

## Reminders

- `GET /api/reminders`
- `POST /api/reminders/{id}/sent`

## Push

- `GET /api/push/status`
- `GET /api/push/vapid-public-key`
- `POST /api/push/subscribe`
- `POST /api/push/unsubscribe`
- `POST /api/push/test`

## Dashboard

- `GET /api/dashboard`

## Hinweise

- API-Keys gehören zum erstellenden Benutzer
- Inbox hat `project_id = 1`
- Sections sind pro Projekt organisiert
