# Test-Doku

## Einstieg

- `./scripts/test_all.sh`
- `npm test`

## Backend

`python3 scripts/test_backend.py`

Deckt ab:
- Setup
- Auth
- Admin
- API-Keys
- Projekte
- Sections
- Todos
- Push
- Reminders
- Projekt-Sharing und Multi-User-Isolation
- Security-Regressionen für CSRF/API-Key, IDOR und Datum-/Zeitvalidierung

## Frontend

### Smoke
- Login
- App-Start
- Projekt anlegen
- Search
- Delete + Undo

### App
- Sections anlegen/umbenennen/löschen
- Todo mit Section-Zuordnung
- Projektwechsel im Todo-Modal
- kompletter Todo-Edit-Flow
- Validierung ungültiger Deadline-/Reminder-Werte
- Regression gegen `temp is not defined`

### Setup
- Erstinstallations-Flow

### Admin
- Admin-Login
- User-Verwaltung

### Settings
- Settings öffnen
- API-Key erstellen/widerrufen
- Push-Status/Test/Deaktivieren
- Passwort ändern

### Projects
- Projekt anlegen
- Subprojekt anlegen
- Projekt bearbeiten/löschen

### Drag & Drop
- Todo zwischen Sections verschieben
- Unsortiert
- Section-Reorder-Basis

### Sharing
- Projekt einladen/annehmen/ablehnen
- Member-Liste und Undo-Aktionen
- Shared-Projekt-Readonly-UI
- Owner-/Member-Sichtbarkeit

### Security
- Markdown-XSS-Regression
- Service-Worker cached keine `/api/*` Antworten
- Offline-Sync-Queue lässt nur erlaubte Felder durch

## Release-Gate

- `release.sh` ruft zuerst `./scripts/test_all.sh` auf
- bei Fehler: sofort Abbruch
- kein Merge, kein Tag, kein Push

## Hinweise

- Frontend-Tests laufen gegen headless Chromium
- Tests sichern/restoren die Dev-DB; nicht parallel zu manuellen DB-Migrationstests laufen lassen
- `web/manifest.json` wird vom Dev-/Release-Flow gepflegt
