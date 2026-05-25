# ✨ nia-todo

Selfhosted todo system — SQLite + FastAPI + Web UI + offline PWA + native Windows/Android apps.

## 🌍 Instances

- **Live:** `http://todo-dev.kneidl-home.de:8753`
- **Dev:** `http://todo-dev.kneidl-home.de:8754`

## 🚀 Quick Start

### Live
```bash
cd ~/projects/nia-todo
systemctl restart nia-todo
```

### Dev
```bash
cd ~/projects/nia-todo-dev
systemctl restart nia-todo-dev
```

## ✨ Features

- 📝 Todos with description, priority, deadline, and reminders
- 📁 Projects/categories including subprojects and protected per-user inbox
- 🤝 Project sharing between users with invitations and undo
- 📧 Email/SMTP integration for invitations, password reset, and email verification
- 🔲 Sections per project
- 📱 Offline PWA plus native Windows/Android wrappers
- 🔐 Auth, admin panel, API keys, CSRF protection, and user data isolation
- 🛡️ 2FA/MFA with authenticator app (TOTP), passkeys/WebAuthn including native Windows/Android bridge, email code fallback, recovery codes, trusted devices, and admin policy
- ⏰ Reminders/deadlines with validated date/time input
- 🔔 Native local reminders on Windows and Android; browser/PWA push remains browser/PWA-only
- 🎨 Theme toggle
- 🗄️ Local SQLite

## 🧱 Project Structure

- `api/` — Backend, DB, migrations
- `web/` — Web UI, service worker, manifest
- `scripts/` — Test suites and helpers
- `docs/` — API, test, and workflow docs
- `systemd/` — Live/dev services

## 🔧 Development

- Dev branch: `develop`
- Dev folder: `~/projects/nia-todo-dev`
- Release only through `./release.sh VERSION`

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
- [Native Apps Clean Architecture Plan](docs/native-apps-clean-architecture.md) — current 2.0 state including Android passkey trust model
- Changelog: `CHANGELOG.md` shared by web app, Windows app, and Android app

## ⚙️ Setup / Operations

- Initial setup: `/setup`
- Admin panel: `/admin`
- 2FA policy and user reset: `/admin` → Security/user list
- Passkeys require an HTTPS `public_base_url` in production setups; Android uses the official app signature through `/.well-known/assetlinks.json`
- Dev branding: `setup-dev.sh`

## Notes

- Do not commit DB files
- `web/manifest.json` is maintained by the dev/release flow

---


