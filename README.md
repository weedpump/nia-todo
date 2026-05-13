# ✨ nia-todo

Selfhosted Todo-System — ersetzt Todoist. SQLite + FastAPI + schicke Web-UI + Telegram-Erinnerungen.

## Features

- 📝 Todos mit Titel, Beschreibung, Priorität, Deadline
- 📁 Projekte/Kategorien (Inbox, Privat, Arbeit, Einkauf, ...)
- ⏰ Erinnerungen mit Telegram-Benachrichtigung
- 🌐 Schicke Web-UI unter `http://todo-dev.kneidl-home.de:8753`
- 🗄️ SQLite-Datenbank (lokal, kein Cloud-Quatsch)
- 🤖 Sprachintegration via Nia (Telegram)

## Quick Start

```bash
cd ~/projects/nia-todo
./start.sh
```

Dann im Browser öffnen: `http://todo-dev.kneidl-home.de:8753`

## Projektstruktur

```
nia-todo/
├── api/
│   ├── main.py          # FastAPI REST-API
│   ├── db.py            # SQLite Schema & Helpers
│   └── data/
│       └── nia-todo.db  # Datenbank
├── web/
│   ├── index.html       # Web-UI
│   └── static/
│       ├── style.css    # Dark Mode ✨
│       └── app.js       # Frontend Logic
├── scripts/
│   └── reminder-check.py  # Cron-Job für Erinnerungen
├── start.sh             # Server starten
└── README.md
```

## API Dokumentation

### Todos

#### Liste abrufen
```
GET /api/todos
GET /api/todos?status=pending
GET /api/todos?project_id=2
```

**Response:**
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
      "project_name": "Arbeit",
      "created_at": "2026-05-12T21:39:40",
      "updated_at": "2026-05-12T21:39:40",
      "reminders": [],
      "labels": []
    }
  ]
}
```

#### Todo erstellen
```
POST /api/todos
```

**Body:**
```json
{
  "title": "Wäsche waschen",
  "description": "Nicht vergessen: Wäsche raushängen!",
  "priority": 3,
  "project_id": 2,
  "due_date": "2026-05-14T10:00:00Z",
  "remind_at": "2026-05-14T09:00:00Z"
}
```

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `title` | string | ✅ | Titel des Todos |
| `description` | string | ❌ | Details/Beschreibung |
| `priority` | int | ❌ | 1=🔴 Sehr hoch, 2=🟡 Hoch, 3=🟢 Mittel (Default), 4=⚪ Niedrig |
| `project_id` | int | ❌ | Projekt-Zuordnung (null = Inbox) |
| `due_date` | string | ❌ | Deadline als ISO 8601 |
| `remind_at` | string | ❌ | Erinnerungszeit als ISO 8601 |

#### Todo aktualisieren
```
PATCH /api/todos/{id}
```

**Body:** Gleiche Felder wie POST, alle optional. `status` auf `"done"` setzt automatisch `completed_at`.

#### Todo löschen
```
DELETE /api/todos/{id}
```

### Projekte

#### Liste abrufen
```
GET /api/projects
```

#### Projekt erstellen
```
POST /api/projects
```

**Body:**
```json
{
  "name": "Hobby",
  "color": "#ec4899",
  "sort_order": 5
}
```

#### Projekt aktualisieren
```
PATCH /api/projects/{id}
```

#### Projekt löschen
```
DELETE /api/projects/{id}
```

> ⚠️ Inbox (id=1) kann nicht gelöscht werden. Alle Todos werden vorher in die Inbox verschoben.

### Reminders

#### Fällige Erinnerungen abrufen
```
GET /api/reminders
GET /api/reminders?due_only=true
```

**Response:**
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

#### Erinnerung als gesendet markieren
```
POST /api/reminders/{id}/sent
```

### Dashboard

#### Statistiken abrufen
```
GET /api/dashboard
```

**Response:**
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

## API Endpoints (Kurzübersicht)

| Endpoint | Method | Beschreibung |
|----------|--------|--------------|
| `/api/todos` | GET, POST | Liste / Erstellen |
| `/api/todos/{id}` | GET, PATCH, DELETE | Einzelnes Todo |
| `/api/projects` | GET, POST | Projekte |
| `/api/projects/{id}` | GET, PATCH, DELETE | Einzelnes Projekt |
| `/api/reminders` | GET | Fällige Erinnerungen |
| `/api/reminders/{id}/sent` | POST | Als gesendet markieren |
| `/api/dashboard` | GET | Statistiken |

## Telegram-Integration

Erinnerungen laufen über OpenClaw-Cron alle 5 Minuten. Nia prüft fällige Reminders und sendet sie direkt an Tobi via Telegram.

Shortcuts in der Web-UI:
- `n` — Neues Todo
- `Escape` — Modal schließen

## Backup

```bash
# DB sichern
cp api/data/nia-todo.db ~/backup/nia-todo-$(date +%Y%m%d).db
```

## TODOs

- [ ] Drag & Drop Sortierung
- [ ] Wiederkehrende Todos
- [ ] Import aus Todoist-Export

---

