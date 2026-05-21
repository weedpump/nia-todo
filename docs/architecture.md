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

- Windows und Android laufen als Tauri-Wrapper um die Web-App.
- Browser/PWA-Push bleibt Browser/PWA-only.
- Native Apps planen Todo-Erinnerungen lokal, weil die Reminder-Zeitpunkte bekannt sind.
- Windows plant Reminder im laufenden Tauri-Prozess; Tray/Autostart halten den Prozess verfügbar.
- Android plant Reminder über `AlarmManager`; geplante Reminder werden persistiert und nach Geräte-Neustart neu registriert.
- Android „Erledigt“ aus der Benachrichtigung markiert das Todo offline lokal in IndexedDB und schreibt eine SyncQueue-Änderung für spätere Synchronisation.
- Der Service Worker bleibt auch in nativen Wrappern aktiv, damit Offline-Cold-Starts funktionieren; native Wrapper aktivieren Updates automatisch.

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
