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
- 📧 E-Mail/SMTP-Integration für Einladungen, Passwort-Reset und E-Mail-Verifizierung
- 🔲 Sections pro Projekt
- 📱 Offline-PWA plus native Windows-/Android-Wrapper
- 🔐 Auth, Admin-Panel, API-Keys, CSRF-Schutz und User-Datenisolation
- 🛡️ 2FA/MFA mit Authenticator-App (TOTP), Passkeys/WebAuthn inkl. nativer Windows-/Android-Bridge, E-Mail-Code-Fallback, Recovery Codes, Trusted Devices und Admin-Policy
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
- gezielte 2FA-Regressionen: `python3 scripts/test_two_factor_services.py`, `node scripts/test_frontend_mfa_login.mjs`, `node scripts/test_frontend_security.mjs`

Details: [Test-Doku](docs/testing.md)

## 📚 Doku

- [API-Doku](docs/api.md)
- [Test-Doku](docs/testing.md)
- [Workflow-Doku](docs/workflow.md)
- [Architektur](docs/architecture.md)
- [Native Apps Clean Architecture Plan](docs/native-apps-clean-architecture.md) — inkl. Android-Passkey-Vertrauensmodell
- [Tauri Desktop/Android Wrapper](docs/tauri-windows-poc.md) — Legacy-/Bestandsdoku, vor Wiederverwendung neu bewerten
- Changelog: `CHANGELOG.md` für Web-App, Windows-App und Android-App gemeinsam

## ⚙️ Setup / Betrieb

- Erstinstallation: `/setup`
- Admin-Panel: `/admin`
- 2FA-Policy und Benutzer-Reset: `/admin` → Security/Benutzerliste
- Passkeys benötigen in produktiven Setups eine HTTPS-`public_base_url`; Android nutzt die offizielle App-Signatur über `/.well-known/assetlinks.json`
- Dev-Branding: `setup-dev.sh`

## Hinweise

- DB-Dateien nicht committen
- `web/manifest.json` wird vom Dev-/Release-Flow gepflegt

---


