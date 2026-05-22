# Windows App Changelog

Alle wichtigen Änderungen am nativen Windows-/Tauri-Wrapper werden in dieser Datei dokumentiert.

Die Windows-App hat eine eigene Versionierung, getrennt von der Web-App-Version in `CHANGELOG.md`.

## [1.7.0] - 2026-05-22

### Added
- Letzte gemeinsame App-Version vor entkoppeltem Release-Takt.
- Installierte Windows-App-Version wird im Sidebar-Footer angezeigt.

### Changed
- Windows-App nutzt künftig eine eigenständige native Versionsnummer im Release-Flow.
- Web-App-Updates werden verpflichtend über ein Fullscreen-Modal aktiviert.

## [1.6.6] - 2026-05-22

### Added
- Native App-Version ist von der Web-App-Version entkoppelt.
- Windows-App stellt ihre installierte Version für den Web-Update-/Download-Check bereit.
- App-Download-Hinweis zeigt verfügbare native Updates mit Downloadbutton an.

### Changed
- Release-Artefakte verwenden die eigenständige Windows-App-Version statt der Web-App-Version.
