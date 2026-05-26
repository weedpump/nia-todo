# <img src="web/static/icons/icon-512.png" alt="nia-todo icon" width="32" height="32"> nia-todo

Self-hosted todo system — SQLite + FastAPI + Web UI + offline PWA + official native Windows/Android clients.

nia-todo is designed for private self-hosting: install the server, open the web app, then download the bundled native apps directly from your own instance.

## ✨ Features

- 📝 Todos with description, priority, deadline, status, and reminders
- 📁 Projects/categories with subprojects, sections, workspaces, and protected per-user inboxes
- 🤝 Project sharing between users with invitations and undo
- 📧 Email/SMTP integration for invitations, password reset, and email verification
- 📱 Offline-capable PWA with local IndexedDB sync queue
- 🖥️ Official native Windows app wrapper
- 🤖 Official native Android APK
- 🔐 Auth, admin panel, API keys, CSRF protection, and per-user data isolation
- 🛡️ 2FA/MFA with TOTP, passkeys/WebAuthn, email-code fallback, recovery codes, trusted devices, and admin policy
- 🔔 Native local reminders on Windows and Android; browser/PWA push remains browser/PWA-only
- 🎨 Theme toggle and English/German UI language support
- 🗄️ Local SQLite database

## 📦 Release artifacts

Each public release provides exactly these distribution targets:

- **Full server bundle**: `nia-todo-server-vX.Y.Z-full.deb`
  - installs/updates the server
  - includes the Web/PWA frontend
  - includes bundled native app downloads under `/downloads/`
- **Docker image**: for container-based installations

The Windows and Android clients are shipped inside the server bundle so your own server can serve them locally.

## 🚀 Debian/Ubuntu installation

Download the full server bundle from the release page, then install it:

```bash
sudo apt install ./nia-todo-server-vX.Y.Z-full.deb
```

Open the setup page:

```text
http://YOUR-SERVER:8753/setup
```

After setup, native app downloads are available from your instance under:

```text
http://YOUR-SERVER:8753/downloads/
```

## 📄 License

Copyright (C) 2026 Tobias Kneidl

nia-todo is free software licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

## 🔄 Updates

Install the newer `.deb` package over the existing installation:

```bash
sudo apt install ./nia-todo-server-vX.Y.Z-full.deb
```

The package keeps existing runtime data and creates a pre-upgrade SQLite backup when a database exists.
It also installs a daily systemd backup timer by default.

Recommended before major upgrades:

```bash
sudo systemctl stop nia-todo
sudo cp -a /var/lib/nia-todo /var/lib/nia-todo.backup.$(date +%Y%m%d-%H%M%S)
sudo apt install ./nia-todo-server-vX.Y.Z-full.deb
```

## 🐳 Docker

Run the published image directly:

```bash
docker run -d \
  --name nia-todo \
  --restart unless-stopped \
  -p 8753:8753 \
  -e NIA_TODO_HOST=0.0.0.0 \
  -e NIA_TODO_PORT=8753 \
  -e NIA_TODO_DATA_DIR=/data \
  -e NIA_TODO_DB=nia-todo.db \
  -v nia-todo-data:/data \
  ghcr.io/weedpump/nia-todo:latest
```

Or create a local `compose.yml` without cloning the source repository:

```yaml
services:
  nia-todo:
    image: ghcr.io/weedpump/nia-todo:latest
    ports:
      - "8753:8753"
    environment:
      NIA_TODO_HOST: 0.0.0.0
      NIA_TODO_PORT: 8753
      NIA_TODO_DATA_DIR: /data
      NIA_TODO_DB: nia-todo.db
    volumes:
      - nia-todo-data:/data

volumes:
  nia-todo-data:
```

Then start it:

```bash
docker compose up -d
```

Default container data volume:

```text
/data
```

## 🧱 Default package layout

- App: `/opt/nia-todo`
- Data: `/var/lib/nia-todo`
- Config: `/etc/nia-todo/nia-todo.env`
- Service: `nia-todo.service`

Useful commands:

```bash
sudo systemctl status nia-todo
sudo systemctl status nia-todo-backup.timer
sudo systemctl start nia-todo-backup.service
sudo systemctl restart nia-todo
sudo journalctl -u nia-todo -f
```

## ⚙️ Setup / operations

- Initial setup: `/setup`
- Admin panel: `/admin`
- API docs: see [`docs/api.md`](docs/api.md)
- Architecture notes: see [`docs/architecture.md`](docs/architecture.md)
- Test/release notes: see [`docs/testing.md`](docs/testing.md)
- Changelog: see [`CHANGELOG.md`](CHANGELOG.md)

Production passkeys require a correct HTTPS `public_base_url` in the admin instance settings. Android passkeys use the official app signature through `/.well-known/assetlinks.json`.

## 📚 Documentation

- [API documentation](docs/api.md)
- [Architecture](docs/architecture.md)
- [Testing](docs/testing.md)
- [Changelog](CHANGELOG.md)

## 🧪 Development / source builds

The public repository is a clean source snapshot for releases. For normal self-hosting, use the release package or Docker image.

Basic local source run:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
./start.sh
```

Frontend/native development uses the Node/Tauri tooling declared in `package.json` and `src-tauri/`.

## 🗄️ Backup

The Debian package installs an automatic daily backup timer by default:

```bash
sudo systemctl status nia-todo-backup.timer
sudo systemctl start nia-todo-backup.service
```

Manual backup:

```bash
sudo nia-todo-backup
```

Manual restore:

```bash
sudo systemctl stop nia-todo
sudo nia-todo-restore /var/lib/nia-todo/backups/nia-todo-YYYYMMDD-HHMMSS.zip
sudo systemctl start nia-todo
```

For fresh migration from an older/private install, the simplest path is:

1. Create a backup on the old install.
2. Install the new package or start the new Docker deployment.
3. Restore the backup into the new data directory.

Runtime data lives here:

```text
/var/lib/nia-todo
```

It contains the SQLite database, generated keys, avatars, and local runtime data.

## Notes

- Do not commit database files or generated runtime data.
- The bundled native app downloads are generated during release packaging.
- `CHANGELOG.md` is shared by web app, server, Windows app, and Android app.
