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

## Auth

- JWT / Session-Token
- CSRF-Schutz für Browser-Sessions
- API-Keys für externe Nutzung nur via `Authorization: ApiKey ...` oder `X-API-Key`
- Benutzer sehen eigene Daten plus akzeptierte Shared-Projekte
- Shared-Projektzugriff wird in Projekten, Todos, Sections, Reminders und WebSocket-Payloads geprüft
