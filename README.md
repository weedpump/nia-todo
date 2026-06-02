# <img src="web/static/icons/icon-512.png" alt="nia-todo icon" width="32" height="32"> nia-todo

Selfhosted todo system — SQLite + FastAPI + Web UI + offline PWA + native Windows/Android apps.

## 🌍 Instances

- **Production:** runs on a separate LXC managed by Tobi; this dev checkout does not contain live data or a live service.
- **Dev:** `http://todo-dev.kneidl-home.de:8754` from `~/projects/nia-todo-dev`

## 🚀 Quick Start

### Dev
```bash
cd ~/projects/nia-todo-dev
systemctl restart nia-todo-dev
```

## ✨ Features

- 📝 Todos with description, priority, deadline, reminders, and recurring schedules
- 🔁 Recurring todos with daily, weekly, monthly, or yearly intervals; completing one creates the next occurrence
- 📁 Projects/categories including subprojects and protected per-user inbox
- 🤝 Project sharing between users with invitations and undo
- 📧 Email/SMTP integration for invitations, password reset, and email verification
- 🔲 Sections per project
- 📱 Offline PWA plus native Windows/Android wrappers
- 🔐 Auth, admin panel, API keys, CSRF protection, and user data isolation
- 🛡️ 2FA/MFA with authenticator app (TOTP), passkeys/WebAuthn including native Windows/Android bridge, email code fallback, recovery codes, trusted devices, and admin policy
- ⏰ Reminders/deadlines with validated date/time input
- 🔁 Recurring todos require a due date and can carry reminders forward to the next occurrence
- 🔔 Native local reminders on Windows and Android; browser/PWA push remains browser/PWA-only
- 🎙️ BrainDump voice capture for turning spoken notes into reviewed todo candidates, with configurable STT/LLM providers including OpenAI-compatible endpoints, Ollama, and OpenClaw agents
- 🎨 Theme toggle
- 🗄️ Local SQLite

## 🧱 Project Structure

- `api/` — Backend, DB, migrations
- `web/` — Web UI, service worker, manifest
- `scripts/` — Test suites and helpers
- `docs/` — API, test, and workflow docs
- `systemd/` — service units and packaging helpers

## 🔧 Development

- Dev branch: `develop`
- Dev folder: `~/projects/nia-todo-dev`
- Release only from `develop` through `./release.sh VERSION --github-repo OWNER/REPO`
- UI changes must follow the [Design Concept](docs/design-concept.md) for desktop/mobile layout, modals, buttons, and reusable patterns. Dropdown/select work must also follow the [UI Dropdown Migration Plan](docs/ui-dropdown-migration-plan.md).

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
- Changelog: `CHANGELOG.md` shared by web app, Windows app, and Android app

## ⚙️ Setup / Operations

- Initial setup: `/setup`
- Admin panel: `/admin`
- 2FA policy and user reset: `/admin` → Security/user list
- Passkeys require an HTTPS `public_base_url` in production setups; Android uses the bundled app signature through `/.well-known/assetlinks.json`
- BrainDump is disabled by default until configured: set up global STT/LLM providers in `/admin`, enable the global feature, then grant per-user access. See [BrainDump](docs/braindump-v2.md).
- Dev branding: `setup-dev.sh`

## 📄 License

Copyright (C) 2026 Tobias Kneidl

nia-todo is free software licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

## Notes

- Do not commit DB files
- `web/manifest.json` is maintained by the dev/release flow

---


