# Workflow

## Entwicklung

- im Dev-Ordner arbeiten: `~/projects/nia-todo-dev`
- nicht im Live-Ordner entwickeln

## Branches

- `develop` -> aktive Entwicklung
- `main` -> stabile Versionen / Tags

## Release

1. Feature-Branch erst nach Review nach `develop` mergen; `release.sh` releast ausschließlich `develop`
2. Release-Script auf `develop` mit sauberem Working Tree starten; Feature-Branches werden bewusst abgelehnt
3. Im Dev-Ordner bleiben: `~/projects/nia-todo-dev`
4. Vorab bei Bedarf gezielt testen; `release.sh` führt die komplette Suite selbst aus
5. `./release.sh VERSION` ausführen, z.B. `./release.sh 2.0.0`; stabile Releases müssen `MAJOR.MINOR.PATCH` nutzen
6. Optional: `./release.sh VERSION --set-min-app-version` hebt die minimale native App-Version auf die Release-Version an; ohne Flag bleiben ältere native Apps kompatibel
7. Das Script setzt dieselbe Version für Web-App, Service Worker, Tauri/Cargo, Windows-Installer, Android-APK und Download-Manifest
8. `scripts/check_release_versions.py VERSION` bricht den Release ab, falls eine automatisch gesetzte Versionsquelle driftet; `min_native_client_version` wird validiert und nur mit explizitem Release-Flag angehoben
9. Das Script baut Windows und Android immer mit; getrennte App-Versionen oder optionale Native-Builds gibt es nicht mehr
10. Das Script merged `develop` nach `main`, erstellt Tag, aktualisiert Live und bumped `develop` auf die nächste gemeinsame `-dev` Version

Changelog-Pflicht:

- `CHANGELOG.md` braucht einen Abschnitt `## [VERSION]` für die gemeinsame Web-/Windows-/Android-Version.
- Separate Windows-/Android-Changelogs werden nicht mehr geführt.

Release-Artefakte werden auf Live unter `/downloads/` veröffentlicht:

- Windows: `nia-todo-vX.Y.Z-windows-x64-setup.exe`
- Android: `nia-todo-vX.Y.Z-android-arm64.apk`
- Vor dem Android-Build schreibt `release.sh` generated `src-tauri/gen/android/app/tauri.properties` passend zur Release-Version und prüft sie vor/nach dem Build.
- Manifest: `web/downloads/app-downloads.json` mit `version`, `web_version`, `latest.version` und je App-Artefakt-Version auf dem Release-Tag.
- `min_native_client_version` ist kein Release-Zähler. Standard-Release lässt die Grenze unverändert; nur `--set-min-app-version` setzt sie in Source und Live-DB auf die neue Release-Version, wenn ältere native Apps wirklich inkompatibel oder unsicher sind.
- Beim Veröffentlichen löscht `release.sh` zuerst alle alten Dateien in `/downloads/` außer `.gitkeep`; alte Installer/APKs dürfen danach auch per manueller URL nicht mehr abrufbar sein.
- Native Builds verwenden ein frisch erzeugtes `src-tauri/frontend-dist` ohne `web/downloads/`; Größenlimits brechen den Release ab, falls Installer/APK unerwartet groß werden.

Android wird mit dem dauerhaften Release-Key signiert:

- Keystore: `$NIA_TODO_SECRETS_DIR/nia-todo-android-release.keystore`
- Alias: `nia-todo-android-release`

Der Release-Key muss gesichert bleiben; ein Key-Wechsel bricht Android-Überinstallationen und die Android-Passkey-Bindung über Digital Asset Links. Eine Signing-Key-Rotation braucht daher zusätzlich einen geplanten Server-/Doku-Migrationspfad für `/.well-known/assetlinks.json` und den erlaubten Android-App-Origin.

Native Build-Hinweise ab `v1.6.0`:

- Windows-Installer enthält den lokalen Reminder-Scheduler; Reminder funktionieren offline, solange App/Tray läuft.
- Android-APK enthält den lokalen `AlarmManager`-Scheduler; Reminder funktionieren offline und werden nach Geräte-Neustart neu geplant.
- Android-Passkeys setzen die offizielle App-ID `de.tobiaskneidl.nia_todo` und den Release-Key voraus; Selfhoster verbinden diese offizielle App nur mit ihrer Server-URL.
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

## Auth-/Admin-/2FA-Änderungen

- Passwort-/Onboarding-/2FA-Änderungen auf Feature-Branches entwickeln
- E-Mail-Adressen client- und serverseitig validieren
- Admins erzeugen Passwort-Setup-/Reset-Links statt Passwörter direkt zu setzen
- Passwort-Links sind einmalig und 24 Stunden gültig
- 2FA-Änderungen müssen Login-MFA, Reauth-MFA und sensitive Aktionen getrennt betrachten: Trusted Devices/Login-MFA dürfen keine Account-Security-Aktion autorisieren
- Recovery Codes sind nur Backup-Faktoren zu TOTP/Passkey; Änderungen daran brauchen mindestens `scripts/test_two_factor_services.py` und einen fokussierten Security-Review
- Vor Merge/Release mindestens Backend-, Admin-, Setup-, Settings-, MFA-Login- und Security-Frontendtests ausführen
