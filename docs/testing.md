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

## Release-Gate

- `release.sh` ruft zuerst `./scripts/test_all.sh` auf
- bei Fehler: sofort Abbruch
- kein Merge, kein Tag, kein Push

## Hinweise

- Frontend-Tests laufen gegen headless Chromium
- `web/manifest.json` wird vom Dev-/Release-Flow gepflegt
