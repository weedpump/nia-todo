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

Aktueller 2.0-Branch-Stand:

- Tauri bündelt die Web-App lokal aus `web/` statt nur eine Remote-Redirect-Shell auszuliefern.
- Native Runtime liest die lokal gespeicherte Server-URL und nutzt sie als API-/WebSocket-Basis.
- `/api/instance` verifiziert Server mit niedriginformativer öffentlicher Instanz-Metadaten-Antwort.
- Native Erstkonfiguration läuft lokal, bevor Login/App-Sync startet.

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
- API-Keys für externe Nutzung nur via `Authorization: ApiKey ...`
- Benutzer sehen eigene Daten plus akzeptierte Shared-Projekte
- Shared-Projektzugriff wird in Projekten, Todos, Sections, Reminders und WebSocket-Payloads geprüft
- **E-Mail-Verifizierung**: Login, Passwort-Reset und Projekt-Sharing erfordern verifizierte E-Mails
- **Neutrale API-Responses** bei E-Mail-basierten Aktionen verhindern User-Enumeration
- **Pending Invites** sind aus Privacy-Gründen nur für den Invitee sichtbar (nicht für Owner/Members)
- **2FA/MFA** ist in den normalen Passwort-Login eingebunden: Wenn ein Account 2FA benötigt und kein gültiges Trusted-Device-Cookie existiert, liefert `/api/login` eine Challenge statt eines Access-Tokens. Nach erfolgreicher Challenge wird ein JWT mit `mfa_at` ausgestellt.
- **2FA-Methoden**: TOTP ist der primäre selbstverwaltete Faktor; Recovery Codes sind gehashed gespeichert und einmalig nutzbar; E-Mail-Code ist ein gültiger Faktor, wenn kein stärkerer Faktor vorhanden ist, eine verifizierte E-Mail existiert und der Versand erfolgreich war; Passkeys nutzen WebAuthn-Challenge/Verify-Endpunkte mit ES256/P-256-Assertions, User-Verification-Pflicht, expliziter HTTPS-`public_base_url`-RP/Origin-Bindung (`http` nur lokal), `none`-Attestation-Parsing, Signaturprüfung und Sign-Counter-Rollback-Prüfung; Credentials liegen widerrufbar in `passkeys`/`passkey_challenges`.
- **Trusted Devices** werden als HttpOnly-Cookie plus gehashter Server-Token gespeichert, laufen nach 30 Tagen ab und werden über `two_factor_remember_version` bei Reset/Disable invalidiert. Trusted Devices erlauben App-Login ohne erneute MFA, zählen aber nicht als `recent MFA`: sensible Aktionen wie Passwortänderung oder API-Key-Verwaltung müssen weiterhin eine echte MFA-Reauth auslösen.
- **Security-sensitive Aktionen** nutzen `require_recent_mfa`; bei 2FA-pflichtigen Accounts muss das JWT innerhalb des Reauth-Fensters (`mfa_at`) ausgestellt worden sein. Alte JWTs ohne `mfa_at` werden nach 2FA-Aktivierung/Policy für normale API-Auth abgelehnt. Der nicht-sensitive 2FA-Status bleibt für gültige interaktive JWTs lesbar, damit Clients bei stale `mfa_at` den richtigen Reauth-Faktor wählen können.
- **Audit-Events** dokumentieren 2FA-Policy-Änderungen, Enrollment, Recovery-Code-Erzeugung/-Nutzung, Challenge-Erfolg/-Fehler, E-Mail-Code-Versand für Login/Reauth, Passkey-Änderungen, Trusted-Device-Erzeugung/-Widerruf und Admin-Reset. Challenge- und Reauth-Verifikation sind per Attempt-Counter begrenzt, inklusive E-Mail-/Passkey-Reauth-Challenges. API Keys sind bewusst als Maschinen-Token von interaktiver MFA ausgenommen und bleiben widerrufbar; Settings-UI reauthentifiziert API-Key-Management bei Bedarf, Admin-UI zeigt aktive API-Key-Anzahl als Hinweis, widerruft bestehende Keys aber nicht automatisch.

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
