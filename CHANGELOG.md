# Changelog

Alle wichtigen Änderungen an diesem Projekt werden in dieser Datei dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.0.0/),
und dieses Projekt hält sich an [Semantic Versioning](https://semver.org/lang/de/spec/v2.0.0.html).

## [2.1.0] - 2026-05-24

### Added
- Öffentlicher Changelog unter `/changelog` ergänzt; die App verlinkt ihn im Versionsbereich der Sidebar.
- Windows-App kann beim Autostart optional direkt minimiert im Tray starten, ohne das Hauptfenster zu öffnen.
- Geteilte Projekte können pro Mitglied einem eigenen Anzeige-Workspace zugeordnet werden; standardmäßig landen sie im Default-Workspace.

### Fixed
- Geteilte Projekte erscheinen nicht mehr in jedem Workspace und Member können Projekt-Icons nicht mehr lokal scheinbar ändern.
- Avatar kann in den Profileinstellungen wieder gelöscht werden; UI, API und gespeicherter User-State fallen danach sauber auf Initialen zurück.
- Neuer-Todo-Dialog fokussiert beim Öffnen per `N`-Taste oder nativem Desktop-Hotkey direkt das Titelfeld.
- Native Apps aktualisieren die Instanz-Konfiguration vor der Update-Prüfung erneut, damit eine frisch erhöhte `min_native_client_version` nicht durch stale Boot-Daten als optionales Update behandelbar bleibt.

### Changed
- Öffentliche API-Dokumentation nutzt neutrale Demo-Beispieldaten statt nutzer- oder instanzspezifischer Namen, E-Mails, URLs und SMTP-Beispielwerte.

## [2.0.1] - 2026-05-24

### Fixed
- MFA-Login bietet bei Accounts mit Passkey und Authenticator/Recovery-Code wieder beide Methoden an; Native Apps bevorzugen den Code-Flow, damit Desktop-/Android-Passkey-Einschränkungen keine Login-Sackgasse erzeugen.
- App-Download-Manifest und Download-Artefakte werden im Service Worker aktiv als `never-cache` behandelt und aus alten Caches entfernt, damit veraltete APK-/Installer-Links nicht weiter angezeigt werden.
- Avatar-URLs werden in Native Apps relativ zur konfigurierten Server-URL aufgelöst, sodass Profilbilder nicht gegen die lokale App-Shell-Origin geladen werden.
- Release-Script wartet beim optionalen Setzen von `min_native_client_version` auf die live migrierte `app_config`-Tabelle.

## [2.0.0] - 2026-05-24

### Fixed
- Release-Version-Checker validiert SemVer strenger und deckt `min_native_client_version`-Grenzen per Regressionstest ab.
- Android-Release setzt generated `tauri.properties` vor dem APK-Build deterministisch, damit alte generated Versionen keinen späten Build-Fail verursachen.
- Native App-Update-Hinweise können bei optionalen Updates bis zum nächsten Appstart verschoben werden; nur eine erhöhte `min_native_client_version` erzwingt das Update.
- Release-Versionierung gehärtet: Web-, Service-Worker-, Tauri- und Cargo-Versionen werden konsistent gesetzt; `min_native_client_version` bleibt eine bewusst gepflegte Kompatibilitätsgrenze.
- Release-Script hebt `min_native_client_version` nur noch mit explizitem `--set-min-app-version` an; Standard-Releases bleiben damit native-app-kompatibel.
- Android-Release validiert jetzt neben `versionName` auch den erwarteten `versionCode`.
- Fehlendes Native-Download-Manifest erzeugt keinen 404-/Console-Noise mehr, sondern liefert ein leeres Manifest mit HTTP 200.

### Added
- Workspaces als neue Anzeige-/Organisationsschicht für Projekte und Todos ergänzt.
- Jeder Nutzer erhält einen Default-Workspace `Privat`; bestehende Projekte werden dorthin migriert.
- Jeder Workspace besitzt eine eigene Inbox; bestehende und neue Workspace-Daten bleiben damit sauber getrennt.
- Workspace-Switcher mit Custom-Dropdown, Farbauswahl, Erstellen, Umbenennen und Löschen ergänzt.
- Lokales Lucide-SVG-Iconset als offline-/PWA-freundliche Icon-Basis ergänzt.
- Optionale Icons für Projekte und Workspaces ergänzt; gesetzte Icons nutzen die jeweilige Projekt-/Workspace-Farbe.
- Einklappbarer Icon-Picker mit Suche, Kategorien und allen lokal verfügbaren Lucide-Icons ergänzt.
- Lokale Designfarben-Presets im User-Menü ergänzt: Standard plus sechs Akzentdesigns für Hell- und Dunkeltheme.
- Lokaler Akzent-Intensitätsregler ergänzt, inklusive Option Akzentwirkung komplett auszuschalten.
- Neues App-eigenes Danger-Confirm-Modal für Löschen von Todos, Projekten, Sections und Workspaces.
- Frontend-/Backend-Regressionstests für Workspaces, Sharing, Workspace-Inboxes, Projektlöschung und Realtime-Sync ergänzt.
- Generische Instanz-Konfiguration für öffentliche Basis-URL, erlaubte Origins/CORS und Trusted Proxies ergänzt.
- Native Windows- und Android-Apps ergänzt, inklusive eigenem App-Update-Dialog mit externem Download-Button.
- Native App-Downloads werden über ein einheitliches Manifest mit Plattform-/Architektur-/Version-/SHA256-Validierung ausgeliefert.
- Öffentliche API-Dokumentation unter `/api` ergänzt; sie rendert die vorhandene `docs/api.md` leichtgewichtig als themekompatible HTML-Seite mit Suche, ohne Swagger/OpenAPI-UI.
- Native Drag & Drop nutzt einen Pointer-/Touch-Fallback statt Browser-HTML5-DnD und unterstützt Android-Scrollen ohne versehentliches Verschieben oder klebende Hover-Markierung.
- Native WebViews unterstützen Suche, Section-Enter und globale Tastaturpfade konsistent.
- Native Regressionstests für Runtime-Konfiguration, Offline-Start, Windows-Installer-Cache und Android-WebView-Cache ergänzt.
- **E-Mail/SMTP-Integration** für Einladungen, Passwort-Reset und E-Mail-Verifizierung ergänzt.
- **Admin-UI für SMTP-Konfiguration** mit Host, Port, Security (none/starttls/tls), Auth, Absender und Test-Mail-Funktion.
- **E-Mail-Vorlagen** für Setup-Link, Passwort-Reset, E-Mail-Verifizierung und Projekt-Sharing-Einladung.
- **Verifizierte E-Mail-Semantik**: Login, Passwort-Reset und Projekt-Sharing funktionieren nur mit verifizierten E-Mails.
- **E-Mail-Verifizierungs-Flow** mit Token-Hashing, Prefix-Lookup, TTL und sicherem Fallback bei SMTP-Ausfall.
- **Neutrale API-Responses** bei E-Mail-basierten Aktionen (Passwort-Reset, Einladung) zur Vermeidung von User-Enumeration.
- **Privacy-safe Member-Listen**: Pending Invites sind nur für den Invitee sichtbar, nicht für Owner oder andere Mitglieder.
- **WebSocket-Broadcasts** bei Einladungen nur an Invitee (ohne `project_id` im Payload), um Pending-Invite-Existenz nicht zu leaken.
- **Migrations 021–023** für SMTP-Konfiguration, case-insensitive E-Mail-Uniqueness und E-Mail-Trust-Source.
- **Zwei-Faktor-Authentifizierung (2FA)** mit TOTP/Authenticator-App, Passkeys/WebAuthn inkl. Passkey-Reauth, Recovery Codes, Login-Challenge-Flow mit Attempt-Lockout, optionalem „Gerät merken“ und E-Mail-Code als gültigem Faktor für Accounts ohne TOTP/Passkey ergänzt.
- **Passkeys produktionsgehärtet**: WebAuthn ist an HTTPS-`public_base_url` gebunden (`http` nur lokal), prüft Origin/RP-ID, User Verification, `none`-Attestation, Signaturen und Sign-Counter; Native Apps zeigen Passkeys erst nach separater nativer Passkey-Bridge.
- **Android Native Passkeys** ergänzt: die offizielle Android-App nutzt AndroidX Credential Manager über eine native Callback-Bridge, validiert konfigurierte Server-Origin/RP-ID vor der Credential-Ceremony und verwendet serverseitig ausgelieferte Digital Asset Links für die offizielle App-Signatur.
- **Official-App-Vertrauensmodell für Android** dokumentiert: Selfhoster hosten ihren Server und verbinden die offizielle App; eigene Package Names, F-Droid-/Re-Sign-Builds und Signing-Key-Rotation benötigen später eine explizite Config-/Migrationsstrategie.
- **2FA-Admin-Steuerung** ergänzt: globale 2FA-Pflicht, Benutzer-Status inkl. Faktoren/API-Key-Hinweis und Admin-Reset pro Benutzer.
- **2FA-/Reauth-Schutz** für sicherheitskritische Account-Aktionen ergänzt, u.a. E-Mail ändern, Passwort ändern, 2FA deaktivieren, Recovery Codes regenerieren, API-Key-Management und Passkey-Verwaltung; E-Mail-Code ist auch für Reauth nutzbar.
- **One-Time-MFA-Action-Grants** ergänzt: Login-MFA und Trusted Devices zählen nur für App-Zugriff, jede sensible Aktion benötigt eine frische, einmalig konsumierte MFA-Bestätigung.
- **2FA-Settings-UX** überarbeitet: TOTP-Setup mit QR-Code, Passkey-/TOTP-Gerätelisten mit Widerruf, App-eigene Sicherheitsdialoge statt Browser-`alert`/`prompt`/`confirm`, dynamische Reauth-Beschriftungen und theme-kompatible Eingabefelder.
- **2FA-Replay-/Race-Hardening** ergänzt: atomarer Challenge-Verbrauch, table-backed Recovery-Code-Verbrauch, single-use E-Mail-Reauth-Codes, TOTP-Reauth-Timestep-Schutz und atomare Passkey-Challenge-Verwendung.
- **Recovery-Code-Semantik** geschärft: Recovery Codes sind Backup-Faktoren zu TOTP/Passkey, werden beim Entfernen des letzten primären Faktors automatisch widerrufen und können nur mit aktivem primären Faktor neu erzeugt werden.
- **Migrations 024–028** für 2FA-Status, Challenges, Attempt-Lockout, Trusted Devices, Passkeys, One-Time-MFA-Grants, Recovery-Code-Zeilen und Replay-Schutz ergänzt.
- Konfigurierbarer `min_native_client_version`-Eintrag in `app_config` ergänzt, damit die native Kompatibilitätsgrenze explizit und migrationsgestützt gepflegt werden kann.

### Changed
- System-E-Mails nutzen ein gemeinsames, modernes HTML/Text-Template mit nia-todo Branding, Logo-Unterstützung und einheitlichen Aktionsbuttons.
- Projekt-, Todo-, Dashboard- und Section-Ansichten werden nach aktivem Workspace gefiltert; Benachrichtigungen, Reminder, Push und WebSocket-Sync bleiben global.
- UI-Emojis wurden durch konsistente SVG-Icons bzw. neutrale Status-Texte ersetzt.
- Neue Projekte werden im aktiven Workspace erstellt; Subprojekte müssen im selben Workspace wie ihr Parent bleiben.
- Geteilte Projekte werden im vom jeweiligen Mitglied gewählten Workspace angezeigt und sind dort im Todo-Modal auswählbar.
- Projektlöschung verschiebt enthaltene Todos in die Inbox desselben Workspaces statt pauschal in eine globale Inbox.
- Workspace-Löschung verschiebt Projekte und Workspace-Inbox-Todos in den Default-Workspace.
- Gleiche Projektnamen sind erlaubt; Projekt-Identität basiert auf IDs statt Namen.
- WebSocket-Sync aktualisiert Workspaces, Projektlöschungen, Child-Projekte und Sharing-Restore-Ereignisse robuster über mehrere Clients hinweg.
- Migrationslauf für Workspaces ist gegen partiell angewendete Workspace-Schema-Zustände robuster.
- Default-Workspace `Privat` erhält direkt das Home-Icon; Inbox-Projekte erhalten direkt das Inbox-Icon.
- Admin-, Setup-, Login- und Passwort-Dialoge wurden visuell auf das neue Button-/Icon-System angeglichen.
- Akzentfarben wirken nur in der Haupt-App; Setup-, Admin- und Passwortseiten bleiben beim neutralen Theme.
- Passwort-Setup-Links verwenden künftig die konfigurierte öffentliche Basis-URL statt implizit die Request-URL.
- CORS lehnt unbekannte Origins konsequent ab; Forwarded-Header werden nur von konfigurierten Trusted Proxies akzeptiert.
- Release-Workflow versioniert Web, Windows und Android gemeinsam, baut die nativen Artefakte immer mit und regeneriert das Download-Manifest aus den aktuellen Build-Artefakten.
- Native Update-Manifest und Download-Dateien werden vom App-Cache ausgenommen und serverseitig mit `no-store` ausgeliefert.
- Release-Publishing bereinigt `/downloads/` vor dem Veröffentlichen neuer App-Artefakte, sodass alte Installer/APKs nicht mehr per direkter URL abrufbar bleiben.
- Release-Builds prüfen ein downloadfreies Tauri-Frontend-Bundle und brechen bei unerwartet großen Windows-/Android-Artefakten ab.
- Native Windows- und Android-Downloads öffnen extern ohne CORS-Preflight-Falle; Android akzeptiert dabei nur sichere HTTP(S)-URLs ohne Control-Zeichen.
- Android-Passkeys verwenden die offizielle App-Identity plus Release-Zertifikat in `/.well-known/assetlinks.json`; diese Bindung ist bewusst nicht pro Selfhost-Instanz konfigurierbar.
- Windows-Upgrades räumen gezielt WebView-Cache-Verzeichnisse auf; Android migriert stale WebView-Cache-Zustände sauber.
- **E-Mail-Sharing liefert neutrale Responses** (keine Member-Details) zur Vermeidung von E-Mail-Enumeration.
- **Member-Listen zeigen nur `accepted` Mitglieder** — Pending Invites sind privat bis zur Annahme.
- **Passwort-Reset und Einladungen** senden nur an verifizierte E-Mails; neutrale Responses verhindern Enumeration.
- **SMTP-Secrets werden in API-Responses redacted** (`smtp_password_configured` statt Klartext).
- Login-Antworten können jetzt eine 2FA-Challenge statt eines Access-Tokens liefern; Clients müssen dann `/api/2fa/challenge/verify` oder den Passkey-Verify-Flow abschließen. Global erzwungene 2FA ohne nutzbaren Faktor erzeugt nur einen Enrollment-Token; E-Mail-Code bleibt dabei Fallback-/Übergangspfad und zählt nicht als eingerichteter primärer Faktor.
- Recovery Codes gelten nicht mehr als alleinstehender primärer Faktor: sobald TOTP und Passkeys entfernt sind, werden verbleibende Recovery Codes widerrufen und die user-seitige 2FA deaktiviert; globale 2FA-Policy kann danach weiterhin E-Mail-Code-MFA verlangen.

### Fixed
- Projektanlage in Workspaces erzeugt keine 500er mehr bei Datenbankkonflikten oder Workspace-Zuordnung.
- Reload in einer Projektansicht stellt Navigation und aktive Sidebar-Markierung zuverlässig wieder her.
- Reload im Dashboard markiert den Dashboard-Eintrag in der Sidebar wieder zuverlässig als aktiv.
- Projektlöschung über UI/Offline-Sync umgeht nicht mehr die Backend-Workspace-Inbox-Logik.
- Realtime-Sync entfernt gelöschte Parent-/Child-Projekte und stale lokale Cache-Einträge korrekt.
- Shared-Project-Änderungen inklusive wiederhergestellter Mitglieder aktualisieren andere Clients per WebSocket.
- Confirm-Dialog-Buttons sind optisch sauber zentriert.
- Theme-Buttons, Admin-Mobile-Layout und Passwort-Setup-Aktionen sind kontrastreicher und sauber ausgerichtet.
- Icon-/Farbwerte für Projekte und Workspaces werden backendseitig validiert und frontendseitig sicher gerendert.
- Akzentverläufe, Plus-Button und Dashboard-Avatar bleiben bei allen Presets und Intensitäten optisch konsistent.
- **E-Mail-Enumeration im Share-Flow geschlossen** (neutrale Responses, keine Member-Details bei E-Mail-Identifiern).
- **Pending-Invite-Leaks über WebSocket behoben** (Broadcasts nur an Invitee, ohne `project_id`).
- **E-Mail-Invite Lookup auf verifizierte E-Mails beschränkt** (kein Username-Matching bei E-Mail-Identifiern).
- Sharing-UI hält lokal gestartete Username-Einladungen sichtbar, ohne privacy-safe Server-Member-Listen für Pending Invites wieder zu öffnen.
- 2FA-Challenges, Reauth-Buckets, Recovery Codes und MFA-Action-Grants können nicht mehrfach für sicherheitskritische Aktionen wiederverwendet werden.
- 2FA-/Security-Flows verwenden keine nativen Browser-Popups mehr; Bestätigungen, Passwortabfragen und Reauth laufen über App-Dialoge.
- Offline-Cold-Start mit gecachter Session loggt erwartbare Server-Refresh-Netzwerkfehler nicht mehr als Frontend-Error.
- 2FA-Enrollment-only Tokens laden nach Login oder Reload keine normale App-Oberfläche und keine lokalen Todo-Daten hinter dem Setup-Modal.
- TOTP- und Passkey-Ersteinrichtung schließen den Enrollment-Lock sauber ab, initialisieren die App ohne Reload und fragen nur das mögliche Passwort-Secret ab.
- Recovery-Code-Regeneration ist in UI und API nur mit aktivem primärem Faktor (TOTP oder Passkey) möglich; E-Mail-Code-only reicht dafür nicht.
- Admin-2FA-Reset invalidiert bestehende Sessions per `token_version`, informiert Clients per WebSocket und trennt aktive User-WebSockets serverseitig.
- Mobile 2FA-/Security-Modals, Workspace-Switcher-Topbar und API-Docs-Theme verhalten sich layout- und theme-konsistent.

## [1.7.3] - 2026-05-22

### Added
- Projektansichten zeigen optional ein kompaktes projektbezogenes Dashboard-Widget.
- User-Menü enthält einen gespeicherten Toggle für das Projekt-Widget.

### Changed
- Neue Standardansicht sortiert nach Priorität und blendet erledigte Todos aus, ohne bestehende Nutzerpräferenzen zu überschreiben.
- Dashboard-Abstand und Projekt-Widget-Optik wurden optisch geglättet.
- Toggle-Beschriftungen im User-Menü sind kürzer.
- Projekt-Sections gruppieren Todos nach Status: In Arbeit, Offen, Erledigt.

### Fixed
- API-Key-Zeitstempel werden aus UTC korrekt in lokale Zeit umgerechnet.
- Projekt-Reload stellt Navigation vor dem ersten Rendern wieder her und verhindert falsche aktive Sidebar-Markierung.

## [1.7.2] - 2026-05-22

### Changed
- Web-Update-Modal nutzt kürzeren Text.
- Native App-Version im Sidebar-Footer nutzt klarere Schreibweise ohne Bindestriche.
- Mobile Update- und Verbinden-Buttons sind kompakter ausgerichtet.
- Download-Manifest wird ohne doppelte App-Einträge normalisiert.

## [1.7.1] - 2026-05-22

### Changed
- Sidebar-Footer zeigt Web-App-Version und Reload-Button kompakt in einer Zeile.
- Native App-Version wird darunter als einzeilige App-Version angezeigt.

## [1.7.0] - 2026-05-22

### Added
- Native Windows-/Android-Apps werden mit derselben Version wie die Web-App gebaut.
- Web-App zeigt verfügbare native App-Updates mit Downloadbutton an.
- Installierte native App-Version wird im Sidebar-Footer angezeigt.

### Changed
- Release-Script baut Web-App, Windows-Installer und Android-APK immer gemeinsam mit einer Version.
- Service-Worker-Update-Hinweis ist jetzt ein verpflichtendes Fullscreen-Modal statt Sidebar-Button.
- Update-Checks laufen robuster bei App-Start, Fokus, Online-Event und periodisch, ohne Offline-Start zu blockieren.

### Fixed
- Release-Flow setzt Web-, Tauri-/Cargo- und Download-Versionen konsistent und schützt vor kaputten Zwischenständen.

## [1.6.5] - 2026-05-22

### Fixed
- Settings-/User-Dropdown richtet alle Menü-Icons und Labels über eine feste Icon-Spalte konsistent aus.
- Geöffnetes User-Dropdown bleibt beim Scrollen der Sidebar an der User-Kachel verankert.
- Regressionstests für User-Menü-Alignment und Scroll-Verankerung ergänzt.

## [1.6.4] - 2026-05-22

### Fixed
- Offline→Online-Sync pusht lokale Änderungen vor autoritativem Server-Refresh, damit offline erledigte/bearbeitete Todos nicht wieder vom Serverstand überschrieben werden.
- Offline-Status gewinnt jetzt über stale WebSocket-Status; die App versucht im echten Offline-Modus keine API-Syncs mehr.
- Online-Event-Sync nutzt mehrere Retry-Versuche plus App-Fokus/Periodik, damit Native/WebView nach Netzwechsel lokale Queue-Änderungen zuverlässig zum Server pusht.
- Regressionstest für offline erledigen → online synchronisieren → Server sieht Änderung → nach Reload erledigt bleiben ergänzt.
- WebSocket-Realtime-Updates rendern nach eingehenden Änderungen wieder mit aktualisiertem In-Memory-State; Änderungen anderer Clients sind ohne Reload sichtbar.
- Regressionstest für zwei Clients ergänzt: Client A ändert ein Todo, Client B sieht die Änderung live per WebSocket.

## [1.6.3] - 2026-05-21

### Changed
- Manueller Reload-Button im Sidebar-Footer zeigt jetzt klar „↻ Neu laden“ statt nur Icon.

### Fixed
- Service Worker aktiviert neue Versionen nicht mehr, wenn der Precache fehlschlägt; dadurch bleibt bei instabiler/offliner Verbindung der letzte vollständige App-Cache erhalten.
- Inline-Boot-Watchdog zeigt bei fehlenden App-Modulen einen Fehler statt endlosem Spinner.
- Versions-Rendering löscht den manuellen Reload-Button nicht mehr nach dem App-Start.
- Service-Worker-Precache enthält kein nicht existentes `/favicon.ico` mehr.
- Test-Suite validiert jetzt, dass der Service-Worker-Precache alle Frontend-JS-Module und App-Shell-Assets enthält und keine stale Assets referenziert.

## [1.6.2] - 2026-05-21

### Added
- Sidebar-Footer hat neben der Versionsnummer einen manuellen Reload-Button, der Service-Worker-Update/Cache-Refresh erzwingt und die Web-App neu lädt.

### Fixed
- Native Android-App entfernt den Service Worker beim Start nicht mehr, damit wiederholte Offline-Cold-Starts nicht in `ERR_NAME_NOT_RESOLVED` landen.
- Release-Script bricht künftig ab, wenn für die Zielversion kein `CHANGELOG.md`-Abschnitt existiert.

## [1.6.1] - 2026-05-21

### Fixed
- Native Offline-Cold-Start in Windows-/Android-App lädt die App-Shell aus dem Service-Worker-Cache statt am Boot-Spinner hängen zu bleiben.

## [1.6.0] - 2026-05-21

### Added
- Native lokale Erinnerungsplanung für Windows/Tauri und Android/Tauri.
  - Windows plant Reminder im laufenden Tray-/App-Prozess lokal.
  - Android plant Reminder über `AlarmManager`, persistiert geplante Reminder und stellt sie nach Geräte-Neustart wieder her.
- Android-Benachrichtigungen haben eine native Aktion „Erledigt“, die das Todo offline lokal als erledigt markiert und über die Sync-Queue später synchronisiert.
- Android-App funktioniert nach einmaligem Laden auch offline inklusive Cold-Start über den Service-Worker-Cache.
- Android nutzt ein eigenes monochromes Small-Notification-Icon.

### Changed
- Native Apps verwenden bekannte Reminder-Zeitpunkte lokal; Browser/PWA-Push bleibt Browser/PWA-only.
- Native Apps melden keine serverseitige WebSocket-Reminder-Bereitschaft mehr an.
- Service Worker bleibt in nativen Wrappern aktiv, damit Offline-Cold-Start funktioniert; native Wrapper aktivieren Service-Worker-Updates automatisch.
- Android nutzt native Systembar-/WindowInsets-Behandlung statt CSS-Hacks.

### Fixed
- Android-Server-URL-Setupscreen ist auf schmalen Displays korrekt zentriert und läuft nicht aus dem Viewport.
- Android-Launcher-/Task-Icon und Notification-Icon sind konsistent mit der App.
- Dashboard-Panels „Fokus“ und „Aktive Projekte“ sind optisch gleichmäßig ausgerichtet.
- Klicks auf Projektlinks im Dashboard synchronisieren die aktive Sidebar-Auswahl.
- Windows/Tauri startet offline nach App-Neustart wieder aus dem Cache statt beim leeren Startscreen hängen zu bleiben.

### Known limitations
- Android „Erledigt“ aus der nativen Benachrichtigung nutzt aktuell einen nativen IndexedDB-Single-Shot-Pfad. Das markiert zuverlässig offline erledigt, zeigt aber derzeit keinen Web-Undo-Toast.

## [1.5.2] - 2026-05-21

### Fixed
- Android/Tauri-Start lädt die Web-App mit Native-Launch-Parameter, um stale Service-Worker-Navigation-Caches zu umgehen.
- Service Worker wird in nativen Tauri-Wrappern deaktiviert und vorhandene Registrierungen werden entfernt, damit Android nicht im Boot-Spinner hängen bleibt.
- Android bekommt ein natives Statusbar-Inset, damit Topbar und Sidebar nicht unter der System-Statusleiste liegen.
- Boot-Prozess zeigt bei hängender Initialisierung einen Reload-Fehler statt endlosem Spinner.

## [1.5.1] - 2026-05-21

### Changed
- Android-APK wird jetzt mit dauerhaftem Release-Keystore signiert, damit zukünftige Android-Updates sauber überinstalliert werden können.
- Download-Buttons nutzen feste Windows-/Android-SVG-Logos statt plattformabhängiger Emojis.

### Fixed
- Release-Script signiert Android-APKs zuverlässig mit `apksigner` und verifiziert die Signatur.

## [1.5.0] - 2026-05-21

### Added
- **Android Tauri-App** als nativer Wrapper neben Windows
  - Lokale Server-URL-Auswahl wie bei Windows, ohne fest eingebaute Standard-URL
  - Android-native Benachrichtigungen über Tauri Notification Plugin inklusive Runtime-Permission
  - Android-App-ID auf die offizielle Release-App-ID umgestellt
- **Android-Download im Browser**
  - Download-Manifest enthält Windows-Setup und Android-APK gleichwertig
  - Login- und Settings-Downloadbereich zeigen beide Plattformen nebeneinander an

### Changed
- Native App-Einstellungen gelten für Windows und Android gemeinsam; Desktop-only Optionen wie Tray, Autostart und globale Hotkeys werden auf Android ausgeblendet.
- Release-Automation baut und veröffentlicht neben dem Windows-Installer auch eine signierte Android-APK inklusive SHA256.

### Fixed
- Android Statusbar-/Edge-to-edge-Überlappung behoben, indem der native Edge-to-edge-Modus entfernt wurde.
- Android Launcher-/Task-Switcher-Icon aus den App-Icons neu generiert.
- Browser-Push-Einstellungen werden in nativen Apps ausgeblendet, weil native Notifications dort separat laufen.

## [1.4.0] - 2026-05-21

### Added
- **Windows Desktop-App auf Tauri-Basis**
  - Server-URL wird lokal konfiguriert statt fest eingebaut
  - Native Windows-Benachrichtigungen für Erinnerungen
  - Globale Desktop-Hotkeys für App anzeigen/verstecken, neues Todo und Suche
  - Hotkeys werden per Tastendruck erfasst und lokal gespeichert
  - Fenstergröße, Position und maximierter Zustand werden über Neustarts hinweg wiederhergestellt
- **Desktop-Download im Browser**
  - Aktuelle Windows-Setup-Datei kann im normalen Browser unter Login und Einstellungen heruntergeladen werden
  - Download wird in Desktop-App/PWA/Standalone-Modus ausgeblendet
- **Release-Automation für Windows**
  - `release.sh` setzt die Tauri-Version, baut das Windows-Setup und legt es versioniert unter `/downloads/` auf dem Live-Server ab
  - Download-Manifest mit Version, Dateiname, Größe und SHA256 wird automatisch erzeugt

### Changed
- Service Worker precached neue Desktop-/Download-Module und nutzt stabile Avatar-URLs für besseren Offline-Cache

### Fixed
- Offline-Cold-Start bleibt mit gültiger lokaler Session eingeloggt und lädt IndexedDB-Daten statt Login zu erzwingen
- Avatare bleiben nach vorherigem Online-Laden auch offline sichtbar
- Hotkey-Capture speichert keine Modifier-only Events mehr (`Ctrl` allein) und ignoriert Key-Repeat beim Gedrückthalten

## [1.3.6] - 2026-05-21

### Fixed
- Sidebar-Benutzermenü ist auf Desktop und Mobile schmaler und mittig am Sidebar-User-Container ausgerichtet

## [1.3.5] - 2026-05-21

### Fixed
- Sidebar-Benutzermenü wird in Desktop-PWA und Mobile nicht mehr vom Sidebar-Overflow abgeschnitten

## [1.3.4] - 2026-05-21

### Fixed
- WebPush-VAPID-Claims werden pro Subscription isoliert, damit Android/FCM und Windows/WNS in einem gemeinsamen Versand nicht gegenseitig die Ziel-Audience überschreiben

## [1.3.3] - 2026-05-21

### Fixed
- Push-Test meldet jetzt das echte WebPush-Sendeergebnis statt immer Erfolg anzuzeigen
- Test-Benachrichtigungen nutzen eindeutige Tags, damit Windows/Edge sie nicht still ersetzt oder zusammenfasst

## [1.3.2] - 2026-05-21

### Added
- Mobile Sidebar lässt sich per defensiver Edge-Swipe-Geste von links öffnen

### Changed
- Swipe-Startzone wurde für Android verbreitert, damit die Browser-/System-Zurück-Geste weniger stört

## [1.3.1] - 2026-05-21

### Changed
- Dashboard-Pill oben rechts entfernt, damit der Header ruhiger wirkt
- **Aktive Projekte** sortiert jetzt nach der letzten Todo-Änderung pro Projekt statt nach offener Todo-Anzahl
  - Nutzt `updated_at` mit Fallback auf `created_at`
  - Zeigt relative Änderungszeit wie `vor 3 Min.` oder `vor 2 Std.`

## [1.3.0] - 2026-05-21

### Added
- **Dashboard-Ansicht** ersetzt „Alle“ als zentrale Übersicht
  - Persönliche Begrüßung mit Anzeigename, Avatar, Datum und Uhrzeit
  - KPI-Karten für Gesamt, Offen, In Arbeit und Überfällig
  - Fokusbereich mit Heute fällig, nächste 7 Tage, Erledigt und Erledigt-Quote
  - Aktive Projekte als klickbare Übersicht
- **Floating Action Button** zum Erstellen neuer Todos
  - Runder Plus-Button rechts unten statt „Neues Todo“ in der Topbar
  - Mobile Safe-Area und extra Listenabstand berücksichtigt

### Changed
- Globale Statistikleiste wird nicht mehr in Projektansichten angezeigt
- Dashboard scrollt gemeinsam mit der Todo-Liste; Topbar bleibt sticky
- Benutzer-/Einstellungsmenü wurde aus der Topbar in den unteren Sidebar-Footer verschoben
- Sidebar-Ansicht „Alle“ wurde zu „Dashboard“ umbenannt

## [1.2.3] - 2026-05-21

### Fixed
- **Header-Avatar optisch ausgerichtet**
  - Avatar-Button sitzt jetzt sauber auf derselben Höhe wie die Topbar-Aktionen
  - `Neues Todo`-Button und Avatar-Control nutzen konsistente 40px-Höhe

## [1.2.2] - 2026-05-21

### Fixed
- **Todo-Bearbeiten erhält Sections korrekt**
  - Section-Auswahl im Edit-Modal wird jetzt anhand des Todo-Projekts geladen
  - Bestehende `section_id` wird beim Öffnen korrekt vorausgewählt
  - Speichern ohne Section-Änderung verschiebt Todos nicht mehr fälschlich nach „Unsortiert“
- Regressionstest für Todo-Edit mit Section-Erhalt ergänzt

## [1.2.1] - 2026-05-21

### Fixed
- **PWA-Offline-Cold-Start**: App bleibt nach komplettem Beenden und erneutem Öffnen ohne Netzwerk eingeloggt
  - Temporäre Netzwerk-/Offline-Fehler bei `/api/me` löschen die lokale Session nicht mehr
  - Gültige lokale Session wird aus gecachtem Benutzerprofil/JWT rekonstruiert
  - Echte Auth-Fehler löschen die Session weiterhin korrekt
- Regressionstest für Offline-Cold-Start ergänzt

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
- **API-Key Auth**: CSRF-Bypass nur noch für `Authorization: ApiKey ...`; `Bearer nt_...` und `X-API-Key` werden abgelehnt
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
- Interne Audit-/Debug-Dateien aus dem Release-Paket entfernt

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
- **CORS**: Erlaubte Origins sind konfigurierbar und werden restriktiv geprüft
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
