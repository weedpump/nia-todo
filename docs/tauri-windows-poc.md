# Tauri Windows/Android PoC

Status: erster testbarer Windows- und Android-Wrapper für `nia-todo`.

## Ziel

Die bestehende Web-App soll als native Windows-App testbar werden, zunächst ohne Umbau der eigentlichen UI.

Der PoC startet mit einem lokalen Server-Auswahlfenster.

- Es gibt keine fest eingebaute Standard-URL.
- Beim ersten Start muss eine Server-URL eingegeben werden, z.B. `https://todo-dev.kneidl-home.de` oder `https://todo.kneidl-home.de`.
- Die URL wird lokal in der Tauri-App gespeichert und kann später in den Desktop-Einstellungen geändert oder zurückgesetzt werden.

Damit bleibt die API relativ zur jeweils geladenen Web-App nutzbar und Login/Session-Verhalten entspricht dem gewählten Server.

## Desktop-Features im PoC

- Lokale Server-Auswahl vor dem Web-App-Login
- Tray-Icon mit Öffnen/Beenden
- Fenster schließen minimiert optional ins Tray statt die App zu beenden
- Autostart kann per Windows-Registry `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run` gesetzt werden
- Native Windows-Benachrichtigungen laufen über Tauri statt Browser-Web-Push
- Reminder werden per bestehender WebSocket-Verbindung als `reminder_due` an angemeldete Desktop-Clients verteilt

## Android-Features im PoC

- Android-App nutzt dieselbe lokale Server-Auswahl wie der Windows-Wrapper.
- Es gibt keine fest eingebaute Standard-URL.
- Desktop-spezifische Features wie Tray, Close-to-tray und Autostart werden auf Android nicht angezeigt.
- Die App ist als `arm64`-APK gebaut und test-signiert.
- Native Benachrichtigungen sind über das Tauri-Notification-Plugin vorbereitet; Android fragt dafür `POST_NOTIFICATIONS` an.

## Struktur

- `src-tauri/tauri.conf.json` — Tauri-Konfiguration
- `src-tauri/Cargo.toml` — Rust/Tauri-App
- `src-tauri/Cargo.lock` — reproduzierbarer Rust-Dependency-Lock
- `src-tauri/src/lib.rs` / `main.rs` — minimale App-Hülle
- `src-tauri/capabilities/default.json` — Default Capability
- `src-tauri/icons/icon.ico` — Windows-App-Icon
- npm Scripts:
  - `npm run tauri:info`
  - `npm run tauri:dev`
  - `npm run tauri:build`

## Build auf dem OpenClaw-Host

Windows-Cross-Build wurde auf Debian mit dem offiziellen Tauri-v2-Weg gebaut:

```bash
npm run tauri:build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
```

Ergebnis:

```text
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/nia-todo_1.3.6_x64-setup.exe
```

SHA256:

```text
faf617c4484033ebc1f58d612d6796b8150bf3a09a081bb57a6ca35e46686afe
```

Hinweis: Der Installer ist nicht signiert, weil Code-Signing auf diesem Host nicht eingerichtet ist. Windows SmartScreen kann deshalb warnen.

Android-Build auf demselben Host:

```bash
export ANDROID_HOME=/opt/android-sdk
export ANDROID_SDK_ROOT=/opt/android-sdk
export NDK_HOME=/opt/android-sdk/ndk/27.0.12077973
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$HOME/.cargo/bin:$PATH"
export CARGO_BUILD_JOBS=1
export GRADLE_OPTS='-Xmx1536m -Dorg.gradle.workers.max=1 -Dkotlin.compiler.execution.strategy=in-process'
export RUSTFLAGS='-C codegen-units=1'
npx tauri android build --apk --target aarch64 --ci
```

Ergebnis:

```text
src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
```

Für Tests wird das APK lokal mit dem Test-Key unter `$NIA_TODO_SECRETS_DIR/` signiert und als Artefakt abgelegt.

## Host-Toolchain

Installiert/benötigt für Cross-Build:

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

## Nächste Schritte

Nach dem Funktionstest auf Windows können native Features schrittweise ergänzt werden:

- Tray Icon
- Close-to-tray
- globale Hotkeys
- Autostart
- Settings-Schalter nur im Tauri-Kontext

## Offene Architekturfrage

Aktuell lädt der Wrapper remote/LAN-URLs. Das ist für PoC gut, aber für eine richtige Desktop-App gibt es zwei Optionen:

1. Remote/LAN-App laden — klein, immer aktuell, braucht Server erreichbar.
2. Frontend lokal bundlen und API-Basis-URL konfigurieren — robuster unterwegs, braucht kleine API-Konfig im Frontend.
