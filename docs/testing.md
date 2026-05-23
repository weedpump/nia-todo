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
- **E-Mail/SMTP-Integration (neutrale Responses, verifizierte E-Mail-Lookups)**
- **2FA-Service-/Security-Regressionen für TOTP, Recovery-Code-Verbrauch, Challenge-Lockout, alte JWTs nach Policy-Aktivierung und WebAuthn-RP/Origin/HTTPS-Bindung**

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
- **Globale 2FA-Pflicht aktivieren/deaktivieren + Statusanzeige in der Benutzerliste**
- **SMTP-Konfiguration + Test-Mail**

### Settings
- Settings öffnen
- API-Key erstellen/widerrufen
- Push-Status/Test/Deaktivieren
- Passwort ändern
- **E-Mail-Verifizierung**
- **2FA-Settings-UI: Status, TOTP-Setup, Recovery-Code-Anzeige, Deaktivieren/Regenerieren**

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
- **E-Mail-Invite (neutrale Response, keine pending Members sichtbar)**

### Security
- Markdown-XSS-Regression
- Service-Worker cached keine `/api/*` Antworten
- Offline-Sync-Queue lässt nur erlaubte Felder durch
- **E-Mail-Enumeration-Schutz (neutrale Responses bei Passwort-Reset/Invite)**

## Release-Gate

- `release.sh` ruft zuerst `./scripts/test_all.sh` auf
- bei Fehler: sofort Abbruch
- kein Merge, kein Tag, kein Push

## E-Mail/SMTP-Tests

### Service-Tests
`python3 scripts/test_email_services.py`

Testet:
- SMTP-Konfiguration (get/patch)
- E-Mail-Versand (send_email)
- E-Mail-Vorlagen (templates)
- Token-Hashing/Prefix-Lookup

### Migrationstests
`python3 scripts/test_migration_022_email_duplicates.py`

Testet:
- Case-insensitive E-Mail-Uniqueness
- Duplikate werden bereinigt

`python3 scripts/test_migration_email_partial_recovery.py`

Testet:
- Partielle Schema-Zustände werden repariert
- Migration ist idempotent

## Hinweise

- Frontend-Tests laufen gegen headless Chromium
- Tests sichern/restoren die Dev-DB; DB-mutierende Tests immer seriell laufen lassen, nicht parallel
- `web/manifest.json` wird vom Dev-/Release-Flow gepflegt
