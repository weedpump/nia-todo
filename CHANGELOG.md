# Changelog

Alle wichtigen Änderungen an diesem Projekt werden in dieser Datei dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.0.0/),
und dieses Projekt hält sich an [Semantic Versioning](https://semver.org/lang/de/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-05-15

### Added
- Automatisches Hochzählen der Dev-Version nach Release (release.sh)
- DB-Backup vor Live-Upgrade (timestamped backups in api/data/backups/)

### Changed
- Sidebar zeigt immer vollständigen Projektbaum (keine Toggle-Buttons mehr)
- Inbox ist geschützt: Kein Löschen, kein Parent-Dropdown, nicht als Parent auswählbar

### Fixed
- Projekt-Löschen wurde nicht synchronisiert (DELETE_PROJECT Handler fehlte)
- Doppelte Projekte nach Erstellen (temp-ID Cleanup)
- Doppelte Todos nach Erstellen (temp-ID + WS Handler Fix)
- Dropdown-Einrückung für Sub-Subprojects (Non-Breaking Spaces)
- Projektbaum im Todo-Modal Dropdown

## [0.3.0] - 2026-05-15

### Added
- **Subproject-Support**: Projekte können jetzt Eltern-Projekte haben
- `parent_id` Spalte in `projects` Tabelle
- Baumstruktur in Sidebar mit Einrückung
- Rekursive Todo-Zählung in Subprojects
- Cascade-Delete: Löschen eines Parents löscht alle Children
- Zyklus-Erkennung: Verhindert zirkuläre Abhängigkeiten
- Migrationssystem: 001_initial_schema.sql + 002_add_project_parent_id.sql

### Changed
- Projekt-Modal: Parent-Dropdown mit Baumstruktur
- API erweitert: create/update/delete mit `parent_id`
- `db.py`: `UNIQUE(name, parent_id)` statt `UNIQUE(name)`

### Fixed
- Dropdown-Anzeige für verschachtelte Subprojects
- Live-Upgrade: Migration 002 fügt `parent_id` sicher hinzu

## [0.2.17] - 2026-05-14

### Added
- Offline-First PWA mit IndexedDB
- WebSocket Echtzeit-Sync
- Service Worker mit Update-Mechanismus
- Sync-Queue für Offline-Änderungen

### Fixed
- Verschiedene UI-Bugs

## [0.2.0] - Früher

### Added
- Grundlegende Todo-Verwaltung
- Projekte und Sections
- Prioritäten und Fälligkeitsdaten
- Reminder-Funktion
- Dark Mode UI
