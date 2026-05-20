# Workflow

## Entwicklung

- im Dev-Ordner arbeiten: `~/projects/nia-todo-dev`
- nicht im Live-Ordner entwickeln

## Branches

- `develop` -> aktive Entwicklung
- `main` -> stabile Versionen / Tags

## Release

1. `./scripts/test_all.sh`
2. `./release.sh VERSION`
3. `develop` -> `main`
4. Tag erstellen
5. Live auf Tag auschecken

## Dev-Branding

- Dev-Branding wird über `setup-dev.sh` gepflegt
- `web/manifest.json` nicht manuell im normalen Workflow anfassen

## Änderungen

- sinnvolle Änderungen committen
- nach größeren Arbeitsblöcken pushen
- kleine Doku-Änderungen bündeln

## Auth-/Admin-Änderungen

- Passwort-/Onboarding-Änderungen auf Feature-Branches entwickeln
- E-Mail-Adressen client- und serverseitig validieren
- Admins erzeugen Passwort-Setup-/Reset-Links statt Passwörter direkt zu setzen
- Passwort-Links sind einmalig und 24 Stunden gültig
- Vor Merge/Release mindestens Backend-, Admin-, Setup- und Settings-Frontendtests ausführen
