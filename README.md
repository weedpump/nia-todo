# <img src="web/static/icons/icon-512.png" alt="nia-todo icon" width="32" height="32"> nia-todo

Selfhosted todo system — SQLite + FastAPI + Web UI + offline PWA + native Windows/Android/Debian apps.

## 🌍 Instances

- **Production:** runs on a separate LXC managed by Tobi; this dev checkout does not contain live data or a live service.
- **Dev:** `https://todo-dev.kneidl-home.de` from the dev checkout (path configurable via `NIA_TODO_DEV_DIR`)

## 🚀 Quick Start

### Dev
```bash
cd "$NIA_TODO_DEV_DIR"   # your local dev checkout
systemctl restart nia-todo-dev
```

## ✨ Features

- 📝 Todos with rich descriptions, status, priority, deadline, reminders, recurring schedules, checklist subtasks, comments, and attachments
- ✅ Checklist-style subtasks with progress chips, parent-complete confirmation, realtime sync, and recurring-todo carry-over
- 💬 Todo comments with author display, edit/delete actions, shared-project permissions, and realtime updates
- 📎 Todo attachments with authenticated uploads/downloads, image/PDF preview, native download handling, quotas, file-type controls, and backup/restore coverage
- 🔁 Recurring todos with daily, weekly, monthly, or yearly intervals; completing one creates the next occurrence and carries compatible reminders/subtasks forward
- 📅 Global Calendar view for todos with due dates, including day, week, and month modes plus mobile-friendly month selection
- 📁 Projects/categories with subprojects, sections, workspaces, protected per-user inboxes, curated icons/colors, and sidebar drag-and-drop todo moves
- 🤝 Project sharing between users with invitations, undo, member management, and shared-project access checks
- 📧 Email/SMTP integration for invitations, password reset, and email verification
- 📱 Offline PWA plus native Windows, Android, and Debian desktop wrappers with bundled downloads from the server
- 🐧 Native Debian desktop app with autostart, tray/global-hotkey settings, OIDC return handling, desktop notifications, and cache cleanup
- 🔐 Auth, admin panel, API keys, CSRF protection, OIDC/SSO support, and user data isolation
- 🛡️ 2FA/MFA with authenticator app (TOTP), passkeys/WebAuthn including native Windows/Android bridge, email code fallback, recovery codes, trusted devices, and admin policy
- 🔔 Native local reminders on Windows and Android, plus Debian desktop notifications; browser/PWA push remains browser/PWA-only
- 🎙️ BrainDump voice capture for turning spoken notes into reviewed todo candidates, with configurable STT/LLM providers including OpenAI-compatible endpoints, Ollama, and OpenClaw agents
- 🎨 Next UI refresh with shared detail-modal primitives, cleaner responsive surfaces, Lucide icons, overlay scrollbars, and polished light/dark themes
- 🆕 Localized “What’s new” release tour with per-user seen state and offline/PWA precache coverage
- 🌐 UI language support for 12 languages across app UI, emails, release tour, native/OIDC handoff screens, and locale-aware dates/times
- 🗄️ Local SQLite with packaged backups that snapshot runtime data, attachments, avatars, generated keys, and database state

## 🌐 Supported languages

nia-todo currently supports:

- German (`de`)
- English (`en`)
- Czech (`cs`)
- French (`fr`)
- Italian (`it`)
- Dutch (`nl`)
- Polish (`pl`)
- Brazilian Portuguese (`pt-BR`)
- Russian (`ru`)
- Swedish (`sv`)
- Spanish (`es`)
- Simplified Chinese (`zh-CN`)

Language support covers the web/native UI, system emails, and release-tour content.

## 🧱 Project Structure

- `api/` — Backend, DB, migrations
- `web/` — Web UI, service worker, manifest
- `scripts/` — Test suites and helpers
- `docs/` — API, test, and workflow docs
- `systemd/` — service units and packaging helpers

## 🔧 Development

- Dev branch: `nia-todo-next` for this release-readiness branch; `develop` remains the normal integration branch after release.
- Dev folder: local checkout path, set via `NIA_TODO_DEV_DIR` (used by test scripts and the dev systemd unit)
- Release only from `develop` through `./release.sh VERSION --github-repo OWNER/REPO`
- UI changes must follow the [Design Concept](docs/design-concept.md) for desktop/mobile layout, modals, buttons, reusable patterns, and the Next UI primitives.

## 🧪 Tests

- `npm test`
- `./scripts/test_all.sh`
- targeted 2FA regressions: `python3 scripts/test_two_factor_services.py`, `node scripts/test_frontend_mfa_login.mjs`, `node scripts/test_frontend_security.mjs`

Details: [Test docs](docs/testing.md)

## 📚 Docs

- [API docs](docs/api.md)
- [Test docs](docs/testing.md)
- [Workflow docs](docs/workflow.md)
- [Architecture](docs/architecture.md)
- [Design Concept](docs/design-concept.md)
- Changelog: `CHANGELOG.md` shared by web app, Windows app, Android app, and Debian desktop app

## ⚙️ Setup / Operations

- Initial setup: `/setup`
- Admin panel: `/admin`
- 2FA policy and user reset: `/admin` → Security/user list
- Passkeys require an HTTPS `public_base_url` in production setups; native passkeys are supported on Windows and Android, while Debian desktop passkey integration is intentionally deferred. Android uses the bundled app signature through `/.well-known/assetlinks.json`.
- BrainDump is disabled by default until configured: set up global STT/LLM providers in `/admin`, enable the global feature, then grant per-user access. See [BrainDump](docs/braindump-v2.md).
- Attachments are admin-controlled: configure global upload enablement, allowed extensions, default quota, and per-user quota overrides in `/admin`.
- Native app downloads are served from `/downloads/` and include Windows, Android, and Debian desktop clients when bundled by release packaging.
- Dev branding: `setup-dev.sh`

## 📄 License

Copyright (C) 2026 Tobias Kneidl

nia-todo is free software licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

## Notes

- Do not commit DB files
- `web/manifest.json` is maintained by the dev/release flow

---


