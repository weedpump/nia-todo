# Tauri Windows PoC

Status: erster testbarer Windows-Wrapper für `nia-todo`.

## Ziel

Die bestehende Web-App soll als native Windows-App testbar werden, zunächst ohne Umbau der eigentlichen UI.

Der PoC lädt:

- im Dev-Modus: `http://localhost:8754`
- im Build/Bundle-Modus: `http://todo-dev.kneidl-home.de:8753`

Damit bleibt die API relativ zur geladenen Web-App nutzbar und Login/Session-Verhalten entspricht der normalen App.

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
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/nia-todo_1.3.2_x64-setup.exe
```

SHA256:

```text
faf617c4484033ebc1f58d612d6796b8150bf3a09a081bb57a6ca35e46686afe
```

Hinweis: Der Installer ist nicht signiert, weil Code-Signing auf diesem Host nicht eingerichtet ist. Windows SmartScreen kann deshalb warnen.

## Host-Toolchain

Installiert/benötigt für Cross-Build:

- Rust stable via `rustup`
- Target `x86_64-pc-windows-msvc`
- `cargo-xwin`
- `nsis`
- `llvm` / `lld` / `clang`

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
