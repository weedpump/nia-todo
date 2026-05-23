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
- **2FA-Service-/Security-Regressionen für TOTP, Recovery-Code-Verbrauch, Challenge-Lockout, alte JWTs nach Policy-Aktivierung, WebAuthn-RP/Origin/HTTPS-Bindung, One-Time-MFA-Grants, Reauth-Replay-Schutz und Recovery-Code-Cleanup nach Entfernen des letzten primären Faktors**

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
- **2FA-Settings-UI: Status, TOTP-Setup mit QR-Code, Recovery-Code-Anzeige, Passkey-/TOTP-Gerätelisten, Deaktivieren/Widerrufen/Regenerieren und Security-Dialoge ohne Browser-Popups**

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
- **2FA-/MFA-Regressionen: Native-Passkey-Deferral, Recovery-Code-Fallback-Labels, Security-Dialoge statt `alert/prompt/confirm`, One-Time-Grant-Verbrauch und sensible Aktionen mit frischer Reauth**

## Release-Gate

- `release.sh` ruft zuerst `./scripts/test_all.sh` auf
- bei Fehler: sofort Abbruch
- kein Merge, kein Tag, kein Push

Für 2FA-Änderungen zusätzlich sinnvoll vor Release/Review:
- `python3 scripts/test_two_factor_services.py`
- `node scripts/test_frontend_mfa_login.mjs`
- `node scripts/test_frontend_settings.mjs`
- `node scripts/test_frontend_admin.mjs`
- `node scripts/test_frontend_security.mjs`

Manuelle 2FA-Smoke-Pfade:
- TOTP einrichten, QR-Code scannen, Login mit TOTP abschließen.
- Passkey hinzufügen, Login/Reauth per Passkey abschließen.
- TOTP/Passkey widerrufen; beim letzten primären Faktor müssen Recovery Codes verschwinden und user-seitige 2FA deaktiviert werden.
- Sensitive Aktionen nacheinander ausführen; jede Aktion muss eine frische MFA-Reauth verlangen.
- Trusted Device muss Login-MFA überspringen können, aber keine sensitive Aktion autorisieren.
- Recovery Code und E-Mail-Code dürfen nach erfolgreicher Nutzung nicht erneut funktionieren.

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
