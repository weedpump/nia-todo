# Android App Changelog

Alle wichtigen Änderungen am nativen Android-/Tauri-Wrapper werden in dieser Datei dokumentiert.

Die Android-App hat eine eigene Versionierung, getrennt von der Web-App-Version in `CHANGELOG.md`.

## [1.6.6] - 2026-05-22

### Added
- Native App-Version ist von der Web-App-Version entkoppelt.
- Android-App stellt ihre installierte Version über die native JavaScript-Bridge für den Web-Update-/Download-Check bereit.
- App-Download-Hinweis zeigt verfügbare native Updates mit Downloadbutton an.

### Changed
- Release-Artefakte verwenden die eigenständige Android-App-Version statt der Web-App-Version.
