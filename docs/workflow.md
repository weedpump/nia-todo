# Workflow

## Entwicklung

- im Dev-Ordner arbeiten: `~/projects/nia-todo-dev`
- nicht im Live-Ordner entwickeln

## Branches

- `develop` -> aktive Entwicklung
- `main` -> stabile Versionen / Tags

## Release

1. Im Dev-Ordner bleiben: `~/projects/nia-todo-dev`
2. Vorab bei Bedarf gezielt testen; `release.sh` führt die komplette Suite selbst aus
3. `./release.sh VERSION` ausführen
4. Das Script setzt Release-Versionen, baut Windows-Installer und Android-APK, merged `develop` nach `main`, erstellt Tag, aktualisiert Live und bumped `develop` auf die nächste `-dev` Version

Release-Artefakte werden auf Live unter `/downloads/` veröffentlicht:

- Windows: `nia-todo-vX.Y.Z-windows-x64-setup.exe`
- Android: `nia-todo-vX.Y.Z-android-arm64.apk`
- Manifest: `web/downloads/app-downloads.json`

Android wird mit dem dauerhaften Release-Key signiert:

- Keystore: `$NIA_TODO_SECRETS_DIR/nia-todo-android-release.keystore`
- Alias: `nia-todo-android-release`

Der Release-Key muss gesichert bleiben; ein Key-Wechsel bricht Android-Überinstallationen.

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
