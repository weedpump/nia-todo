# nia-todo

Self-hosted todo system with SQLite, FastAPI, Web UI, offline PWA, and official native Windows/Android clients.

## Install

For Debian/Ubuntu hosts, use the full server bundle from the release page:

```bash
tar -xzf nia-todo-server-vX.Y.Z-full.tar.gz
cd nia-todo-server-vX.Y.Z
sudo ./install.sh
```

Then open:

```text
http://YOUR-SERVER:8753/setup
```

The installed server serves bundled native app downloads under `/downloads/`.

## Docker

```bash
docker compose up -d
```

## Data

Default package layout:

- App: `/opt/nia-todo`
- Data: `/opt/nia-todo/api/data`
- Service: `nia-todo.service`

Back up `api/data/` before migrations or host moves.
