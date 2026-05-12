# ✨ nia-todo

Selfhosted Todo-System — ersetzt Todoist. SQLite + FastAPI + schicke Web-UI + Telegram-Erinnerungen.

## Features

- 📝 Todos mit Titel, Beschreibung, Priorität, Deadline
- 📁 Projekte/Kategorien (Inbox, Privat, Arbeit, Einkauf, ...)
- 🏷️ Labels für flexible Filterung
- ⏰ Erinnerungen mit Telegram-Benachrichtigung
- 🌐 Schicke Web-UI unter `http://todo-dev.kneidl-home.de:8753`
- 🗄️ SQLite-Datenbank (lokal, kein Cloud-Quatsch)
- 🤖 Sprachintegration via Nia (Telegram)

## Quick Start

```bash
cd ~/workspace/nia-todo
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

## API Endpoints

| Endpoint | Method | Beschreibung |
|----------|--------|--------------|
| `/api/todos` | GET, POST | Liste / Erstellen |
| `/api/todos/{id}` | GET, PATCH, DELETE | Einzelnes Todo |
| `/api/projects` | GET, POST | Projekte |
| `/api/labels` | GET, POST | Labels |
| `/api/reminders` | GET | Fällige Erinnerungen |
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

- [ ] Label-Filter in Web-UI
- [ ] Drag & Drop Sortierung
- [ ] Wiederkehrende Todos
- [ ] Import aus Todoist-Export

---

