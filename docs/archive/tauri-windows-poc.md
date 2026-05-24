# Tauri Desktop/Android Wrapper

> **Archiv / Legacy-Hinweis:** Diese Datei beschreibt die ältere Tauri-Wrapper-/Remote-WebView-Phase vor dem 2.0-Native-Umbau. Sie ist nur noch historische Referenz und nicht die aktuelle Betriebs- oder Release-Doku. Aktuell sind `docs/architecture.md`, `docs/native-apps-clean-architecture.md`, `docs/workflow.md` und `docs/testing.md`.

Status: produktiver Tauri-Wrapper für `nia-todo` ab `v1.5.1`; native lokale Reminder ab `v1.6.0`.

## Ziel

Die bestehende Web-App läuft zusätzlich als native Windows-App und Android-App. Beide Wrapper laden die gewählte Server-Web-App in der Tauri-WebView. Native Features wie lokale Reminder, Tray/Hotkeys und Android-Systemintegration liegen im Tauri-/Android-Layer; Browser/PWA-Push bleibt Browser/PWA-only.

Wichtig:

- Keine fest eingebaute Standard-URL.
- Beim ersten Start wird lokal eine Server-URL eingegeben.
- Die URL wird lokal in der App gespeichert.
- In den App-Einstellungen kann die Server-URL geändert oder zurückgesetzt werden.
- Web-App-Releases brauchen keinen neuen Tauri-Installer, solange keine nativen Features geändert werden.
- Native Wrapper hängen beim Start einen `nativeApp=tauri` Launch-Parameter an.
- Der Service Worker bleibt auch in nativen Wrappern aktiv, damit Offline-Cold-Starts funktionieren; native Wrapper aktivieren wartende Service-Worker-Updates automatisch.
- Native Apps verlassen sich für Todo-Erinnerungen nicht auf Server-/WebSocket-Push, sondern planen bekannte Reminder-Zeitpunkte lokal.

## Plattformen

### Windows

- Lokale Server-Auswahl vor dem Login
- Native Windows-Benachrichtigungen über Tauri
- Lokaler Reminder-Scheduler im laufenden App-/Tray-Prozess
- Tray-Icon mit Öffnen/Beenden
- Optional Close-to-tray
- Optional Autostart per Windows-Registry `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`
- Globale Hotkeys für App anzeigen/verstecken, neues Todo und Suche
- Fenstergröße, Position und maximierter Zustand werden lokal wiederhergestellt

### Android

- Lokale Server-Auswahl wie Windows
- Keine Desktop-only Optionen wie Tray, Autostart oder globale Hotkeys
- Native Benachrichtigungen über AndroidX `NotificationCompat`
- Lokaler Reminder-Scheduler über `AlarmManager`
- Persistierte Reminder werden nach `BOOT_COMPLETED` neu geplant
- Runtime-Permission `POST_NOTIFICATIONS`
- Android-App-ID: `de.tobiaskneidl.nia_todo`
- Android-Notification-Aktion „Erledigt“ markiert Todos offline lokal per IndexedDB-Single-Shot und schreibt eine SyncQueue-Änderung; aktuell ohne Web-Undo-Toast
- Native WindowInsets/Systembar-Behandlung, damit die App nicht unter die Statusbar rutscht
- Launcher-/Task-Switcher-Icons werden aus den Web-App-Icons erzeugt
- Eigenes monochromes Small-Notification-Icon

## Downloads

Der normale Browser zeigt Download-Buttons für Windows und Android nebeneinander. Tauri-App, PWA und Standalone-Modus blenden diese Downloads aus.

Live-Dateien:

```text
web/downloads/app-downloads.json
web/downloads/nia-todo-vX.Y.Z-windows-x64-setup.exe
web/downloads/nia-todo-vX.Y.Z-android-arm64.apk
```

Download-Buttons nutzen feste SVG-Logos:

```text
web/static/icons/platform/windows.svg
web/static/icons/platform/android.svg
```

## Release-Build

Der normale Release läuft über:

```bash
./release.sh VERSION
```

Das Script erledigt:

1. Tests
2. Release-Version in Web/Tauri setzen
3. Windows-Installer bauen
4. Android-APK bauen, zipalignen, signieren und verifizieren
5. `develop` nach `main` mergen
6. Tag erstellen
7. Live auf Tag aktualisieren
8. Downloads und Manifest veröffentlichen
9. Live/Dev Services neu starten
10. `develop` auf nächste `-dev` Version setzen

In nativen Tauri-Wrappern bleibt der PWA-Service-Worker aktiv. Das ist für Offline-Cold-Start nötig, weil die WebView nach dem ersten Laden die App-Shell aus dem Cache starten kann. Wartende Service-Worker-Updates werden in nativen Wrappern automatisch aktiviert, damit APK-/Installer-Updates nicht dauerhaft altes Web-JS ausführen.

Native Reminder-Architektur:

- Browser/PWA: WebPush/Service-Worker-Push bleibt zuständig.
- Windows/Tauri: Web-UI übergibt zukünftige Reminder an `desktop_schedule_reminders`; Rust plant sie lokal im laufenden Prozess.
- Android/Tauri: Web-UI übergibt zukünftige Reminder über `NiaAndroidNative.scheduleReminders`; `ReminderReceiver` plant sie mit `AlarmManager` und stellt sie nach Geräte-Neustart wieder her.
- Native Apps melden keine serverseitige WebSocket-Reminder-Bereitschaft mehr an.

## Android Signing

Ab `v1.5.1` wird Android mit dauerhaftem Release-Key signiert.

```text
Keystore: $NIA_TODO_SECRETS_DIR/nia-todo-android-release.keystore
Passfile: $NIA_TODO_SECRETS_DIR/nia-todo-android-release.pass
Alias: nia-todo-android-release
Certificate SHA-256: 900e26cd40b8bf42a65b98028aa5439f6a72741555fe26c485b834e3b197e058
```

Dieser Key ist Teil der Android-Update-Kette und der Android-Passkey-Vertrauensbindung via Digital Asset Links. Wenn er verloren geht oder gewechselt wird, können bestehende Installationen nicht per normalem Update überinstalliert werden; zusätzlich müssten Server-Doku/AssetLinks und erlaubte Android-App-Origins migriert werden.

Die test-signierte `v1.5.0` APK sollte nicht als Basis genutzt werden; falls installiert, einmal deinstallieren und ab `v1.5.1` neu installieren.

## Build-Toolchain

Benötigt auf dem OpenClaw-Host:

- Rust stable via `rustup`
- Target `x86_64-pc-windows-msvc`
- `cargo-xwin`
- `nsis`
- `llvm` / `lld` / `clang`
- OpenJDK 21
- Android SDK Command Line Tools
- Android SDK Platform/Build Tools 35/36
- Android NDK `27.0.12077973`
- Rust Android Targets: `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android`

## Wichtige Dateien

- `src-tauri/tauri.conf.json` — Tauri-Konfiguration
- `src-tauri/Cargo.toml` — Rust/Tauri-App
- `src-tauri/src/lib.rs` — Native Commands, Tray, Hotkeys, Notifications
- `src-tauri/capabilities/default.json` — Tauri Capability/ACL
- `src-tauri/gen/android/app/build.gradle.kts` — Android Namespace/Application-ID
- `src-tauri/gen/android/app/src/main/AndroidManifest.xml` — Android Permissions/Activity
- `web/static/js/features/desktop-integration.js` — Native App Integration im Web-UI
- `web/static/js/features/app-downloads.js` — Browser-only Download-Buttons
