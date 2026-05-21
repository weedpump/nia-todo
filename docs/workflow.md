# Workflow

## Entwicklung

- im Dev-Ordner arbeiten: `~/projects/nia-todo-dev`
- nicht im Live-Ordner entwickeln

## Branches

- `develop` -> aktive Entwicklung
- `main` -> stabile Versionen / Tags

## Release

1. Feature-Branch erst nach Review nach `develop` mergen; `release.sh` releast ausschließlich `develop`
2. Im Dev-Ordner bleiben: `~/projects/nia-todo-dev`
3. Vorab bei Bedarf gezielt testen; `release.sh` führt die komplette Suite selbst aus
4. `./release.sh VERSION` ausführen, z.B. `./release.sh 1.6.0`
5. Das Script setzt Release-Versionen, baut Windows-Installer und Android-APK, merged `develop` nach `main`, erstellt Tag, aktualisiert Live und bumped `develop` auf die nächste `-dev` Version

Release-Artefakte werden auf Live unter `/downloads/` veröffentlicht:

- Windows: `nia-todo-vX.Y.Z-windows-x64-setup.exe`
- Android: `nia-todo-vX.Y.Z-android-arm64.apk`
- Manifest: `web/downloads/app-downloads.json`

Android wird mit dem dauerhaften Release-Key signiert:

- Keystore: `$NIA_TODO_SECRETS_DIR/nia-todo-android-release.keystore`
- Alias: `nia-todo-android-release`

Der Release-Key muss gesichert bleiben; ein Key-Wechsel bricht Android-Überinstallationen.

Native Build-Hinweise ab `v1.6.0`:

- Windows-Installer enthält den lokalen Reminder-Scheduler; Reminder funktionieren offline, solange App/Tray läuft.
- Android-APK enthält den lokalen `AlarmManager`-Scheduler; Reminder funktionieren offline und werden nach Geräte-Neustart neu geplant.
- Browser/PWA-Push bleibt Browser/PWA-only; native Apps sollen nicht vom Server-WebSocket für Reminder abhängig sein.
- Service Worker bleibt auch in nativen Wrappern aktiv, damit Offline-Cold-Start funktioniert.
- Nach erfolgreichem Release räumt `release.sh` lokale Tauri-Build-Artefakte per `cargo clean --manifest-path src-tauri/Cargo.toml` auf. Bei Bedarf kann das mit `CLEAN_BUILD_ARTIFACTS_AFTER_RELEASE=0 ./release.sh VERSION` übersprungen werden.

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
