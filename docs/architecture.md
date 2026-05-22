# Architektur

## Stack

- FastAPI
- SQLite
- Vanilla JS Frontend
- Offline-PWA

## Bereiche

- `api/` -> Backend und Datenzugriff
- `web/` -> UI, Service Worker, Manifest
- `scripts/` -> Tests und Helfer
- `systemd/` -> Services für Live/Dev

## Datenmodell

- Jeder Benutzer hat eine eigene Inbox (`projects.is_inbox = 1`), unabhängig vom Projektnamen
- Projekt-Namen sind pro Benutzer eindeutig, nicht global
- Geteilte Projekte werden über `project_members` verwaltet (`pending`, `accepted`, `removed`, `left`, `declined`)

## Sync

- lokale Änderungen gehen in eine Sync-Queue
- WebSocket/Sync halten lokale Daten und Serverzustand zusammen
- Server-Refresh schreibt den autoritativen Zustand direkt in IndexedDB, damit Reloads nach Login stabil bleiben

## Native Apps

Die Native-Apps-Architektur wird nach Generic Server Config sauber neu geplant/umgebaut. Ziel ist keine reine Remote-WebView, sondern eine offline-robuste native App mit lokal verfügbarem UI-Shell, konfigurierbarer Remote-API und späterer Server-Verifikation über `/api/instance`.

Aktueller Plan: [Native Apps Clean Architecture Plan](native-apps-clean-architecture.md)

Bestands-/Legacy-Kontext:

- Vorhandene Tauri-Dateien und die ältere Tauri-Doku dürfen nicht blind als Zielarchitektur gelten.
- Tauri kann als Runtime erneut entschieden werden, aber Änderungen aus verworfenen Branches werden nicht übernommen.
- Browser/PWA-Push bleibt Browser/PWA-only; native lokale Reminder werden separat geplant.
- Offline-Cold-Start ist ein hartes Merge-Kriterium und muss auf Windows und Android manuell getestet werden.

## Auth

- JWT / Session-Token
- User-Sessions laufen 30 Tage und werden über `/api/me` gleitend verlängert, wenn sie bald ablaufen
- Admin-Sessions sind kürzerlebig und separat versioniert
- CSRF-Schutz für Browser-Sessions
- API-Keys für externe Nutzung nur via `Authorization: ApiKey ...` oder `X-API-Key`
- Benutzer sehen eigene Daten plus akzeptierte Shared-Projekte
- Shared-Projektzugriff wird in Projekten, Todos, Sections, Reminders und WebSocket-Payloads geprüft

## Benutzer-Onboarding

- E-Mail-Adressen sind für neue Benutzer Pflicht, werden validiert und eindeutig gehalten
- Bestehende Benutzer ohne E-Mail bleiben migrierbar; Admin oder Benutzer können die Adresse nachtragen
- Admins setzen Benutzerpasswörter nicht direkt
- Neue Benutzer erhalten einen einmaligen Passwort-Setup-Link (`password_setup_tokens`)
- Passwort-Setup-/Reset-Links sind 24 Stunden gültig und werden gehashed gespeichert
- Benutzer können ihre eigene E-Mail und ihren Anzeigenamen im Settings-Modal ändern; der Username bleibt unveränderlich
- Avatar-Bilder liegen als WebP-Dateien unter `api/data/avatars/`, die Datenbank speichert nur URL und Änderungszeitpunkt
- Avatar-Uploads akzeptieren JPEG/PNG/WebP/GIF sowie HEIC/HEIF; HEIC wird serverseitig über `pillow-heif` oder `heif-convert` verarbeitet, wenn der Browser keine Vorschau/Crop unterstützt
- Live-Backups sichern SQLite-DB, `metadata.json` und `api/data/avatars/` gemeinsam als rotierendes `nia-todo-live-daily-slot-XX.zip`
