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

## Sync

- lokale Änderungen gehen in eine Sync-Queue
- WebSocket/Sync halten lokale Daten und Serverzustand zusammen

## Auth

- JWT / Session-Token
- CSRF-Schutz
- API-Keys für externe Nutzung
