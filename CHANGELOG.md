# Changelog

Alle wichtigen Änderungen an diesem Projekt werden in dieser Datei dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.0.0/),
und dieses Projekt hält sich an [Semantic Versioning](https://semver.org/lang/de/spec/v2.0.0.html).

## [1.2.0] - 2026-05-21

### Added
- **Avatar-/User-Menü oben rechts** als neuer Ort für globale Aktionen
  - Einstellungen, Theme, Sortierung, erledigte Todos ausblenden und Logout im kompakten Menü
  - Alter Sidebar-User-Footer wurde entfernt
- **Benutzerprofil im Settings-Modal**
  - Username wird read-only angezeigt
  - Anzeigename ist inline wie die E-Mail bearbeitbar
  - E-Mail und Profil laden beim Öffnen frische `/api/me` Daten
- **Avatar-Upload über Settings**
  - Runder Cropper mit Drag, Pinch-to-Zoom auf Mobile und Mausrad-/Trackpad-Zoom auf Desktop
  - JPEG/PNG/WebP/GIF sowie HEIC/HEIF als Upload-Formate
  - HEIC/HEIF wird serverseitig verarbeitet, wenn der Browser keine Vorschau unterstützt
  - Gespeichert wird immer WebP unter `api/data/avatars/`; die DB speichert nur URL und Änderungszeitpunkt
- **Avatar-Backups**
  - Live-Backup sichert SQLite-DB, Metadaten und Avatar-Dateien gemeinsam als rotierendes ZIP pro Slot

### Changed
- User-Menü-Textfarben normalisiert, damit aktive Toggle-Einträge optisch ruhig bleiben
- Settings-Profilbereich kompakter und sauberer angeordnet

### Fixed
- Undo für erneut geöffnete Todos stellt den vorherigen Status korrekt wieder her
- Avatar-Cropper zeigt Bilder auf Mobile korrekt an, statt wegen unsichtbarer Modal-Größe mit `scale(0)` zu starten
- Projekt-Modal kann ein Subprojekt wieder zurück auf „kein Eltern-Projekt“ setzen (`parent_id: null` wird jetzt übernommen)

## [1.1.0] - 2026-05-20

### Added
- **Passwort-Setup-/Reset-Links** für Benutzer-Onboarding
  - Admins erzeugen beim Benutzeranlegen automatisch einen einmaligen Setup-Link
  - Admins können jederzeit einen neuen Passwort-Link für bestehende Benutzer erzeugen
  - Öffentliche `/set-password` Seite zum Setzen des Passworts per Token
  - Tokens werden gehashed gespeichert, sind einmalig und 24 Stunden gültig
- **E-Mail-Adressen für Benutzer**
  - E-Mail ist für neue Benutzer und den ersten Setup-Benutzer Pflicht
  - Admin-UI zeigt E-Mail-Adressen in der Benutzerliste
  - Admins können E-Mail-Adressen inline per Stift/Haken/X bearbeiten
  - Benutzer können ihre eigene E-Mail im Einstellungsmodal inline bearbeiten
- **E-Mail-Validierung** in Backend, Admin-UI, Setup-UI und User-Settings

### Changed
- Admins setzen Benutzerpasswörter nicht mehr direkt; stattdessen werden Passwort-Links erzeugt
- User-Settings laden beim Öffnen frische `/api/me` Daten, damit Admin-Änderungen sofort sichtbar sind
- Admin-Benutzerliste vereinfacht: Status-Spalte entfernt, kompaktere E-Mail-Bearbeitung
- Settings-Modal aufgeräumt: Passwort-Button sitzt direkt in der Passwort-Section

### Fixed
- Todo-Erstellung übernimmt den gewählten Status korrekt und setzt `completed_at` bei direkt erledigten Todos
- Admin-Tabellenlayout läuft beim Inline-Bearbeiten nicht mehr aus dem Container
- Tabellen-Ellipsis erscheint nicht mehr fälschlich neben „Link erzeugen“

### Security
- Passwort-Setup-Token werden nur gehashed gespeichert und sind nach Nutzung ungültig
- E-Mail-Adressen müssen eindeutig und formal gültig sein
- `/api/password-setup/complete` ist explizit tokenbasiert öffentlich, bleibt aber CSRF-unabhängig begrenzt auf den einmaligen Token

## [1.0.0] - 2026-05-20

### Added
- **Projekt-Sharing**: Projekte können mit anderen Benutzern geteilt werden
  - Einladungen per Benutzername
  - Annahme/Ablehnung im UI
  - Owner-/Member-Rollen mit klarer Readonly-Ansicht für geteilte Projekte
  - Mitglieder entfernen, Projekt verlassen und Undo für beide Fälle
  - Owner-Metadaten (`owner_username`, `owner_display_name`) für geteilte Projekte
- **Stabile Inbox-Identität**: `projects.is_inbox` ersetzt harte Annahmen über Name oder ID
  - Jeder Benutzer hat eine eigene Inbox
  - Inbox darf umbenannt werden, bleibt aber geschützt
  - Migration repariert fehlende/kaputte Inbox-Zuordnungen und projektlose Todos
- **Frontend-Security-Test**: Neue Regressionstests für Markdown-XSS, Service-Worker API-Cache und Offline-Sync-Queue
- **Sharing-Frontend-Test**: Playwright-Test für Einladen, Member-Liste, Readonly-UI und Owner-Sichtbarkeit
- **Cold-Start Loading-Screen**: Zeigt beim App-Boot einen eigenen Ladezustand statt zu früher Loginmaske

### Changed
- **Projekt-Namen nur pro Benutzer eindeutig** statt global eindeutig
- **Todo-Default-Projekt**: Neue Todos ohne Projekt landen in der Inbox des aktuellen Benutzers
- **Login/Reload-Stabilität**: Server-Refresh rendert sofort und persistiert Projekte/Todos/Sections direkt in IndexedDB
- **PWA-Session**: User-Logins laufen 30 Tage und werden bei App-Öffnung automatisch verlängert, wenn sie bald ablaufen
- **Service Worker**: `/api/*` wird nicht mehr gecached, um Auth-/User-Datenleaks zu vermeiden
- **API-Key Auth**: CSRF-Bypass nur noch für `Authorization: ApiKey ...` oder `X-API-Key`; `Bearer nt_...` wird abgelehnt
- **Reminder/Deadline Eingaben**: Frontend- und Backendvalidierung für ungültige Datum-/Zeitwerte (`1900..9999`, gültige Uhrzeit)

### Fixed
- **Multi-User-Isolation**: Projekt-/Section-/Todo-/Reminder-Filter validieren Zugriff vor Datenabfrage
- **Shared Reminders**: Reminder sind benutzerspezifisch sichtbar und werden an den korrekten User dispatched
- **Projekt löschen**: Todos werden in die Inbox des jeweiligen Users verschoben, nicht hart auf Projekt-ID 1
- **Login Race**: Formular-Submit kann nicht mehr feuern, bevor die App-Module bereit sind
- **App Import Failure**: Dynamische Importfehler zeigen jetzt einen Fehlerzustand mit „Neu laden“ statt Endlosspinner
- **Markdown Rendering**: Token-Inhalte werden escaped, statt Regex-Reinjektion zu erlauben
- **Offline Sync Queue**: Payloads werden whitelisted/sanitized
- **Sharing UI Polish**: Inline-Invite-Fehler, dezente Member-Liste, kompakte Aktionsbuttons, sichtbare Owner-Info

### Security
- CSRF-Härtung für API-Key-Verwechslung (`Bearer nt_...`)
- IDOR-Schutz für fremde Projekt-/Section-Filter
- Kein authenticated API Response Caching im Service Worker
- Striktere Shared-Data-Isolation über REST und WebSocket

## [0.4.11] - 2026-05-20

### Architecture
- **Backend modularisiert**: Monolithisches `main.py` aufgeteilt in Router + Services
  - `api/routers/` — API-Endpunkte (auth, todos, projects, sections, push, admin, me, setup, dashboard, websocket, reminders)
  - `api/services/` — Geschäftslogik (auth, push, audit, utils, websocket)
  - `api/middleware/` — Security-Middleware (CSRF, Rate-Limiting)
  - `api/migrations/` — Versionierte DB-Migrationen
- **Frontend modularisiert**: Legacy-Inline-Skript ersetzt durch ES-Module-Architektur
  - `web/static/js/features/` — Isolierte Feature-Module (auth, sync, todos, projects, sections, drag-drop, toast-undo, push, theme, websocket, view-preferences, service-worker-updates, app-lifecycle, ui-shell, navigation, section-actions, todo-rendering, app-rendering, api-keys, user-settings, connection-status, legacy-globals)
  - `web/static/js/api/` — API-Clients (http, auth, todos, projects, sections, push)
  - `web/static/js/core/` — Config + Utilities
  - `web/static/js/storage/` — IndexedDB + App-Storage Wrapper

### Added
- **Test-Framework**: Frontend-Regressionstests mit Playwright (8 Module)
  - `scripts/test_all.sh` — Gesamtsuite (Backend + 8 Frontend-Tests)
  - `scripts/test_backend.py` — 40 API-Endpunkte mit automatischem DB-Backup/Restore
  - `scripts/test_frontend_smoke.mjs` — Login, Project, Section, Todo, Theme, Search, Delete, Undo
  - `scripts/test_frontend_app.mjs` — Todo-CRUD, Edit, Filter, Prio, Drag & Drop zwischen Sections
  - `scripts/test_frontend_setup.mjs` — Setup-Flow, Admin-Erstellung, Erst-User
  - `scripts/test_frontend_admin.mjs` — Admin-Login, User-Management, Passwort-Reset
  - `scripts/test_frontend_settings.mjs` — API-Keys, Push-Settings, Passwort-Änderung
  - `scripts/test_frontend_projects.mjs` — Project-CRUD, Subprojects, Farben
  - `scripts/test_frontend_dragdrop.mjs` — Drag & Drop zwischen Sections und Projekten
- **Doku**: Aufgeteilt in separate Dateien unter `docs/`
  - `docs/api.md` — Vollständige API-Dokumentation (Request/Response/Body/Beispiele)
  - `docs/testing.md` — Frontend- und Backend-Testanleitung
  - `docs/workflow.md` — Git-Workflow, Branches, Release-Prozess
  - `docs/architecture.md` — Frontend- und Backend-Architektur
- **Release-Gate**: `./scripts/test_all.sh` muss vor Tag/Merge grün sein

### Fixed
- **Startup-Performance**: `app.js` wird jetzt dynamisch nach DOMContentLoaded importiert
  - Reduziert blockierenden Initial-Load erheblich
- **Reload bleibt eingeloggt**: `startAppModule()` wird bei jedem Import explizit aufgerufen
  - Vorher: ESM-Cache verhinderte Neuausführung der Startup-Seiteneffekte
- **Service Worker**: Kein falscher Update-Hinweis bei Erstinstallation
  - Update-Button nur bei `controller` vor Registrierung + `waiting`-Worker
- **Service Worker**: Kein automatischer Reload-Loop beim ersten `controllerchange`
- **Auth**: Login-Flow stabilisiert gegen Timeouts bei Setup-/Auth-Checks
- **Settings-Test**: Push-Buttons robust gegen `display:none` im Test-Context
- **Section-DnD-UX**: Trennlinien nur noch beim Verschieben von Sections, Todo-Zonen nur beim Verschieben von Todos

## [0.4.10] - 2026-05-18

### Changed
- **Release-/Versionsupdate** auf `v0.4.10`
  - Versionstexte in UI, Frontend und Service Worker angehoben
  - Keine fachlichen Änderungen gegenüber `v0.4.9`

## [0.4.9] - 2026-05-17

### Added
- **Erledigte löschen**: Inline-Button neben "Neue Section" löscht alle done Todos im Projekt
  - Inklusive Subprojekten
  - Bestätigungsdialog mit Anzahl
  - **Batch-Undo**: Rückgängig-Machen stellt alle gelöschten Todos wieder her
- **Projekt merken**: Letztes ausgewähltes Projekt/Filter wird nach Reload wiederhergestellt
- **Shortcut 'n'**: Öffnet Todo-Modal und fokussiert direkt das Titel-Feld
- **Deadline & Überfälligkeit**: Zeigt wieder in Todo-Liste an (zweite Zeile)
- **Beschreibung**: Wird jetzt in Todo-Liste angezeigt (dritte Zeile, max. 12 Wörter)
- **Markdown Support**: Beschreibungen unterstützen **fett**, *kursiv*, `code`, - Listen, [Links](url)
- **Live Markdown Preview**: Echtzeit-Vorschau im Todo-Bearbeitungs-Modal

## [0.4.8] - 2026-05-16

### Added
- **Push Notifications**: Vollständige PWA-Benachrichtigungen für Todo-Erinnerungen
  - VAPID-basierte Web Push Notifications
  - Settings-UI mit Server-Status-Check (zeigt "inaktiv" wenn Subscription tot)
  - "Erledigt"-Action aus Notification markiert Todo direkt (App bleibt im Hintergrund)
  - Background Task prüft alle **30 Sekunden** auf fällige Reminders
  - Automatische Bereinigung: 14-tägiger Cleanup entfernt tote Subscriptions
  - Server-Status Endpoint: `GET /api/push/status`
- **UX-Verbesserung**: Neues Todo hat aktuelles Projekt vorausgewählt (oder Inbox)

### Fixed
- **Reminder löschen**: Erinnerung kann jetzt entfernt werden (Feld leer → löscht Reminder)
- **Sync-Duplikate**: Race-Condition für Todos, Sections und Projects behoben
- **Async Startup**: Background-Loop startet jetzt zuverlässig (vorher sync def mit asyncio.create_task)
- **Service Worker**: Ignoriert silent Health-Check Pushes (keine leeren Notifications)
- **Undo-Toast**: Toast-Notification ist jetzt mittig zentriert auf Mobile

### Removed
- Telegram-Reminder-Skripte (ersetzt durch Push Notifications)
- SECURITY_AUDIT Dateien (interne Debug-Dateien)

## [0.4.6] - 2026-05-16

### Fixed
- **Section-Broadcasts**: WebSocket-Broadcasts für Section-CRUD hinzugefügt
  - `section_create`, `section_update`, `section_delete` werden jetzt in Echtzeit an andere Geräte gesendet
  - Sections umbenennen/erstellen erscheint sofort auf allen verbundenen Geräten
- **Sync-Consistency**: `sync_response` merged Todos jetzt nur, wenn keine lokalen pending Updates existieren
  - Bisher konnte Server-Stand lokale Todo-Updates überschreiben (wie bei Projekten/Sections schon korrekt)
- **Project WS Handler**: `renderStats()` und `renderTodos()` werden bei `project_create`/`project_update` aufgerufen
  - Todo-Ansicht zeigt sofort aktualisierte Projekt-Namen/Farben ohne View-Wechsel

## [0.4.5] - 2026-05-16

### Fixed
- **CSRF-Cookie-Support**: `credentials: 'include'` zu allen `fetch()`-Aufrufen hinzugefügt
  - Alle schreibenden Operationen (PATCH, POST, DELETE) funktionieren jetzt korrekt
  - Projekt-Umbenennungen, Farbänderungen, Todo-Updates etc. werden jetzt zum Server synchronisiert
  - Login/Logout/API-Keys ebenfalls gefixt
- **Migration 008**: `updated_at` Spalte zu `sections` hinzugefügt (für Offline-Sync)

## [0.4.4] - 2026-05-16

### Added
- **Sections Offline-First**: CREATE/UPDATE/DELETE Sections funktioniert jetzt offline mit Sync-Queue
  - `updated_at` Spalte zu `sections` hinzugefügt
  - Merge-Logik für Sections bei Server-Refresh (wie Todos/Projekte)
  - Sync-Queue Handler: `CREATE_SECTION`, `UPDATE_SECTION`, `DELETE_SECTION`

### Fixed
- **Project-Sync**: Offline umbenannte Projekte werden nicht mehr vom Server überschrieben
  - `updated_at` Vergleich + pending-changes-Check für Projekte in `refreshFromServer()`
- **Mobile Scroll**: Letztes Todo wird nicht mehr abgeschnitten in der PWA
  - `100dvh` statt `100vh` für korrekte Viewport-Höhe
  - `padding-bottom` für Mobile Safe Areas
  - Toast-Position berücksichtigt jetzt `safe-area-inset-bottom`

## [0.4.3] - 2026-05-16

### Changed
- **Projekte alphabetisch sortiert**: Inbox (ID=1) immer zuerst, dann Custom-Projekte A→Z

## [0.4.2] - 2026-05-16

### Changed
- **Projekte alphabetisch sortiert**: Sidebar-Baum, Todo-Modal Dropdown und Projekt-Modal Dropdown sortieren jetzt nach Projektname (A→Z)

## [0.4.1] - 2026-05-16

### Added
- **3-State Checkbox**: Klick auf Checkbox toggled Offen → In Arbeit → Erledigt → Offen
- **Undo Toast**: "Rückgängig"-Button erscheint nach Erledigen/Löschen eines Todos (5s Timeout)
- **Sort-Toggle**: Sortierung in Topbar wechselt zwischen Reihenfolge / Priorität / Alphabetisch
- **Hide-Done Toggle**: Erledigte Todos app-wide ausblenden (localStorage)
- **Offline-Indikator**: Nur sichtbar bei Offline — dezenter roter Punkt, kein Text

### Changed
- **Theme Toggle**: Sidebar hat jetzt einen einzelnen Button statt drei (durchschaltet Light/Dark/System)
- **Kompakte Todos**: Prio-Emoji vor dem Titel, kein Projekt-Name mehr, eine Zeile pro Todo
- **Globale Ansichten**: Todos in All/Offen/In Arbeit/Erledigt jetzt nach Projekt gruppiert
- **Sections**: Minimaler Stil ohne Hintergrund/Border, kein Folder-Icon
- **Logout-Button**: Jetzt als Icon neben dem Settings-Icon in der Sidebar
- **Topbar**: Neue Toggle-Buttons (40×40) für bessere Ergonomie
- **"In Arbeit" über "Offen"**: Reihenfolge in globalen Ansichten geändert

## [0.4.0] - 2026-05-16

### Added
- **Multi-User Support**: Mehrere Benutzer mit eigenen Daten
- **JWT Authentication**: Bearer Token mit 1-Tag-Laufzeit, `token_version` für sofortiges Invalidieren aller Sessions
- **Admin Setup** (`/setup`): Admin-Passwort setzen + ersten Benutzer erstellen
- **Admin Panel** (`/admin`): Benutzer anlegen, löschen, Passwörter zurücksetzen
- **Passwort-Management**:
  - Benutzer kann eigenes Passwort ändern (Einstellungen-Modal)
  - Admin kann eigenes Passwort ändern
  - Admin kann Benutzer-Passwörter zurücksetzen
  - Console-Notfall-Reset: `api/change_admin_password.py`
- **Passwort-Stärke-Validierung**: Admin 12+ Zeichen, Benutzer 8+ Zeichen (Groß-/Kleinbuchstabe, Ziffer, Sonderzeichen)
- **Theme Toggle**: Light/Dark/System mit localStorage-Persistenz
- **Daten-Isolation**: Benutzer sehen nur ihre eigenen Projekte, Todos und Sections
- **IndexedDB-Cache-Sicherheit**: Automatisches Löschen bei Logout/User-Wechsel
- **Migrationssystem erweitert**: 003_add_user_support.sql + 004_add_jwt_support.sql
- **API-Key-Authentifizierung**: Benutzer können in den Einstellungen API-Keys generieren
- **Rate-Limiting / Bruteforce-Schutz**: Login (5 Versuche / 15 Min), API (100 Requests / Min), WebSocket (max 10 pro IP)
- **CORS**: Erlaubte Origins `todo.kneidl-home.de` & `todo-dev.kneidl-home.de`
- **CSRF-Protection**: Double-Submit Cookie Pattern für alle state-changing Endpoints
- **Security Headers**: CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, HSTS
- **Audit-Log**: Sicherheitsrelevante Events werden protokolliert
- **Input-Sanitization**: HTML-Tags werden entfernt, Null-Bytes gestrippt
- **Input-Validierung**: Username (3-32 Zeichen, alphanumeric), Passwort-Länge, Text-Längenlimits

### Changed
- Sidebar zeigt immer vollständigen Projektbaum (keine Toggle-Buttons mehr)
- Admin-Panel mit eigener Login-Seite statt Browser-Prompt
- Inbox (id=1) geschützt: Kein Löschen, kein Parent-Dropdown, nicht als Parent auswählbar
- WebSocket Auth: Token wird als Message statt Query-Parameter gesendet
- JWT-Ablaufzeit: 7 Tage → 1 Tag
- OpenAPI docs deaktiviert in Produktion
- **UI**: Admin-Link aus Sidebar entfernt (nur direkte URL /admin)
- **UI**: Abmelden-Button als Icon neben Einstellungen, kompaktere User-Bar

### Security
- **SQL Injection** in `update_todo` und `update_project` behoben (Column-Whitelist)
- **XSS** in Frontend und Admin-Panel behoben (`escapeHtml`, `escapeHtmlAttr`)
- **Path Traversal** in SPA-Route behoben (`PurePath.name`)
- **User-Löschung** löscht jetzt alle Benutzerdaten (Cascade)
- **Setup-Admin** kann nicht mehrfach ausgeführt werden
- **X-Forwarded-For** wird nur von internen Proxies vertraut

## [0.3.3] - 2026-05-15

### Added
- **Theme-Support**: Light/Dark/System-Theme mit Toggle in Sidebar
- Theme-Einstellung wird in localStorage gespeichert
- Theme reagiert live auf System-Theme-Änderungen ("System"-Modus)

## [0.3.2] - 2026-05-15

### Added
- CHANGELOG.md mit vollständiger Versionshistorie

### Fixed
- Section-Button wird jetzt **immer** angezeigt (auch in leeren Projekten)
- Empty-State überschreibt nicht mehr den "Neue Section"-Button

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
