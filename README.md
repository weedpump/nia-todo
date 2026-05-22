# ✨ nia-todo

Selfhosted Todo-System — SQLite + FastAPI + Web-UI + Offline-PWA + native Windows-/Android-Apps.

## 🌍 Instanzen

- **Live:** `http://todo-dev.kneidl-home.de:8753`
- **Dev:** `http://todo-dev.kneidl-home.de:8754`

## 🚀 Quick Start

### Live
```bash
cd ~/projects/nia-todo
systemctl restart nia-todo
```

### Dev
```bash
cd ~/projects/nia-todo-dev
systemctl restart nia-todo-dev
```

## ✨ Features

- 📝 Todos mit Beschreibung, Priorität, Deadline und Erinnerungen
- 📁 Projekte/Kategorien inkl. Subprojekten und geschützter pro-User Inbox
- 🤝 Projekt-Sharing zwischen Benutzern mit Einladungen und Undo
- 🔲 Sections pro Projekt
- 📱 Offline-PWA plus native Windows-/Android-Wrapper
- 🔐 Auth, Admin-Panel, API-Keys, CSRF-Schutz und User-Datenisolation
- ⏰ Erinnerungen/Deadlines mit validierter Datum-/Zeit-Eingabe
- 🔔 Native lokale Reminder auf Windows und Android; Browser/PWA-Push bleibt Browser/PWA-only
- 🎨 Theme-Toggle
- 🗄️ SQLite lokal

## 🧱 Projektstruktur

- `api/` — Backend, DB, Migrationen
- `web/` — Web-UI, Service Worker, Manifest
- `scripts/` — Test-Suiten und Hilfen
- `docs/` — API-, Test- und Workflow-Doku
- `systemd/` — Live-/Dev-Services

## 🔧 Entwicklung

- Dev-Branch: `develop`
- Dev-Ordner: `~/projects/nia-todo-dev`
- Release nur über `./release.sh VERSION`

## 🧪 Tests

- `npm test`
- `./scripts/test_all.sh`

Details: [Test-Doku](docs/testing.md)

## 📚 Doku

- [API-Doku](docs/api.md)
- [Test-Doku](docs/testing.md)
- [Workflow-Doku](docs/workflow.md)
- [Architektur](docs/architecture.md)
- [Native Apps Clean Architecture Plan](docs/native-apps-clean-architecture.md)
- [Tauri Desktop/Android Wrapper](docs/tauri-windows-poc.md) — Legacy-/Bestandsdoku, vor Wiederverwendung neu bewerten
- Changelogs: `CHANGELOG.md` Web-App, `CHANGELOG.windows.md` Windows-App, `CHANGELOG.android.md` Android-App

## ⚙️ Setup / Betrieb

- Erstinstallation: `/setup`
- Admin-Panel: `/admin`
- Dev-Branding: `setup-dev.sh`

## Hinweise

- DB-Dateien nicht committen
- `web/manifest.json` wird vom Dev-/Release-Flow gepflegt

---


