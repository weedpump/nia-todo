# Tauri Windows PoC

Status: erster Wrapper-Prototyp für `nia-todo`.

## Ziel

Die bestehende Web-App soll als native Windows-App testbar werden, zunächst ohne Umbau der eigentlichen UI.

Der PoC lädt:

- im Dev-Modus: `http://localhost:8754`
- im Build/Bundle-Modus: `http://todo-dev.kneidl-home.de:8753`

Damit bleibt die API relativ zur geladenen Web-App nutzbar und Login/Session-Verhalten entspricht der normalen App.

## Struktur

- `src-tauri/tauri.conf.json` — Tauri-Konfiguration
- `src-tauri/Cargo.toml` — Rust/Tauri-App
- `src-tauri/src/lib.rs` / `main.rs` — minimale App-Hülle
- `src-tauri/capabilities/default.json` — Default Capability
- npm Scripts:
  - `npm run tauri:info`
  - `npm run tauri:dev`
  - `npm run tauri:build`

## Ergebnis auf dem OpenClaw-Host

`npm run tauri:info` erkennt die Konfiguration, meldet aber fehlende native Toolchain/Dependencies:

- `rustc`: fehlt
- `cargo`: fehlt
- `webkit2gtk-4.1`: fehlt
- `rsvg2`: fehlt

`npm run tauri:build` bricht deshalb erwartbar bei `cargo metadata` ab.

## Nächste Schritte für echten Windows-Test

Auf Windows benötigt man:

1. Rust via rustup
2. Microsoft C++ Build Tools
3. WebView2 Runtime
4. Node/npm
5. Repo auschecken
6. `npm install`
7. `npm run tauri:dev` oder `npm run tauri:build`

Danach können die nativen Features schrittweise ergänzt werden:

- Tray Icon
- Close-to-tray
- globale Hotkeys
- Autostart
- Settings-Schalter nur im Tauri-Kontext

## Offene Architekturfrage

Aktuell lädt der Wrapper remote/LAN-URLs. Das ist für PoC gut, aber für eine richtige Desktop-App gibt es zwei Optionen:

1. Remote/LAN-App laden — klein, immer aktuell, braucht Server erreichbar.
2. Frontend lokal bundlen und API-Basis-URL konfigurieren — robuster unterwegs, braucht kleine API-Konfig im Frontend.
