# ✨ nia-todo

Selfhosted Todo-System — ersetzt Todoist. SQLite + FastAPI + schicke Web-UI + Offline-PWA + Telegram-Erinnerungen.

## 🌍 Instanzen

| Instanz | URL | Zweck |
|---------|-----|-------|
| **Live** | `http://todo-dev.kneidl-home.de:8753` | Produktion — stabile Releases |
| **Dev** | `http://todo-dev.kneidl-home.de:8754` | Tests — neue Features vor Release |

## Branches

| Branch | Zweck |
|--------|-------|
| `main` | Stabile Version — wird getaggt |
| `develop` | Aktive Entwicklung |

## Workflow

1. **Entwicklung** → Arbeite auf `develop` Branch in `~/projects/nia-todo-dev`
2. **Testen** → Öffne Dev-Instanz auf Port 8754, installiere als separate PWA
3. **Release** → `./release.sh VERSION` (z.B. `./release.sh 0.2.11`)

### Release-Prozess

```bash
cd ~/projects/nia-todo-dev
./release.sh 0.2.11
```

Was `release.sh` macht:
1. `develop` → `main` mergen
2. Tag `vX.Y.Z` erstellen und pushen
3. Live-Instanz auf **Tag** auschecken (nicht `main`!)
4. Live-Service neu starten
5. Zurück auf `develop`

Die Live-Instanz läuft immer auf einem **Tag**, nie direkt auf `main`. So kann bei Problemen einfach auf einen alten Tag zurückgesprungen werden.

### Dev-Anpassungen

Die Dev-Instanz (Port 8754) wird automatisch bei Start angepasst:
- `setup-dev.sh` wird von `systemd` vor dem Server-Start ausgeführt
- Setzt PWA-Name auf "nia-todo", IndexedDB-Name auf `nia-todo-db`
- Ist idempotent (mehrfach ausführbar)

## Features

- 📝 Todos mit Titel, Beschreibung, Priorität, Deadline
- 📁 Projekte/Kategorien (Inbox, Privat, Arbeit, Einkauf, ...)
- 🔲 Sections innerhalb von Projekten
- ⏰ Erinnerungen mit Telegram-Benachrichtigung
- 📱 **PWA — Offline-First!** Installierbar auf Android, funktioniert offline
- 🗄️ SQLite-Datenbank (lokal, kein Cloud-Quatsch)
- 🤖 Sprachintegration via Nia (Telegram)

## Quick Start (Live)

```bash
cd ~/projects/nia-todo
systemctl restart nia-todo
```

Dann im Browser öffnen: `http://todo-dev.kneidl-home.de:8753`

## Quick Start (Dev)

```bash
cd ~/projects/nia-todo-dev
systemctl restart nia-todo-dev
```

Dann im Browser öffnen: `http://todo-dev.kneidl-home.de:8754`

## PWA — Offline-First

nia-todo ist eine Progressive Web App (PWA) die auch offline funktioniert:

1. **Im Browser öffnen** → `http://todo-dev.kneidl-home.de:8753` (Live) oder `http://todo-dev.kneidl-home.de:8754` (Dev)
2. **Menü (⋮)** → "Zum Startbildschirm hinzufügen"
3. **App installiert!** 📱

**Offline-Funktionen:**
- ✅ Todos anlegen, abhaken, ändern
- ✅ Projekte wechseln
- ✅ Alle Änderungen werden lokal gespeichert
- ✅ Auto-Sync wenn wieder online
- ✅ App lädt auch ohne Internet-Verbindung

**Wichtig:** Beim ersten Start muss die App online sein damit der Service Worker sich registrieren und die Assets cachen kann.

## Projektstruktur

```
nia-todo/
├── api/
│   ├── main.py              # FastAPI REST-API
│   ├── db.py                # SQLite Schema & Helpers
│   ├── migrate.py           # Auto-Migrationen bei Start
│   ├── migrations/          # SQL-Migrationsdateien
│   └── data/
│       └── nia-todo.db      # Datenbank (NICHT im Git!)
├── web/
│   ├── index.html           # Web-UI
│   ├── manifest.json        # PWA Manifest
│   ├── sw.js                # Service Worker
│   └── static/
│       ├── style.css        # Dark Mode ✨
│       ├── app.js           # Frontend Logic
│       └── icons/           # PWA Icons
├── systemd/
│   ├── nia-todo.service     # Live systemd Service
│   └── nia-todo-dev.service # Dev systemd Service
├── release.sh               # Release-Automatisierung
├── setup-dev.sh             # Dev-Instanz Branding
├── start.sh                 # Server starten
└── README.md
```

## DB Migrationen

Schema-Änderungen laufen **automatisch** beim Server-Start:

1. Migrations-Dateien in `api/migrations/` ablegen (z.B. `002_add_labels.sql`)
2. Server starten → `migrate.py` prüft und führt neue Migrationen aus
3. `schema_version` Tabelle trackt bereits ausgeführte Migrationen

**Wichtig:** `.db` Dateien sind in `.gitignore` und gehören **niemals** ins Git.

## API Dokumentation

### Todos

#### Liste abrufen
```
GET /api/todos
GET /api/todos?status=pending
GET /api/todos?project_id=2
GET /api/todos?section_id=1
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
  "section_id": 1,
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
| `section_id` | int | ❌ | Section-Zuordnung |
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

### Sections

#### Sections eines Projekts abrufen
```
GET /api/projects/{project_id}/sections
```

#### Section erstellen
```
POST /api/projects/{project_id}/sections
```

**Body:**
```json
{
  "name": "🍎 Obst & Gemüse",
  "sort_order": 0
}
```

#### Section aktualisieren
```
PATCH /api/sections/{id}
```

#### Section löschen
```
DELETE /api/sections/{id}
```

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
| `/api/projects/{id}/sections` | GET, POST | Sections eines Projekts |
| `/api/sections/{id}` | GET, PATCH, DELETE | Einzelne Section |
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

- [ ] Wiederkehrende Todos
- [ ] Import aus Todoist-Export
- [ ] Drag & Drop Sortierung

---

